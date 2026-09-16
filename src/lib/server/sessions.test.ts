import { describe, expect, test } from 'bun:test';
import {
	advancePresence,
	diffPresence,
	newPresence,
	resolvePending,
	type OpenSession,
	type PendingStats
} from './sessions';
import type { Player } from '$lib/types';

const player = (steamId: string, name = steamId): Player => ({
	name,
	steamId,
	faction: null,
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: null
});
const open = (steamId: string): OpenSession => ({
	id: Number(steamId.slice(-3)),
	steamId,
	name: steamId,
	faction: null,
	kills: 0,
	deaths: 0,
	cash: 0,
	rawKills: 0,
	rawDeaths: 0,
	pending: [],
	joinedAt: 1000,
	lastSeen: 2000,
	writtenAt: 2000,
	firstVisit: false,
	lastFaction: null
});

describe('advancePresence', () => {
	const adv = (matchId: number | null, fresh = false) => ({ matchId, fresh, baselines: new Map() });
	test('kills and deaths accumulate as increments over the previous reading', () => {
		const p = newPresence();
		const s = { ...open('76561198100000001'), kills: 10, deaths: 4, rawKills: 10, rawDeaths: 4 };
		p.open.set(s.steamId, s);
		const d = diffPresence(p, [{ ...player(s.steamId), kills: 13, deaths: 5 }]);
		advancePresence(d, 3000, adv(7));
		expect([s.kills, s.deaths, s.rawKills, s.rawDeaths]).toEqual([13, 5, 13, 5]);
		expect(s.pending).toEqual([{ matchId: 7, kills: 3, deaths: 1 }]);
	});
	test('a reset counter (the game restarted the match, or a reconnect) counts from zero', () => {
		const p = newPresence();
		const s = { ...open('76561198100000001'), kills: 40, rawKills: 40 };
		p.open.set(s.steamId, s);
		advancePresence(diffPresence(p, [{ ...player(s.steamId), kills: 2 }]), 3000, adv(8));
		expect(s.kills).toBe(42);
		expect(s.pending).toEqual([{ matchId: 8, kills: 2, deaths: 0 }]);
	});
	test('the sample that begins a match takes every reading in full and banks it against the new match', () => {
		const p = newPresence();
		const s = { ...open('76561198100000001'), kills: 40, rawKills: 40 };
		p.open.set(s.steamId, s);
		// counters reset to 0 and this player already got 3 kills, more than a delta could see
		advancePresence(diffPresence(p, [{ ...player(s.steamId), kills: 3 }]), 3000, adv(null, true));
		advancePresence(diffPresence(p, [{ ...player(s.steamId), kills: 4 }]), 4000, adv(null));
		expect(s.kills).toBe(44);
		expect(s.pending).toEqual([{ matchId: null, kills: 4, deaths: 0 }]);
		resolvePending(p, 9);
		expect(s.pending).toEqual([{ matchId: 9, kills: 4, deaths: 0 }]);
	});
	test('increments for different matches stay apart until they are written', () => {
		const p = newPresence();
		const s = {
			...open('76561198100000001'),
			pending: [{ matchId: 7, kills: 5, deaths: 1 }] as PendingStats[]
		};
		p.open.set(s.steamId, s);
		advancePresence(diffPresence(p, [{ ...player(s.steamId), kills: 2 }]), 3000, adv(null, true));
		expect(s.pending).toEqual([
			{ matchId: 7, kills: 5, deaths: 1 },
			{ matchId: null, kills: 2, deaths: 0 }
		]);
	});
	test('nothing is banked when nothing happened', () => {
		const p = newPresence();
		const s = { ...open('76561198100000001'), kills: 3, rawKills: 3 };
		p.open.set(s.steamId, s);
		advancePresence(diffPresence(p, [{ ...player(s.steamId), kills: 3 }]), 3000, adv(7));
		expect(s.pending).toEqual([]);
	});
});

describe('diffPresence', () => {
	test('splits the observed list into joined, stayed and left', () => {
		const p = newPresence();
		for (const id of ['76561198100000001', '76561198100000002']) p.open.set(id, open(id));
		const d = diffPresence(p, [player('76561198100000002'), player('76561198100000003')]);
		expect(d.joined.map((x) => x.steamId)).toEqual(['76561198100000003']);
		expect(d.stayed.map((x) => x.session.steamId)).toEqual(['76561198100000002']);
		expect(d.left.map((x) => x.steamId)).toEqual(['76561198100000001']);
	});

	test('ignores duplicates and players without a SteamID', () => {
		const p = newPresence();
		const d = diffPresence(p, [
			player('76561198100000009'),
			player('76561198100000009'),
			player('')
		]);
		expect(d.joined).toHaveLength(1);
		expect(d.stayed).toHaveLength(0);
	});

	test('reports players who have just picked or changed faction', () => {
		const p = newPresence();
		p.open.set('76561198100000001', open('76561198100000001'));
		p.open.set('76561198100000002', {
			...open('76561198100000002'),
			faction: 'Valkyra',
			lastFaction: 'Valkyra'
		});
		const d = diffPresence(p, [
			{ ...player('76561198100000001'), faction: 'Valkyra' },
			{ ...player('76561198100000002'), faction: 'Kessler' },
			{ ...player('76561198100000003'), faction: 'Valkyra' }
		]);
		expect(d.factioned.map((x) => [x.player.steamId, x.from])).toEqual([
			['76561198100000001', null],
			['76561198100000002', 'Valkyra']
		]);
		expect(d.joined.map((x) => x.steamId)).toEqual(['76561198100000003']);
	});

	test('a side cleared at match start and picked again is not a new pick', () => {
		const p = newPresence();
		p.open.set('76561198100000001', {
			...open('76561198100000001'),
			faction: null,
			lastFaction: 'Valkyra'
		});
		p.open.set('76561198100000002', {
			...open('76561198100000002'),
			faction: null,
			lastFaction: 'Valkyra'
		});
		const d = diffPresence(p, [
			{ ...player('76561198100000001'), faction: 'Valkyra' },
			{ ...player('76561198100000002'), faction: 'Kessler' }
		]);
		expect(d.factioned.map((x) => [x.player.steamId, x.from])).toEqual([
			['76561198100000002', 'Valkyra']
		]);
	});

	test('an empty list means everyone left', () => {
		const p = newPresence();
		p.open.set('76561198100000001', open('76561198100000001'));
		const d = diffPresence(p, []);
		expect(d.left).toHaveLength(1);
		expect(d.joined).toHaveLength(0);
	});
});
