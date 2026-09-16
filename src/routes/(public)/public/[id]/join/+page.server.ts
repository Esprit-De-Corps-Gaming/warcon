import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { publicTarget } from '$lib/server/public';
import { readLiveRows } from '$lib/server/live';
import { steamLaunchLink } from '$lib/server/join';

/**
 * The join page: on with the status page, and only once the worker has read a join code from the
 * build (GET /v1/server-id on CL-501228+). Older builds serve none, so there is no page.
 */
export const load: PageServerLoad = async ({ params }) => {
	const env = getEnv();
	const t = await publicTarget(env, params.id);
	if (!t || !t.features.publicStatus) error(404, 'Not found.');
	const code = (await readLiveRows(env, [t.server.id])).get(t.server.id)?.gameServerId ?? '';
	if (!code) error(404, 'Not found.');
	return { code, launch: steamLaunchLink() };
};
