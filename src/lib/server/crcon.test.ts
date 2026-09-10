import { describe, expect, test } from 'bun:test';
import {
	CrconParseError,
	expandReason,
	MAX_RECORDS,
	parseCrconExport,
	parseCsvRows
} from './crcon';

const now = new Date('2026-09-10T12:00:00Z');
const ALICE = '76561198000000001';
const BOB = '76561198000000002';

/** A record shaped the way CRCON's get_blacklist_records writes one. */
const record = (over: Record<string, unknown> = {}) => ({
	id: 1,
	player_id: ALICE,
	reason: 'Cheating',
	admin_name: 'admin1',
	created_at: '2026-01-02T03:04:05+00:00',
	expires_at: null,
	is_active: true,
	blacklist: { id: 0, name: 'Default', sync: 'KICK_ONLY', servers: null },
	player: { id: 7, player_id: ALICE, names: [{ name: 'Alice' }, { name: 'Al' }] },
	...over
});

describe('parseCrconExport: the shapes CRCON actually returns', () => {
	test('the get_blacklist_records envelope', () => {
		const file = JSON.stringify({
			result: { records: [record()], total: 1 },
			command: 'get_blacklist_records',
			failed: false,
			error: null,
			version: 'v11.0.0'
		});
		const out = parseCrconExport(file, now);
		expect(out.total).toBe(1);
		expect(out.blacklists).toEqual(['Default']);
		expect(out.records[0]).toMatchObject({
			steamId: ALICE,
			name: 'Alice',
			reason: 'Cheating',
			adminName: 'admin1',
			expiresAt: null,
			blacklist: 'Default'
		});
	});

	test('the get_blacklist envelope, where records hang off the blacklist', () => {
		const file = JSON.stringify({
			result: {
				id: 2,
				name: 'Cheaters',
				sync: 'BAN_ON_CONNECT',
				servers: null,
				records: [record()]
			},
			failed: false
		});
		expect(parseCrconExport(file, now).records).toHaveLength(1);
	});

	test('a bare array, and a bare {records}', () => {
		expect(parseCrconExport(JSON.stringify([record()]), now).records).toHaveLength(1);
		expect(parseCrconExport(JSON.stringify({ records: [record()] }), now).records).toHaveLength(1);
	});

	test('a CRCON error answer is reported as such, not as an empty list', () => {
		const file = JSON.stringify({
			result: null,
			failed: true,
			error: 'You do not have permission'
		});
		expect(() => parseCrconExport(file, now)).toThrow(CrconParseError);
		expect(() => parseCrconExport(file, now)).toThrow(/You do not have permission/);
	});

	test('junk is refused with a message naming the endpoints to use', () => {
		expect(() => parseCrconExport('hello there', now)).toThrow(/get_blacklist_records/);
		expect(() => parseCrconExport('{ not json', now)).toThrow(/not valid JSON/);
		expect(() => parseCrconExport('   ', now)).toThrow(/empty/);
		expect(() => parseCrconExport(JSON.stringify({ result: {} }), now)).toThrow(
			/No blacklist records/
		);
	});
});

describe('parseCrconExport: which records become bans', () => {
	test('a Windows Store player is skipped, since Warcon lists address SteamID64s', () => {
		const out = parseCrconExport(
			JSON.stringify([record({ player_id: 'abcdef01-2345-6789-abcd-ef0123456789', player: null })]),
			now
		);
		expect(out.records).toHaveLength(0);
		expect(out.skipped[0].reason).toMatch(/SteamID64/);
	});

	test('a record with no player ID at all is skipped', () => {
		const out = parseCrconExport(JSON.stringify([record({ player_id: null, player: null })]), now);
		expect(out.skipped[0].reason).toMatch(/no player ID/);
	});

	test('a lapsed ban is skipped rather than re-applied', () => {
		const out = parseCrconExport(
			JSON.stringify([record({ expires_at: '2026-01-01T00:00:00+00:00', is_active: false })]),
			now
		);
		expect(out.records).toHaveLength(0);
		expect(out.skipped[0].reason).toMatch(/already expired/);
	});

	test('is_active: false is taken at its word, expiry or not', () => {
		const out = parseCrconExport(
			JSON.stringify([record({ expires_at: null, is_active: false })]),
			now
		);
		expect(out.records).toHaveLength(0);
		expect(out.skipped[0].reason).toMatch(/already expired/);
	});

	test('a file with no is_active column imports normally', () => {
		const csv = `player_id,reason\n${ALICE},Cheating\n`;
		expect(parseCrconExport(csv, now).records).toHaveLength(1);
	});

	test('a live dated ban keeps its expiry', () => {
		const out = parseCrconExport(
			JSON.stringify([record({ expires_at: '2026-12-01T00:00:00+00:00' })]),
			now
		);
		expect(out.records[0].expiresAt).toBe('2026-12-01T00:00:00.000Z');
	});

	test("CRCON's far-future 'permanent' date becomes a permanent ban", () => {
		const out = parseCrconExport(
			JSON.stringify([record({ expires_at: '3000-01-01T00:00:00+00:00' })]),
			now
		);
		expect(out.records[0].expiresAt).toBeNull();
		expect(out.skipped).toHaveLength(0);
	});

	test('a player on two blacklists is merged into their longest ban', () => {
		const out = parseCrconExport(
			JSON.stringify([
				record({ id: 1, expires_at: '2026-10-01T00:00:00+00:00', reason: 'short' }),
				record({ id: 2, expires_at: null, reason: 'permanent' })
			]),
			now
		);
		expect(out.total).toBe(2);
		expect(out.records).toHaveLength(1);
		expect(out.records[0].reason).toBe('permanent');
	});

	test('an oversized file is refused before it is walked', () => {
		const many = JSON.stringify(
			Array.from({ length: MAX_RECORDS + 1 }, (_, i) => record({ id: i }))
		);
		expect(() => parseCrconExport(many, now)).toThrow(/limit is 5000/);
	});
});

describe('parseCrconExport: CSV', () => {
	test('a CSV with CRCON column names reads like the JSON', () => {
		const csv = [
			'player_id,player_name,reason,admin_name,created_at,expires_at,is_active',
			`${ALICE},Alice,"Cheating, badly",admin1,2026-01-02T03:04:05Z,,true`,
			`${BOB},Bob,Griefing,admin2,2026-02-02T00:00:00Z,2026-12-01T00:00:00Z,true`
		].join('\n');
		const out = parseCrconExport(csv, now);
		expect(out.records).toHaveLength(2);
		expect(out.records.find((r) => r.steamId === ALICE)?.reason).toBe('Cheating, badly');
		expect(out.records.find((r) => r.steamId === BOB)?.expiresAt).toBe('2026-12-01T00:00:00.000Z');
	});

	test('semicolon files (a spreadsheet in a European locale) are read too', () => {
		const csv = `player_id;reason;expires_at\n${ALICE};Cheating;\n`;
		expect(parseCrconExport(csv, now).records[0].reason).toBe('Cheating');
	});
});

describe('parseCsvRows', () => {
	test('quotes, embedded delimiters, newlines and doubled quotes', () => {
		expect(parseCsvRows('a,b\n1,"x,y"\n')).toEqual([
			['a', 'b'],
			['1', 'x,y']
		]);
		expect(parseCsvRows('a\n"line\nbreak"\n')).toEqual([['a'], ['line\nbreak']]);
		expect(parseCsvRows('a\n"say ""hi"""\n')).toEqual([['a'], ['say "hi"']]);
	});

	test('blank lines are dropped, CRLF is tolerated', () => {
		expect(parseCsvRows('a,b\r\n1,2\r\n\r\n')).toEqual([
			['a', 'b'],
			['1', '2']
		]);
	});
});

describe('expandReason', () => {
	const vars = {
		name: 'Alice',
		steamId: ALICE,
		createdAt: new Date('2026-01-02T03:04:00Z'),
		expiresAt: null,
		adminName: 'admin1',
		blacklist: 'Default'
	};

	test("CRCON's template variables are filled in from the record", () => {
		expect(expandReason('{player_name} banned by {admin_name}', vars)).toBe(
			'Alice banned by admin1'
		);
		expect(expandReason('Banned until {banned_until}', vars)).toBe('Banned until forever');
		expect(
			expandReason('Until {expires_at}', { ...vars, expiresAt: new Date('2026-12-01T00:00:00Z') })
		).toBe('Until 2026-12-01 00:00');
	});

	test('a variable we cannot fill is dropped rather than shipped to a game server', () => {
		expect(expandReason('Cheating {seed} here', vars)).toBe('Cheating here');
	});

	test('plain reasons pass through untouched', () => {
		expect(expandReason('Cheating', vars)).toBe('Cheating');
	});
});
