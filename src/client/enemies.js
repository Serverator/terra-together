/**
 * src/client/enemies.js
 * Enemy identity, registry and ownership bookkeeping, and the state wiring on top of it: the
 * client half of the enemy-sync split (announce the enemies this client can see, learn who the
 * server assigned to simulate each of them, publish the state of the ones we own, drive the
 * ones we do not from the owner's snapshots). The only thing this module changes about an
 * enemy is the one it drives as a puppet: everything else is observation and bookkeeping.
 * Responsibilities:
 *   - The canonical enemy identity helper enemyStableId() (moved here from
 *     ../debug/enemy-debug.js, which now imports it) and the wire-safe subset of those ids.
 *   - Per-frame enumeration of the live enemies -> announce new ones (enemy_register) and
 *     withdrawn ones (enemy_unregister), on change only.
 *   - The enemyId -> { registered, owner, epoch } registry, fed by the server's enemy_owner
 *     broadcast and guarded against stale epochs.
 *   - The readers the debug overlay consumes: isOwner() / getEnemyOwnerName().
 *   - Owner half of the state sync: one MSG.ENEMY_STATE per frame carrying every enemy this
 *     client owns, and nothing at all when it owns none or has no peer to send to.
 *   - Peer half: accept state only from an enemy's CURRENT owner, drive that enemy through
 *     ./enemy-puppet.js while the state is fresh, and release the puppet as soon as it is not
 *     (see PEER_STATE_FRESH_MS — the anti-freeze guarantee).
 * Public surface: ENEMY_SYNC_OPTION, enemyStableId, isEnemySyncEnabled, onEnemyOwner,
 *   onEnemyState, isOwner, getEnemyOwnerName, EnemySync
 * Engine touchpoints: terra.addAddon (../main.js registers EnemySync at onGameMapStart /
 *   onPreUpdate / onPostUpdate 35010), terra.export g_options / g_gState.entities /
 *   g_game.map.active.path / g_scene.isRunning / EnemyCmp (and, through it, each enemy's
 *   sourceEntity.core, which is where identity comes from); ./enemy-puppet.js, which owns the
 *   prototype patches and the actual puppet drive; window.terraTogether.playerId / playerNames
 *   (published by ./session.js); performance.now() (the freshness clock). Inbound routing:
 *   ./client.js (see the note at the handler registration below).
 * Notes: the module is a no-op, and holds no state, while its option is off or the client is
 *   not connected, which is what makes it safe to default on. Off or disconnected, its puppets
 *   are released too, so no enemy can stay suppressed (or frozen) because this module stopped
 *   running. The option KEY is declared here as a literal instead of being imported from
 *   ../config/settings.js: that module imports ../debug/enemy-debug.js, which imports this
 *   one, so importing back would close a cycle (same reason ENEMY_DEBUG_OPTION is a literal
 *   in ../debug/enemy-debug.js).
 */

import { send, isConnected, addPeerMessageHandler } from "./client.js";
import { getRogueInfo, hasPeers } from "./session.js";
import { MSG } from "../net/protocol.js";
import {
	installPuppetPatches, makePuppet, releasePuppet, readEnemyState, drivePuppet,
} from "./enemy-puppet.js";

// The option key declared in ../config/settings.js (see the header note on why it is a
// literal here). Read through g_options.get(), which hands back the stored value as-is.
export const ENEMY_SYNC_OPTION = "tt-enemy-sync";

// The username option, same source ../debug/enemy-debug.js uses to name the local player.
const USERNAME_OPTION = "tt-username";

// Name shown when the local player has not set a username; matches the overlay's fallback so
// both surfaces name the local player the same way.
const LOCAL_FALLBACK_NAME = "Player";

// Epoch of "no assignment seen yet" for an enemy in the registry. The server starts real
// epochs at 1 (server/enemy-ownership.js), so a first assignment always beats this.
const NO_EPOCH = 0;

// How long a peer's enemy state stays usable — the anti-freeze threshold, and the number this
// phase turns on. The owner publishes every frame (MSG.ENEMY_STATE, ~16ms apart at 60fps), so
// healthy state is a frame or two old; 500ms is roughly thirty missed frames, i.e. far past
// ordinary lag and into "that owner is not simulating this enemy any more": a hitch, a
// disconnect, or an owner that never had the enemy to begin with. Below the threshold the peer
// drives the enemy from the snapshot; at or above it the peer RELEASES the puppet and the
// enemy resumes its own local simulation. That fallback is deliberate and load-bearing: a
// failed sync must degrade to "both clients simulate this enemy" (harmless-ish, and
// self-correcting as soon as state flows again), never to an enemy frozen at the last state
// that did arrive.
const PEER_STATE_FRESH_MS = 500;

// True while the feature is on. Strict `=== true`, like the overlay's flag test: only a real
// boolean switches it on, and an option that was never seeded counts as off.
export function isEnemySyncEnabled() {
	return terra.export.g_options?.get(ENEMY_SYNC_OPTION) === true;
}

// Whitespace/command sanitising for network-supplied text, mirrored from
// ../debug/enemy-debug.js: `{...}` are text commands in this engine's text blocks, so a
// crafted username must not reach a label (or any other consumer) verbatim.
function cleanText(value) {
	if (value == null)
		return null;
	const text = String(value).replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
	return text === "" ? null : text;
}

// The local player's server-assigned id, as the string the wire contract uses for an owner.
// null while offline (the runner has not sent WELCOME yet).
function localPlayerId() {
	const id = window.terraTogether?.playerId;
	return id == null ? null : String(id);
}

// ────────────────────────────── enemy identity ──────────────────────────────

// The map-scoped identity of the enemy's SOURCE SPOT — `m:<mapPath>#<mapId>` — or null when
// this entity is not a map-placed spot, or its map is not known yet.
//
// Identity MUST come from the spot, never from the enemy entity itself. Every fightable enemy
// is a runtime-created TerraActor: EnemySpotEntity.spawnEnemy()
// (features/enemies/entity/enemy-spot-entity.js) builds one with `new TerraActor()`, i.e. with NO
// map settings, and never reconstructs it with any, so the actor's own core keeps the
// CoreCmp.reset() default mapId 0 and a null gMap (engine/entity/core-cmp.js). Keying on that
// core collapses EVERY enemy on a map onto the single id `m:<mapPath>#0`. The spot that spawned
// it is a real map-placed entity, and spawnEnemy() sets `enemy.sourceEntity` to it before the
// actor joins the entity list, so it is always populated for spot-spawned enemies. Its mapId is
// the index the map file gave that entity (game-map.js: `entry.mapId = parseInt(id)`), so 0 is a
// real id and the test has to be `>= 0`; its gMap gives the map's data path. That (mapPath,
// mapId) pair is exactly what the engine itself keys on: respawn-tracker.js trackEntity() /
// hasEntity() use (core.gMap.path, core.mapId), and the per-spot dead flag is
// `session.map._enemySpot.<sourceEntity.core.mapId>` (enemy-spot-entity.js getVarName(), written
// on defeat). An enemy spawned by the spawner rather than a spot (an act add) has no
// sourceEntity and only the client-local id `u:<core.uid>`.
//
// gMap is null while the spot is detached and while no map is loaded (the map object can be
// missing outright), so the path falls back to the active map's data path and can be "". An id
// whose map half is empty is not an identity, so it degenerates to `u:<uid>`. uid is a
// per-process counter (`++Entity.globalUid`), unique inside one client but NOT correlated across
// clients — such enemies may show different owners per client until the real ownership scheme
// lands, and they are not wire-addressable (see wireEnemyId). The `?? "?"` on the uid is only
// there so a uid-less entity cannot put the string "undefined" in an id.
//
// KNOWN GAP — deliberately deferred to Phase 2; do NOT "fix" it by changing this format here.
// The id is not scoped to the rogue variant, so the same map path in two different variants
// gives the same mapId the same id. The engine's own disambiguator for that is the room UID in
// getVarName() (`session.map._rogue_enemySpot.<mapId>_<roomUid>`), which is engine-local and not
// part of the wire format. The ROOM key the server arbitrates against IS variant-scoped
// (`<map>#<variant>`), so the two clients register the one id into their two
// rooms and the server de-dupes them onto whichever registered first: one client ends up owning
// an enemy that exists (independently) on both variants. It is rogue-only, and it stays because
// both halves of every surface are built on this format; Phase 2 syncs state and will treat the
// variant as part of enemy identity, which is the change that closes the gap.
function enemySpotId(core) {
	const src = terra.export.EnemyCmp?.get?.(core?.ent)?.sourceEntity;
	const mapPath = src?.core?.gMap?.path ?? terra.export.g_game?.map?.active?.path ?? "";
	const mapId = src?.core?.mapId;
	if (mapPath === "" || typeof mapId !== "number" || mapId < 0)
		return null;
	return "m:" + mapPath + "#" + mapId;
}

// The enemy's stable identity — the same string on every client for the same enemy.
// (Lives here, not in ../debug/enemy-debug.js, which imports it from this module.) It is the
// spot's map-scoped id when there is one, so it can never disagree with the wire id below, and
// the client-local `u:<uid>` otherwise.
export function enemyStableId(core) {
	return enemySpotId(core) ?? "u:" + (core?.uid ?? "?");
}

// The subset of those identities that may travel on the wire: exactly the
// `m:<mapPath>#<mapId>` form the frozen contract defines, i.e. an enemy whose map-placed spot is
// known and still carries its map path and mapId. A runtime spawn (no sourceEntity, so only
// `u:<uid>`, unique per process but not correlated across clients) and a spot whose map path or
// mapId is missing (map unloading, or a detached spot) would each hand the server an id that
// means a different enemy on every client, so neither is announced in Phase 1 — the design gives
// runtime spawns an owner-minted id in a later phase. Those enemies simply have no known owner
// here, and the overlay keeps labelling them with its local rendezvous hash. Reading the same
// resolution as enemyStableId() is what keeps the two from ever disagreeing about which enemies
// are addressable.
function wireEnemyId(core) {
	return enemySpotId(core);
}

// ──────────────────────────────── entity plumbing ────────────────────────────────

function isWorldSceneActive() {
	return !!terra.export.g_scene?.isRunning?.() && !terra.export.g_scene?.isCutscene?.();
}

// Data path of the map in play, "" while no map is loaded. The same expression enemySpotId()
// reads for an id's map half, factored out so the register and the state publish read the map
// the same way instead of each spelling out the lookup.
function activeMapPath() {
	return terra.export.g_game?.map?.active?.path ?? "";
}

// A live enemy = an entity carrying an EnemyCmp whose combatant is alive. Same guards as the
// debug overlay (../debug/enemy-debug.js getLiveEnemy) so both agree on which enemies exist:
// entities that have not finished initialising (no combatant yet) and already-killed entities
// are skipped.
function getLiveEnemy(core) {
	if (!core || !core.ent || core.isKilled?.())
		return null;
	const enemy = terra.export.EnemyCmp?.get?.(core.ent);
	if (!enemy || !enemy.combatant)
		return null;
	if (typeof enemy.isAlive === "function" && !enemy.isAlive())
		return null;
	return enemy;
}

// ─────────────────────────────────── registry ───────────────────────────────────

// enemyId -> { registered, owner, epoch }.
//   owner      the server-assigned owner's playerId as a string, or null while unassigned.
//   epoch      that assignment's version (NO_EPOCH until one arrives); a lower epoch is a
//              superseded assignment and is dropped (see onEnemyOwner).
//   registered whether THIS client has announced the enemy to the server. An entry can
//              predate that: enemy_owner is broadcast to every client in the room, so a
//              client can learn about an enemy another client registered first.
const registry = new Map();

// Drop every entry without telling the server. Used while the feature is off or the
// connection is down: `send()` drops silently while closed, so nothing we "registered" in a
// previous connection survives server-side, and the next enabled frame re-announces whatever
// is live. Holding no state then also keeps isOwner()/getEnemyOwnerName() honest: with no
// connection there is no assignment to report, and the overlay falls back to its local label.
function clearRegistry() {
	registry.clear();
}

// ──────────────────────────────── peer state ────────────────────────────────

// Inbound state by enemy id: { state, at, from }. `state` is the owner's readEnemyState()
// object, kept exactly as received (nothing here rewrites it); `at` is the clock reading it
// arrived at (PEER_STATE_FRESH_MS is measured against that); `from` is the owner that sent it,
// so state whose sender stops being the owner can be dropped. One small object per enemy per
// message is the only allocation this half adds.
const peerState = new Map();

// The enemies THIS client is currently driving as puppets: enemyId -> entity. Kept so every
// release path (stale state, ownership change, enemy gone, map change, disconnect, flag off)
// can undo exactly what was done without a second enumeration of the entity list, and so
// makePuppet() is called only on the transition into a puppet rather than every frame. The
// module does not need to consult the puppet module's isPuppet(): this map is its own record of
// what it puppeted.
const puppets = new Map();

// Drop every stored peer state. Part of the reset path: state stored for the map we are leaving
// can never be applied to the next one.
function clearPeerState() {
	peerState.clear();
}

// Release every puppet and forget it. Called on every cleanup path: an enemy still puppeted
// after its owner went away, or left puppeted across a map change, is exactly the frozen enemy
// this module must not ship.
function releaseAllPuppets() {
	if (puppets.size === 0)
		return;
	for (const ent of puppets.values())
		releasePuppet(ent);
	puppets.clear();
}

// The prototype patches that make the puppet flag mean anything. Installed exactly once, never
// per frame: at map start while the feature is on, or — for a flag switched on mid-map, which
// never sees another map start — just before the first makePuppet(). installPuppetPatches() is
// idempotent on its own side; this guard keeps even the call off the hot path.
let puppetPatchesInstalled = false;
function ensurePuppetPatches() {
	if (puppetPatchesInstalled)
		return;
	puppetPatchesInstalled = true;
	installPuppetPatches();
}

// The freshness clock: wall-clock milliseconds, monotonic and independent of the frame rate,
// which is what lets the threshold be a duration rather than a frame count (one slow frame must
// not look like a silent owner).
function nowMs() {
	return performance.now();
}

// The enemy's current owner per the registry (null while unassigned or unknown).
function currentOwner(enemyId) {
	return registry.get(enemyId)?.owner ?? null;
}

// Copy the variant currently in play (null outside a rogue run), i.e. the second half of the
// `<map>#<variant>` room key the server arbitrates a registration against. ./session.js owns
// how it is read.
function roomVariant() {
	return getRogueInfo().variant;
}

// The per-frame diff: announce what appeared, withdraw what vanished, send nothing otherwise.
// Returns the live wire-addressable enemies as enemyId -> core, for the two state halves below
// (each needs the entity behind an id: one to read its state, one to drive it), or null on a
// frame that was skipped or gated off — the signal to touch nothing this frame.
function syncEnemies() {
	// Gated: switched off or offline. Nothing is enumerated, nothing is sent, and every piece of
	// state this module holds goes with it — the registry (see clearRegistry), the peer state,
	// and the puppets: with the feature off, or the connection gone, no enemy may stay
	// suppressed or driven by a snapshot nobody will refresh.
	if (!isEnemySyncEnabled() || !isConnected()) {
		clearRegistry();
		clearPeerState();
		releaseAllPuppets();
		return null;
	}
	const map = activeMapPath();
	// A map mid-transition / a paused world: the entity list is not the world it will be, and
	// the map path an id is built from may not be the one the entities came from. Skip the
	// frame instead of reporting on it, and keep the registry: the sweep below would read the
	// transition as a mass despawn. Peer state and puppets are kept too — driving or releasing
	// an entity out of a list that is being rebuilt is exactly the frame it must not happen on.
	if (map === "" || !isWorldSceneActive())
		return null;

	const live = new Map();
	const added = [];
	for (const core of terra.export.g_gState?.entities ?? []) {
		if (!getLiveEnemy(core))
			continue;
		const id = wireEnemyId(core);
		if (id === null)
			continue;                      // runtime spawn / unknown map: not wire-addressable
		live.set(id, core);
		const entry = registry.get(id);
		if (entry) {
			// Known enemy: only an entry we learned from the server still needs announcing.
			if (entry.registered)
				continue;
			entry.registered = true;
			added.push(id);
			continue;
		}
		registry.set(id, { registered: true, owner: null, epoch: NO_EPOCH });
		added.push(id);
	}

	const gone = [];
	for (const [id, entry] of registry) {
		if (live.has(id))
			continue;
		// Only an enemy we announced is ours to withdraw; an entry we merely learned about
		// from the server is dropped locally.
		if (entry.registered)
			gone.push(id);
		registry.delete(id);
	}

	// Registers are one message per enemy (the contract carries id + room per id); the
	// vanished ids ride in a single unregister. Room variant is read once, and only when there
	// is something to announce.
	if (added.length > 0) {
		const variant = roomVariant();
		for (const id of added)
			send({ type: MSG.ENEMY_REGISTER, id, map, variant });
	}
	if (gone.length > 0)
		send({ type: MSG.ENEMY_UNREGISTER, ids: gone });

	return live;
}

// ─────────────────────── owner half: publish our state ───────────────────────

// One MSG.ENEMY_STATE per frame, carrying every enemy this client is the assigned owner of in
// a single `list` (the frozen payload). Run after the frame's update, so what a peer receives
// is the state this frame produced. Silent when there is nothing to say: no enemy we own, no
// peer to say it to, or no enemy whose state could be read. Playing alone must not put anything
// on the wire — an owner with no peers has nobody to keep in sync, and the whole point of the
// split is that only the owner's word is authoritative, so there is nothing to fall back to.
function sendOwnerStates(live) {
	if (!live || live.size === 0 || !hasPeers())
		return;
	const list = [];
	for (const [id, core] of live) {
		if (!isOwner(id))
			continue;
		const state = readEnemyState(core.ent);
		// An enemy whose state cannot be read simply does not appear: the peer's copy of it goes
		// stale and resumes local simulation, which is better than publishing a half state.
		if (state)
			list.push(state);
	}
	if (list.length === 0)
		return;
	// `owner` is our own playerId — the identity the server validates the sender against and
	// the one every recipient gates on. `map`/`variant` name the room this state belongs to,
	// exactly as the register does (they are part of the frozen payload both directions).
	send({ type: MSG.ENEMY_STATE, owner: localPlayerId(), map: activeMapPath(), variant: roomVariant(), list });
}

// ───────────────────── peer half: drive what we do not own ─────────────────────

// The per-frame peer half, run before the frame's own update. For every live enemy this client
// does NOT own: drive it from the owner's state while that state is fresh, and release it back
// to local simulation the moment it is not. The release branch is not an error path — it is the
// normal outcome of an owner going quiet, and it is what turns a failed sync into "both
// clients simulate this enemy" instead of a frozen one.
function applyPeerState(live) {
	if (!live)
		return;
	const now = nowMs();
	for (const [id, core] of live) {
		const ent = core.ent;
		// Ours: never a puppet. Becoming the owner (a rebalance) releases the enemy and starts
		// simulating and publishing it instead.
		if (isOwner(id)) {
			if (puppets.delete(id))
				releasePuppet(ent);
			continue;
		}
		let entry = peerState.get(id);
		// State whose sender is no longer the enemy's owner is stale by definition (the
		// assignment moved since it arrived), so it is dropped rather than applied.
		if (entry && entry.from !== currentOwner(id)) {
			peerState.delete(id);
			entry = undefined;
		}
		const age = entry ? now - entry.at : Infinity;
		if (entry && age < PEER_STATE_FRESH_MS) {
			if (!puppets.has(id)) {
				ensurePuppetPatches();
				makePuppet(ent);
				puppets.set(id, ent);
			}
			drivePuppet(ent, entry.state);
			continue;
		}
		// No usable state: nobody owns this enemy right now, the owner has gone quiet (or never
		// had it), or its state predates the current assignment. Simulate it locally again.
		if (puppets.delete(id))
			releasePuppet(ent);
	}
	// Enemies that are gone (killed, unloaded, or no longer wire-addressable): nothing to drive,
	// and nothing may stay suppressed. Their stored state goes too, or it would be applied to
	// whatever holds the same id on the next map.
	for (const [id, ent] of puppets) {
		if (live.has(id))
			continue;
		puppets.delete(id);
		releasePuppet(ent);
	}
	for (const id of peerState.keys()) {
		if (!live.has(id))
			peerState.delete(id);
	}
}

// The map is gone: every id we announced embeds the old map path, so none of them can come
// back, and the server's records for them should not outlive it. The new map's own enemies are
// announced by the next frame's diff. Peer state and puppets go with it — the same ids on the
// new map would otherwise resume driving from state read on the old one — and any enemy still
// puppeted is released, which is the last thing standing between a map change and a frozen
// enemy.
function resetForNewMap() {
	clearPeerState();
	releaseAllPuppets();
	if (registry.size === 0)
		return;
	const ids = [...registry.keys()];
	registry.clear();
	send({ type: MSG.ENEMY_UNREGISTER, ids });
}

// ─────────────────────────── inbound owner assignment ───────────────────────────

// Inbound MSG.ENEMY_OWNER (server -> all): the authoritative answer to a registration, or the
// reassignment that replaced it. Routed here from ./client.js.
export function onEnemyOwner(msg) {
	if (!isEnemySyncEnabled())
		return;
	const id = msg?.id;
	if (typeof id !== "string" || id === "")
		return;
	const epoch = Number(msg?.epoch);
	if (!Number.isFinite(epoch))
		return;
	const owner = msg.owner == null ? null : String(msg.owner);

	const entry = registry.get(id);
	if (!entry) {
		// An assignment for an enemy we have not announced: the broadcast goes to every client
		// in the room, so another client got there first. Remember it, and announce our own
		// registration on the next frame (registered: false drives that).
		registry.set(id, { registered: false, owner, epoch });
		return;
	}
	// Stale-guard: the server bumps the epoch on every reassignment, so an older epoch is an
	// assignment that has already been replaced and must not overwrite a newer one. Equal
	// epochs are the same assignment arriving twice and are applied harmlessly.
	if (epoch < entry.epoch)
		return;
	entry.owner = owner;
	entry.epoch = epoch;
}

// ──────────────────────────── inbound peer state ────────────────────────────

// Inbound MSG.ENEMY_STATE (owner -> everyone but the sender, relayed after the server has
// checked the sender against the assignment): the owner's snapshot of the enemies it simulates.
// Routed here from ./client.js. Nothing is APPLIED from here — this only records what arrived
// and when; the per-frame peer half decides whether it is still worth using, and releases the
// enemy when it stops arriving.
export function onEnemyState(msg) {
	if (!isEnemySyncEnabled())
		return;
	const owner = msg?.owner == null ? null : String(msg.owner);
	if (owner === null)
		return;
	const list = msg?.list;
	if (!Array.isArray(list))
		return;
	const now = nowMs();
	for (const state of list) {
		// Malformed and partial entries are skipped, never thrown on: a peer's payload must not
		// be able to break this frame, not even the one it arrives in.
		if (!state || typeof state !== "object")
			continue;
		const id = state.id;
		if (typeof id !== "string" || id === "")
			continue;
		// The cheap correctness gate: only the enemy's CURRENT owner may speak for it. The
		// server validates the same thing before relaying, so this mainly catches what arrives
		// after an assignment has moved (applyPeerState drops that too, on the next frame) — and
		// an id we do not hold at all, such as another room's enemy, fails it as well.
		if (currentOwner(id) !== owner)
			continue;
		peerState.set(id, { state, at: now, from: owner });
	}
}

// ─────────────────────────────── public readers ───────────────────────────────

// True when the local player is the server-assigned simulator of `enemyId`. False for an
// unknown or unassigned enemy, while offline, and while the feature is off (nothing here
// claims an enemy by accident: owner null and local id null must not compare equal, and a
// disabled module reports no assignment even before the next frame clears the registry).
export function isOwner(enemyId) {
	if (!isEnemySyncEnabled())
		return false;
	const owner = registry.get(enemyId)?.owner;
	if (owner == null)
		return false;
	const localId = localPlayerId();
	return localId !== null && owner === localId;
}

// The display name of the assigned owner, or null when there is no assignment to name
// (feature off, offline, not yet assigned, enemy unknown). The local player is named from
// their own tt-username option, like the overlay; a peer's name comes from the server-relayed
// playerNames map, and is null when that peer has never sent one.
export function getEnemyOwnerName(enemyId) {
	if (!isEnemySyncEnabled())
		return null;
	const owner = registry.get(enemyId)?.owner;
	if (owner == null)
		return null;
	const localId = localPlayerId();
	if (localId !== null && owner === localId)
		return cleanText(terra.export.g_options?.get(USERNAME_OPTION)) ?? LOCAL_FALLBACK_NAME;
	// playerNames is keyed by the server's numeric ids (./session.js), while an owner is the
	// string form of one; either lookup may be the one that hits.
	const names = window.terraTogether?.playerNames;
	return cleanText(names?.get(owner) ?? names?.get(Number(owner))) ?? null;
}

// Routed by ./client.js, which the composition root owns: this module cannot be imported
// there (it imports send() from it), so it registers its handlers instead. Keeps the client
// module graph a DAG. ./session.js has the inbound cases that hand these two types to
// ./client.js (see the dispatch there).
addPeerMessageHandler(MSG.ENEMY_OWNER, onEnemyOwner);
addPeerMessageHandler(MSG.ENEMY_STATE, onEnemyState);

// ──────────────────────────────────── addon ────────────────────────────────────

// The per-frame loop, in two halves. onPreUpdate reads the frame's opening set — a freshly
// loaded map's enemies are announced before this frame's update consumes them — and drives the
// enemies this client does not own from the owner's state, before that same update runs, so a
// release lands in time for the enemy to simulate this frame rather than the next. onPostUpdate
// runs the same identity diff (so enemies the frame itself spawned or killed are reported in the
// frame that did it) and then publishes this frame's state for the enemies we own. The diff is
// silent when nothing changed, so registering still costs one message per identity change; only
// the state publish is per-frame, and only while there is a peer and something we own to send.
class EnemySync {
	onGameMapStart() {
		resetForNewMap();
		// The map is the moment this module knows a world is about to be simulated, so the puppet
		// patches go in here — once, and only while the feature is on (see ensurePuppetPatches
		// for the mid-map case).
		if (isEnemySyncEnabled())
			ensurePuppetPatches();
	}

	onPreUpdate() {
		applyPeerState(syncEnemies());
	}

	onPostUpdate() {
		sendOwnerStates(syncEnemies());
	}
}

export { EnemySync };

//# sourceURL=/mods/terra-together/client/enemies.js
