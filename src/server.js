export { startServer, stopServer, send, broadcast };

import { WebSocketServer } from "./ws.js";

let server = null;
const clientsSockets = new Map();

// Server need to store current location of players to send to new players
const playerData = new Map();

function startServer(host = '0.0.0.0', port = 17005) {
	if (server) return console.log("[TerraTogether] Server already running.");

	server = new WebSocketServer({ port, host });

	server.on('listening', () => {
		console.log(`[TerraTogether] Server listening on ws://${host}:${port}`);
	});

	server.on('connection', (socket) => {
		const playerId = crypto.randomUUID();
		console.log(`[TT Server] Client '${playerId}' connected`);
		clientsSockets.set(socket, { id: playerId });

		send(socket, { type: "welcome", id: playerId });

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
						broadcast({ type: "scene_changed", id: playerId, scene: msg.scene }, socket);
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
			console.log(`Player ${playerId} disconnected. Total: ${clientsSockets.size}`);
			broadcast({ type: "player_left", id: playerId });
		});

		socket.on("error", (err) => console.error(`Player ${playerId} error:`, err));
	});

	server.on("error", (err) => {
		console.error(`Failed to start server: ${err.message}`);
		server = null;
	});

	server.on("close", () => {
		console.error(`[TT Server] Server closed`);
		clientsSockets.clear();
		server = null;
	});
}

function stopServer() {
	if (!server) return;
	for (const [socket] of clientsSockets) socket.close();
	clientsSockets.clear();
	server.close();
	server = null;
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
