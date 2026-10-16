/**
 * src/server/server.js
 * Authoritative Terra Together host server: relays player state between connected clients.
 * Responsibilities:
 *   - Own the WebSocketServer lifecycle (start/stop, listening/error/close handlers).
 *   - Track per-player state, username and last scene, and replay them to late joiners.
 *   - Push host-authoritative settings (revive, estus-share) on change.
 *   - Relay update/scene_changed/join_map/revive/revive_progress/area_heal to other clients, and
 *     enemy_state to other clients once its entries are checked against the arbiter, and
 *     enemy_handoff, enemy_despawn, enemy_respawn, enemy_hit and enemy_wake to other clients with
 *     the sender's id stamped on them.
 *   - Arbitrate enemy-sync ownership (which client simulates which map-placed enemy) and
 *     publish it, re-arbitrating when a room's membership changes or, on a timer, when a
 *     different player has become the nearest one to an enemy (Phase 7 proximity). The timer's
 *     cadence, and the holds/margins/radii the arbiter applies, come from
 *     src/config/aggro-tuning.js -- the shared, editable knob file for both halves of the mod.
 *   - Feed the arbiter the aggro rebuild's three extra facts, all cached from traffic it already
 *     relays: whether an enemy is mid-action (the idle gate), whether it is in a fight (the
 *     engagement radius) and which client most recently attacked it (an attack claim, recorded
 *     from the enemy_hit frames it forwards).
 * Public surface: startServer, stopServer, send, broadcast, isHosting, getHostPort, setHostSetting
 * Engine touchpoints: window.addEventListener('beforeunload') (stops the server on reload);
 *   crypto.randomUUID() from the ambient global (the NW.js page, not terra.*); no direct
 *   terra.* usage.
 * Notes:
 *   - The host process also runs a client, so a broadcast reaches the host's own client too;
 *     setHostSetting() de-dupes on value to avoid echoing its own push back out.
 *   - Wire message types live in src/net/protocol.js (MSG.*) as the single source of truth;
 *     every inbound type is matched through MSG.*, so an unknown type falls to the default
 *     branch and is dropped. The direction table for all 21 types is documented there.
 *   - Enemy-sync ownership is arbitrated here, never simulated: the server is a single
 *     process, so its assignment is the consensus (see src/server/enemy-ownership.js). A
 *     client registers the map-placed enemies it can see and the server answers with the
 *     owner for everyone -- broadcast to all rather than scoped to the room, like every
 *     other relay here, so a client just ignores an id it does not know. The room a
 *     registration is arbitrated against comes from the messages that client sends -- its
 *     ENEMY_REGISTER/JOIN_MAP name its map, and its UPDATE states where it is -- so the room is
 *     known even for the registrations a client writes at map start, ahead of its first
 *     snapshot (see noteRoom).
 *   - Routing is "everyone but the sender" (broadcast(data, skip)): the author already
 *     applied its own change locally, so relaying back to it would double-apply it. The
 *     one exception is setHostSetting(), where the *host's* client is a normal recipient
 *     and de-dupes on value instead.
 *   - The server is a dumb relay: it trusts the peer-supplied payload (state/scene/map/
 *     variant/username, and revive/area_heal wholesale) and only enforces the shapes its
 *     own caches dereference. Anything that matters is re-checked by the recipient
 *     (e.g. the area-heal distance test in src/features/area-heal.js). The one exception is
 *     enemy_state, whose per-enemy entries the server authorises against the ownership arbiter
 *     before relaying (see the MSG.ENEMY_STATE case): an owner is the only party that can be
 *     allowed to drive an enemy, and that is a fact only the server can vouch for.
 *     enemy_handoff is relayed on the same trust as revive/area_heal -- deliberately NOT
 *     entry-validated: it comes from a client that has just STOPPED being the owner of the
 *     enemies in it, so the arbiter would reject the whole message (see the MSG.ENEMY_HANDOFF
 *     case). The recipient is what makes it safe: it applies a handed-on state only to an enemy
 *     it owns itself (src/client/enemies.js onEnemyHandoff). enemy_despawn rides the same trust
 *     and for the same shape of reason: the sender has just killed the enemies in it, so the
 *     arbiter's record for them can already be gone or moved by the time it arrives, and
 *     validate() would drop the very message that removes a ghost (see the MSG.ENEMY_DESPAWN
 *     case). enemy_respawn is relayed on that same coop trust for the mirror-image reason: it is
 *     not about an enemy at all, but about the map's whole population having been reset by a rest
 *     (see the MSG.ENEMY_RESPAWN case). enemy_hit is relayed on that same coop trust for the same
 *     shape of reason: any client may hit any enemy, so there is no ownership claim in it to
 *     validate -- the sender is never the owner of the enemies in the frame (see the
 *     MSG.ENEMY_HIT case). enemy_wake rides that same coop trust for the mirror image of the
 *     enemy_respawn reason: it is about a GROUP of enemies waking together, not about who owns any
 *     one of them, so there is nothing for the arbiter to authorise, and the recipient is what
 *     makes it safe -- it wakes only enemies it holds itself, and idempotently (see the
 *     MSG.ENEMY_WAKE case).
 *   - Ordering: each send is one synchronous socket.write, so per-connection order is
 *     preserved, but there is no rate limiting, batching or backpressure -- inbound
 *     traffic is paced by the clients' own tick (see src/client/snapshot.js).
 */

export { startServer, stopServer, send, broadcast, isHosting, getHostPort, setHostSetting };

import { WebSocketServer } from "../net/ws.js";
import { MSG } from "../net/protocol.js";
import { EnemyOwnership } from "./enemy-ownership.js";
import { AGGRO_TUNING } from "../config/aggro-tuning.js";

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

// Last known position per enemy id, for the proximity pass: the arbiter needs to know which of
// an enemy's candidates is standing nearest to it, and only the server sees everyone's traffic.
// Fed from the enemy_state frames it already relays (list[].x/y/z, cached only for entries whose
// sender it just vouched for as the owner, so a non-owner's claim can never move the arbitration)
// and from the `position` field of the state snapshots, which is the same source playerData's
// own downed/hp fields come from. Bounded by the number of live enemies: an id leaves on the
// despawn or the withdrawal that ends it, and the whole map is emptied when the server stops.
const enemyPositions = new Map();

// The other per-enemy facts the ownership pass needs, cached from the SAME owner-validated
// enemy_state entries as the positions above and cleared on exactly the same paths (see
// forgetEnemyFacts): `enemyBusy` holds the ids whose owner reports the enemy mid-action (its own
// actor.isActionRunning -- the idle gate, so a switch never cuts a swing in half), and
// `enemyAggro` the ids the owner reports as aggressive (in a fight -- the input the engagement
// radius gates a distance-driven switch on). Both are SETS, membership refreshed on every frame
// an owner reports, so they cannot go stale while an owner is streaming; a missing id means
// "not known", which every reader treats as `false` (fail-open -- an enemy is moved rather than
// frozen when nobody says otherwise).
const enemyBusy = new Set();
const enemyAggro = new Set();

// Attack claims: enemy id -> { playerId, at }. Recorded when the server relays an enemy_hit
// frame (the sender has, by construction, just attacked an enemy it does not simulate) and read
// by the proximity pass, which hands such an enemy to the player attacking it. The claimant is
// the SENDING SOCKET, the one identity the server can vouch for; the payload's own `attacker` is
// the same value from an honest client but is only its word. Bounded like the caches above: an
// entry leaves when the enemy is despawned/withdrawn, on a rest (a world reset), and when the
// server stops. Ages out on its own too (AGGRO_TUNING.claimTtlMs, read by the arbiter).
const enemyClaims = new Map();

// A player's last known position, as the { x, y, z } the proximity pass reads. Missing (undefined)
// while we have not heard from that player yet, which reads as UNMEASURABLE there -- never as
// "far away". A malformed or non-finite vector is dropped for the same reason.
function playerPosition(playerId) {
	const state = playerData.get(playerId);
	const p = state?.position;
	if (!Array.isArray(p) || p.length < 3)
		return undefined;
	const [x, y, z] = p;
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
		return undefined;
	return { x, y, z };
}

// Record one relayed enemy_state entry's facts. Only the fields the arbitration uses are kept
// (the vx/vy/vz, hp, anim of the frame are not this cache's business), and a malformed vector is
// DROPPED rather than coerced: NaN would compare false against everything and quietly turn the
// distance test into a no-op, and storing a partial vector would make an enemy look nearer or
// further than it is. The two flags are refreshed unconditionally -- a `busy` that goes back to
// false, or an enemy that leaves combat, has to be able to say so -- while the POSITION is only
// ever overwritten by a good vector, so a bad frame leaves the last good position standing rather
// than erasing it.
function cacheEnemyFacts(entry) {
	const x = entry.x;
	const y = entry.y;
	const z = entry.z;
	if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))
		enemyPositions.set(entry.id, { x, y, z });
	if (entry.busy === true)
		enemyBusy.add(entry.id);
	else
		enemyBusy.delete(entry.id);
	if (entry.aggro === true)
		enemyAggro.add(entry.id);
	else
		enemyAggro.delete(entry.id);
}

// Forget everything cached about the enemies named in `ids` (a despawn or a withdrawal): their
// position, their flags and their claim. Called with a list that may name enemies this server
// never had anything for, so it is safe on every path. A wrong id is not an error: it simply
// removes nothing.
function forgetEnemyFacts(ids) {
	if (!Array.isArray(ids))
		return;
	for (const entry of ids) {
		const id = entry && typeof entry === "object" ? entry.id : entry;
		if (typeof id !== "string")
			continue;
		enemyPositions.delete(id);
		enemyBusy.delete(id);
		enemyAggro.delete(id);
		enemyClaims.delete(id);
	}
}

// Drop EVERY cached enemy fact (position, flags, claims). Used by the rest reset, which is a
// world-wide event: resting puts every enemy on every map back, so nothing cached about where an
// enemy was, whether it was mid-swing, or who had claimed it survives it.
function forgetAllEnemyFacts() {
	enemyPositions.clear();
	enemyBusy.clear();
	enemyAggro.clear();
	enemyClaims.clear();
}

// Room key for a map + rogue variant; variant is null outside rogue. The clients match peers
// on this same pair (their JOIN_MAP flow), so the key is what "same room" means here.
function roomKey(map, variant) {
	return `${map}#${variant ?? null}`;
}

// Live, opt-in switch for the ownership log below, off by default and read straight from the
// page global like the enemy debug overlay's window.ttEnemyDebug (src/debug/enemy-debug.js).
// Enable it from the HOST's devtools console with `window.ttEnemyNetDebug = true` to get one
// line per inbound register/withdraw, per roster change and per published assignment, each
// carrying the room and roster the server computed -- which is what a report of mis-ownership
// has to contain to be actionable. Every call site tests the flag before building its arguments,
// so the off path is one property read.
function netDebugEnabled() {
	return window.ttEnemyNetDebug === true;
}

function netDebug(...parts) {
	console.log("[TT enemy-net]", ...parts);
}

// Short id for the log: the wire ids are uuids, and only their prefixes are needed to tell two
// clients apart in a line.
function shortId(id) {
	return id === null || id === undefined ? String(id) : String(id).slice(0, 8);
}

// The room a client's cached STATE puts it in. Null when we cannot tell: no cached state yet, or
// a state that names no map. A MENU scene is deliberately NOT nulled here, though it used to be:
// MENU is the in-game pause menu, where the character is still standing in the world, so a merely
// paused client keeps its room -- and its enemies. Nulling it was what made a paused player's
// enemies migrate away and the peer's copies go calm (Sam: "walks away on pause"). A client that
// really leaves the world stops appearing in this state (TITLE) or withdraws its enemies, and is
// handled there. This is only the fallback for a client the server has not heard a room report
// from yet (see roomOf), which is why the same rule has to hold in the SCENE_CHANGED case.
function roomFromState(state) {
	if (!state)
		return null;
	if (typeof state.map !== "string" || state.map.length === 0)
		return null;
	return roomKey(state.map, state.variant);
}

// The room a message names, or null when it names no usable map. JOIN_MAP and ENEMY_REGISTER
// both carry the map (and rogue variant) their client is on, read from the same live g_game.map
// the state snapshots are built from.
function roomFromMessage(msg) {
	return typeof msg.map === "string" && msg.map.length > 0 ? roomKey(msg.map, msg.variant) : null;
}

// The room each client is in, as the server last heard it (see noteRoom). A client's room is
// tracked from its own messages rather than derived on demand from its cached state, because
// the cached state is a frame behind what the client is doing: the first enemy_register of a
// map is written ahead of that map's first UPDATE, and an UPDATE that first names a client's
// room used to change nothing at all -- which let a room's split stay one-sided for good.
const playerRooms = new Map();

// The room a player is in: what it last reported, else what its cached state says.
function roomOf(playerId) {
	if (playerRooms.has(playerId))
		return playerRooms.get(playerId);
	return roomFromState(playerData.get(playerId));
}

// Record `playerId` as being in `room` (null = no room), re-arbitrating the rooms it moved
// between: the one it left, which now has to do without it (its enemies must not stay owned by a
// client that has walked away, or nobody would simulate them), and the one it entered, whose
// split is recomputed over the roster that now includes it. This is the server's single
// convergence point -- every message that tells us where a client is funnels through here (its
// first UPDATE naming a room, JOIN_MAP, ENEMY_REGISTER) -- which is what repairs a room whose
// announcement was lost: the map-start JOIN_MAP is written while the socket is still connecting
// (session.send() drops it), so the first split has to be able to converge from nothing but the
// snapshots and the registrations that follow. Idempotent: a report of the room the client is
// already in returns without touching the arbiter.
function noteRoom(playerId, room) {
	if (playerRooms.has(playerId) && playerRooms.get(playerId) === room)
		return;
	const previous = playerRooms.get(playerId) ?? null;
	playerRooms.set(playerId, room);
	if (netDebugEnabled())
		netDebug(`room ${shortId(playerId)}: ${previous ?? "(none)"} -> ${room ?? "(none)"} | ${roomTable()}`);
	if (previous !== null)
		reassignRoom(previous, playerId);
	if (room !== null)
		reassignRoom(room, null, playerId);
}

// Room per connected client, for the opt-in log: "which room did the server think each client was
// in" is the first question nearly every mis-ownership report comes down to.
function roomTable() {
	const parts = [];
	for (const [, client] of clientsSockets)
		parts.push(`${shortId(client.id)}=${roomOf(client.id) ?? "(none)"}`);
	return parts.join(" ");
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
	for (const assignment of assignments) {
		if (netDebugEnabled())
			netDebug(`publish enemy_owner ${assignment.id} ${assignment.previous == null ? "(new)" : shortId(assignment.previous)} -> ${assignment.owner == null ? "none" : shortId(assignment.owner)} epoch ${assignment.epoch}`);
		broadcast({ type: MSG.ENEMY_OWNER, id: assignment.id, owner: assignment.owner, epoch: assignment.epoch });
	}
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
	const changed = enemyOwnership.onRosterChange(room, members, Date.now());
	if (netDebugEnabled())
		netDebug(`rebalance ${room} roster=[${members.map(shortId).join(",")}]${leavingId !== null ? ` leaving=${shortId(leavingId)}` : ""}${joiningId !== null ? ` joining=${shortId(joiningId)}` : ""} -> ${changed.length} moved`);
	publishOwners(changed);
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

// ─── proximity cadence (Phase 7) ─────────────────────────────────────────────────
// How often ownership is re-evaluated against where the players actually are. A CADENCE, not a
// per-frame or per-message reaction, and that is the whole point: positions change every frame,
// so a pass that chased them would move owners -- each move a handoff, each handoff visible
// mid-fight -- continuously. The arbiter is idempotent, so a tick that finds nothing to move
// publishes nothing at all.
const OWNERSHIP_TICK_MS = AGGRO_TUNING.ownershipTickMs;
let ownershipTimer = null;

// Everything the proximity pass needs to know about where a player or an enemy is, as one map
// from id to { x, y, z }: the players' last snapshots plus the enemies' last relayed states.
// The two id spaces cannot alias -- an enemy id is always `m:<mapPath>#<mapId>`
// (src/client/enemies.js wireEnemyId) and a player id is a bare uuid -- so one map is safe, and
// it is exactly the shape the arbiter's distance lookup takes. A missing entry means
// UNMEASURABLE, which the arbiter treats as "no evidence", never as "far away".
function positionsSnapshot() {
	const positions = new Map();
	for (const [id] of clientsSockets) {
		const p = playerPosition(id);
		if (p !== undefined)
			positions.set(id, p);
	}
	for (const [id, p] of enemyPositions)
		positions.set(id, p);
	return positions;
}

// One proximity pass: who is in each room, where everyone and every enemy is, who is down, which
// enemies are mid-action (the idle gate) or in a fight (the engagement radius), who has claimed
// what, and the clock. The arbiter returns exactly the assignments that moved, and those are all
// that is published -- MSG.ENEMY_OWNER, same shape, same field-for-field epoch rule, so no client
// can tell this phase happened from the wire.
function ownershipTick() {
	// One client cannot disagree with itself. With no peer there is nobody to hand an enemy to,
	// so the pass could only ever keep the incumbent: skip it and pay nothing.
	if (clientsSockets.size < 2)
		return;

	// The roster per room, from the same source the membership-driven rebalance uses, so a tick
	// and a rebalance of the same state see the same candidates.
	const rosterByRoom = new Map();
	for (const room of enemyOwnership.rooms())
		rosterByRoom.set(room, rosterOf(room));

	// Downed players are the one liveness fact that matters: a downed player cannot fight, and
	// an enemy's target follows its owner, so an enemy left on a downed owner stops fighting
	// even after its owner is revived. Read from the same cached snapshot fields (downed) the
	// rest of the server reads; a state from before anyone was down simply does not report one.
	// A downed player is DEMOTED (the enemy moves to a live candidate) but the enemy keeps its
	// in-combat state -- the aggro bit is the owner's, and the peer shows it (the client half).
	const downed = new Set();
	for (const [id, state] of playerData) {
		if (state.downed)
			downed.add(id);
	}

	// The three aggro-rebuild inputs, all of them server-side caches of traffic already relayed:
	// the idle gate, the engagement radius and the attack claims (see the caches above). Passed
	// as the live collections -- the arbiter only reads them.
	const changed = enemyOwnership.onProximityTick(rosterByRoom, positionsSnapshot(), downed, Date.now(), {
		busy: enemyBusy,
		inCombat: enemyAggro,
		claims: enemyClaims,
	});
	if (changed.length === 0)
		return;
	// An enemy that has moved has served (or outlived) any claim naming it: drop the claim, so
	// the next tick does not keep hearing a hit that has already had its effect. A claimant that
	// is still attacking re-registers one on its next forwarded hit.
	for (const assignment of changed)
		enemyClaims.delete(assignment.id);
	if (netDebugEnabled())
		netDebug(`tick busy=${enemyBusy.size} combat=${enemyAggro.size} claims=[${[...enemyClaims.keys()].join(",")}] -> ${changed.length} moved`);
	publishOwners(changed);
}

// Stop the cadence. Idempotent, and safe to call from every teardown path (stopServer, the
// bind-failure handler, the http server's own close): the timer is the only thing it owns.
function stopOwnershipTimer() {
	if (ownershipTimer !== null) {
		clearInterval(ownershipTimer);
		ownershipTimer = null;
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

	// The proximity cadence starts with the server and dies with it (see stopOwnershipTimer):
	// it reads clientsSockets/playerData, so a tick that outlived the session would read an
	// emptied world and hand nothing out. Created once per startServer() call -- the early
	// return above makes a second one impossible while one is running.
	ownershipTimer = setInterval(ownershipTick, OWNERSHIP_TICK_MS);

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
						// Where this client says it is. This is the room report that used to be missing:
						// at map start the JOIN_MAP and scene_changed of that start are written while the
						// socket is still connecting (session.send() drops them), so the first snapshot to
						// name a room can be the only one the server ever gets -- and an UPDATE used to
						// change no room at all, which is how a room's split stayed one-sided for good.
						// A state that is not an object is relayed verbatim (as before) but cannot move
						// anyone: reading it as "this client left its room" would hand its enemies away.
						if (msg.state && typeof msg.state === "object")
							noteRoom(playerId, roomFromState(msg.state));
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
						// What this scene does to the client's ROOM. MENU (the in-game pause) now
						// does nothing: a paused client keeps its room and its enemies, so the fight
						// does not walk away from it -- and roomFromState no longer nulls a MENU
						// state either, which the two must agree on because the one UPDATE a paused
						// loop sends also carries scene MENU. TITLE is the one scene that does take a
						// client out of its room: the character is unloaded there, so an enemy left on
						// it would be simulated by nobody (and without this a pause followed by a quit
						// to the title would keep ownership the client can no longer drive, which the
						// old MENU eviction used to sweep up). LOADING stays a non-event, as it was:
						// a map change re-reports the new room through JOIN_MAP, and evicting mid-load
						// would churn the room's split for a client that is merely between maps.
						if (msg.scene === "TITLE")
							noteRoom(playerId, null);
						// Whichever room it is in now is re-arbitrated as well: it takes over enemies whose
						// owner is gone AND re-splits the room over the roster that now includes this client
						// (returning from MENU is the case that matters -- though there the room is re-reported
						// by the first UPDATE of the resumed loop, so this is usually the no-op).
						else
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
						// The client tells us which room it is entering. noteRoom records it and re-arbitrates
						// BOTH rooms: the one it left, whose enemies must not stay owned by a client that has
						// walked away (nobody would simulate them), and the one it entered, re-split over the
						// roster that now includes it. That re-split is the point -- it moves enemies even when
						// every current owner is present, which is what turns a one-client assignment made
						// before this client's room was known into a real split, and why re-entering the room
						// it is already in moves nothing.
						const enteredRoom = roomFromMessage(msg);
						if (enteredRoom !== null)
							noteRoom(playerId, enteredRoom);
						else
							// No usable map in the message: hand on everything this client still owns except the
							// room its cached state names, the old best guess at where it is.
							reassignOwnedRooms(playerId, roomOf(playerId));
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
						// A client announces a map-placed enemy and asks who simulates it. The room comes from
						// the message, which names the map this enemy and this client are on: read from the same
						// live g_game.map the snapshots use, but not a frame behind them and never the map the
						// client just left. Trusting it here is what keeps a re-entering client's registrations
						// in the room that will re-split them; deriving the room from cached state instead
						// records the enemy against a player who is no longer there, whose one-member roster
						// then hands it the whole map.
						const messageRoom = roomFromMessage(msg);
						if (messageRoom !== null)
							noteRoom(playerId, messageRoom);
						const room = messageRoom ?? roomOf(playerId);
						const roster = rosterOf(room);
						const assignment = enemyOwnership.register(msg.id, room, playerId, roster, Date.now());
						if (netDebugEnabled())
							netDebug(`in enemy_register ${msg.id} (msg map=${msg.map} variant=${msg.variant}) room=${room ?? "(none)"} from=${shortId(playerId)} roster=[${roster.map(shortId).join(",")}] -> owner=${shortId(assignment?.owner) || "none"} epoch ${assignment?.epoch ?? "-"} moved=${assignment?.changed?.length ?? 0}`);
						// Everyone, the registrant included: it has to learn who owns the enemy it just
						// registered, and a duplicate register is how a late joiner learns it.
						if (assignment) {
							publishOwners([assignment]);
							// Registering a second time widens the enemy's candidate set, so the arbiter
							// re-split the room and handed back the assignments that moved. Publishing them
							// is what converges a room whose split was made while only one client had
							// announced the enemies (see register() in enemy-ownership.js); it is empty
							// when nothing moved, so an idempotent re-register stays silent.
							if (assignment.changed.length > 0)
								publishOwners(assignment.changed);
						}
						break;

					case MSG.ENEMY_STATE: {
						// Owner -> server -> other clients, per frame: the position/animation/HP of the
						// enemies this client simulates. Unlike every other relay here the frame is NOT
						// taken on trust -- the server is the only party that can vouch for who owns an
						// enemy, and only its owner may drive it -- so each entry is checked against the
						// arbiter and an entry this sender does not own is DROPPED. Dropping per entry
						// (not per message) is deliberate: a rebalance can move one enemy between friends,
						// and the rest of the frame is still good. Wire shape (frozen): { owner, map,
						// variant, list: [{ id, x, y, z, vx, vy, vz, fx, fy, anim, animTime, hp, state,
						// action, aggro, busy }] } -- `aggro` (in a fight) and `busy` (mid-action) are
						// per-entry owner facts the server caches for the proximity pass and relays on
						// untouched; both are additive to the frozen shape and absent means false, so an
						// older sender costs nothing and only the ownership pass notices.
						const list = Array.isArray(msg.list) ? msg.list : null;
						const count = list === null ? 0 : list.length;
						// `kept` stays null while every entry passes, so the common frame is relayed
						// without allocating a filtered copy; it is seeded from the entries before the
						// first failure, which are exactly the ones that passed.
						let kept = null;
						let passed = 0;
						for (let i = 0; i < count; i++) {
							const entry = list[i];
							if (entry && enemyOwnership.validate(entry.id, playerId)) {
								passed++;
								if (kept !== null)
									kept.push(entry);
								// Remember this enemy's position and its two owner flags (busy/aggro), for the
								// proximity pass. Cached only for entries whose sender the arbiter just vouched
								// for as the owner, which is what keeps a non-owner's claim out of the
								// arbitration. Free: the frame is already in hand and this is a couple of
								// property reads per entry, on a path this loop already walks (a malformed
								// vector is dropped by the helper).
								cacheEnemyFacts(entry);
							} else if (kept === null) {
								kept = list.slice(0, i);
							}
						}
						if (netDebugEnabled())
							netDebug(`in enemy_state from=${shortId(playerId)} map=${msg.map} variant=${msg.variant ?? null} entries=${count} owner-pass=${passed} not-owner-drop=${count - passed}`);
						// Nothing authorised: no frame, in particular no empty one, reaches the wire.
						if (passed === 0)
							break;
						if (kept !== null)
							msg.list = kept;
						// The sender's own claim is never relayed: it is the socket's playerId that the
						// arbiter just vouched for, and the frozen shape says owner is that id.
						msg.owner = playerId;
						broadcast(msg, socket);
						break;
					}

					case MSG.ENEMY_HANDOFF: {
						// The client that was simulating these enemies has just LOST them (the same
						// enemy_owner broadcast that told the recipients did): this is their final state,
						// so whoever takes them over continues from where they were instead of from its
						// own copy -- which, for a client re-entering a map, is the spawn point. That is
						// the whole reason the type exists; see src/client/enemies.js sendHandoffs.
						//
						// Deliberately NOT entry-validated like ENEMY_STATE, and that difference is the
						// point: `validate()` asks "is this sender the owner" and the honest answer here is
						// no for every entry, so checking would drop the whole message and re-break the
						// bug. It is coop traffic relayed on the same trust as revive/area_heal, and the
						// recipient is what makes that safe (it applies a handed-on state only to an
						// enemy it owns itself). Wire shape (frozen): { owner, list: [{ id, x, y, z, vx,
						// vy, vz, fx, fy, anim, animTime, hp, state, action }] }.
						const handoffList = Array.isArray(msg.list) ? msg.list : null;
						if (netDebugEnabled())
							netDebug(`in enemy_handoff from=${shortId(playerId)} entries=${handoffList === null ? 0 : handoffList.length}`);
						// Nothing to hand on: no frame. An empty relay would only wake every client's
						// handler for a message with nothing in it.
						if (handoffList === null || handoffList.length === 0)
							break;
						// The sender's own claim is never relayed -- the socket identity is the id the
						// recipients gate on, exactly as in the ENEMY_STATE case above.
						msg.owner = playerId;
						broadcast(msg, socket);
						break;
					}

					case MSG.ENEMY_DESPAWN: {
						// The id of an enemy this client owned and has just beaten (the owner half lives in
						// src/client/enemies.js, markDying/sendDespawnId): tell everyone else, so each of them can mark it
						// dead in its OWN per-client dead-set and take it out of the world. Without it a peer
						// keeps a live copy of an enemy the owner has already killed, and no local event can
						// ever correct that: a peer's copy of an enemy it does not own has its local hit
						// application suppressed (enemy-puppet.js patches (c)/(d)), so the owner's word is the
						// only one there is about that enemy's death.
						//
						// Deliberately NOT entry-validated, exactly like ENEMY_HANDOFF just above, and for the
						// same shape of reason: validate() asks "is this sender the owner right now", and by
						// the time this frame arrives the honest answer can already be no -- the sender's own
						// ENEMY_UNREGISTER for the same enemy is written in that same frame (its copy stopped
						// being "live" the instant it was beaten), and any rebalance in between moves the id.
						// Dropping it would strand the ghost this type exists to remove, so the check is left
						// to the recipient, which applies a despawn only to an enemy it holds itself and only
						// idempotently (src/client/enemies.js onEnemyDespawn). Wire shape (frozen):
						// { owner, list: [{ id }] }.
						const despawnList = Array.isArray(msg.list) ? msg.list : null;
						if (netDebugEnabled())
							netDebug(`in enemy_despawn from=${shortId(playerId)} entries=${despawnList === null ? 0 : despawnList.length}`);
						// Nothing to despawn: no frame, in particular no empty one (the same rule as the
						// handoff case above).
						if (despawnList === null || despawnList.length === 0)
							break;
						// The sender's own claim is never relayed -- the socket identity is the id the
						// recipients gate and log on, exactly as in the ENEMY_STATE / ENEMY_HANDOFF cases.
						msg.owner = playerId;
						// Everything cached about these enemies goes with them: the owner has just killed
						// them, so a later proximity pass must not reason about where the corpses were,
						// hold a stale claim on one, or believe one is still busy. The map's enemy count
						// (not the session's) is what bounds the caches.
						forgetEnemyFacts(despawnList);
						broadcast(msg, socket);
						break;
					}

					case MSG.ENEMY_RESPAWN: {
						// One-shot "the enemy population of this map has reset" from a client that just rested.
						// Its rest cleared its own per-client enemy dead-set and respawned its spots, and every
						// other client has to run the same reset or it is left simulating a map whose enemies
						// are gone (src/client/enemies.js applyLocalRespawn). Relayed on the same coop trust as
						// revive/area_heal: it describes a world event, not an enemy's ownership, so there is
						// nothing for the arbiter to validate. Broadcast is already EVERY connected client
						// (not room-scoped), which is what Sam's "for every player on every map" reset needs;
						// the client half is what must stop ignoring a reset for a map it is not on.
						// Nothing is re-arbitrated here either -- the respawned enemies are re-registered by
						// each client's normal registration diff, which is what re-splits their room.
						// Wire shape (frozen): { from, map, variant }.
						const respawnMap = typeof msg.map === "string" ? msg.map : "";
						if (netDebugEnabled())
							netDebug(`in enemy_respawn from=${shortId(playerId)} map=${respawnMap || "(none)"} variant=${msg.variant ?? null}`);
						// A reset that names no map cannot be applied by anyone: no frame.
						if (respawnMap === "")
							break;
						// The sender's own claim is never relayed -- the socket identity is the id the
						// recipients log on, exactly as in the ENEMY_STATE / ENEMY_HANDOFF / ENEMY_DESPAWN cases.
						msg.from = playerId;
						// A rest is a FULL RESET, so every cached enemy fact dies with it: positions,
						// the busy/aggro flags and the attack claims are all about enemies that this
						// event has just put back on their spawn spots. Keeping them would let a stale
						// claim re-home a fresh enemy and a stale `busy` pin an enemy nobody is
						// swinging at. Cleared GLOBALLY, not just for the rester's map: the reset is
						// world-wide by design (Sam: "for every player on every map it should
						// completely respawn and reset all enemies"), so a fact cached for any other
						// map is just as stale.
						forgetAllEnemyFacts();
						broadcast(msg, socket);
						break;
					}

					case MSG.ENEMY_HIT: {
						// A hit that landed on an enemy the SENDER does not simulate: its local damage is
						// suppressed on its own side, so the hit has to be applied by whoever owns that
						// enemy (src/client/enemies.js onEnemyHit, queued by the onHit seam in
						// src/client/enemy-puppet.js). Relayed on the same coop trust as revive/area_heal:
						// ANY client may hit any enemy, so there is nothing about an ownership claim here
						// for the arbiter to validate -- and the sender is, by construction, never the
						// owner of the enemies in the frame. The recipient is what makes it safe: it
						// applies an entry only to an enemy it holds itself, and only once. Batched per
						// frame like ENEMY_STATE. Wire shape (frozen): { owner, list: [{ id, attacker,
						// dmgFactor, element, weaponKey, level, impact, fly, fx, triggerFactor,
						// statusFactor, spGain, hints, hitPause, hitPoint, hitVel, hitDir, hitRotDir,
						// part, ranged }] }.
						const hitList = Array.isArray(msg.list) ? msg.list : null;
						if (netDebugEnabled())
							netDebug(`in enemy_hit from=${shortId(playerId)} entries=${hitList === null ? 0 : hitList.length}`);
						// Nothing to apply: no frame, in particular no empty one (the same rule as the
						// handoff/despawn cases above).
						if (hitList === null || hitList.length === 0)
							break;
						// The sender's own claim is never relayed -- the socket identity is the id the
						// recipients attribute the hit to, exactly as in the ENEMY_STATE / ENEMY_HANDOFF /
						// ENEMY_DESPAWN cases.
						msg.owner = playerId;
						// ...and this frame is where an ATTACK CLAIM is recorded (the aggro rebuild): the
						// sender has just hit an enemy it does NOT simulate -- that is what enemy_hit means,
						// a suppressed local hit -- so it is asking, in effect, for that enemy to come and
						// fight it, which is Sam's "I can pummel all the enemies of another player and they
						// will not aggro on me". Keyed by the SOCKET identity, the one the server can vouch
						// for (an entry's own `attacker` is the same value from an honest client, but it is
						// only its word). The claim REGISTERS instantly and the SWITCH lands at the next
						// proximity tick, where the arbiter applies it to a claimant that is an eligible
						// candidate and an enemy that is not busy (src/server/enemy-ownership.js).
						const claimAt = Date.now();
						for (const entry of hitList) {
							if (entry && typeof entry.id === "string" && entry.id.length > 0)
								enemyClaims.set(entry.id, { playerId, at: claimAt });
						}
						if (netDebugEnabled())
							netDebug(`claim [${hitList.map((entry) => entry?.id ?? "?").join(", ")}] by ${shortId(playerId)}`);
						broadcast(msg, socket);
						break;
					}

					case MSG.ENEMY_UNREGISTER:
						// The enemy no longer exists for THIS client (its death resolved, or its map unloaded):
						// withdraw it. Records other clients still hold survive the withdrawal (see
						// enemy-ownership.js unregister()), so an enemy the other client can still see keeps
						// both its owner and its epoch instead of being re-registered from scratch. Nothing is
						// reassigned -- a removal never moves load around.
						const dropped = enemyOwnership.unregister(msg.ids, playerId);
						// The enemy is no longer anywhere on this client's screen (it died there, or its
						// map unloaded), so everything cached about it is stale for the proximity pass
						// whether or not the record survives this withdrawal: its position, its busy/aggro
						// flags and any claim on it. Dropping them bounds the caches to the enemies that are
						// live RIGHT NOW, and costs nothing: a surviving owner re-fills the position and the
						// flags on the same frame.
						forgetEnemyFacts(msg.ids);
						if (netDebugEnabled())
							netDebug(`in enemy_unregister [${(msg.ids ?? []).join(", ")}] from=${shortId(playerId)} -> ${dropped} record(s) dropped, ${(msg.ids ?? []).length - dropped} still held elsewhere`);
						break;

					case MSG.ENEMY_WAKE: {
						// "Wake these enemies" from an owner whose own client just stirred a group: the
						// engine's group aggro (CombatManager.aggroNearbyEnemy, combat.js:226-271) wakes
						// only the members the SIMULATING client owns, so the rest of a group -- the ones
						// the peer owns -- would stay calm. The client that saw the aggro lists the group
						// members that need waking (it has the group and radius data; the server does not,
						// and deliberately does not compute groups); the server relays the ids verbatim,
						// exactly like the other enemy relays: `from` stamped to the SENDER'S SOCKET, the
						// sender excluded (it already woke its own). No arbiter check -- the recipient
						// wakes only enemies it holds itself, and idempotently, so a wrong or stale id is
						// a no-op there rather than anything this side has to authorise. Wire shape:
						// { from, ids: [<enemy id>] }.
						const wakeIds = Array.isArray(msg.ids) ? msg.ids : null;
						if (netDebugEnabled())
							netDebug(`in enemy_wake from=${shortId(playerId)} ids=${wakeIds === null ? 0 : wakeIds.length}`);
						// Nothing to wake: no frame, in particular no empty one (the same rule as the
						// handoff/despawn/hit cases above).
						if (wakeIds === null || wakeIds.length === 0)
							break;
						msg.from = playerId;
						broadcast(msg, socket);
						break;
					}

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
			playerRooms.delete(playerId);
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
			playerRooms.delete(playerId);
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
		// The cadence started with this instance even though it never listened: leaving it
		// running would keep re-arbitrating (and reading) a session that does not exist.
		stopOwnershipTimer();
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
		// Also the cadence's stop: 'close' is the last word on this instance, whichever path
		// got here (stopServer clears it first, which makes this a no-op), and a timer left
		// running past it would tick against an emptied world forever.
		stopOwnershipTimer();
		if (server === srv)
			server = null;
	});

	return ready;
}

function stopServer() {
	if (!server) return;
	// Stop the proximity cadence first: it arbitrates over the state the next two lines are
	// about to empty, and a tick landing in between would publish owners for a session that is
	// already ending.
	stopOwnershipTimer();
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
	playerRooms.clear();
	// The enemy facts and claims go with the session they were gathered in: they are keyed by
	// enemy id, which the next session's clients re-announce from scratch, so a kept entry could
	// only mislead the next session's first ticks.
	forgetAllEnemyFacts();
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
