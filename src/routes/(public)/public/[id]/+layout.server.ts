import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { publicTarget } from '$lib/server/public';

/** Any public page of a server needs at least one of its public features on; otherwise the URL is a 404. */
export const load: LayoutServerLoad = async ({ params }) => {
	const env = getEnv();
	const t = await publicTarget(env, params.id);
	if (!t || (!t.features.publicStatus && !t.features.publicStats)) error(404, 'Not found.');
	return {
		publicServer: {
			id: t.server.id,
			name: t.server.name,
			/** the join page exists when the status page is on and a join code is set */
			join: t.features.publicStatus && !!t.server.joinCode
		},
		publicOrg: { name: t.org.name, slug: t.org.slug, discordUrl: t.org.discordUrl },
		features: t.features
	};
};
