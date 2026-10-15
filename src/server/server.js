/**
 * src/server/server.js
 * Authoritative Terra Together host server: relays player state between connected clients.
 * Responsibilities:
 *   - Own the WebSocketServer lifecycle (start/stop, listening/error/close handlers).
 *   - Track per-player state, username and last scene, and replay them to late joiners.
 *   - Push host-authoritative settings (revive, estus-share) on change.
 *   - Relay update/scene_changed/join_map/revive/revive_progress/area_heal to other clients.
 *   - Arbitrate enemy-sync ownership (which client simulates which map-placed enemy) and
 *     publish it, re-arbitrating when a room's membership changes.
 * Public surface: startServer, stopServer, send, broadcast, isHosting, getHostPort, setHostSetting
 * Engine touchpoints: window.addEventListener('beforeunload') (stops the server on reload);
 *   crypto.randomUUID() from the ambient global (the NW.js page, not terra.*); no direct
 *   terra.* usage.
 * Notes:
 *   - The host process also runs a client, so a broadcast reaches the host's own client too;
 *     setHostSetting() de-dupes on value to avoid echoing its own push back out.
 *   - Wire message types live in src/net/protocol.js (MSG.*) as the single source of truth;
 *     every inbound type is matched through MSG.*, so an unknown type falls to the default
 *     branch and is dropped. The direction table for all 15 types is documented there.
 *   - Enemy-sync ownership is arbitrated here, never simulated: the server is a single
 *     process, so its assignment is the consensus (see src/server/enemy-ownership.js). A
 *     client registers the map-placed enemies it can see and the server answers with the
 *     owner for everyone -- broadcast to all rather than scoped to the room, like every
 *     other relay here, so a client just ignores an id it does not know. The room a
 *     registration is arbitrated against is read from the state that client has ALREADY
 *     sent (see roomOf), so an UPDATE for the new map has to land before its registrations
 *     to be split across that map's players; before that it lands on itself alone.
 *   - Routing is "everyone but the sender" (broadcast(data, skip)): the author already
 *     applied its own change locally, so relaying back to it would double-apply it. The
 *     one exception is setHostSetting(), where the *host's* client is a normal recipient
 *     and de-dupes on value instead.
 *   - The server is a dumb relay: it trusts the peer-supplied payload (state/scene/map/
 *     variant/username, and revive/area_heal wholesale) and only enforces the shapes its
 *     own caches dereference. Anything that matters is re-checked by the recipient
 *     (e.g. the area-heal distance test in src/features/area-heal.js).
 *   - Ordering: each send is one synchronous socket.write, so per-connection order is
 *     preserved, but there is no rate limiting, batching or backpressure -- inbound
 *     traffic is paced by the clients' own tick (see src/client/snapshot.js).
 */

export { startServer, stopServer, send, broadcast, isHosting, getHostPort, setHostSetting };

import { WebSocketServer } from "../net/ws.js";
import { MSG } from "../net/protocol.js";
import { EnemyOwnership } from "./enemy-ownership.js";

let server = null;
let hostPort = 17005;
const clientsSockets = new Map();

// Host-authoritative settings (e.g. the revive toggle), pushed by the host process and
// replayed to every client as it connects. The server runs in the host's process, so
// clients can't set these — they only ever receive them. Deliberately kept across a
// stop/start cycle: they describe the host's preference, not this connection's state.
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

// Last known state per player, kept so a late joiner can be caught up (JOIN_MAP) and
// tagged with the scene it belongs to.
// Invariant: every value is a non-null object. The UPDATE case below is the only writer
// and it refuses anything else, which is what makes the state.scene / state.map /
// state.variant reads safe to dereference without a guard.
const playerData = new Map();

// Username per player, from the one-off PROFILE message each client sends after WELCOME.
// Replayed to a newcomer so it can label everyone already connected.
const playerNames = new Map();

// The enemy-sync ownership arbiter (src/server/enemy-ownership.js). One instance per server
// process: it is the single point of truth for who simulates each map-placed enemy, which is
// what makes split ownership safe. The server never simulates an enemy itself -- it only
// arbitrates, and being one process means it needs no consensus protocol to do so.
const enemyOwnership = new EnemyOwnership();

// Room key for a map + rogue variant; variant is null outside rogue. The clients match peers
// on this same pair (their JOIN_MAP flow), so the key is what "same room" means here.
function roomKey(map, variant) {
	return `${map}#${variant ?? null}`;
}

// The room a player is currently in, read from the state it has already sent (UPDATE caches
// map/variant and SCENE_CHANGED keeps `scene` current, so nothing new is asked of the
// client). Null when we cannot tell: no cached state yet, or a MENU scene -- the engine is
// paused there, so that client is not simulating anything and must not be picked to own an
// enemy. Callers treat null as "this client's room is unknown".
function roomOf(playerId) {
	const state = playerData.get(playerId);
	if (!state || state.scene === "MENU")
		return null;
	if (typeof state.map !== "string" || state.map.length === 0)
		return null;
	return roomKey(state.map, state.variant);
}

// The ownership candidate roster for a room: every connected player whose stored state puts
// them in it. Walked from clientsSockets (the membership truth) rather than playerData, so a
// player that has not sent any state yet is simply not a candidate.
function rosterOf(room) {
	const members = [];
	if (room === null)
		return members;
	for (const [, client] of clientsSockets) {
		if (roomOf(client.id) === room)
			members.push(client.id);
	}
	return members;
}

// Publish assignments to everyone -- the registrant included, since it has to learn who owns
// the enemy it just registered. Deliberately not room-scoped: this server relays everything
// to everyone (see the routing note in the header) and a client ignores an enemy_owner for an
// id it does not know.
function publishOwners(assignments) {
	for (const assignment of assignments)
		broadcast({ type: MSG.ENEMY_OWNER, id: assignment.id, owner: assignment.owner, epoch: assignment.epoch });
}

// Re-arbitrate a room after its membership changed and publish whatever moved. `leavingId` is
// the client on its way OUT of the room, dropped from the roster explicitly because its stored
// state may still name that room (a JOIN_MAP runs before the first UPDATE from the new map
// arrives); `joiningId` is a client on its way IN, added explicitly for the mirror-image reason
// (its stored state does not name the new room yet). Pass null for either when the roster
// derived from stored state is already accurate.
function reassignRoom(room, leavingId = null, joiningId = null) {
	if (room === null)
		return;
	const members = rosterOf(room).filter((id) => id !== leavingId);
	if (joiningId !== null && !members.includes(joiningId))
		members.push(joiningId);
	publishOwners(enemyOwnership.onRosterChange(room, members));
}

// Hand on every enemy this client still owns, except in `exceptRoom` (the room it is entering).
// Which rooms those are comes from the arbiter's registry rather than the client's stored state,
// because a client on its way out of a room may already have overwritten that state with the
// new one (see MSG.JOIN_MAP). The enemies it left behind are exactly the ones that must not stay
// owned by a client that has walked away -- nobody would simulate them, so they freeze on every
// other screen.
function reassignOwnedRooms(playerId, exceptRoom = null) {
	for (const room of enemyOwnership.ownedRooms(playerId)) {
		if (room !== exceptRoom)
			reassignRoom(room, playerId);
	}
}

function startServer(host = '0.0.0.0', port = 17005) {
	if (server) return Promise.resolve();

	hostPort = port;
	server = new WebSocketServer({ port, host });

	// The instance this startServer() call owns. The 'error' and 'close' handlers below clear
	// the module-level `server` only while it is still this instance: a restart issued before
	// either event fires replaces `server`, and nulling the live reference would make
	// isHosting() lie (and let a later startServer() hit EADDRINUSE).
	const srv = server;

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
		// One id per connection: it is the identity every relayed message carries and the
		// key for this player's entries in the maps below.
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
						// Cache the last state for the JOIN_MAP catch-up, but only when it really is an
						// object: the cache is dereferenced as state.scene/map/variant below and in
						// JOIN_MAP, and every module here is strict mode, so a property write on a
						// primitive would throw. The relay line is unaffected -- it forwards msg.state
						// verbatim whether or not we cache it.
						if (msg.state && typeof msg.state === "object")
							playerData.set(playerId, msg.state);
						broadcast({ type: MSG.UPDATE, id: playerId, state: msg.state }, socket);
						break;

					case MSG.SCENE_CHANGED:
						// Remember the scene so stale state can't resurrect a player who left
						// the world (e.g. for clients that join the map later). has() implies the
						// cached value is an object (see the UPDATE case); the relay carries
						// msg.scene verbatim, and clients act on LOADING/TITLE (hide) and
						// MENU/PAUSED (freeze) -- the client's MSG.SCENE_CHANGED case.
						if (playerData.has(playerId))
							playerData.get(playerId).scene = msg.scene;
						broadcast({ type: MSG.SCENE_CHANGED, id: playerId, scene: msg.scene }, socket);
						// MENU takes this client out of every roster (roomOf excludes it), so the rooms it
						// owned enemies in are re-arbitrated over the members that remain. The scenes that
						// hide it while it stays in the world (LOADING/TITLE) deliberately do not.
						if (msg.scene === "MENU")
							reassignOwnedRooms(playerId);
						// Whichever room it is in now is re-arbitrated as well: it takes over enemies whose
						// owner is gone AND re-splits the room over the roster that now includes this client
						// (returning from MENU is the case that matters). Null after a MENU, so it is a
						// no-op there.
						reassignRoom(roomOf(playerId));
						break;

					case MSG.PROFILE:
						// Sent once per connection, right after WELCOME (the client's MSG.WELCOME case
						// in src/client/session.js).
						// Stored for the backfill below and relayed verbatim: no length or charset
						// check here, so consumers must sanitise before drawing -- see the escaping
						// note in src/debug/enemy-debug.js (its cleanText escaping).
						playerNames.set(playerId, msg.username);
						// Tell everyone else who just connected...
						broadcast({ type: MSG.PLAYER_PROFILE, id: playerId, username: msg.username }, socket);
						// ...and tell the newcomer about everyone already here. It is deliberately
						// skipped for itself: a profile for its own id would add itself to its peer
						// set (src/client/session.js MSG.PLAYER_PROFILE case), making hasPeers() lie
						// about having company.
						for (const [id, username] of playerNames) {
							if (id !== playerId)
								send(socket, { type: MSG.PLAYER_PROFILE, id, username });
						}
						break;

					case MSG.JOIN_MAP:
						// Map entry: announce where we are, then catch the newcomer up on the
						// players we have cached state for.
						broadcast({ type: MSG.JOIN_MAP, id: playerId, map: msg.map, variant: msg.variant ?? null }, socket);
						for (const [id, state] of playerData) {
							// Rogue rooms share a map name but differ per seeded sublayout, so match
							// on variant too (both null outside rogue). The MENU filter picks the
							// players worth replaying: "MENU" is what a snapshot reports while the
							// engine is paused, i.e. exactly the case where the per-tick UPDATEs
							// have gone quiet (src/client/snapshot.js sendPlayerData() sends once and
							// then returns while g_system.loopPaused) and the newcomer
							// would otherwise draw nobody. Runners keep broadcasting every tick.
							if (state.scene === "MENU" && playerId !== id && msg.map === state.map && (msg.variant ?? null) === (state.variant ?? null))
								send(socket, { type: MSG.UPDATE, id, state });
						}
						// Leaving a room invalidates this client's ownership in it: its enemies there need
						// an owner still in that room. Which rooms those are comes from the arbiter, not
						// from this client's cached state -- an UPDATE for the new map may already have
						// overwritten that, and the enemies left behind are still owned here either way.
						// Re-entering the SAME room moves nothing (it is the excluded one), so this
						// never churns ownership on a reload.
						const enteredRoom = typeof msg.map === "string" && msg.map.length > 0 ? roomKey(msg.map, msg.variant) : null;
						reassignOwnedRooms(playerId, enteredRoom ?? roomOf(playerId));
						// The room being ENTERED is re-arbitrated too, and this is the convergence point for
						// the map-start race: the joiner is added by hand (its cached state still names the
						// room it is leaving), and the room's enemies are re-split over the roster that now
						// includes it -- which is what turns a one-client assignment made before this client's
						// room was known into a real split. Because it re-splits, it can move enemies even when
						// every current owner is present; an unchanged split is what stays silent.
						if (enteredRoom !== null)
							reassignRoom(enteredRoom, null, playerId);
						break;

					case MSG.REVIVE:
					case MSG.REVIVE_PROGRESS:
					case MSG.AREA_HEAL:
						// Downed/revive handshake and area estus heals: relay verbatim to everyone
						// but the sender (the sender already healed itself locally). The frame is
						// forwarded as-is -- no id is stamped on it, so the client-chosen fields are
						// taken on trust: area_heal's `from`/distance is re-validated by the
						// recipient against its own peer actors (src/features/area-heal.js).
						broadcast(msg, socket);
						break;

					case MSG.ENEMY_REGISTER:
						// A client announces a map-placed enemy and asks who simulates it. The room
						// comes from the state this client has already sent (roomOf) and the candidate
						// roster is everyone whose state puts them in that room; with no room known the
						// arbiter falls back to the registrant alone. msg.map/msg.variant only back the
						// RECORDED room key, so an assignment made before the first UPDATE from the new
						// map can still be repaired by a later roster change -- they are never trusted
						// over the stored state for choosing the roster.
						const room = roomOf(playerId);
						const knownRoom = room ?? (typeof msg.map === "string" && msg.map.length > 0 ? roomKey(msg.map, msg.variant) : null);
						const assignment = enemyOwnership.register(msg.id, knownRoom, playerId, rosterOf(room));
						// Everyone, the registrant included: it has to learn who owns the enemy it just
						// registered, and a duplicate register is how a late joiner learns it.
						if (assignment)
							publishOwners([assignment]);
						break;

					case MSG.ENEMY_UNREGISTER:
						// The enemy no longer exists for this client (its death resolved, or the map
						// unloaded): forget it. Nothing is reassigned -- a removal never moves load
						// around -- and the entry lives on for clients that still hold the enemy.
						enemyOwnership.unregister(msg.ids);
						break;

					default:
						// Unknown type, or one of the six server->client-only types a client has no
						// business sending (src/net/protocol.js): dropped, never relayed.
						console.warn(`[TT Server] Unknown message type from '${playerId}':`, msg.type);
				}
			} catch (err) {
				console.warn(`[TT Server] Error when receiving message from '${playerId}':`, err);
				return;
			}
		});

		socket.on("close", () => {
			// Also fires for a socket we closed ourselves (stopServer) and right after an
			// 'error' (error -> destroy -> close), so this and the 'error' handler below have to
			// agree on who tears the peer down: clientsSockets.delete() returns whether this
			// connection was still tracked, i.e. whether this is the first of the two to run.
			// Only the first one empties playerData/playerNames and announces PLAYER_LEFT, so a
			// peer that errors and then closes produces exactly one player_left.
			if (!clientsSockets.delete(socket))
				return;
			playerData.delete(playerId);
			playerNames.delete(playerId);
			console.log(`Player ${playerId} disconnected. Total: ${clientsSockets.size}`);
			broadcast({ type: MSG.PLAYER_LEFT, id: playerId });
			// Hand on everything this client still owned: the socket is already out of
			// clientsSockets, so it is missing from every roster.
			reassignOwnedRooms(playerId);
		});

		socket.on("error", (err) => {
			// Same teardown as 'close', gated the same way: whichever handler runs first wins the
			// clientsSockets.delete() and emits the single PLAYER_LEFT, the other bails out here.
			if (!clientsSockets.delete(socket))
				return;
			playerData.delete(playerId);
			playerNames.delete(playerId);
			console.log(`Player ${playerId} crashed. Reason: ${err}`);
			broadcast({ type: MSG.PLAYER_LEFT, id: playerId });
			reassignOwnedRooms(playerId);
		});
	});

	server.on("error", (err) => {
		// Bind failure (e.g. EADDRINUSE): drop the reference so isHosting() tells the truth
		// and a later startServer() can retry, and reject the promise startServer()
		// returned -- a no-op if we were already listening. Guarded on identity like the
		// 'close' handler below: an error racing a restart must not lose the new reference.
		console.error(`Failed to start server: ${err.message}`);
		if (server === srv)
			server = null;
		readyReject(err);
	});

	// Fires once the http server has stopped accepting peers -- after stopServer(), which
	// destroys the peer sockets first. Cleared here too so both paths agree; the state maps
	// are emptied by the per-socket 'close'/'error' handlers above, or by stopServer itself
	// (it empties clientsSockets first, so those handlers no longer see a tracked socket).
	// The clear is guarded on identity: a restart issued before this fires (startServer
	// replacing `server` while the old one is still shutting down) would otherwise null the
	// live reference and make isHosting() lie, so only the instance this handler was
	// registered for clears it -- the shared `srv` capture above is that instance.
	srv.on("close", () => {
		console.log(`[TT Server] Server closed`);
		clientsSockets.clear();
		if (server === srv)
			server = null;
	});

	return ready;
}

function stopServer() {
	if (!server) return;
	// Close every peer first: the close frames are queued and each socket is destroyed from
	// its write callback, which is what fires the per-socket handlers that empty
	// playerData/playerNames. The http server then has no live peer left to hold it open.
	for (const [socket] of clientsSockets) socket.close();
	clientsSockets.clear();
	// Emptied here as well: clearing clientsSockets above means the per-socket handlers (which
	// do this for a normal departure) now find no tracked socket and bail out early, so leaving
	// it to them would strand the finished session's state for a later startServer().
	playerData.clear();
	playerNames.clear();
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


// Fire-and-forget JSON frame on a single connection. Gated on isOpen, the only liveness flag
// a WebSocketConnection exposes (src/net/ws.js): it never carries readyState/OPEN, so the old
// `ws.readyState === ws.OPEN` test compared undefined to undefined and was always true. Its
// send() re-checks the same flag before writing, so a dead socket is skipped, not thrown at.
function send(ws, data) {
	if (ws.isOpen) {
		ws.send(JSON.stringify(data));
	}
}

// Fan-out to every connection except `skip`, the sender: a relayed message must not bounce
// back to its author, which already applied it locally. Pass null to reach everyone (used by
// the join/leave notices and by the host-setting push). The payload is serialised once and
// the same string is written to each socket, so all peers receive identical bytes.
function broadcast(data, skip = null) {
	const json = JSON.stringify(data);
	for (const [ws] of clientsSockets) {
		if (ws !== skip && ws.isOpen) {
			ws.send(json);
		}
	}
}

// Stop server on page reload or else it stays in the background
window.addEventListener('beforeunload', () => {
	stopServer()
});

//# sourceURL=/mods/terra-together/server/server.js
