<script lang="ts">
	import { toast } from '$lib/toast.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let copied = $state(false);
	async function copy() {
		try {
			await navigator.clipboard.writeText(data.address);
			copied = true;
			toast('Address copied.', 'ok');
		} catch {
			window.prompt('Copy the address:', data.address);
		}
	}
	/**
	 * Which Steam handshake WARDOGS honours is undocumented, so each is one click: the browser
	 * hands the steam:// link to Steam, and whatever the game does next is the answer.
	 */
	let OPTIONS = $derived([
		{
			href: data.steam.connect,
			label: 'Connect through Steam',
			blurb:
				'steam://connect — Steam asks the game to join this address, as for games in Steam’s server browser.'
		},
		{
			href: data.steam.run,
			label: 'Launch with +connect',
			blurb:
				'steam://run — starts the game with +connect on its launch line, for games that read it.'
		},
		{
			href: data.steam.launch,
			label: 'Just launch the game',
			blurb:
				'Opens WARDOGS; then find the server in the browser, or paste the address if the game takes one.'
		}
	]);
</script>

<svelte:head><title>Join · {data.publicServer.name} · {data.appName}</title></svelte:head>

<div class="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
	<div class="panel">
		<span class="label-sm">Join {data.publicServer.name}</span>
		<div class="space-y-3">
			{#each OPTIONS as o (o.href)}
				<div class="rounded-ctl border border-black bg-ink-950 px-3 py-3">
					<a href={o.href} class="btn btn-primary">{o.label}</a>
					<p class="mt-2 text-[12.5px] text-mist-400">{o.blurb}</p>
				</div>
			{/each}
		</div>
		<p class="note">
			Needs Steam and WARDOGS installed on this machine. If the browser asks whether to open Steam,
			allow it.
		</p>
	</div>
	<div class="self-start panel">
		<span class="label-sm">Server address</span>
		<div class="flex flex-wrap items-center gap-2">
			<code class="chip text-[13px]">{data.address}</code>
			<button class="btn btn-sm" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
		</div>
		<p class="note">
			For the in-game server browser, or a launch option. Find {data.publicServer.name} by name if the
			game does not take an address.
		</p>
	</div>
</div>
