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
 *   - Handoff half: when the server moves an enemy away from this client, hand that enemy's final
 *     state on in one MSG.ENEMY_HANDOFF (see sendHandoffs); when it moves one TO this client,
 *     adopt the previous owner's state (a handoff, else the freshest cached peer state) onto the
 *     local entity before simulating it, so a re-entering client does not reset the enemy to its
 *     spawn point (see takeOwnership).
 *   - Peer half: accept state only from an enemy's CURRENT owner, drive that enemy through
 *     ./enemy-puppet.js while the state is fresh, and release the puppet as soon as it is not
 *     (see PEER_STATE_FRESH_MS — the anti-freeze guarantee).
 *   - Death/despawn half (Phase 4): detect that an enemy THIS client owns has been definitively
 *     beaten (the one engine seam that cannot fire for a disengaging enemy, see the patch note on
 *     onEnemyDeathHit) and announce it in one MSG.ENEMY_DESPAWN (sendDespawn); and, on the
 *     receiving side, take such an enemy out of this client's world and record it in the engine's
 *     own per-spot dead-set so it cannot come back (onEnemyDespawn).
 * Public surface: ENEMY_SYNC_OPTION, enemyStableId, isEnemySyncEnabled, onEnemyOwner,
 *   onEnemyState, onEnemyHandoff, onEnemyDespawn, isOwner, getEnemyOwnerName, EnemySync
 * Engine touchpoints: terra.addAddon (../main.js registers EnemySync at onGameMapStart /
 *   onPreUpdate / onPostUpdate 35010), terra.export g_options / g_gState.entities /
 *   g_game.map.active.path / g_scene.isRunning / EnemyCmp (and, through it, each enemy's
 *   sourceEntity.core, which is where identity comes from), plus — for the death half —
 *   EnemyCmp.prototype.onDeathHit (the owner seam, wrapped once) and g_vars (the engine's var
 *   store, which is where the per-spot dead-set lives); ./enemy-puppet.js, which owns the
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
	installPuppetPatches, makePuppet, releasePuppet, readEnemyState, drivePuppet, adoptState,
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

// The epoch of an enemy's FIRST assignment (server/enemy-ownership.js starts the counter at 1 and
// bumps it on every move). Epoch 1 therefore means "nobody owned this enemy before", which is the
// test that tells a takeover with a previous owner (its state is worth waiting for) from the
// ordinary first assignment of a map start (there is no state anywhere to wait for).
const FIRST_EPOCH = 1;

// How long a takeover with nothing to adopt holds the enemy before it starts simulating it anyway.
// The loss and the gain ride the SAME enemy_owner broadcast, so the state the outgoing owner sends
// is one network hop away -- this covers roughly one round trip at 60fps. Deliberately counted in
// FRAMES, not milliseconds: what has to be bounded is how long an ENEMY can stay suppressed, and
// the frame loop is what ticks the hold (the same loop the enemy would be simulating in). It is a
// wait, never a wait-forever: on expiry the enemy is released and simulates from wherever it is,
// which is the same degraded outcome as before this path existed. Do not raise it much: the
// freshness window below (PEER_STATE_FRESH_MS) is the same order of magnitude, and a hold longer
// than that would outlive the state it is waiting for.
const HANDOFF_HOLD_FRAMES = 10;

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

// Opt-in trace for the handoff path. The server side is gated on window.ttEnemyNetDebug (a line
// per relayed handoff); what that cannot show is whether the client on the receiving end actually
// HAD a state to apply, which is the whole question when a takeover still looks like a teleport.
// So the client half reuses the EXISTING client enemy-debug flag (../debug/enemy-debug.js, whose
// overlay reads the same property) instead of adding a third switch: `window.ttEnemyDebug = true`
// in the devtools console turns on both. Strict `=== true`, off by default, and the flag test is
// the only cost when it is off.
function debugEnabled() {
	return window.ttEnemyDebug === true;
}

function debugLog(...parts) {
	console.log("[TT enemy-sync]", ...parts);
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

// Inbound handoffs by enemy id: the state the previous owner sent for an enemy THIS client is now
// the owner of, waiting to be spent by the takeover on the next frame (see onEnemyHandoff for the
// gate and takeOwnership for the spend). One entry per enemy, newest wins. Only ever written while
// we own the enemy, and cleared when we stop owning it or it leaves, so it can never be applied to
// an unrelated later takeover of the same id.
const handoffState = new Map();

// Enemy ids this client owns AND has already taken over -- i.e. is simulating and publishing. The
// takeover decision belongs to the transition, not to every frame: an entry is added once (adopt,
// or hold expiry) and dropped as soon as the enemy stops being ours or leaves. It doubles as the
// publish gate: an enemy this client owns but has not taken over yet must NOT be published, or the
// peer would see exactly the spawn-point snapshot this path exists to avoid.
const adopted = new Set();

// Enemy ids we own but are deliberately not simulating yet: { ent, frames }, awaiting the previous
// owner's handoff under the bounded hold above. An entry exists exactly while the entity is
// suppressed, so every release path can find the entity to un-suppress without walking the entity
// list -- and a held entity is ALWAYS released (adoption, expiry, loss, map change, feature off),
// which is what keeps this module's no-frozen-enemy promise. `ent` is the entity currently behind
// the id, not necessarily the one the entry was created with: a respawn can put a fresh entity on
// the same wire id mid-hold, so takeOwnership re-points it on every held frame.
const holding = new Map();

// Enemy ids this client was simulating until the server moved them to someone else, waiting for the
// next frame's post-update to read their final state and hand it on (sendHandoffs). One batch: the
// whole set travels as a single message, however many assignments in it moved.
const lostOwnership = new Set();

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

// Release one held entity and forget the hold. The single exit from the hold, so the puppet mark
// and the hold entry can never disagree.
function releaseHold(id) {
	const hold = holding.get(id);
	if (!hold)
		return;
	holding.delete(id);
	releasePuppet(hold.ent);
}

// Drop everything the takeover path holds: state waiting to be spent, the ids already simulating,
// the entities held mid-takeover (released) and the losses still to be handed on. Part of every
// reset that also drops the peer state -- see syncEnemies' gated branch and resetForNewMap.
function clearTakeoverState() {
	handoffState.clear();
	adopted.clear();
	lostOwnership.clear();
	for (const hold of holding.values())
		releasePuppet(hold.ent);
	holding.clear();
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
		clearTakeoverState();
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
		// Ours, but not taken over yet: either a takeover that has not run this frame or one that is
		// holding the enemy for the handoff. Our copy is not authoritative then -- it is the position
		// the previous owner's state is about to replace -- so publishing it would be exactly the
		// snap-to-spawn this path exists to prevent. See adopted and takeOwnership.
		if (!adopted.has(id))
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

// The other half of a takeover, one network hop earlier: when the server moves an enemy THIS client
// was simulating to somebody else, that enemy's final state has to travel with the assignment, or
// whoever takes it over starts from ITS OWN copy of the enemy. That is the bug this whole path is
// about -- the client that left and came back rebuilds the map, so its copy is at the spawn point.
//
// One-shot and batched: onEnemyOwner collects every enemy lost since the last frame, and this sends
// them as ONE message (matching the one enemy_owner broadcast that moved them). Silent when nothing
// was lost, when there is no peer to tell, and when no loss still has a readable state -- a dead or
// unloaded enemy has nothing to hand on, and the taker falls back to its cached state or its own
// copy, which beats a fabricated one.
function sendHandoffs(live) {
	if (lostOwnership.size === 0)
		return;
	const ids = [...lostOwnership];
	lostOwnership.clear();                 // one-shot, whatever happens below
	if (!live || !hasPeers())
		return;                            // nothing to read / nobody to tell: do not hold it for later
	const list = [];
	for (const id of ids) {
		const core = live.get(id);
		if (!core)
			continue;                      // gone locally (its death resolved, or this map unloaded)
		const state = readEnemyState(core.ent);
		if (state)
			list.push(state);
	}
	if (list.length === 0)
		return;
	if (debugEnabled())
		debugLog(`handoff: ${list.length}/${ids.length} lost ${ids.join(", ")}`);
	// `owner` is our own playerId. It is the outgoing owner by definition -- the server does NOT
	// check it against the arbiter (we have just lost these enemies), it only stamps the sender's
	// id over it, which is what a recipient compares against.
	send({ type: MSG.ENEMY_HANDOFF, owner: localPlayerId(), list });
}

// ─────────────────── owner half: announce one of our own deaths ───────────────────

// THE SEAM. `EnemyCmp.prototype.onDeathHit` (features/enemies/entity/enemy-cmp.js:1119) is the
// engine's own "this enemy has been definitively beaten" hook, and it is the only reachable one
// that a merely disengaging enemy cannot fire:
//   * it is called by the enemy's own combatant (combatant-cmp.js:988, from the damage path) and
//     by selfDestruct (:407) -- and by NOTHING else. In particular `giveUp()` does not reach it.
//   * the combatant flips its state to KILL_HIT and only then chains to it (combatant-cmp.js:978-988:
//     `if (this.state == COMBATANT_STATE.ALIVE) { ... this.state = COMBATANT_STATE.KILL_HIT; ...
//     this.callback.onDeathHit(force) }`), so one enemy's death fires it AT MOST ONCE.
//   * a kill that the engine decides to SURVIVE never gets here either: the kill-survive reaction
//     returns before HP is applied (enemy-cmp.js:850-857), so `onDeathHit` means the defeat stands.
//
// The two seams that look more authoritative both MISS that distinction, which is why this module
// does not hook them:
//   * `EnemySpotEntity.onEnemyDefeat` (enemy-spot-entity.js:304-310) is where the spot records the
//     kill -- state DEFEATED plus the per-spot dead-set variable -- but the engine reaches it from
//     `giveUp()` as well: giveUp ends in `submitDefeat()` either directly (:1151) or through
//     `disappear()` (:1148 -> :344-356, which submits too). Hooking it would make an enemy that
//     ESCAPES indistinguishable from one that died, and would delete it on the peer while the owner
//     still has it on screen. It is also reached by the scripted removals (`EnemySpotEntity.remove`,
//     :314-325, the RemoveEnemies event step) -- and every client runs its own copy of a map's
//     scripts, so those are already symmetric and must not be mirrored.
//   * `EnemyCmp.submitDefeat` (:1156) is the same call site one level up and has exactly the same
//     problem; telling a real death from a giveUp there needs the combatant state as a heuristic
//     (KILL_HIT vs ALIVE at that instant, and DYING when a dramatic zoom defers the submission --
//     combat.js:434-465, :489-494), which this seam does not need at all.
//
// CHAINING, not replacing. The raw defeat callback is NOT ours to take: `EnemySpotEntity` owns
// that single slot (`enemyEnt.enemy.setDefeatCallback(this)`, enemy-spot-entity.js:260, where
// `this` IS the spot, so `defeatCallback` is read back as `instanceof EnemySpotEntity` by the
// engine's own analytics, analytics-combat.js:126-128, and as `this.callback.onX` by the spot), and
// every enemy cmp holds it. This patch is on EnemyCmp instead and calls through to whatever was
// there with the same receiver and arguments, so the spot still receives its own `onEnemyDefeat`
// through `submitDefeat()` exactly as before -- and so does the puppet patch in ./enemy-puppet.js
// (patch (d)), which wraps this SAME method to suppress the whole death/reward chain on a peer.
// Either install order is safe: for a puppet that patch never calls through (so nothing is
// announced for a puppet's death), and this wrapper only ever announces an enemy the registry says
// THIS client owns (`isOwner`, below), which a puppet never is.
let despawnPatched = false;

// Install-once, called every frame from the addon (see onPreUpdate). Not installed alongside the
// puppet patches in ./enemy-puppet.js on purpose: those belong to the peer half and are installed
// when a puppet is first made (or at map start), while this one has to exist BEFORE an enemy can
// die locally -- and an enemy can die without this module having driven anything at all first.
function ensureDespawnPatch() {
	if (despawnPatched)
		return;
	const proto = terra.export.EnemyCmp?.prototype;
	if (!proto || typeof proto.onDeathHit !== "function") {
		// Unknown game build: leave the flag alone so a later frame can retry instead of giving up on
		// the seam for the rest of the session.
		if (debugEnabled())
			debugLog("cannot install the death patch: terra.export.EnemyCmp.onDeathHit is missing");
		return;
	}
	const original = proto.onDeathHit;
	if (original.__ttDespawnPatched !== true) {
		const wrapper = function (...args) {
			// Announce BEFORE the engine's own death work runs: the message is the one thing here that
			// cannot be repeated, and nothing the original does (rewards, screen shake, the deferred
			// defeat submission of a dramatic zoom) may delay or swallow it.
			if (isEnemySyncEnabled())
				sendDespawn(this?.ent);
			return original.apply(this, args);
		};
		wrapper.__ttDespawnPatched = true;
		proto.onDeathHit = wrapper;
	}
	despawnPatched = true;
}

// One MSG.ENEMY_DESPAWN for an enemy THIS client owns and has just beaten. Silent when the feature
// is off, while offline, for an enemy whose identity is not wire-addressable (a runtime spawn, or a
// spot whose map is already gone), and for an enemy the registry does not assign to us -- only the
// owner's word about an enemy is authoritative here, exactly as in the state publish, and the peer
// gates nothing else. Deliberately NOT gated on hasPeers(): unlike the per-frame state publish, a
// death happens once and can never be re-sent, so it must not be dropped just because the peer set
// has not been populated yet; the cost of sending it to a server with nobody to relay to is one
// small frame.
function sendDespawn(ent) {
	if (!isEnemySyncEnabled() || !isConnected())
		return;
	const id = wireEnemyId(ent?.core);
	if (id === null || !isOwner(id))
		return;
	send({ type: MSG.ENEMY_DESPAWN, owner: localPlayerId(), list: [{ id }] });
	if (debugEnabled())
		debugLog(`despawn sent for ${id}`);
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
		// simulating and publishing it instead -- through takeOwnership(), which spends whatever
		// the previous owner left for us before this frame's update runs.
		if (isOwner(id)) {
			if (puppets.delete(id))
				releasePuppet(ent);
			takeOwnership(id, ent);
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
	// The takeover bookkeeping is per-assignment, so it must not outlive one: a stored handoff, an
	// "already simulating" mark or a hold belongs to the ownership that is ending, and spending any
	// of them on a much later takeover of the same id would be worse than starting from scratch.
	for (const id of handoffState.keys()) {
		if (!live.has(id) || !isOwner(id))
			handoffState.delete(id);
	}
	for (const id of adopted) {
		if (!live.has(id) || !isOwner(id))
			adopted.delete(id);
	}
	// A hold whose enemy is gone or is no longer ours ends here: the entity is released, which is
	// the one thing a held (suppressed) enemy must never be left un-released without.
	for (const [id, hold] of holding) {
		if (live.has(id) && isOwner(id))
			continue;
		holding.delete(id);
		releasePuppet(hold.ent);
	}
}

// ────────────────────────── takeover: adopt, or hold ──────────────────────────

// Our stored peer state for `id`, if it is still fresh enough to be worth adopting. Unlike the
// per-frame peer half this does NOT require the sender to be the enemy's current owner: at a
// takeover the sender is exactly the owner we are replacing, and its last frame is the position to
// continue from. The age test is what makes that safe -- older state is a silent owner, not a
// handoff, and applying it would teleport the enemy just as badly as starting from spawn.
function freshPeerState(id) {
	const entry = peerState.get(id);
	return entry && nowMs() - entry.at < PEER_STATE_FRESH_MS ? entry.state : null;
}

// True when this enemy's assignment replaced an earlier one, i.e. it had a previous owner that may
// owe us a handoff (the arbiter starts every enemy's epoch at FIRST_EPOCH and bumps it on every
// move). A first assignment has no previous owner, so there is nothing to wait for.
function assignmentMoved(id) {
	return (registry.get(id)?.epoch ?? NO_EPOCH) > FIRST_EPOCH;
}

// The takeover path: run ONCE per enemy we own (the `adopted` mark is the guard), from the frame's
// pre-update hook, so an enemy that just changed hands continues from where the previous owner left
// it -- before this frame simulates it and before this frame's state is published.
//
// Which state to continue from, in order of preference:
//   1. a handoff from the previous owner (the state it sent on losing the enemy);
//   2. our freshest cached peer state (we may have been puppeting the enemy until a frame ago);
//   3. the entity's own local state -- already in place, so no write at all. That is the correct
//      answer for a first assignment and for a takeover with no news, and it is why the fallback
//      needs no call.
// With nothing but (3) on an assignment that DID have a previous owner, the previous owner's state
// is one network hop away, so the enemy is held instead of simulated: suppressed, unpublished, for
// at most HANDOFF_HOLD_FRAMES frames. That hold is what stops this client's own copy -- the spawn
// point, on a map it has just rebuilt -- from being published to everyone as the enemy's position.
function takeOwnership(id, ent) {
	if (adopted.has(id))
		return;                            // already simulating this enemy: nothing to do per frame
	const handoff = handoffState.get(id);
	const state = handoff ?? freshPeerState(id);
	if (state) {
		// One-shot: apply it now (this call IS "before the first simulation"), then forget it, so no
		// later takeover can re-apply a snapshot that belongs to this one.
		adoptState(ent, state);
		handoffState.delete(id);
		peerState.delete(id);
		releaseHold(id);
		adopted.add(id);
		if (debugEnabled())
			debugLog(`takeover ${id}: adopted ${handoff ? "handoff" : "cached peer"} state (x=${state.x} y=${state.y} z=${state.z})`);
		return;
	}
	// Nothing to adopt. No hold without peers (nobody to hand anything on, nobody to be wrong on),
	// and none on a FIRST assignment -- there is no previous owner and no handoff coming, so the
	// local state really is the answer. This is what keeps map start on its previous behaviour.
	if (!hasPeers() || !assignmentMoved(id)) {
		adopted.add(id);
		return;
	}
	const hold = holding.get(id);
	if (hold === undefined) {
		holding.set(id, { ent, frames: HANDOFF_HOLD_FRAMES });
		makePuppet(ent);
		if (debugEnabled())
			debugLog(`takeover ${id}: holding ${HANDOFF_HOLD_FRAMES} frames for the previous owner's handoff`);
		return;
	}
	if (hold.frames > 1) {
		hold.frames--;
		// Follow the entity behind the id. A hold is keyed by the enemy's WIRE id, and the entity
		// behind that id can be REPLACED inside the hold's window (a spot that respawns builds a
		// fresh TerraActor for the same source spot, so the same id): the entity passed in here is
		// then not the one the hold was created with. Every path that ends a hold releases
		// `hold.ent` -- releaseHold(), clearTakeoverState() and the gone/no-longer-ours sweep in
		// applyPeerState() -- so re-pointing it is what keeps the puppet mark and the hold entry
		// from disagreeing, and what stops a replacement being marked every frame and then never
		// released by anyone. See the note on releaseHold.
		hold.ent = ent;
		makePuppet(ent);                   // re-assert: physics.skip is a single-frame flag
		return;
	}
	// Bounded: the wait is over, so simulate from wherever we are. Release first, so the entity can
	// act on this very frame.
	releaseHold(id);
	adopted.add(id);
	if (debugEnabled())
		debugLog(`takeover ${id}: hold expired without a handoff, simulating from the local state`);
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
	clearTakeoverState();
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
	const localId = localPlayerId();

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
	// A LOSS: we were the simulator of this enemy and the server has just moved it elsewhere. Its
	// final state has to reach whoever takes it over, or that client -- which may have just rebuilt
	// the map this enemy lives on -- starts it from its own copy, i.e. the spawn point. Remember the
	// id for this frame's post-update (sendHandoffs), and drop the takeover bookkeeping of the
	// ownership that is ending: the two are per-assignment, and neither may be spent on a later one.
	//
	// Only an enemy we actually took over is handed on (see adopted): an assignment that moved on
	// again before we ever simulated the enemy would otherwise hand on OUR copy, and on a map this
	// client has just rebuilt that copy is the spawn point -- the very thing this message exists to
	// prevent, sent in the other direction.
	const wasLocal = entry.owner !== null && entry.owner === localId;
	entry.owner = owner;
	entry.epoch = epoch;
	if (wasLocal && !(owner !== null && owner === localId)) {
		if (adopted.has(id))
			lostOwnership.add(id);
		handoffState.delete(id);
		adopted.delete(id);
	}
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

// ─────────────────────────── inbound ownership handoff ───────────────────────────

// Inbound MSG.ENEMY_HANDOFF (previous owner -> server -> everyone but the sender): the final state
// of an enemy that just changed hands, stamped by the server with the id of the client that was
// simulating it until this same rebalance. Routed here from ./client.js.
//
// The gate is "WE are this enemy's current owner" -- deliberately NOT "the sender is the enemy's
// previous owner" (msg.owner is, by definition, a client that no longer owns it, so comparing it
// against the registry would be comparing against the wrong side), and not "is the payload's
// sender the owner our registry remembers" either, which lags the very broadcast this handoff
// answers. A handoff for an enemy somebody else owns is not ours to apply: it is dropped, and in
// particular it is NOT stored -- a state kept "just in case" would be spent on an unrelated later
// takeover, teleporting the enemy to a position from an ownership that is long over.
//
// Nothing is applied here. Storing is all this does; the per-frame takeover (takeOwnership) decides
// when the state is written onto the entity, which is what keeps every entity write on the frame
// path and ahead of the first simulation of the enemy we just took over.
export function onEnemyHandoff(msg) {
	if (!isEnemySyncEnabled())
		return;
	const list = msg?.list;
	if (!Array.isArray(list))
		return;
	for (const state of list) {
		// Malformed and partial entries are skipped, never thrown on: a peer's payload must not be
		// able to break this frame, not even the one it arrives in (same rule as onEnemyState).
		if (!state || typeof state !== "object")
			continue;
		const id = state.id;
		if (typeof id !== "string" || id === "")
			continue;
		if (!isOwner(id))
			continue;
		handoffState.set(id, state);
		if (debugEnabled())
			debugLog(`received handoff for ${id} from ${msg.owner} (x=${state.x} y=${state.y} z=${state.z})`);
	}
}

// ──────────────────────────── inbound despawn ────────────────────────────

// The engine's own record of "this spot's enemy is gone for good" is per client and lives in a
// session variable keyed by the spot: `session.map._enemySpot.<mapId>` -- or
// `session.map._rogue_enemySpot.<mapId>_<roomUid>` in a rogue run (enemy-spot-entity.js:93-97,
// written on defeat at :304-310 and read back in the spot's constructor at :79-80). Because it is
// per client, two clients can legitimately disagree about which enemies are still alive, and the
// owner's kill is the side that has to win: the peer's copy can never die on its own (its local HP
// loss and its whole death chain are suppressed, ./enemy-puppet.js patches (c)/(d)), so nothing
// else will ever correct it. This is the one place this module writes engine state on purpose, and
// it writes exactly the two engine bits that ARE that record -- the spot's own `setDefeated()`
// (:142-144, the same call its constructor makes when it reads the variable back) and the variable
// itself through the engine's var store, with `spot.getVarName()` spelling it (so the rogue prefix
// is the engine's own, not ours).
//
// Deliberately NOT applied by calling `spot.onEnemyDefeat()`: that method also runs the spot's
// `callback` (:307-309) -- the map's BattleSequence (battle-sequence.js:280-287), whose counters and
// `checkWaveCompletion` describe a wave THIS client may never have counted (its own spots trigger
// on its own player's proximity, not the owner's). Replaying the engine's defeat path wholesale
// would fire another client's battle progress here; writing the dead-set alone changes nothing
// about this client's scripts, and it is what makes the spot refuse to spawn the enemy again
// (`onEnemyTrigger` :180-195, `respawn` :152-169).
function markSpotDefeated(spot) {
	if (!spot || typeof spot.setDefeated !== "function" || typeof spot.getVarName !== "function")
		return false;
	spot.setDefeated();
	const gVars = terra.export.g_vars;
	if (gVars && typeof gVars.set === "function")
		gVars.set(spot.getVarName(), true);
	return true;
}

// The entity behind a wire id, if this client still has one. Looser than getLiveEnemy on purpose:
// the despawn path has to find an enemy that may already be dying (which is not "alive", so the
// state halves' liveness test would miss it) and must be free of every other concern.
function findCoreById(enemyId) {
	for (const core of terra.export.g_gState?.entities ?? []) {
		if (core?.ent && wireEnemyId(core) === enemyId)
			return core;
	}
	return null;
}

// Take one enemy the owner has definitively killed out of this client's world. The removal is the
// engine's own `CoreCmp.kill()` (core-cmp.js:169-195): it runs the entity's onKill chain, then
// GameState.deactivateEntity -> the deferred deactivation that unregisters the entity from the
// update/physics lists and finally buries it (:144-161). That is the same last step of every one of
// the engine's own death paths (combatant-cmp.js:369 `this.ent.core.kill()`, :417-429
// doManualKill, enemy-cmp.js:344-357 disappear(skipFx)), so nothing is left half-torn-down. NO
// reward path is involved: giveExp and dropItems hang off `EnemyCmp.onDeathHit`
// (enemy-cmp.js:1127-1130) and are not called here -- and because the death hit is not replayed
// either, a despawn cannot grant anything on this client at all.
function removeDefeatedEnemy(core) {
	const enemy = terra.export.EnemyCmp?.get?.(core?.ent);
	// The dead-set FIRST: killing the entity destroys its components' links, so the spot has to be
	// read off the enemy while the enemy is still there.
	markSpotDefeated(enemy?.sourceEntity);
	if (typeof core?.kill === "function" && !core.isKilled?.())
		core.kill();
}

// Apply one despawn, idempotently. Every case that is not "an enemy this client still holds" has to
// end here as a no-op: an id we never held, an enemy already killed or buried (so `findCoreById`
// finds nothing), and a repeat of a despawn we already applied.
function despawnEnemyLocally(enemyId) {
	const core = findCoreById(enemyId);
	if (core)
		removeDefeatedEnemy(core);

	// The per-id bookkeeping goes either way. A killed entity is no longer live, so the per-frame
	// sweeps (syncEnemies, applyPeerState) would drop all of this on the next frame anyway; doing it
	// here means the frame after a despawn starts clean, and it is the only way to drop the bookkeeping
	// of an enemy that is already gone from the entity list.
	peerState.delete(enemyId);
	handoffState.delete(enemyId);
	adopted.delete(enemyId);
	releaseHold(enemyId);                       // releases the held entity's puppet mark, if any
	const puppeted = puppets.get(enemyId);
	if (puppeted) {
		puppets.delete(enemyId);
		releasePuppet(puppeted);
	}

	const known = registry.get(enemyId);
	if (!known)
		return;                                // never held here, or already dropped: nothing to withdraw
	registry.delete(enemyId);
	// Withdraw the announcement, exactly as the per-frame diff would have (and on its rule: only an
	// enemy WE announced is ours to withdraw). The enemy is gone here, so the server must stop
	// keeping this client as a holder of it -- that record is what would otherwise hand the dead
	// enemy back to this client on the next rebalance.
	if (known.registered)
		send({ type: MSG.ENEMY_UNREGISTER, ids: [enemyId] });
}

// Inbound MSG.ENEMY_DESPAWN (owner -> server -> everyone but the sender), one-shot per killed enemy.
// Routed here from ./client.js. The entry's `id` is what is applied; the payload's `owner` is only
// logged -- the server has already stamped it from the sender's socket, and the gate that matters is
// that we HOLD the enemy (no other client can despawn an id this client never learned about).
export function onEnemyDespawn(msg) {
	if (!isEnemySyncEnabled())
		return;
	const list = msg?.list;
	if (!Array.isArray(list))
		return;
	for (const entry of list) {
		// Malformed entries are skipped, never thrown on: a peer's payload must not be able to break
		// this frame, not even the one it arrives in (the same rule as onEnemyState/onEnemyHandoff).
		if (!entry || typeof entry !== "object")
			continue;
		const id = entry.id;
		if (typeof id !== "string" || id === "")
			continue;
		despawnEnemyLocally(id);
		if (debugEnabled())
			debugLog(`despawn applied for ${id} (sent by ${msg.owner == null ? "?" : msg.owner})`);
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
addPeerMessageHandler(MSG.ENEMY_HANDOFF, onEnemyHandoff);
addPeerMessageHandler(MSG.ENEMY_DESPAWN, onEnemyDespawn);

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
		// The owner half's seam (see ensureDespawnPatch): installed once, and this hook is where it
		// happens because it runs before this frame's entity updates -- an enemy can die in any frame,
		// whether or not this module has driven anything yet, so the map-start install the puppet
		// patches use would not cover a flag switched on mid-map. Installed while the option is off
		// too: the wrapper is inert then (it re-tests the option per death), and there is no hook that
		// fires on the moment the option changes.
		ensureDespawnPatch();
		applyPeerState(syncEnemies());
	}

	onPostUpdate() {
		// One identity diff for both halves of the publish: the state of the enemies we own, and the
		// final state of the ones we have just lost (see sendHandoffs).
		const live = syncEnemies();
		sendOwnerStates(live);
		sendHandoffs(live);
	}
}

export { EnemySync };

//# sourceURL=/mods/terra-together/client/enemies.js
