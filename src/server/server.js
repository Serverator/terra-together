/**
 * src/server/server.js
 * Authoritative Terra Together host server: relays player state between connected clients.
 * Responsibilities:
 *   - Own the WebSocketServer lifecycle (start/stop, listening/error/close handlers).
 *   - Track per-player state, username and last scene, and replay them to late joiners.
 *   - Push host-authoritative settings (revive, estus-share) on change.
 *   - Relay update/scene_changed/join_map/revive/revive_progress/area_heal to other clients.
 * Public surface: startServer, stopServer, send, broadcast, isHosting, getHostPort, setHostSetting
 * Engine touchpoints: window.addEventListener('beforeunload') (stops the server on reload);
 *   crypto.randomUUID() from the ambient global; no direct terra.* usage.
 * Notes:
 *   - The host process also runs a client, so a broadcast reaches the host's own client too;
 *     setHostSetting() de-dupes on value to avoid echoing its own push back out.
 *   - Wire message types live in src/net/protocol.js (MSG.*) as the single source of truth;
 *     every inbound type is matched through MSG.*, so an unknown type falls to the default
 *     branch and is dropped.
 *   - Pre-existing: the default branch's warn string uses single quotes, so ${playerId} there
 *     never interpolates. Not changed (behaviour-preserving move).
 */

export { startServer, stopServer, send, broadcast, isHosting, getHostPort, setHostSetting };

import { WebSocketServer } from "../net/ws.js";
import { MSG } from "../net/protocol.js";

let server = null;
let hostPort = 17005;
const clientsSockets = new Map();

// Host-authoritative settings (e.g. the revive toggle), pushed by the host process and
// replayed to every client as it connects. The server runs in the host's process, so
// clients can't set these — they only ever receive them.
const hostSettings = {};

function setHostSetting(key, value) {
	// Only broadcast on an actual change. The host's own client also receives these
	// (broadcast hits every socket), so without this guard applying the value would
	// echo straight back as another broadcast — an endless loop.
	if (hostSettings[key] === value)
		return;
	hostSettings[key] = value;
	broadcast({ type: MSG.HOST_SETTING, key, value });
}

// Server need to store current location of players to send to new players
const playerData = new Map();

// Username per player, sent once by each client on connect.
const playerNames = new Map();

function startServer(host = '0.0.0.0', port = 17005) {
	if (server) return Promise.resolve();

	hostPort = port;
	server = new WebSocketServer({ port, host });

	// Resolves once the socket is actually accepting connections. Callers (the
	// host button) must await this before connecting a client, otherwise the first
	// join races the bind and gets refused.
	let readyResolve;
	let readyReject;
	const ready = new Promise((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});

	server.on('listening', () => {
		console.log(`[TerraTogether] Server listening on ws://${host}:${port}`);
		readyResolve();
	});

	server.on('connection', (socket) => {
		const playerId = crypto.randomUUID();
		console.log(`[TT Server] Client '${playerId}' connected`);
		clientsSockets.set(socket, { id: playerId });

		send(socket, { type: MSG.WELCOME, id: playerId });

		// Replay the host's settings to the newcomer.
		for (const [key, value] of Object.entries(hostSettings))
			send(socket, { type: MSG.HOST_SETTING, key, value });

		// Existing players broadcast their state every frame, and the "join_map"
		// handler syncs on map entry, so no extra state sync is needed here.
		broadcast({ type: MSG.PLAYER_JOINED, id: playerId }, socket);

		socket.on('message', (raw) => {
			try {
				let msg = JSON.parse(raw);
				
				// Handle message types. Types come from ../net/protocol.js (single source of truth).
				switch (msg.type) {
					case MSG.UPDATE:
						playerData.set(playerId, msg.state);
						broadcast({ type: MSG.UPDATE, id: playerId, state: msg.state }, socket);
						break;

					case MSG.SCENE_CHANGED:
						// Remember the scene so stale state can't resurrect a player who left
						// the world (e.g. for clients that join the map later).
						if (playerData.has(playerId))
							playerData.get(playerId).scene = msg.scene;
						broadcast({ type: MSG.SCENE_CHANGED, id: playerId, scene: msg.scene }, socket);
						break;

					case MSG.PROFILE:
						playerNames.set(playerId, msg.username);
						clientsSockets.get(socket).username = msg.username;
						// Tell everyone else who just connected...
						broadcast({ type: MSG.PLAYER_PROFILE, id: playerId, username: msg.username }, socket);
						// ...and tell the newcomer about everyone already here.
						for (const [id, username] of playerNames) {
							if (id != playerId)
								send(socket, { type: MSG.PLAYER_PROFILE, id, username });
						}
						break;

					case MSG.JOIN_MAP:
						broadcast({ type: MSG.JOIN_MAP, id: playerId, map: msg.map, variant: msg.variant ?? null }, socket);
						for (const [id, state] of playerData) {
							// Rogue rooms share a map name but differ per seeded sublayout, so match
							// on variant too (both null outside rogue).
							if (state.scene == "MENU" && playerId != id && msg.map == state.map && (msg.variant ?? null) == (state.variant ?? null))
								send(socket, { type: MSG.UPDATE, id, state });
						}
						break;

					case MSG.REVIVE:
					case MSG.REVIVE_PROGRESS:
					case MSG.AREA_HEAL:
						// Downed/revive handshake and area estus heals: relay verbatim to everyone
						// but the sender (the sender already healed itself locally).
						broadcast(msg, socket);
						break;

					default:
						console.warn("[TT Server] Unknown message type from '${playerId}':", msg.type);
				}
			} catch (err) {
				console.warn(`[TT Server] Error when recieving message from '${playerId}':`, err);
				return;
			}
		});

		socket.on("close", () => {
			clientsSockets.delete(socket);
			playerData.delete(playerId);
			playerNames.delete(playerId);
			console.log(`Player ${playerId} disconnected. Total: Disconnect`);
			broadcast({ type: MSG.PLAYER_LEFT, id: playerId });
		});

		socket.on("error", (err) => {
			clientsSockets.delete(socket);
			playerData.delete(playerId);
			playerNames.delete(playerId);
			console.log(`Player ${playerId} crashed. Reason: ${err}`);
			broadcast({ type: MSG.PLAYER_LEFT, id: playerId });
		});
	});

	server.on("error", (err) => {
		console.error(`Failed to start server: ${err.message}`);
		server = null;
		readyReject(err);
	});

	server.on("close", () => {
		console.log(`[TT Server] Server closed`);
		clientsSockets.clear();
		server = null;
	});

	return ready;
}

function stopServer() {
	if (!server) return;
	for (const [socket] of clientsSockets) socket.close();
	clientsSockets.clear();
	server.close();
	server = null;
}

// True while a server is running (or starting up) on this machine.
function isHosting() {
	return !!server;
}

// Port the server is (or was last) listening on.
function getHostPort() {
	return hostPort;
}


function send(ws, data) {
	if (ws.readyState === ws.OPEN) {
		ws.send(JSON.stringify(data));
	}
}

function broadcast(data, skip = null) {
	const json = JSON.stringify(data);
	for (const [ws] of clientsSockets) {
		if (ws !== skip && ws.readyState === ws.OPEN) {
			ws.send(json);
		}
	}
}

// Stop server on page reload or else it stays in the background
window.addEventListener('beforeunload', () => {
	stopServer()
});

//# sourceURL=/mods/terra-together/server/server.js
