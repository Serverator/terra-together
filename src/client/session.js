/**
 * src/client/session.js
 * Owns the multiplayer session: the connection singleton, all peer state and the inbound
 * wire dispatch. Also the home of the state several client modules share.
 * Responsibilities:
 *   - Connection singleton + peer maps: playerActors/playerNames/playerUpdates/playerActions/
 *     peers/peerDowned/peerRogue, plus the window.terraTogether mirrors of them.
 *   - Private config helpers (getSetting/getUsername/getServerUrl) and the exported config
 *     readers hasPeers/getRogueInfo/getPeerRogueSeed.
 *   - Shared sync state (queues, soundRegistry, activeSyncedSounds, activePersistentFx,
 *     soundSyncSuppress, RUN_FX_*) that fx-sync.js fills, snapshot.js drains and actors.js
 *     reads — declared here because the client module graph is a DAG rooted at this file.
 *   - Lifecycle: joinServer/leaveServer/disconnect/send + detachClient/clearPeers/
 *     onDisconnected, and the inbound dispatch (MSG.* -> peer state, snapshot ingest,
 *     revive/area-heal/enemy-owner routing).
 * Public surface: joinServer, leaveServer, disconnect, isConnected, isConnecting, send,
 *   hasClient, hasPeers, initSession, getLocalId, getDownedFraction, setLocalDowned,
 *   getPeerDowned, isLocalDowned, getRogueInfo, getPeerRogueSeed, playerActors, playerNames,
 *   playerUpdates, playerActions, peers, peerDowned, peerRogue, queues, soundRegistry,
 *   activeSyncedSounds, activePersistentFx, soundSyncSuppress, RUN_FX_GROUPS,
 *   RUN_FX_SPEED_EPS, SCENE_STATE, SCENE_EVENT, Vec2, Vec3
 * Engine touchpoints: terra.file.sceneTypes, terra.export.{Vec2,Vec3,g_options,g_rogue},
 *   window.terraTogether (read/write mirrors, incl. reviveEnabled/estusShareEnabled), WebSocket.
 * Notes: import leaf — it imports ../net/protocol.js and nothing else, so the client
 *   modules form a DAG (session <- fx-sync <- actors <- snapshot <- client). Calls it must
 *   make *out* to a sibling (snapshot ingest, peer-actor teardown, revive/area-heal message
 *   routing, hosting state) are injected by ./client.js through initSession(); that is the
 *   same host-callback seam ../features/revive.js and ../features/area-heal.js already take.
 */

import { MSG } from "../net/protocol.js";

// --- Collaborator seam -------------------------------------------------------
// Wired once by ./client.js (the composition root) at module-init time; see the header
// note. Defaults are no-ops/neutral values so a partially wired module degrades quietly
// instead of throwing. Nothing here is called before the composition root runs.
const deps = {
	// ../server/server.js
	isHosting: () => false,
	getHostPort: () => 17005,
	// ./snapshot.js
	updatePlayerState: () => { },
	// ./actors.js
	setActorTimeFactor: () => { },
	// ./fx-sync.js
	clearPeerFx: () => { },
	// The feature modules' own inbound types and both of their onConnectionReset()s:
	// "revive" / "revive_progress" / "area_heal" (../features/revive.js,
	// ../features/area-heal.js) and "enemy_owner" (./enemies.js, routed by ./client.js).
	onPeerMessage: () => { },
	onConnectionReset: () => { },
	// host.reviver.downedFraction() (published to peers in the state snapshot).
	getDownedFraction: () => 0,
};

export function initSession(collaborators) {
	Object.assign(deps, collaborators);
}

// --- Shared engine bindings --------------------------------------------------
export const { SCENE_STATE, SCENE_EVENT } = terra.file.sceneTypes;

export const Vec2 = terra.export.Vec2;
export const Vec3 = terra.export.Vec3;

// --- Connection singleton ----------------------------------------------------
let client = null;
let clientHandlers = null;
let playerId = null;
let connected = false;
let connecting = false;
// True while the connection is pinned to our own hosted server (cannot be dropped
// by the player; it follows hosting state instead).
let forced = false;

// --- Peer state --------------------------------------------------------------
export const playerActors = new Map();
export const playerNames = new Map();

window.terraTogether ??= {};
window.terraTogether.playerActors = playerActors;
window.terraTogether.playerNames = playerNames;
// Read-only mirror for consumers that only have the window surface (e.g. the enemy debug
// overlay): our server-assigned id, as a getter so it always tracks `playerId`.
Object.defineProperty(window.terraTogether, "playerId", { get: () => playerId, configurable: true });

export const playerUpdates = new Map();
export const playerActions = new Map();

// Network ids of other connected players (drives hasPeers()).
export const peers = new Set();
// Exposed for the enemy debug overlay's player roster; the Set is mutated in place, so
// this single reference always stays current.
window.terraTogether.peers = peers;

// Downed/revive state (see ../features/revive.js): whether our own player is down, and
// per-peer down state propagated through the normal player state sync.
let localDowned = false;
export const peerDowned = new Map();
export function setLocalDowned(value) { localDowned = !!value; }
export function getPeerDowned() { return peerDowned; }
export function isLocalDowned() { return localDowned; }

// Last known rogue identity per peer: { seed, variant }. Kept sticky (not cleared
// every frame) so an in-progress run's seed stays available to adopt later.
export const peerRogue = new Map();

// --- Shared sync state -------------------------------------------------------
// Filled by the capture hooks in fx-sync.js and drained every frame by snapshot.js. One
// holder object (rather than free `let`s) so the drain can still rebind each slot.
export const queues = {
	// player actorFx emitted this frame (see installActorFxInjection in fx-sync.js)
	actorFx: [],
	// player-owned fx spawned this frame
	globalFx: [],
	// those fx stopping
	fxStops: [],
	// world/gameplay sounds started this frame
	sounds: [],
	// those sounds stopping
	soundStops: [],
	// knockback windboxes applied to the local player
	windboxes: [],
	// mirrored ranged projectiles
	projectiles: [],
};

// Sound resources by buffer path; sounds sync by path and re-resolve on the peer.
export const soundRegistry = new Map();

// >0 while inside a sound source intentionally not synced here (see fx-sync.js and
// actors.js). A holder object so both modules adjust the same counter.
export const soundSyncSuppress = { depth: 0 };

export const activeSyncedSounds = new Map();

// Player-owned *infinite* fx (status conditions, hold loops, ...) currently alive on the
// local player, keyed by their sync id: id -> { fx: FxEntity, desc: descriptor }. Re-sent
// every frame so a peer entering our room can rebuild lasting fx whose one-shot spawn they
// dropped while apart.
export const activePersistentFx = new Map();

// Groups the peer *ghost* can spawn on its own through player-side run logic (the sprint /
// float glow). Those local copies are never owner-reported, so nothing else removes them and
// they stick after the owner stops. We clear any fx in these groups that we did not spawn
// from the sync (see clearUntrackedRunFx in fx-sync.js).
export const RUN_FX_GROUPS = ["playerRunFx", "__runFX__"];
// Ghost XY speed below which the owner counts as "not running" (used to drop a stale run glow).
export const RUN_FX_SPEED_EPS = 0.15;

// --- Config / engine read helpers --------------------------------------------
// All config lives in the in-game options (Options > Mods tab); there is no config.json.
function getSetting(key, fallback) {
	const value = terra.export.g_options?.get(key);
	return (value === undefined || value === null || value === "") ? fallback : value;
}

function getUsername() {
	const name = String(getSetting("tt-username", "")).trim();
	return name === "" ? null : name;
}

function getServerUrl() {
	// When hosting, the connection is pinned to our own server on localhost.
	if (forced && deps.isHosting())
		return `ws://127.0.0.1:${deps.getHostPort()}`;
	const host = getSetting("tt-server-address", "127.0.0.1");
	const port = getSetting("tt-server-port", 17005);
	return `ws://${host}:${port}`;
}

// True while at least one other player is connected.
export function hasPeers() {
	return peers.size > 0;
}

// True while a connection object exists (even while still connecting). The capture hooks gate
// on this (see fx-sync.js), so they keep queueing while connecting; send() drops those until OPEN.
export function hasClient() {
	return !!client;
}

// Server-assigned id of the local player (null while offline).
export function getLocalId() {
	return playerId;
}

// Downed bleed-out fraction of the local player, published in the state snapshot. Owned by
// ../features/revive.js, reached through the collaborator seam (see the header).
export function getDownedFraction() {
	return deps.getDownedFraction();
}

// Local player's rogue sublayout identity. `variant` is the seeded layout of the
// current room and is null outside an active rogue run, so it only affects syncing
// while in the roguelike mode.
// (Lives here rather than in fx-sync.js with the rest of the rogue sync: snapshot.js and
// actors.js both need it and may not import fx-sync.js.)
export function getRogueInfo() {
	const g = terra.export.g_rogue;
	if (!g || !g.isActive())
		return { seed: null, variant: null };
	const room = g.getCurrentRoom?.();
	return {
		seed: g.run ? g.run.getRunState().seed : null,
		variant: room?.config ? room.variant : null,
	};
}

// Seed of any peer currently in a rogue run, so a fresh run can reuse it.
export function getPeerRogueSeed() {
	for (const info of peerRogue.values()) {
		if (info?.seed)
			return info.seed;
	}
	return null;
}

// --- Connection lifecycle ----------------------------------------------------
export function joinServer(address, options = {}) {
	// Replace any existing connection (e.g. switching from a remote server to hosting).
	if (client)
		detachClient();

	forced = !!options.force;
	connecting = true;
	address = address ?? getServerUrl();

	let ws;
	try {
		ws = new WebSocket(address);
	}
	catch (err) {
		console.error(`[TT Client] Invalid server address '${address}':`, err);
		connecting = false;
		forced = false;
		return;
	}
	client = ws;

	const onOpen = () => {
		if (client !== ws) return;
		connected = true;
		connecting = false;
		console.log("[TT Client] Connected to server");
	};

	const onMessage = (event) => {
		if (client !== ws) return;
		try {
			let msg = JSON.parse(event.data);

			switch (msg.type) {
				case MSG.WELCOME:
					console.log("[TT Client] Connected to the server");
					playerId = msg.id;
					// Username is sent exactly once per connection, not with every update.
					send({ type: MSG.PROFILE, username: getUsername() });
					break;

				case MSG.HOST_SETTING:
					// Host-authoritative: the host's revive toggle, obeyed by every client.
					// Apply with skipNotify so it does NOT re-fire CHANGED (which would
					// re-broadcast it and loop); set the runtime flag directly instead.
					if (msg.key === "tt-revive") {
						const on = msg.value === true;
						window.terraTogether.reviveEnabled = on;
						const g = terra.export.g_options;
						if (g?.settings?.["tt-revive"] && g.get("tt-revive") !== on)
							g.set("tt-revive", on, true);
					}
					if (msg.key === "tt-estus-share") {
						const on = msg.value === true;
						window.terraTogether.estusShareEnabled = on;
						const g = terra.export.g_options;
						if (g?.settings?.["tt-estus-share"] && g.get("tt-estus-share") !== on)
							g.set("tt-estus-share", on, true);
					}
					break;

				case MSG.PLAYER_PROFILE:
					playerNames.set(msg.id, msg.username);
					peers.add(msg.id);
					break;

				case MSG.UPDATE:
					deps.updatePlayerState(msg.id, msg.state);
					break;

				case MSG.PLAYER_JOINED:
					console.log(`[TT Client] Player ${msg.id} joined`);
					peers.add(msg.id);
					// Carries no state (the server broadcasts it that way); the peer's own update
					// follows, and updatePlayerState tolerates the missing state.
					deps.updatePlayerState(msg.id, msg.state);
					break;

				case MSG.SCENE_CHANGED:
					// Title screen: unload this player's character for everyone else.
					if (msg.scene == "LOADING" || msg.scene == "TITLE") {
						playerActions.set(msg.id, "HIDE");
					}
					// In-game menu / window focus lost: keep them in place but frozen.
					if (msg.scene == "MENU" || msg.scene == "PAUSED") {
						playerActions.set(msg.id, "PAUSE");
					}
					break;

				case MSG.PLAYER_LEFT:
					playerActions.set(msg.id, "HIDE");
					playerNames.delete(msg.id);
					peers.delete(msg.id);
					peerRogue.delete(msg.id);
					peerDowned.delete(msg.id);
					console.log(`[TT Client] Player ${msg.id} left`);
					break;

				case MSG.JOIN_MAP:
					console.log(`[TT Client] Player ${msg.id} joined map '${msg.map}'`);
					break;

				// Types owned by a feature module rather than by this dispatch: the downed/revive
				// + estus area-heal protocol (../features/revive.js, ../features/area-heal.js)
				// and the enemy ownership broadcast + state snapshots (../client/enemies.js).
				// ./client.js is the composition root that routes them on.
				case MSG.REVIVE:
				case MSG.REVIVE_PROGRESS:
				case MSG.AREA_HEAL:
				case MSG.ENEMY_OWNER:
				case MSG.ENEMY_STATE:
					deps.onPeerMessage(msg);
					break;
			}
		} catch (err) {
			console.warn("Error on client 'message':", err);
			return;
		}
	};

	const onClose = () => {
		if (client !== ws) return;
		connecting = false;
		console.log("Disconnected from server.");
		onDisconnected();
	};

	const onError = () => {
		if (client !== ws) return;
		connecting = false;
		// A WebSocket 'error' event is a plain Event with no message, so logging
		// err.message just prints "undefined". A hosted connection recovers through
		// onDisconnected()'s forced retry.
		console.error("[TT Client] Connection error (server unreachable)");
		onDisconnected();
	};

	ws.addEventListener("open", onOpen);
	ws.addEventListener("message", onMessage);
	ws.addEventListener("close", onClose);
	ws.addEventListener("error", onError);

	clientHandlers = { open: onOpen, message: onMessage, close: onClose, error: onError };
}

// Tear down a connection without its close/error events reaching onDisconnected.
function detachClient() {
	if (!client)
		return;
	const ws = client;
	if (clientHandlers) {
		ws.removeEventListener("open", clientHandlers.open);
		ws.removeEventListener("message", clientHandlers.message);
		ws.removeEventListener("close", clientHandlers.close);
		ws.removeEventListener("error", clientHandlers.error);
	}
	clientHandlers = null;
	try { ws.close(); } catch (e) { /* ignore */ }
	client = null;
	connected = false;
	clearPeers();
}

// Drop all per-connection state. Shared by detachClient() and onDisconnected().
function clearPeers() {
	// Hide any existing peer actors before dropping references, otherwise they stay
	// rendered in the world as untracked orphans.
	for (const actor of playerActors.values()) {
		deps.clearPeerFx(actor);
		deps.setActorTimeFactor(actor, 1);
		actor.core?.hide();
	}
	playerActors.clear();
	playerUpdates.clear();
	playerNames.clear();
	peerRogue.clear();
	peers.clear();
	peerDowned.clear();
	localDowned = false;
	deps.onConnectionReset();
	playerId = null;
	connecting = false;
}

export function leaveServer() {
	// Manual disconnect also clears the forced (hosting) flag.
	forced = false;
	if (!client) {
		connecting = false;
		return console.log("Not connected.");
	}
	client.close();
}

// Alias used by the settings menu.
export function disconnect() {
	leaveServer();
}

export function isConnected() {
	return connected && !!client && client.readyState === WebSocket.OPEN;
}

export function isConnecting() {
	return connecting;
}

// Clean up local state after a disconnect. The player is never moved out of their
// current scene: a dropped connection just clears the peers until they reconnect.
function onDisconnected() {
	if (!client && !connected)
		return;
	client = null;
	clientHandlers = null;
	connected = false;
	clearPeers();

	// A hosted connection is mandatory: rejoin our own server while it is up.
	if (forced && deps.isHosting()) {
		setTimeout(() => {
			if (forced && deps.isHosting() && !client)
				joinServer(undefined, { force: true });
		}, 1000);
	}
}

export function send(data) {
	if (client && client.readyState === WebSocket.OPEN) {
		client.send(JSON.stringify(data));
	}
}

//# sourceURL=/mods/terra-together/client/session.js
