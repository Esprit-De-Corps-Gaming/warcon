import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { previewCrconImport } from '$lib/server/lists';

/**
 * What a Community RCON (hll_rcon_tool) blacklist export would add to the org ban list. Reads the
 * uploaded text and writes nothing, so an editor may look even though only an owner can import.
 */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org } = await requireListsRole(env, event.locals, param(event, 'id'));
	const body = await readJson(event.request);
	return apiJson({ ok: true, preview: await previewCrconImport(env, org, body.file) });
});
