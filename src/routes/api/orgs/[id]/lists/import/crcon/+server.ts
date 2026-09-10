import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { importCrconRecords } from '$lib/server/lists';

/**
 * Adopt records from a CRCON export into the org ban list. Owners only, like the other import:
 * it puts the panel in charge of bans it will later be expected to lift.
 */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireListsRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	return apiJson({
		ok: true,
		...(await importCrconRecords(env, event.request, user, org, body.records))
	});
});
