// How a Discord status card looks; picked per webhook, built by webhook-status-core.ts.
export const STATUS_STYLES = ['banner', 'compact', 'scoreboard'] as const;
export type StatusStyle = (typeof STATUS_STYLES)[number];

export const STATUS_STYLE_LABELS: Record<StatusStyle, string> = {
	banner: 'Banner: map art, a column of players per faction',
	compact: 'Compact: map thumbnail, faction counts and the top three',
	scoreboard: 'Scoreboard: ranked table of everyone across the factions'
};

export const isStatusStyle = (v: unknown): v is StatusStyle =>
	typeof v === 'string' && (STATUS_STYLES as readonly string[]).includes(v);

// How often a card is re-edited: the owner picks, Discord's ~30 req/min sets the floor.
export const MIN_STATUS_INTERVAL = 30;
export const MAX_STATUS_INTERVAL = 300;
export const DEFAULT_STATUS_INTERVAL = 60;
/** The choices the Discord tab offers, in seconds. */
export const STATUS_INTERVALS = [30, 60, 120, 300] as const;
export const STATUS_INTERVAL_LABELS: Record<number, string> = {
	30: 'Every 30 seconds',
	60: 'Every minute',
	120: 'Every 2 minutes',
	300: 'Every 5 minutes'
};

/** A refresh interval clamped to the allowed range; a bad value falls back to the default. */
export const clampStatusInterval = (s: unknown): number => {
	const n = Math.round(Number(s));
	if (!Number.isFinite(n)) return DEFAULT_STATUS_INTERVAL;
	return Math.min(MAX_STATUS_INTERVAL, Math.max(MIN_STATUS_INTERVAL, n));
};
