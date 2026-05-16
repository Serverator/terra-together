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
	if (server) return console.log("Server already running.");

	server = new WebSocketServer({ port });

	server.on('listening', () => {
		console.log('TerraTogether server listening on ws://127.0.0.1:17505');
	});

	server.on('connection', (socket) => {
		console.log('[+] Client connected');
		const playerId = crypto.randomUUID();
		clientsSockets.set(socket, { id: playerId });

		console.log(`Player connected`);

		send(socket, { type: "welcome", id: playerId });

		broadcast({ type: "player_joined", id: playerId }, socket);

		socket.on('message', (raw) => {
			let msg;
			try {
				msg = JSON.parse(raw);
			} catch {
				console.warn("Invalid JSON from player", playerId);
				return;
			}

			console.log(`Player ${playerId} sent:`, msg);

			// Handle message types
			switch (msg.type) {
				case "update":
					playerData.set(id, { state: msg.state, map: msg.map });
					broadcast({ type: "update", id: playerId, state: msg.state }, socket);
					break;

				case "left_map":
					broadcast({ type: "left_map", id: playerId, map: msg.map }, socket);
					break;

				case "join_map":
					broadcast({ type: "join_map", id: playerId, map: msg.map }, socket);
					break;

				default:
					console.warn("Unknown message type:", msg.type);
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
}

function stopServer() {
	if (!server) return;
	clientsSockets.clear();
	server.close(() => console.log("Server stopped."));
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

//# sourceURL=mods/multiplayer/server.js
