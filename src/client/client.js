/**
 * src/client/client.js
 * Composition root for the multiplayer client: wires the session, snapshot, actor and
 * fx-sync modules together and drives them from the game's addon hooks.
 * Responsibilities:
 *   - Own the MultiplayerClient addon: the tick hooks (onPreUpdate/onPostUpdate), scene
 *     gating/observer registration and the window-focus hook.
 *   - Build the feature modules (../features/revive.js, ../features/area-heal.js) with
 *     their host callbacks, then inject the collaborators session.js cannot import back.
 *   - Re-export the public API (../main.js and ../config/settings.js consume it).
 * Public surface: joinServer, leaveServer, disconnect, isConnected, isConnecting, send
 * Engine touchpoints: terra.export.{Observable,System,g_scene,g_options,g_game,g_player},
 *   terra.addAddon (onGameMapStart 35000, onLoopStart 35000), System.prototype.setWindowFocus
 * Notes: keep this file thin — it orchestrates only. The peer maps/connection live in
 *   ./session.js, the snapshot ends in ./snapshot.js, the peer actors in ./actors.js and
 *   the fx/sound/projectile sync in ./fx-sync.js. Module graph (DAG):
 *   session <- fx-sync <- actors <- snapshot <- client.
 *   The collaborators handed to initSession() are the ones session.js cannot import
 *   without closing a cycle (it is the leaf) and mirror the host-callback shape the
 *   feature modules already use.
 */

import {
	joinServer, leaveServer, disconnect, isConnected, isConnecting, send, hasClient,
	hasPeers, getLocalId, getRogueInfo, setLocalDowned, getPeerDowned, isLocalDowned,
	playerActors, playerUpdates, SCENE_STATE, SCENE_EVENT, initSession,
} from "./session.js";
import { updatePlayerState, sendPlayerData } from "./snapshot.js";
import { updateOtherPlayers, setActorTimeFactor } from "./actors.js";
import {
	installFxSyncHooks, installActorFxInjection, installRogueSeedHook, clearPeerFx,
	clearUntrackedRunFx,
} from "./fx-sync.js";
import { MSG } from "../net/protocol.js";
import { isHosting, getHostPort } from "../server/server.js";
import { Reviver } from "../features/revive.js";
import { AreaHealer } from "../features/area-heal.js";

// Public API — unchanged surface, now owned by ./session.js.
export { joinServer, leaveServer, disconnect, isConnected, isConnecting, send };

// Scene the last onSceneStateEvent saw: the addon's own scene gating state.
let lastScene = "INIT";

// --- Composition root ---------------------------------------------------------
// Downed/revive handling lives in its own module.
const reviver = new Reviver({
	send,
	isConnected,
	hasPeers,
	getLocalId,
	getPlayerActors: () => playerActors,
	getPeerDowned,
	setLocalDowned,
});

// Area estus heal handling lives in its own module.
const areaHealer = new AreaHealer({
	send,
	isConnected,
	hasPeers,
	getLocalId,
	getPlayerActors: () => playerActors,
	getPeerDowned,
	isSelfDowned: isLocalDowned,
	reviveLocal: () => reviver.reviveLocal(),
});

// Hand ./session.js the collaborators it must not import (see the header / its own header).
initSession({
	isHosting,
	getHostPort,
	updatePlayerState,
	setActorTimeFactor,
	clearPeerFx,
	onPeerMessage: (msg) => {
		if (msg.type === MSG.REVIVE || msg.type === MSG.REVIVE_PROGRESS)
			reviver.onMessage(msg);
		else if (msg.type === MSG.AREA_HEAL)
			areaHealer.onMessage(msg);
	},
	onConnectionReset: () => {
		reviver.onConnectionReset();
		areaHealer.onConnectionReset();
	},
	getDownedFraction: () => reviver.downedFraction(),
});

class MultiplayerClient extends terra.export.Observable {
	onPreUpdate() {
		updateOtherPlayers();
		reviver.onPreUpdate();
		areaHealer.onPreUpdate();
	}

	onPostUpdate() {
		sendPlayerData();
		// The ghost can spawn its own run glow during its entity update(), which runs after
		// movePlayerActor — strip it again here, before draw, so it never shows.
		for (const actor of playerActors.values()) {
			if (actor?.core?.isVisible?.() && !actor.terraTogether?.fxHidden)
				clearUntrackedRunFx(actor);
		}
	}

	// Clear peer actors when entering a new map.
	onGameMapLoad() {
		for (const actor of playerActors.values())
			clearPeerFx(actor);
		playerActors.clear();
		playerUpdates.clear();
		reviver.onMapLoad();
		areaHealer.onGameMapLoad();
	}

	onOptionEvent(event, key) {
		// NOTE: `key = 'tt-skin'` (assignment, not comparison) is pre-existing; kept as-is so
		// behaviour is unchanged. The body therefore always sends a snapshot.
		if (key = 'tt-skin') {
			sendPlayerData(true);
		}
	}

	// Join the server and hook the player's actorFx on map start.
	onGameMapStart() {
		if (!hasClient())
			joinServer(undefined, { force: isHosting() });

		for (const actor of playerActors.values())
			clearPeerFx(actor);
		playerActors.clear();
		playerUpdates.clear();

		let map = terra.export.g_game.map.active?.path;
		let variant = getRogueInfo().variant;
		send({ type: MSG.JOIN_MAP, map, variant });

		installActorFxInjection();
	}

	onFocusChange(focused) {
		if (focused)
			return;
		// Only meaningful while in a world: at the title the character is already
		// unloaded, and a focus change must not re-show it for other players.
		const scene = SCENE_STATE[terra.export.g_scene?.currentState ?? 0];
		if (scene != "RUNNING")
			return;
		send({ type: MSG.SCENE_CHANGED, scene: "PAUSED" });
		sendPlayerData(true, "PAUSED");
	}

	onLoopStart() {
		installRogueSeedHook();
		reviver.onLoopStart();
		areaHealer.onLoopStart();

		terra.export.g_scene.observers.push(this);
		terra.export.g_options.observers.push(this);

		let focusChange = this.onFocusChange;
		let originalsetWindowFocus = terra.export.System.prototype.setWindowFocus;
		terra.export.System.prototype.setWindowFocus = function (...args) {
			const result = originalsetWindowFocus.apply(this, args);
			focusChange(!args[0]);
			return result;
		};

		// Windbox/Fx/Sound/Projectile capture hooks (see ./fx-sync.js).
		installFxSyncHooks();
	}

	onSceneStateEvent(event) {
		let scene = SCENE_STATE[terra.export.g_scene.currentState];
		if (event != SCENE_EVENT.SCENE_CHANGED && scene != lastScene) return;
		lastScene = scene;

		if (hasClient())
			send({ type: MSG.SCENE_CHANGED, scene });
	}
}

terra.addAddon(new MultiplayerClient(), { onGameMapStart: 35000, onLoopStart: 35000 });

//# sourceURL=/mods/terra-together/client/client.js
