// Player presence per server, kept in the worker's memory and written to player_sessions in
// batches: a row on join, left_at on leave (with the exact last time the player was seen), and a
// heartbeat every sessionHeartbeatMs that refreshes last_seen and the stats of everyone still on.
// A 2-second observation cadence must not mean a database write per player per observation.
//
// Kills and deaths are read as increments over the previous reading (see match-track.ts): the
// game's counters start over with every match and every reconnect, so a session that spans two
// matches keeps both, and the increments are banked per match and flushed into
// player_match_stats with the same writes.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { playerMatchStats, playerSessions } from './db/schema';
import { baselineAfterGap, counterDelta } from './match-track';
import type { Player } from '$lib/types';

/** Increments not yet written to player_match_stats; `matchId` null is the match this sample began, resolved once its row exists. */
export interface PendingStats {
	matchId: number | null;
	kills: number;
	deaths: number;
}

export interface OpenSession {
	id: number;
	steamId: string;
	name: string;
	faction: string | null;
	/** accumulated over the session: the game's counters reset every match, these do not */
	kills: number;
	deaths: number;
	cash: number;
	/** the counters as the game last reported them: the baseline for the next increment */
	rawKills: number;
	rawDeaths: number;
	pending: PendingStats[];
	joinedAt: number;
	lastSeen: number;
	/** what the database currently holds for last_seen */
	writtenAt: number;
	/** this is the player's first session on this server (false when unknown: sessions reloaded
	 *  after a restart, or opened quietly when joins were not trusted) */
	firstVisit: boolean;
	/** the last faction seen this session; unlike `faction` it survives the game clearing everyone's
	 *  side at a match start, so a re-pick of the same side is not a new pick */
	lastFaction: string | null;
}

export interface Presence {
	loaded: boolean;
	open: Map<string, OpenSession>;
	heartbeatAt: number;
}

export const newPresence = (): Presence => ({ loaded: false, open: new Map(), heartbeatAt: 0 });

/** Loads the sessions the database still has open for this server (once per process per server). */
export async function loadPresence(
	db: DbOrTx,
	serverId: string,
	presence: Presence
): Promise<void> {
	const rows = await db
		.select()
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)));
	presence.open.clear();
	for (const r of rows)
		presence.open.set(r.steamId, {
			id: r.id,
			steamId: r.steamId,
			name: r.name,
			faction: r.faction,
			kills: r.kills,
			deaths: r.deaths,
			cash: r.cash,
			// rows from before increments were tracked hold the last raw reading in kills/deaths
			rawKills: r.rawKills ?? r.kills,
			rawDeaths: r.rawDeaths ?? r.deaths,
			pending: [],
			joinedAt: r.joinedAt.getTime(),
			lastSeen: r.lastSeen.getTime(),
			writtenAt: r.lastSeen.getTime(),
			firstVisit: false,
			lastFaction: r.faction
		});
	presence.loaded = true;
}

export interface PresenceDiff {
	joined: Player[];
	left: OpenSession[];
	/** the players still on, with their open session */
	stayed: { player: Player; session: OpenSession }[];
	/** the players still on who are in a faction other than the last one seen this session;
	 *  `from` is that last one (null: their first pick of the session) */
	factioned: { player: Player; from: string | null }[];
}

/** Compares the observed player list with the open sessions. Pure; touches nothing. */
export function diffPresence(presence: Presence, players: Player[]): PresenceDiff {
	const seen = new Set<string>();
	const joined: Player[] = [];
	const stayed: PresenceDiff['stayed'] = [];
	const factioned: PresenceDiff['factioned'] = [];
	for (const p of players) {
		if (!p.steamId || seen.has(p.steamId)) continue;
		seen.add(p.steamId);
		const s = presence.open.get(p.steamId);
		if (s) {
			stayed.push({ player: p, session: s });
			if (p.faction && p.faction !== s.lastFaction)
				factioned.push({ player: p, from: s.lastFaction });
		} else joined.push(p);
	}
	const left = [...presence.open.values()].filter((s) => !seen.has(s.steamId));
	return { joined, left, stayed, factioned };
}

const json = (v: unknown) => sql`(${JSON.stringify(v)}::text)::jsonb`;

/** Which of these SteamIDs have never had a session on this server (a read; call before the transaction). */
export async function firstVisits(
	db: DbOrTx,
	serverId: string,
	ids: string[]
): Promise<Set<string>> {
	const out = new Set<string>();
	if (!ids.length) return out;
	const known = await db
		.selectDistinct({ steamId: playerSessions.steamId })
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), inArray(playerSessions.steamId, ids)));
	const knownIds = new Set(known.map((k) => k.steamId));
	for (const id of ids) if (!knownIds.has(id)) out.add(id);
	return out;
}

/**
 * The counter baselines for joiners who had a session that an outage closed while the running
 * match went on: their counters may have kept going, and without the last raw reading they
 * would count twice. A read; call before the transaction.
 */
export async function gapBaselines(
	db: DbOrTx,
	serverId: string,
	ids: string[],
	matchStartedAt: Date | null
): Promise<Map<string, { kills: number; deaths: number }>> {
	const out = new Map<string, { kills: number; deaths: number }>();
	if (!ids.length || !matchStartedAt) return out;
	const rows = await db.execute<{
		steamId: string;
		leftAt: Date;
		rawKills: number;
		rawDeaths: number;
	}>(sql`
		SELECT DISTINCT ON (steam_id) steam_id AS "steamId", left_at AS "leftAt",
		       COALESCE(raw_kills, kills) AS "rawKills", COALESCE(raw_deaths, deaths) AS "rawDeaths"
		  FROM player_sessions
		 WHERE server_id = ${serverId} AND steam_id IN ${ids} AND left_at IS NOT NULL
		   AND left_at >= ${matchStartedAt}
		 ORDER BY steam_id, left_at DESC`);
	for (const r of rows) {
		const leftAt = new Date(r.leftAt);
		const kills = baselineAfterGap(leftAt, r.rawKills, matchStartedAt);
		const deaths = baselineAfterGap(leftAt, r.rawDeaths, matchStartedAt);
		if (kills !== null && deaths !== null) out.set(r.steamId, { kills, deaths });
	}
	return out;
}

/** How this observation's readings turn into increments. */
export interface Advance {
	/** the match the increments belong to; null when this sample began one whose row does not exist yet */
	matchId: number | null;
	/** this sample began a match: every counter has just reset, so each reading is its own increment */
	fresh: boolean;
	/** from gapBaselines, for joiners */
	baselines: Map<string, { kills: number; deaths: number }>;
}

const bank = (s: OpenSession, matchId: number | null, kills: number, deaths: number): void => {
	if (!kills && !deaths) return;
	const p = s.pending.find((e) => e.matchId === matchId);
	if (p) {
		p.kills += kills;
		p.deaths += deaths;
	} else s.pending.push({ matchId, kills, deaths });
};

/**
 * Folds one observation into the open sessions: names, factions, cash, and kills and deaths as
 * increments over the previous reading, banked per match until the next write. Memory only.
 */
export function advancePresence(diff: PresenceDiff, now: number, adv: Advance): void {
	for (const { player: p, session: s } of diff.stayed) {
		const dk = counterDelta(p.kills, adv.fresh ? null : s.rawKills);
		const dd = counterDelta(p.deaths, adv.fresh ? null : s.rawDeaths);
		s.name = p.name;
		s.faction = p.faction;
		if (p.faction) s.lastFaction = p.faction;
		s.kills += dk;
		s.deaths += dd;
		s.rawKills = p.kills;
		s.rawDeaths = p.deaths;
		s.cash = p.cash;
		s.lastSeen = now;
		bank(s, adv.matchId, dk, dd);
	}
}

/** The match this sample began has a row now: increments banked against "the new match" belong to it. */
export function resolvePending(presence: Presence, matchId: number): void {
	for (const s of presence.open.values())
		for (const e of s.pending) if (e.matchId === null) e.matchId = matchId;
}

/**
 * Writes banked increments into player_match_stats (one row per player per match, added onto)
 * and drops them from memory. Entries for a match that has no row yet stay banked.
 */
export async function flushPending(
	db: DbOrTx,
	serverId: string,
	sessions: Iterable<OpenSession>,
	ts: Date,
	only?: number
): Promise<void> {
	const rows: {
		match_id: number;
		steam_id: string;
		name: string;
		faction: string | null;
		kills: number;
		deaths: number;
		cash: number;
	}[] = [];
	for (const s of sessions) {
		const keep: PendingStats[] = [];
		for (const e of s.pending) {
			if (e.matchId === null || (only !== undefined && e.matchId !== only)) {
				keep.push(e);
				continue;
			}
			rows.push({
				match_id: e.matchId,
				steam_id: s.steamId,
				name: s.name,
				faction: s.faction,
				kills: e.kills,
				deaths: e.deaths,
				cash: s.cash
			});
		}
		s.pending = keep;
	}
	if (!rows.length) return;
	await db.execute(sql`
		INSERT INTO player_match_stats (match_id, server_id, steam_id, name, faction, first_seen, last_seen, kills, deaths, cash)
		SELECT v.match_id, ${serverId}, v.steam_id, v.name, v.faction, ${ts}, ${ts}, v.kills, v.deaths, v.cash
		  FROM jsonb_to_recordset(${json(rows)})
		    AS v(match_id bigint, steam_id text, name text, faction text, kills int, deaths int, cash int)
		ON CONFLICT (match_id, steam_id) DO UPDATE
		   SET name = EXCLUDED.name, faction = EXCLUDED.faction, last_seen = EXCLUDED.last_seen,
		       kills = player_match_stats.kills + EXCLUDED.kills,
		       deaths = player_match_stats.deaths + EXCLUDED.deaths, cash = EXCLUDED.cash`);
}

/**
 * Applies a diff to the database and to the in-memory presence: inserts joins, closes leaves,
 * and (when the heartbeat is due) refreshes everyone else. `firstVisit` (from firstVisits, read
 * before the transaction) is remembered on the new sessions for rules that fire later on. The
 * stayed sessions were already advanced in memory (advancePresence); their banked increments go
 * to player_match_stats with the same write.
 */
export async function persistPresence(
	db: DbOrTx,
	serverId: string,
	presence: Presence,
	diff: PresenceDiff,
	ts: Date,
	heartbeatDue: boolean,
	firstVisit: Set<string> = new Set(),
	adv: Advance = { matchId: null, fresh: false, baselines: new Map() }
): Promise<void> {
	const now = ts.getTime();

	if (diff.left.length) {
		await db.execute(sql`
			UPDATE player_sessions AS s SET left_at = v.left_at, last_seen = v.left_at,
			       name = v.name, faction = v.faction, kills = v.kills, deaths = v.deaths, cash = v.cash,
			       raw_kills = v.raw_kills, raw_deaths = v.raw_deaths
			  FROM jsonb_to_recordset(${json(
					diff.left.map((s) => ({
						id: s.id,
						left_at: new Date(s.lastSeen).toISOString(),
						name: s.name,
						faction: s.faction,
						kills: s.kills,
						deaths: s.deaths,
						cash: s.cash,
						raw_kills: s.rawKills,
						raw_deaths: s.rawDeaths
					}))
				)}) AS v(id bigint, left_at timestamptz, name text, faction text, kills int, deaths int, cash int, raw_kills int, raw_deaths int)
			 WHERE s.id = v.id AND s.left_at IS NULL`);
		await flushPending(db, serverId, diff.left, ts);
		for (const s of diff.left) presence.open.delete(s.steamId);
	}

	if (diff.joined.length) {
		const first = diff.joined.map((p) => {
			const base = adv.fresh ? null : (adv.baselines.get(p.steamId) ?? null);
			return {
				p,
				kills: counterDelta(p.kills, base?.kills ?? null),
				deaths: counterDelta(p.deaths, base?.deaths ?? null)
			};
		});
		const rows = await db
			.insert(playerSessions)
			.values(
				first.map(({ p, kills, deaths }) => ({
					serverId,
					steamId: p.steamId,
					name: p.name,
					faction: p.faction,
					joinedAt: ts,
					lastSeen: ts,
					kills,
					deaths,
					cash: p.cash,
					rawKills: p.kills,
					rawDeaths: p.deaths
				}))
			)
			.returning({ id: playerSessions.id, steamId: playerSessions.steamId });
		const idOf = new Map(rows.map((r) => [r.steamId, r.id]));
		const opened: OpenSession[] = [];
		for (const { p, kills, deaths } of first) {
			const s: OpenSession = {
				id: idOf.get(p.steamId)!,
				steamId: p.steamId,
				name: p.name,
				faction: p.faction,
				kills,
				deaths,
				cash: p.cash,
				rawKills: p.kills,
				rawDeaths: p.deaths,
				pending: [],
				joinedAt: now,
				lastSeen: now,
				writtenAt: now,
				firstVisit: firstVisit.has(p.steamId),
				lastFaction: p.faction || null
			};
			bank(s, adv.matchId, kills, deaths);
			presence.open.set(p.steamId, s);
			opened.push(s);
		}
		await flushPending(db, serverId, opened, ts);
	}

	if (heartbeatDue && diff.stayed.length) {
		await db.execute(sql`
			UPDATE player_sessions AS s SET last_seen = v.last_seen,
			       name = v.name, faction = v.faction, kills = v.kills, deaths = v.deaths, cash = v.cash,
			       raw_kills = v.raw_kills, raw_deaths = v.raw_deaths
			  FROM jsonb_to_recordset(${json(
					diff.stayed.map(({ session: s }) => ({
						id: s.id,
						last_seen: new Date(s.lastSeen).toISOString(),
						name: s.name,
						faction: s.faction,
						kills: s.kills,
						deaths: s.deaths,
						cash: s.cash,
						raw_kills: s.rawKills,
						raw_deaths: s.rawDeaths
					}))
				)}) AS v(id bigint, last_seen timestamptz, name text, faction text, kills int, deaths int, cash int, raw_kills int, raw_deaths int)
			 WHERE s.id = v.id AND s.left_at IS NULL`);
		await flushPending(
			db,
			serverId,
			diff.stayed.map((x) => x.session),
			ts
		);
		for (const { session: s } of diff.stayed) s.writtenAt = now;
		presence.heartbeatAt = now;
	}
}

/** Closes every open session at the time each player was last seen (the server went away). */
export async function closeAllSessions(
	db: DbOrTx,
	serverId: string,
	presence: Presence
): Promise<number> {
	const open = [...presence.open.values()];
	if (open.length)
		await persistPresence(
			db,
			serverId,
			presence,
			{ joined: [], left: open, stayed: [], factioned: [] },
			new Date(),
			false
		);
	return open.length;
}
