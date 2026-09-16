import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { publicTarget } from '$lib/server/public';
import { steamJoinLinks } from '$lib/server/join';

/** The join page: on with the status page, and only once an org owner set the game address. */
export const load: PageServerLoad = async ({ params }) => {
	const env = getEnv();
	const t = await publicTarget(env, params.id);
	if (!t || !t.features.publicStatus || !t.server.joinAddress) error(404, 'Not found.');
	return { address: t.server.joinAddress, steam: steamJoinLinks(t.server.joinAddress) };
};
