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
 * Public surface: joinServer, leaveServer, disconnect, isConnected, isConnecting, send,
 *   addPeerMessageHandler, addFocusLossHandler
 * Engine touchpoints: terra.export.{Observable,System,g_scene,g_options,g_game},
 *   terra.addAddon (onGameMapStart 35000, onLoopStart 35000), System.prototype.setWindowFocus
 * Notes: keep this file thin — it orchestrates only. The peer maps/connection live in
 *   ./session.js, the snapshot ends in ./snapshot.js, the peer actors in ./actors.js and
 *   the fx/sound/projectile sync in ./fx-sync.js. Module graph (DAG):
 *   session <- fx-sync <- actors <- snapshot <- client; the enemy identity/ownership
 *   bookkeeping in ./enemies.js also imports this file (for send()), which is why its
 *   inbound type is routed through the handler table below instead of an import.
 *   The collaborators handed to initSession() are the ones session.js cannot import
 *   without closing a cycle (it is the leaf) and mirror the host-callback shape the
 *   feature modules already use.
 */

import {
	joinServer, leaveServer, disconnect, isConnected, isConnecting, send, hasClient,
	hasPeers, getLocalId, getRogueInfo, setLocalDowned, getPeerDowned, isLocalDowned,
	playerActors, playerUpdates, SCENE_STATE, initSession,
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

// Public API — re-exported from ./session.js for ../main.js and ../config/settings.js.
export { joinServer, leaveServer, disconnect, isConnected, isConnecting, send };

// Last scene seen by onSceneStateEvent (see the note on its gate); "INIT" only until the
// first scene event arrives.
let lastScene = "INIT";

// --- Composition root ---------------------------------------------------------
// Downed/revive handling is delegated to ../features/revive.js.
const reviver = new Reviver({
	send,
	isConnected,
	hasPeers,
	getLocalId,
	getPlayerActors: () => playerActors,
	getPeerDowned,
	setLocalDowned,
});

// Area estus heal handling is delegated to ../features/area-heal.js.
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

// Inbound handlers for the message types a module owns but this file must not import: a
// module that imports ./client.js for send() cannot be imported back without closing a
// module cycle, so it registers its handler here at load time (./enemies.js does this for
// MSG.ENEMY_OWNER -- see its own note). Keyed by message type.
const peerMessageHandlers = new Map();
export function addPeerMessageHandler(type, handler) {
	peerMessageHandlers.set(type, handler);
}

// The same seam for the one event that is not a message: a window focus loss. ./enemies.js has
// to withdraw the enemies it owns when this client stops running (see onFocusChange), and it
// cannot be imported here for the same cycle reason as above, so it registers that callback. The
// callback takes no arguments and must tolerate being called at any time; it is run before this
// file's own pause sync so the withdraw leaves on the same turn of the browser's event loop.
const focusLossHandlers = [];
export function addFocusLossHandler(handler) {
	focusLossHandlers.push(handler);
}

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
		else
			// A type owned by a module outside this composition root (see the note on the
			// handler table above).
			peerMessageHandlers.get(msg.type)?.(msg);
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
		// A skin change must reach peers at once: while the Options menu is open the scene is
		// MENU and the loop is paused, so sendPlayerData's per-frame call is throttled (./snapshot.js);
		// this forced send bypasses that. Peers re-apply the figure when its name changes
		// (see movePlayerActor in ./actors.js).
		if (key === 'tt-skin') {
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

		// Tell the server which room we are in; it replays the stored state of peers already
		// there, matched on map + rogue variant (server.js MSG.JOIN_MAP case).
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
		// The engine returns from its loop before any addon hook while the window is unfocused
		// (engine/system.js runInner -> hasFocusLost), so this is the LAST moment this client can
		// say anything: the modules that own per-frame state get to withdraw it here. ./enemies.js
		// uses it to hand its enemies on instead of going silent (a silent owner is what the
		// peer's freshness gate reads as a gone one).
		for (const handler of focusLossHandlers)
			handler();
		// "PAUSED" is the mod's own pseudo-scene (the receiver freezes the peer on it, see the
		// MSG.SCENE_CHANGED case in ./session.js); it is not a SCENE_STATE value.
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
			// The engine argument is windowFocusLost, not "focused" (blur passes true, focus
			// passes false — engine/input/input.js blur/focus), hence the inversion.
			focusChange(!args[0]);
			return result;
		};

		// Windbox/Fx/Sound/Projectile capture hooks (see ./fx-sync.js).
		installFxSyncHooks();
	}

	onSceneStateEvent(event) {
		// Notify peers only on a genuine scene-value change. SceneManager also fires
		// SCENE_CHANGED for in-place updates (exp/level-up timers, cutscene state) that leave
		// currentState alone; those must not tell peers the scene changed.
		let scene = SCENE_STATE[terra.export.g_scene.currentState];
		if (scene == lastScene) return;
		lastScene = scene;

		if (hasClient())
			send({ type: MSG.SCENE_CHANGED, scene });
	}
}

terra.addAddon(new MultiplayerClient(), { onGameMapStart: 35000, onLoopStart: 35000 });

//# sourceURL=/mods/terra-together/client/client.js
