<script lang="ts">
	// Importing an organisation's ban list out of Community RCON (hll_rcon_tool).
	//
	// CRCON has no export button, so the operator saves what its API returned and drops the file
	// here. The panel reads it, shows exactly what it found — including what it had to leave out
	// and why — and only writes once the owner picks. Parsing lives on the server (crcon.ts) so
	// one reader serves the API and the panel alike.
	import { invalidateAll } from '$app/navigation';
	import { api, errorMessage } from '$lib/api';
	import { fmtTime } from '$lib/format';
	import { describeSync } from '$lib/lists';
	import { toast } from '$lib/toast.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import type { CrconImportPreview, ListSyncSummary } from '$lib/types';

	let { org, onclose }: { org: { id: string; name: string }; onclose: () => void } = $props();

	let preview = $state<CrconImportPreview | null>(null);
	let picked = $state<Record<string, boolean>>({});
	let busy = $state(false);
	let fileName = $state('');
	let pasted = $state('');
	let showSkipped = $state(false);

	let importable = $derived((preview?.records ?? []).filter((r) => !r.duplicate));
	let chosen = $derived(importable.filter((r) => picked[r.steamId]));
	let base = $derived(`/api/orgs/${encodeURIComponent(org.id)}/lists/import/crcon`);

	async function read(text: string, name: string) {
		if (!text.trim()) return;
		busy = true;
		try {
			const res = await api<{ preview: CrconImportPreview }>('POST', `${base}/preview`, {
				file: text
			});
			preview = res.preview;
			fileName = name;
			// Everything importable is ticked; duplicates are not offered at all.
			const next: Record<string, boolean> = {};
			for (const r of res.preview.records) if (!r.duplicate) next[r.steamId] = true;
			picked = next;
		} catch (err) {
			preview = null;
			toast(errorMessage(err), 'err', 9000);
		} finally {
			busy = false;
		}
	}

	async function onpick(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await read(await file.text(), file.name);
		input.value = '';
	}

	async function run() {
		if (!chosen.length) return;
		busy = true;
		try {
			const res = await api<{ imported: number; skipped: number; sync: ListSyncSummary }>(
				'POST',
				base,
				{
					records: chosen.map((r) => ({
						steamId: r.steamId,
						reason: r.reason,
						expiresAt: r.expiresAt
					}))
				}
			);
			toast(
				describeSync(
					res.sync,
					`Imported ${res.imported} ban${res.imported === 1 ? '' : 's'} from CRCON.`
				),
				'ok',
				8000
			);
			await invalidateAll();
			onclose();
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			busy = false;
		}
	}
</script>

<Modal title="Import bans from Community RCON" wide {onclose}>
	{#if !preview}
		<p class="mb-3 text-[13px] text-mist-400">
			CRCON has no export button, so ask it for the blacklist and save the answer. With an API key
			that may view blacklists:
		</p>
		<pre
			class="mb-3 overflow-x-auto rounded-ctl border border-black bg-ink-950 p-3 font-mono text-[12px] text-mist-300">curl -H "Authorization: Bearer $CRCON_API_KEY" \
  "https://your-crcon/api/get_blacklist_records?blacklist_id=0&page_size=1000" \
  &gt; bans.json</pre>
		<p class="mb-3 text-[13px] text-mist-400">
			Then upload <code class="font-mono">bans.json</code> below. The answer from
			<code class="font-mono">get_blacklist</code>, a bare list of records, or a CSV with a
			<code class="font-mono">player_id</code> column all work too. Nothing is written until you review
			what the file holds.
		</p>
		<label class="block">
			<span class="field-label">Export file</span>
			<input
				class="input"
				type="file"
				accept=".json,.csv,.txt,application/json,text/csv,text/plain"
				disabled={busy}
				onchange={onpick}
			/>
		</label>
		<details class="mt-3">
			<summary class="cursor-pointer text-[13px] text-mist-400">Or paste the JSON</summary>
			<textarea
				class="mt-2 h-32 input font-mono text-[12px]"
				placeholder={'{"result": {"records": [ … ]}}'}
				bind:value={pasted}></textarea>
			<button
				class="mt-2 btn btn-sm"
				disabled={busy || !pasted.trim()}
				onclick={() => read(pasted, 'pasted text')}>Read it</button
			>
		</details>
	{:else}
		<div class="callout mb-3">
			<b>{fileName}</b>: {preview.total} record{preview.total === 1 ? '' : 's'},
			{importable.length} importable{#if preview.records.length - importable.length > 0}, {preview
					.records.length - importable.length} already on the list{/if}{#if preview.skipped.length},
				{preview.skipped.length} skipped{/if}.
			{#if preview.blacklists.length}
				<span class="block text-mist-400"
					>From {preview.blacklists.length === 1 ? 'blacklist' : 'blacklists'}
					{preview.blacklists.join(', ')}.</span
				>
			{/if}
			<span class="block text-mist-400"
				>Importing puts these on {org.name}'s ban list and applies them to every one of its servers.
				Removing one later lifts it everywhere the panel applied it.</span
			>
		</div>

		{#if preview.skipped.length}
			<div class="mb-3">
				<button class="btn btn-sm" onclick={() => (showSkipped = !showSkipped)}
					>{showSkipped ? 'Hide' : 'Show'} {preview.skipped.length} skipped</button
				>
				{#if showSkipped}
					<ul class="mt-2 max-h-40 overflow-y-auto text-[12.5px] text-mist-400">
						{#each preview.skipped as s, i (`${s.playerId}:${i}`)}
							<li>
								<span class="font-mono">{s.playerId || '—'}</span>
								{#if s.name}<span class="text-mist-300">{s.name}</span>{/if}
								— {s.reason}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		<div class="max-h-[50vh] table-wrap overflow-y-auto">
			<table>
				<thead>
					<tr>
						<th></th>
						<th>Player</th>
						<th>Reason</th>
						<th>By</th>
						<th>Banned</th>
						<th>Expires</th>
					</tr>
				</thead>
				<tbody>
					{#each preview.records as r (r.steamId)}
						<tr class={r.duplicate ? 'text-mist-600' : ''}>
							<td>
								{#if r.duplicate}
									<Badge>on list</Badge>
								{:else}
									<input type="checkbox" bind:checked={picked[r.steamId]} />
								{/if}
							</td>
							<td>
								<span class="font-medium">{r.name || r.steamId}</span>
								{#if r.name}<div class="font-mono text-[12px] text-mist-600">{r.steamId}</div>{/if}
							</td>
							<td class="max-w-[280px] text-[12.5px]"
								>{#if r.reason}{r.reason}{:else}<span class="text-mist-600">—</span>{/if}</td
							>
							<td class="text-[12.5px]">{r.adminName || '—'}</td>
							<td class="text-[12.5px] whitespace-nowrap text-mist-400"
								>{r.createdAt ? fmtTime(r.createdAt) : '—'}</td
							>
							<td class="text-[12.5px] whitespace-nowrap">
								{#if r.expiresAt}{fmtTime(r.expiresAt)}{:else}<span class="text-mist-600"
										>never</span
									>{/if}
							</td>
						</tr>
					{:else}
						<tr
							><td colspan="6" class="py-6 text-center text-mist-600"
								>The file held no bans Warcon can import.</td
							></tr
						>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#snippet actions()}
		{#if preview}
			<button
				type="button"
				class="mr-auto btn"
				disabled={!importable.length}
				onclick={() => {
					const all = importable.every((r) => picked[r.steamId]);
					const next: Record<string, boolean> = {};
					for (const r of importable) next[r.steamId] = !all;
					picked = next;
				}}
				>{importable.length && importable.every((r) => picked[r.steamId])
					? 'Select none'
					: 'Select all'}</button
			>
			<button type="button" class="btn" onclick={() => (preview = null)}>Choose another file</button
			>
			<button type="button" class="btn btn-primary" disabled={busy || !chosen.length} onclick={run}
				>Import {chosen.length}</button
			>
		{:else}
			<button type="button" class="btn" data-close onclick={onclose}>Cancel</button>
		{/if}
	{/snippet}
</Modal>
