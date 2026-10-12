export { startServer, stopServer, send, broadcast, isHosting, getHostPort };

import { WebSocketServer } from "./ws.js";

let server = null;
let hostPort = 17005;
const clientsSockets = new Map();

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

		send(socket, { type: "welcome", id: playerId });

		// Existing players broadcast their state every frame, and the "join_map"
		// handler syncs on map entry, so no extra state sync is needed here.
		broadcast({ type: "player_joined", id: playerId }, socket);

		socket.on('message', (raw) => {
			try {
				let msg = JSON.parse(raw);
				
				// Handle message types
				switch (msg.type) {
					case "update":
						playerData.set(playerId, msg.state);
						broadcast({ type: "update", id: playerId, state: msg.state }, socket);
						break;

					case "scene_changed":
						// Remember the scene so stale state can't resurrect a player who left
						// the world (e.g. for clients that join the map later).
						if (playerData.has(playerId))
							playerData.get(playerId).scene = msg.scene;
						broadcast({ type: "scene_changed", id: playerId, scene: msg.scene }, socket);
						break;

					case "actor_fx":
						broadcast({ type: "actor_fx", id: playerId, actorFx: msg.actorFx }, socket);
						break;

					case "profile":
						playerNames.set(playerId, msg.username);
						clientsSockets.get(socket).username = msg.username;
						// Tell everyone else who just connected...
						broadcast({ type: "player_profile", id: playerId, username: msg.username }, socket);
						// ...and tell the newcomer about everyone already here.
						for (const [id, username] of playerNames) {
							if (id != playerId)
								send(socket, { type: "player_profile", id, username });
						}
						break;

					case "join_map":
						broadcast({ type: "join_map", id: playerId, map: msg.map }, socket);
						for (const [id, state] of playerData) {
							if (state.scene == "MENU" && playerId != id && msg.map == state.map)
								send(socket, { type: "update", id, state });
						}
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
			broadcast({ type: "player_left", id: playerId });
		});

		socket.on("error", (err) => {
			clientsSockets.delete(socket);
			playerData.delete(playerId);
			playerNames.delete(playerId);
			console.log(`Player ${playerId} crashed. Reason: ${err}`);
			broadcast({ type: "player_left", id: playerId });
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

//# sourceURL=/mods/terra-together/server.js
