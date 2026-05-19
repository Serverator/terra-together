export { startServer, stopServer, send, broadcast };

// Make local requires in CommonJS working
const require = makeRequire(import.meta.url);
const { WebSocketServer } = require('ws');

let server = null;
const clientsSockets = new Map();

// Server need to store current location of players to send to new players
const playerData = new Map();

const DEFAULT_PORT = 17005;

function startServer(port = DEFAULT_PORT) {
	if (server) return console.log("[TerraTogether] Server already running.");

	server = new WebSocketServer({ port });

	server.on('listening', () => {
		console.log('[TerraTogether] Server listening on ws://0.0.0.0:17505');
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
						playerData.set(playerId, { state: msg.state, map: msg.map });
						broadcast({ type: "update", id: playerId, state: msg.state }, socket);
						break;

					case "left_map":
						broadcast({ type: "left_map", id: playerId, map: msg.map }, socket);
						break;

					case "join_map":
						broadcast({ type: "join_map", id: playerId, map: msg.map }, socket);
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
