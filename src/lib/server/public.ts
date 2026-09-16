// The public face of a server: pages and JSON anyone can open without an account, when the site
// owner allows it for the organisation and an org owner switched it on for the server. The status
// view reads the worker's live snapshot (server_live), never the game server directly, so a crowd
// of viewers costs the listener nothing; it is cached briefly and the JSON is rate limited. The
// stored error names the RCON host and port, so it is never served here.
import { eq } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, clientIp } from './http';
import { assertRate } from './ratelimit';
import { effectiveFeatures, type FeatureKey, type Features } from './features';
import { organizations, servers, type OrgRow, type ServerRow } from './db/schema';
import { readLiveRows } from './live';
import { careerFor, loadLeaderboard } from './career';
import { cashByFaction } from '$lib/cash';
import type {
	CareerRange,
	CareerView,
	LeaderboardSort,
	LeaderboardView,
	Player,
	PublicStatusView
} from '$lib/types';

export interface PublicTarget {
	server: ServerRow;
	org: OrgRow;
	features: Features;
}

/** The server with its org and effective features; null when there is no such server. */
export async function publicTarget(env: Env, serverId: string): Promise<PublicTarget | null> {
	if (!serverId || serverId.length > 64) return null;
	const [row] = await env.db
		.select({ server: servers, org: organizations })
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.where(eq(servers.id, serverId))
		.limit(1);
	if (!row || row.org.suspendedAt) return null;
	return { server: row.server, org: row.org, features: effectiveFeatures(row.org, row.server) };
}

/** 404 (never 403: a closed page should look like no page) unless the feature is on. */
export function requirePublic(t: PublicTarget | null, key: FeatureKey): PublicTarget {
	if (!t || !t.features[key]) throw new ApiError(404, 'Not found.', 'not_found');
	return t;
}

/** Public JSON is unauthenticated: a modest per-address budget keeps a scraper from hurting the database. */
export const publicRate = (req: Request): void =>
	assertRate(`public:${clientIp(req) || 'unknown'}`, 120, 60_000);

// ---- status -------------------------------------------------------------------------------------

const STATUS_TTL_MS = 5_000;
const statusCache = new Map<string, { until: number; view: PublicStatusView }>();

export async function publicStatus(env: Env, t: PublicTarget): Promise<PublicStatusView> {
	const hit = statusCache.get(t.server.id);
	if (hit && hit.until > Date.now()) return hit.view;
	const view = await buildStatus(env, t);
	statusCache.set(t.server.id, { until: Date.now() + STATUS_TTL_MS, view });
	return view;
}

async function buildStatus(env: Env, t: PublicTarget): Promise<PublicStatusView> {
	const live = (await readLiveRows(env, [t.server.id])).get(t.server.id) ?? null;
	const status = live?.status ?? null;
	// The connected players, ranked by kills: the current match's live scoreboard.
	const players = [...((live?.players as Player[] | undefined) ?? [])]
		.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.name.localeCompare(b.name))
		.slice(0, 100)
		.map((p) => ({
			steamId: p.steamId,
			name: p.name,
			faction: p.faction,
			kills: p.kills,
			deaths: p.deaths
		}));
	// Cash per faction, summed over connected players ('' = unassigned), as the dashboard shows it.
	const cash = status
		? cashByFaction(status, (live?.players as Player[] | undefined) ?? []).map((c) => ({
				name: c.name,
				cash: c.cash
			}))
		: [];
	return {
		server: { id: t.server.id, name: t.server.name },
		org: { name: t.org.name, slug: t.org.slug, discordUrl: t.org.discordUrl },
		features: { publicStats: t.features.publicStats, stats: t.features.stats },
		generatedAt: new Date().toISOString(),
		observedAt: live?.observedAt ?? null,
		reachable: !!live?.ok,
		// Never the stored error: it names the RCON host and port, and this view is public.
		error: live?.ok
			? ''
			: live
				? 'The panel could not reach the game server.'
				: 'Not observed yet.',
		startedAt: live?.startedAt ?? null,
		map: status?.map ?? null,
		experiences: status?.experiences ?? [],
		lighting: status?.lighting ?? null,
		matchSeconds: status?.matchSeconds ?? null,
		playerCount: status?.playerCount ?? players.length,
		maxPlayers: status?.maxPlayers ?? 0,
		scores: status ? status.scores.map((s) => ({ name: s.name, score: s.score })) : [],
		cash,
		players
	};
}

/** Test-only. */
export const resetPublicCache = (): void => statusCache.clear();

// ---- leaderboards and careers -------------------------------------------------------------------

/** Every server of the org whose public stats are on (both levels), for an org-wide board. */
export async function publicStatsServers(
	env: Env,
	t: PublicTarget
): Promise<{ id: string; name: string }[]> {
	const rows = await env.db
		.select()
		.from(servers)
		.where(eq(servers.orgId, t.org.id))
		.orderBy(servers.sortOrder, servers.name);
	return rows
		.filter((s) => effectiveFeatures(t.org, s).publicStats)
		.map((s) => ({ id: s.id, name: s.name }));
}

export async function publicLeaderboard(
	env: Env,
	t: PublicTarget,
	opts: { scope: 'server' | 'org'; range: CareerRange; sort: LeaderboardSort; minMinutes: number }
): Promise<LeaderboardView> {
	const list =
		opts.scope === 'org'
			? await publicStatsServers(env, t)
			: [{ id: t.server.id, name: t.server.name }];
	return loadLeaderboard(env, list, opts);
}

/** A player's career over the org's public servers, plus the name they last used there. */
export async function publicCareer(
	env: Env,
	t: PublicTarget,
	steamId: string
): Promise<{ name: string; career: CareerView; servers: { id: string; name: string }[] }> {
	const list = await publicStatsServers(env, t);
	const career = await careerFor(env, list, steamId);
	const name = career.recent[0]?.matchId
		? ((await latestName(
				env,
				list.map((s) => s.id),
				steamId
			)) ?? steamId)
		: steamId;
	return { name, career, servers: list };
}

async function latestName(env: Env, ids: string[], steamId: string): Promise<string | null> {
	if (!ids.length) return null;
	const { sql } = await import('drizzle-orm');
	const [row] = await env.db.execute<{ name: string }>(sql`
		SELECT name FROM player_match_stats WHERE steam_id = ${steamId} AND server_id IN ${ids}
		 ORDER BY last_seen DESC LIMIT 1`);
	return row?.name ?? null;
}
