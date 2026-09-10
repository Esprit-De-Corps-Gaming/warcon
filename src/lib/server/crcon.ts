// Reading a ban list exported from Community RCON (hll_rcon_tool) so an org can adopt it.
//
// CRCON has no export button, so what an operator actually has to hand is whatever its API
// returned, saved to a file:
//
//   curl -H "Authorization: Bearer $KEY" \
//     "https://crcon.example.com/api/get_blacklist_records?blacklist_id=0&page_size=1000" \
//     > bans.json
//
// That answer is wrapped in CRCON's {result, command, failed, error} envelope; `get_blacklist`
// nests the records under the blacklist instead, and people paste bare arrays too. Rather than
// insist on one shape this reads any of them, and a CSV with the same column names, because the
// cost of being lenient here is a few lines and the cost of being strict is an operator with a
// file we refuse to open.
//
// Nothing in this module touches the database or the network: it turns text into rows, and
// lists.ts decides what to write. Everything it cannot use comes back in `skipped` with a reason,
// so the panel can show an operator exactly what a file did and did not contain.

import type { CrconBanRecord, CrconSkippedRecord } from '$lib/types';

/**
 * A blacklist record we could turn into a Warcon ban, and one we could not. The shapes are shared
 * with the browser (the review table renders them), so they live in $lib/types.
 */
export type CrconRecord = CrconBanRecord;
export type CrconSkip = CrconSkippedRecord;

export interface CrconParse {
	records: CrconRecord[];
	skipped: CrconSkip[];
	/** Records found in the file, before skipping and merging. */
	total: number;
	/** Names of the CRCON blacklists the file spans. */
	blacklists: string[];
}

/** Text longer than this is refused rather than parsed; ~4 MB is far more than any ban list. */
export const MAX_EXPORT_BYTES = 4_000_000;
/** Records read from one file. CRCON pages at 50 by default, so this is a generous ceiling. */
export const MAX_RECORDS = 5000;
/** CRCON stores "permanent" as a far-future date; anything past this is treated as permanent. */
const PERMANENT_AFTER_MS = 10 * 365.25 * 86400_000;

export class CrconParseError extends Error {}

const isSteamId64 = (v: string): boolean => /^\d{17}$/.test(v);
const text = (v: unknown, max = 200): string =>
	typeof v === 'string' || typeof v === 'number' ? String(v).trim().slice(0, max) : '';

// ---- CSV --------------------------------------------------------------------------------------

/**
 * RFC 4180 rows: quoted fields may hold commas, newlines and doubled quotes. Semicolon and tab
 * files (what a spreadsheet in a European locale saves) are read too, by sniffing the header.
 */
export function parseCsvRows(input: string): string[][] {
	const head = input.slice(0, input.indexOf('\n') + 1 || input.length);
	const delim = head.includes('\t')
		? '\t'
		: (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0)
			? ';'
			: ',';
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let started = false;
	const endField = () => {
		row.push(field);
		field = '';
		started = false;
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
	};
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (quoted) {
			if (c === '"') {
				if (input[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"' && !started) {
			quoted = true;
			started = true;
		} else if (c === delim) endField();
		else if (c === '\r') continue;
		else if (c === '\n') endRow();
		else {
			field += c;
			started = true;
		}
	}
	if (field || row.length) endRow();
	// A trailing newline leaves one empty row behind; so do blank lines mid-file.
	return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** CSV to objects keyed by the header row, normalised the way the JSON keys are. */
function csvObjects(input: string): Record<string, unknown>[] {
	const rows = parseCsvRows(input);
	if (rows.length < 2) return [];
	const header = rows[0].map((h) => h.trim());
	return rows.slice(1).map((r) => {
		const o: Record<string, unknown> = {};
		header.forEach((h, i) => (o[h] = r[i] ?? ''));
		return o;
	});
}

// ---- locating the records ----------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The record array, wherever this particular file put it: a bare array, `{records}`, CRCON's
 * `{result: …}` envelope around either, or `{result: {records}}` from `get_blacklist`.
 */
function findRecords(root: unknown): unknown[] {
	const seen = new Set<unknown>();
	const walk = (node: unknown, depth: number): unknown[] | null => {
		if (depth > 6 || node === null || typeof node !== 'object') return null;
		if (seen.has(node)) return null;
		seen.add(node);
		if (Array.isArray(node)) return node.some(isObj) || node.length === 0 ? node : null;
		const o = node as Record<string, unknown>;
		// A CRCON error answer is worth naming rather than reporting as "no records".
		if (o.failed === true && typeof o.error === 'string' && o.error)
			throw new CrconParseError(`CRCON reported an error in this file: ${text(o.error, 200)}`);
		for (const key of ['records', 'result', 'blacklists', 'data']) {
			const found = key in o ? walk(o[key], depth + 1) : null;
			if (found) return found;
		}
		return null;
	};
	const found = walk(root, 0);
	if (!found)
		throw new CrconParseError(
			'No blacklist records found in this file. Export one with CRCON’s get_blacklist_records or get_blacklist endpoint.'
		);
	return found;
}

// ---- one record --------------------------------------------------------------------------------

const pick = (o: Record<string, unknown>, keys: string[], max = 200): string => {
	for (const k of keys) {
		const v = text(o[k], max);
		if (v) return v;
	}
	return '';
};

/** CRCON's player object carries the name history, newest first. */
function playerName(o: Record<string, unknown>): string {
	const player = isObj(o.player) ? o.player : null;
	const names = player && Array.isArray(player.names) ? player.names : null;
	if (names?.length) {
		for (const n of names) {
			const v = isObj(n) ? text(n.name, 60) : text(n, 60);
			if (v) return v;
		}
	}
	return pick(o, ['player_name', 'playerName', 'name'], 60);
}

function playerId(o: Record<string, unknown>): string {
	const direct = pick(
		o,
		['player_id', 'playerId', 'steam_id_64', 'steam_id', 'steamId', 'steamID64'],
		40
	);
	if (direct) return direct;
	const player = isObj(o.player) ? o.player : null;
	return player ? pick(player, ['player_id', 'playerId', 'steam_id_64', 'steam_id'], 40) : '';
}

/** An ISO timestamp from CRCON (orjson writes RFC 3339), or null when absent or unreadable. */
function when(v: unknown): Date | null {
	const s = text(v, 40);
	if (!s || s.toLowerCase() === 'none' || s.toLowerCase() === 'null') return null;
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** An explicit "no" — a JSON false, or the text a CSV writes for one. Absent is not a no. */
const saysNo = (v: unknown): boolean =>
	v === false || (typeof v === 'string' && ['false', '0', 'no'].includes(v.trim().toLowerCase()));

/**
 * CRCON reasons are templates: it stores "Banned until {banned_until}" and expands the variables
 * when it shows or sends the reason. We expand the ones we know from the record itself, and drop
 * any leftover placeholder rather than carry `{seed}`-style braces onto a game server.
 */
export function expandReason(
	reason: string,
	vars: {
		name: string;
		steamId: string;
		createdAt: Date | null;
		expiresAt: Date | null;
		adminName: string;
		blacklist: string;
	}
): string {
	const stamp = (d: Date | null, forever: string) =>
		d ? d.toISOString().slice(0, 16).replace('T', ' ') : forever;
	const table: Record<string, string> = {
		player_name: vars.name,
		player_id: vars.steamId,
		banned_at: stamp(vars.createdAt, ''),
		banned_until: stamp(vars.expiresAt, 'forever'),
		expires_at: stamp(vars.expiresAt, 'never'),
		expires: vars.expiresAt ? stamp(vars.expiresAt, 'never') : 'never',
		duration: vars.expiresAt ? '' : 'forever',
		admin_name: vars.adminName,
		blacklist_name: vars.blacklist
	};
	return reason
		.replace(/\{(\w+)\}/g, (whole, key: string) => (key in table ? table[key] : whole))
		.replace(/\{\w*\}/g, '')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

// ---- the reader ---------------------------------------------------------------------------------

/**
 * Reads a CRCON export into the records an org could adopt.
 *
 * Records are dropped, with a reason, when they have no player ID, when the ID is not a SteamID64
 * (CRCON also tracks Windows Store players, whom Warcon's lists cannot address), or when the ban
 * has already expired — importing a lapsed ban would only ban someone CRCON had let back in.
 * A player appearing on several blacklists is merged into the longest of their bans, which is the
 * one CRCON itself would have enforced.
 */
export function parseCrconExport(input: string, now: Date = new Date()): CrconParse {
	if (input.length > MAX_EXPORT_BYTES)
		throw new CrconParseError(
			`That file is too large (limit ${Math.floor(MAX_EXPORT_BYTES / 1_000_000)} MB). Export one blacklist at a time.`
		);
	const trimmed = input.trim();
	if (!trimmed) throw new CrconParseError('That file is empty.');

	let raw: unknown[];
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		let root: unknown;
		try {
			root = JSON.parse(trimmed);
		} catch {
			throw new CrconParseError(
				'That file is not valid JSON. Save CRCON’s answer exactly as it came.'
			);
		}
		raw = findRecords(root);
	} else if (/player_id|steam_id/i.test(trimmed.slice(0, 500))) {
		raw = csvObjects(trimmed);
	} else {
		throw new CrconParseError(
			'Unrecognised file. Expected JSON from CRCON’s get_blacklist_records or get_blacklist endpoint, or a CSV with a player_id column.'
		);
	}
	if (raw.length > MAX_RECORDS)
		throw new CrconParseError(
			`That file holds ${raw.length} records; the limit is ${MAX_RECORDS} per import. Export it in pages.`
		);

	const skipped: CrconSkip[] = [];
	const byPlayer = new Map<string, CrconRecord>();
	const blacklists = new Set<string>();
	const permanentAfter = now.getTime() + PERMANENT_AFTER_MS;
	let total = 0;

	for (const item of raw) {
		if (!isObj(item)) continue;
		total++;
		const id = playerId(item);
		const name = playerName(item);
		if (!id) {
			skipped.push({ playerId: '', name, reason: 'no player ID in the record' });
			continue;
		}
		if (!isSteamId64(id)) {
			skipped.push({
				playerId: id,
				name,
				reason: 'not a SteamID64 (Warcon lists cannot address Windows Store players)'
			});
			continue;
		}
		const created = when(item.created_at ?? item.createdAt);
		const expiryRaw = when(item.expires_at ?? item.expiresAt);
		// A date past the far horizon is CRCON's way of writing "permanent".
		const expires = expiryRaw && expiryRaw.getTime() > permanentAfter ? null : expiryRaw;
		// CRCON's is_active is "not expired", so either signal means the ban has already lapsed.
		// A record only carries the flag when the file has the column, and absent is not a no.
		if (
			saysNo(item.is_active ?? item.isActive) ||
			(expires && expires.getTime() <= now.getTime())
		) {
			skipped.push({ playerId: id, name, reason: 'the ban has already expired' });
			continue;
		}
		const blacklist = isObj(item.blacklist)
			? text(item.blacklist.name, 60)
			: pick(item, ['blacklist_name', 'blacklistName'], 60);
		if (blacklist) blacklists.add(blacklist);
		const adminName = pick(item, ['admin_name', 'adminName', 'by'], 60);
		const record: CrconRecord = {
			steamId: id,
			name,
			reason: expandReason(pick(item, ['reason'], 400), {
				name,
				steamId: id,
				createdAt: created,
				expiresAt: expires,
				adminName,
				blacklist
			}).slice(0, 200),
			adminName,
			createdAt: created ? created.toISOString() : null,
			expiresAt: expires ? expires.toISOString() : null,
			blacklist
		};
		const seen = byPlayer.get(id);
		// The longest ban wins: permanent beats dated, later beats earlier.
		if (!seen) byPlayer.set(id, record);
		else if (seen.expiresAt && (!record.expiresAt || record.expiresAt > seen.expiresAt))
			byPlayer.set(id, record);
	}

	if (!total) throw new CrconParseError('That file holds no blacklist records.');

	const records = [...byPlayer.values()].sort(
		(a, b) =>
			(b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.steamId.localeCompare(b.steamId)
	);
	return { records, skipped, total, blacklists: [...blacklists].sort() };
}
