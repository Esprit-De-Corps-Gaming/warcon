// The address players connect to (not the RCON listener), and the Steam URIs a join page can try.
// Whether WARDOGS honours any of them is undocumented; the page offers each so it can be tested
// in game, and a plain launch with the address to copy as the fallback. Pure.

export const WARDOGS_APP_ID = 1867240;

const HOST =
	/^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/i;

/** `host:port` with a public-looking host and a real port; blank clears. */
export function validateJoinAddress(raw: unknown): string {
	const text = String(raw ?? '').trim();
	if (!text) return '';
	const m = /^(.+):(\d{1,5})$/.exec(text);
	const host = m?.[1].toLowerCase() ?? '';
	const port = m ? Number(m[2]) : 0;
	if (!m || !HOST.test(host) || port < 1 || port > 65535)
		throw new Error('The game address must be host:port, e.g. 203.0.113.7:9025.');
	return `${host}:${port}`;
}

export interface SteamJoin {
	/** Steam's server-browser connect; works for games that register with Steam's browser */
	connect: string;
	/** launch the game with +connect, for games that parse the launch line */
	run: string;
	/** just launch the game; the address is shown to type into the browser */
	launch: string;
}

export function steamJoinLinks(address: string, appId = WARDOGS_APP_ID): SteamJoin {
	return {
		connect: `steam://connect/${address}`,
		run: `steam://run/${appId}//+connect%20${encodeURIComponent(address)}/`,
		launch: `steam://rungameid/${appId}`
	};
}
