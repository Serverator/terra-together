/**
 * src/client/enemies.js
 * Enemy identity, registry and ownership bookkeeping: the client half of the enemy-sync
 * split, Phase 1 (announce the enemies this client can see; learn who the server assigned
 * to simulate each of them). Nothing here changes what an enemy does.
 * Responsibilities:
 *   - The canonical enemy identity helper enemyStableId() (moved here from
 *     ../debug/enemy-debug.js, which now imports it) and the wire-safe subset of those ids.
 *   - Per-frame enumeration of the live enemies -> announce new ones (enemy_register) and
 *     withdrawn ones (enemy_unregister), on change only.
 *   - The enemyId -> { registered, owner, epoch } registry, fed by the server's enemy_owner
 *     broadcast and guarded against stale epochs.
 *   - The readers the debug overlay consumes: isOwner() / getEnemyOwnerName().
 * Public surface: ENEMY_SYNC_OPTION, enemyStableId, isEnemySyncEnabled, onEnemyOwner,
 *   isOwner, getEnemyOwnerName, EnemySync
 * Engine touchpoints: terra.addAddon (../main.js registers EnemySync at onGameMapStart /
 *   onPreUpdate / onPostUpdate 35010), terra.export g_options / g_gState.entities /
 *   g_game.map.active.path / g_scene.isRunning / EnemyCmp (and, through it, each enemy's
 *   sourceEntity.core, which is where identity comes from); window.terraTogether.playerId /
 *   playerNames (published by ./session.js). Inbound routing: ./client.js (see the note at
 *   the handler registration below).
 * Notes: Phase 1 is deliberately inert gameplay-wise — the module only observes and reports,
 *   so enemy AI, state, HP and rewards are untouched. It is a no-op, and holds no state, while
 *   its option is off or the client is not connected, which is what makes it safe to default
 *   on. The option KEY is declared here as a literal instead of being imported from
 *   ../config/settings.js: that module imports ../debug/enemy-debug.js, which imports this
 *   one, so importing back would close a cycle (same reason ENEMY_DEBUG_OPTION is a literal
 *   in ../debug/enemy-debug.js).
 */

import { send, isConnected, addPeerMessageHandler } from "./client.js";
import { getRogueInfo } from "./session.js";
import { MSG } from "../net/protocol.js";

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

// Copy the variant currently in play (null outside a rogue run), i.e. the second half of the
// `<map>#<variant>` room key the server arbitrates a registration against. ./session.js owns
// how it is read.
function roomVariant() {
	return getRogueInfo().variant;
}

// The per-frame diff: announce what appeared, withdraw what vanished, send nothing otherwise.
function syncEnemies() {
	// Gated: switched off or offline. Nothing is enumerated, nothing is sent, and the registry
	// goes too (see clearRegistry).
	if (!isEnemySyncEnabled() || !isConnected()) {
		clearRegistry();
		return;
	}
	const map = terra.export.g_game?.map?.active?.path ?? "";
	// A map mid-transition / a paused world: the entity list is not the world it will be, and
	// the map path an id is built from may not be the one the entities came from. Skip the
	// frame instead of reporting on it, and keep the registry: the sweep below would read the
	// transition as a mass despawn.
	if (map === "" || !isWorldSceneActive())
		return;

	const live = new Set();
	const added = [];
	for (const core of terra.export.g_gState?.entities ?? []) {
		if (!getLiveEnemy(core))
			continue;
		const id = wireEnemyId(core);
		if (id === null)
			continue;                      // runtime spawn / unknown map: not wire-addressable
		live.add(id);
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
}

// The map is gone: every id we announced embeds the old map path, so none of them can come
// back, and the server's records for them should not outlive it. The new map's own enemies are
// announced by the next frame's diff.
function resetForNewMap() {
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
// there (it imports send() from it), so it registers its handler instead. Keeps the client
// module graph a DAG.
addPeerMessageHandler(MSG.ENEMY_OWNER, onEnemyOwner);

// ──────────────────────────────────── addon ────────────────────────────────────

// The per-frame bookkeeping loop. onPreUpdate reads the frame's opening set — a freshly
// loaded map's enemies are announced before this frame's update consumes them — and
// onPostUpdate reads it again, so enemies the frame itself spawned or killed are reported in
// the same frame rather than the next one. Both run the same diff, which is silent when
// nothing changed, so the wire sees one message per identity change and never per-frame
// chatter.
class EnemySync {
	onGameMapStart() {
		resetForNewMap();
	}

	onPreUpdate() {
		syncEnemies();
	}

	onPostUpdate() {
		syncEnemies();
	}
}

export { EnemySync };

//# sourceURL=/mods/terra-together/client/enemies.js
