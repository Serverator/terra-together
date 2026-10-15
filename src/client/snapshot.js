/**
 * src/client/snapshot.js
 * The two ends of the peer state snapshot: inbound ingest and outbound egress.
 * Responsibilities:
 *   - updatePlayerState: absorb one peer state update (remember rogue identity + down
 *     state, carry one-shot events over when the previous update has not been consumed).
 *   - sendPlayerData: build and send the local player's state snapshot — transform,
 *     animation, HP/nameplate bars, rogue identity, and the drained fx/sound/projectile
 *     queues plus the persistent infinite-fx snapshot.
 * Public surface: updatePlayerState, sendPlayerData
 * Engine touchpoints: terra.export.{g_player,g_system,g_scene,g_game}; terra.file.sceneTypes
 *   via SCENE_STATE. The downed fraction comes from ../features/revive.js through
 *   ./session.js's collaborator seam.
 * Notes: the peer maps and the sync queues this module reads and drains are owned by
 *   ./session.js (see its header). The apply side of the snapshot (movePlayerActor /
 *   updateOtherPlayers) lives in ./actors.js, which keeps this module's imports to
 *   ../net/protocol.js + ./session.js.
 *   Timeline of one update: joinServer's dispatch -> updatePlayerState (ingest) ->
 *   actors.updateOtherPlayers (apply); the reverse direction is sendPlayerData on
 *   MultiplayerClient.onPostUpdate, one "update" message per frame.
 */

import { MSG } from "../net/protocol.js";
import {
	playerUpdates, peerRogue, peerDowned, isLocalDowned, getDownedFraction, getRogueInfo,
	SCENE_STATE, queues, activePersistentFx, activeSyncedSounds, send,
} from "./session.js";

export function updatePlayerState(id, state) {
	// Remember the peer's rogue seed/variant even while it is hidden (menu/pause),
	// so variant matching stays correct and its seed can still be adopted.
	if (state)
		peerRogue.set(id, { seed: state.seed ?? null, variant: state.variant ?? null });
	peerDowned.set(id, !!state?.downed);

	let scene = SCENE_STATE[terra.export.g_scene?.currentState ?? 0];
	let lastUpdate = playerUpdates.get(id);

	// If the previous update hasn't been consumed yet, carry its one-shot events over.
	// `state` can be missing here (the server's PLAYER_JOINED carries none, and any client may
	// send an update without one), so guard before touching its fields.
	if (lastUpdate && state && scene == "RUNNING") {
		state.globalFx ??= [];
		state.actorFx ??= [];
		state.sounds ??= [];
		state.soundVols ??= [];
		state.fxStops ??= [];
		state.soundStops ??= [];
		state.windboxes ??= [];
		state.projectiles ??= [];

		for (const fx of lastUpdate.actorFx ?? []) {
			state.actorFx.push(fx);
		}

		// Carry sounds/volumes over too: with the server on the same machine updates can
		// outpace frames, so a dropped one-shot sound is never re-delivered.
		for (const s of lastUpdate.sounds ?? []) {
			state.sounds.push(s);
		}

		for (const v of lastUpdate.soundVols ?? []) {
			state.soundVols.push(v);
		}

		for (const fx of lastUpdate.globalFx ?? []) {
			state.globalFx.push(fx);
		}

		for (const fx of lastUpdate.fxStops ?? []) {
			state.fxStops.push(fx);
		}

		for (const st of lastUpdate.soundStops ?? []) {
			state.soundStops.push(st);
		}

		for (const fx of lastUpdate.windboxes ?? []) {
			state.windboxes.push(fx);
		}

		for (const p of lastUpdate.projectiles ?? []) {
			state.projectiles.push(p);
		}
	}

	playerUpdates.set(id, state);
}

// Send only one paused state
let pausedSent = false;

export function sendPlayerData(forceSend = false, scene = null) {
	let g_player = terra.export.g_player;
	let g_system = terra.export.g_system;

	if (!scene)
		scene = SCENE_STATE[terra.export.g_scene?.currentState ?? 0];

	// Don't send state when not in game.
	if (scene == "INIT" || scene == "TITLE" || scene == "LOADING" || g_player.entity == null)
		return;

	let state = {}

	// Effective *animation* speed of the local player, not the raw world slow factor.
	// Slow-motion abilities use ADD_SLOW_MOTION with invert:"ALL"/"LOGIC", which makes
	// the caster ignore the slow-mo (its core.time.factor/logicFactor compensate). The
	// figure advances by core.getTick(true) = g_tick.world * factor * logicFactor, so
	// sending timeFactor.world alone slowed the peer actor during the wind-up — before
	// the explosion FX (sent a few frames later) had even arrived.
	let timeFactor = 0;
	if (!g_system.loopPaused) {
		const t = g_player.entity?.core?.time;
		timeFactor = g_system.timeFactor.global * g_system.timeFactor.world
			* (t ? t.factor * t.logicFactor : 1);
	}

	// Throttle only on a real engine pause (menu/cutscene), NOT on a slow-motion that
	// bottoms out at 0: a scripted slow-mo (e.g. the tutorial dodge) still moves/faces the
	// player, so position/face must keep flowing while the ghost itself stays frozen
	// (timeFactor 0 makes the peer snap its facing; see movePlayerActor).
	if (g_system.loopPaused) {
		if (pausedSent && !forceSend) return;
		pausedSent = true;
	} else {
		pausedSent = false;
	}

	state.timeFactor = timeFactor;

	state.char = g_player.entity?.npc?.char?.path;
	state.figure = g_player.entity?.view?.getFigure()?.name;

	state.scene = scene;

	state.downed = isLocalDowned();
	state.downedFrac = getDownedFraction();

	state.map = terra.export.g_game.map.active?.path;

	// Rogue sublayout identity: variant must match to render a peer; seed is shared so
	// a player starting a run can adopt an in-progress run's seed.
	const rogue = getRogueInfo();
	state.variant = rogue.variant;
	state.seed = rogue.seed;

	state.position = g_player.entity?.core?.pos?.clone().v;
	state.velocity = g_player.entity?.move?.vel?.clone().v;

	// Copy current animation state
	state.animation = g_player.entity?.view?.figState?.anim?.name || "idle";
	state.anim_time = g_player.entity?.view?.figState?.time;

	// Copy the look direction
	state.face_dir = g_player.entity?.actor?.face?.clone().v;

	// HP ratio (0..1) for the peer nameplate HP bar.
	state.hp = g_player.combat?.params?.getHPRatio?.() ?? 1;
	// HP ratio including pending heals (HoT) — the "will stop here" preview the HUD shows.
	state.hp_target = g_player.combat?.params?.getHPRatio?.(0, true) ?? state.hp;

	let weapon = g_player.entity?.player?.weapon;
	state.weapon = { weapon: weapon?.current?.name, back: weapon?.back ?? false, timer: weapon?.timer ?? 0 };

	// Send effect data
	state.actorFx = [...queues.actorFx];
	queues.actorFx = [];

	state.globalFx = [...queues.globalFx];
	queues.globalFx = [];

	// Full snapshot of our lasting (infinite) fx, re-sent every frame (NOT cleared like the
	// queues above) so a peer entering the room rebuilds debuffs it missed while we were
	// apart. Ended instances are pruned here as a backstop.
	const persistent = [];
	for (const [id, entry] of activePersistentFx) {
		// Drop entries whose fx is gone, reused for another fx, ended, or already stopping: an
		// infinite fx has duration -1 while alive and stop() sets it to 0. `_ttFxId` is an
		// identity check so a pooled FxEntity recycled for a new fx can't keep an old id alive.
		if (!entry.fx || entry.fx._ttFxId !== id || entry.fx.hasEnded?.() || !(entry.fx.duration < 0)) {
			activePersistentFx.delete(id);
			continue;
		}
		persistent.push(entry.desc);
	}
	state.persistentFx = persistent;

	state.fxStops = [...queues.fxStops];
	queues.fxStops = [];

	state.sounds = [...queues.sounds];
	queues.sounds = [];

	// Current volume of still-active synced sounds (e.g. charge loops).
	const vols = [];
	for (const [id, entry] of activeSyncedSounds) {
		const pb = entry.playback;
		if (!pb || pb.stopped) {
			activeSyncedSounds.delete(id);
			continue;
		}
		const v = pb.currentVolume;
		if (typeof v === "number" && (entry.lastVol < 0 || Math.abs(v - entry.lastVol) > 0.005)) {
			entry.lastVol = v;
			vols.push({ id, vol: v });
		}
	}
	state.soundVols = vols;

	state.soundStops = [...queues.soundStops];
	queues.soundStops = [];

	state.windboxes = [...queues.windboxes];
	queues.windboxes = [];

	state.projectiles = [...queues.projectiles];
	queues.projectiles = [];

	send({ type: MSG.UPDATE, state });
}

//# sourceURL=/mods/terra-together/client/snapshot.js
