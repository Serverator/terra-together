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
 *     onEnemyDeathHit) and announce it in one MSG.ENEMY_DESPAWN (sendDespawnId, once the engine has
 *     removed the entity, see the death-ANIMATION bullet below); and, on the
 *     receiving side, take such an enemy out of this client's world and record it in the engine's
 *     own per-spot dead-set so it cannot come back (onEnemyDespawn).
 *   - Death ANIMATION half (Phase 4b): a beaten enemy is not despawned at the killing blow -- its
 *     state keeps being published until the engine removes the entity (markDying + syncEnemies),
 *     so the peer puppets the dying enemy and the death animation streams. On the peer, a state at
 *     0 HP latches the enemy DYING (dyingPuppets): it OVERRIDES the freshness gate, so a dying
 *     enemy can never be released into local simulation (the zombie), and is removed by the despawn
 *     or a bounded cap.
 *   - Rest/respawn half (Phase 4b): resting clears a PER-CLIENT dead-set, so the reset is synced --
 *     wrapping the engine's own CombatManager.onRestReset announces one MSG.ENEMY_RESPAWN
 *     (sendRespawn), and a recipient on that map runs the engine's own reset locally
 *     (onEnemyRespawn -> applyLocalRespawn: clear the engine's own rest-reset keys, respawn
 *     defeated spots the way a fresh map load would -- CALMLY, see respawnSpotCalm), after which the
 *     normal registration diff re-announces and re-splits the enemies. Both ends of a rest ALSO calm
 *     every enemy that was already alive and attacking: a rest leaves a fresh map's whole population
 *     calm, not just the spots that had to be respawned (see calmAllEnemies).
 *   - Hit forwarding (Phase 5a), the peer half: a PLAYER hit that lands on an enemy this client only
 *     PUPPETS has its local damage suppressed (./enemy-puppet.js patch (c)), so the hit is described
 *     (readHitDescriptor) and queued (onEnemyHitSeam -> pendingHits -> sendHitQueue) for one
 *     MSG.ENEMY_HIT per frame. Nothing is applied locally: the owner is the only party that writes
 *     an enemy's HP.
 *   - Hit application (Phase 5a), the owner half: onEnemyHit rebuilds an equivalent force from the
 *     forwarded descriptor (getForwardedRig -> applyForwardedHit) and applies it with the engine's
 *     own `ent.onHit(force, coll)`, so HP, part damage, the hit reaction/stun, the damage FX and the
 *     hit number all behave exactly as a local hit -- once per hit (recentHits), only for the enemies
 *     we hold. The peer's whole damage factor AND its resolved attack basis (atk + str, the one
 *     attacker-side term of the engine's damage formula) are folded onto the rebuilt attacker, so the
 *     owner's number IS the attacker's number without needing the peer's stat sheet; a status
 *     condition is the one thing that cannot travel (it is attributed to the attacker's combatant --
 *     see applyForwardedHit), and the same missing attacker means a forwarded hit grants the attacker
 *     no SP.
 *   - Engagement (Phase 5a), the input the reward phase consumes: a LATCH WITH A TTL recording
 *     which players have engaged each enemy -- the attackers of the hits we applied, the local
 *     player's own hits on BOTH sides of the split (the ones we applied and the ones we forwarded),
 *     plus every player inside ENGAGE_RADIUS (= AGGRO_TUNING.aggroShareRadius) of an enemy that is
 *     in a fight (the engine's own `aggressive` flag on the entity we hold, whichever side of the
 *     split we are on -- see enemyInFight). Exposed as isEngaged()/engagedPlayers(), per enemy, so
 *     Phase 5b never has to re-derive it. The latch is not a live flag on purpose: the engine
 *     de-aggros an enemy before it grants its rewards. A rest drops it (Sam: a rest resets every
 *     enemy for every player, see dropEnemyCombatState).
 *   - The fight SURVIVES a handover (the aggro rebuild): an enemy whose owner's stream reports it in
 *     combat stays in combat here when that owner stops speaking for it -- a pause, a downed host, a
 *     rebalance -- which is the whole point of applying the owner's `aggro` with the engine's own
 *     setAggressive on a driven enemy (./enemy-puppet.js, engagePuppet). Every release that hands an
 *     enemy back to local simulation therefore re-engages it through the engine (relinquishPuppet ->
 *     engageLocally, which restores the attack-frequency registration the puppet deliberately did
 *     not hold), and a takeover adopts the previous owner's fight along with its position
 *     (takeOwnership). A rest is the one event that ends every fight on the map.
 *   - Group wake (the aggro rebuild), cross-client: aggro is a GROUP event in this engine
 *     (CombatManager.aggroNearbyEnemy, combat.js:226-271: the enemy's entity groups plus an 8-unit
 *     recursive chain), but that pass runs on the simulating client only, so a group split across
 *     clients wakes half of itself. The client that sees an enemy of its own aggro lists the ids
 *     that pass reached (wakeIdList) and sends them once (detectWakes -> MSG.ENEMY_WAKE); the server
 *     relays them and each recipient wakes the ids it is simulating itself (onEnemyWake).
 *   - Kill rewards (Phase 5b), the consumer of that latch: every client grants ONLY its own local
 *     player's share of a killed enemy, and only when that player was IN COMBAT with it (the
 *     engagement latch above) or NEAR it (the engine's own player-proximity call, KILL_REWARD_RADIUS
 *     -- see eligibleForKillReward, the one predicate both halves of this use). The engine's own
 *     unconditional grant is intercepted for the enemies this client OWNS (the giveExp/dropItems
 *     patch: rewards follow the fight, not ownership, and an owner legitimately can be far away),
 *     and on a client that did NOT simulate the death the grant happens at the moment the death is
 *     CERTAIN -- the received MSG.ENEMY_DESPAWN, or the bounded removal of a latched dying puppet
 *     (grantKillReward, once per enemy). Nothing beyond that travels: giveExp/dropItems take no
 *     arguments and read only per-client state, so every client can answer for itself, and a
 *     grant never replays the owner's own kill bookkeeping (see grantKillReward).
 *   - Effects/sounds/projectiles (Phase 6), both halves: the fx, sounds and projectiles an enemy we
 *     own emits are attributed by ./fx-sync.js through the ownership probe registered below and
 *     ride the SAME enemy_state frame as that enemy's state (sendOwnerStates/drainEnemyEffects) --
 *     including its attack telegraph, which is an infinite fx in group "__aimFx__" and needs no
 *     channel of its own. On the receiving side the same frame's effect batches are applied to the
 *     LOCAL copy of that enemy exactly while it is driven as a puppet (applyEnemyEffects), and are
 *     dropped when it stops being one (clearRemoteEnemyFx), so a peer renders the owner's enemy
 *     effects and never emits a second copy of them.
 *   - Damage numbers (the tail of Phase 5a's hit application): a hit's number is drawn inside the
 *     VICTIM's damage pipeline and is a GUI element, not an fx, so a hit forwarded to us drew its
 *     number on OUR screen and on the peer's screen nowhere. The owner captures it off
 *     CombatantCmp.prototype.dealDamage (wrapped once) for forwarded hits only
 *     (captureForwardedHitNumber) and it rides the same enemy frame as one more batch (`hitNumbers`,
 *     ENEMY_EFFECT_KEYS); the peer replays it through the engine's own HitNumbers.addCustom
 *     (replayEnemyHitNumber). Nothing about the reward path or the HP write changes.
 *   - Contact attacks, and this is the one enemy melee that is NOT an act: the TACKLE step hangs a
 *     `Tackle` on the enemy's AttackerCmp and lets physical contact resolve the damage
 *     (combat-act-steps.js:302-338, attacker-cmp.js:183-212), so none of it ever reached the other
 *     player -- the spiky balls charging, the hedgebird's spin, the wasp's dash, the platapus's bite.
 *     The owner captures the tackle that step leaves on the entity (same step seam as the hit acts)
 *     and its end (AttackerCmp.clearTackle, the only call that tears one down) and sends them as
 *     those SAME hitActs/hitActStops entries with the kind "TACKLE"; the peer builds the same Tackle
 *     from the same authored step and tests it against its OWN player every frame
 *     (driveRemoteTackles), through the engine's own collision query and its own Tackle.hit -- so the
 *     damage, the party check, the hit direction and the 1.0s repeat cooldown are the engine's, and
 *     still nothing arbitrates. See the tackle section below.
 *   - Melee/splash hits on the player who RECEIVES them (the hit-act half), both halves: an enemy's
 *     melee or splash hitbox was resolved only on the client simulating the enemy, so it could only
 *     ever hit the OWNER's player. The owner captures the hit ACT its own enemies start -- the
 *     identity of the authored step (action name, step index, step kind) taken off the
 *     ACTION_STEP.{HIT_CIRCLE,HIT_SWEEP,HIT_LINE} step seam and its end off
 *     CombatAct.prototype.cancel -- and sends it in the same enemy frame as two more batches
 *     (`hitActs`/`hitActStops`, ENEMY_EFFECT_KEYS); the peer re-runs that very step on its OWN copy
 *     of the enemy (applyRemoteHitAct), so the hitbox resolves against that peer's own world and can
 *     only damage that peer's own player. Nothing arbitrates and nothing can apply twice: each
 *     client resolves the hits it receives, at the position it sees the enemy at. Ranged attacks need
 *     none of this -- the synced projectile is a real one (./fx-sync.js) and simply has its damage
 *     guard lifted for an enemy's own shot.
 * Public surface: ENEMY_SYNC_OPTION, ENGAGE_RADIUS, ENGAGEMENT_TTL_MS, KILL_REWARD_RADIUS,
 *   enemyStableId, isEnemySyncEnabled, onEnemyOwner, onEnemyState, onEnemyHandoff, onEnemyDespawn,
 *   onEnemyRespawn, onEnemyHit, onEnemyWake, isOwner, getEnemyOwnerId, getEnemyOwnerName,
 *   isEngaged, engagedPlayers, EnemySync
 * Engine touchpoints: terra.addAddon (../main.js registers EnemySync at onGameMapStart /
 *   onPreUpdate / onPostUpdate 35010), terra.export g_options / g_gState.entities /
 *   g_game.map.active.path / g_scene.isRunning / g_player (the local player's position, for the
 *   proximity half of engagement) / EnemyCmp (and, through it, each enemy's
 *   sourceEntity.core, which is where identity comes from), plus — for the group wake —
 *   g_group.getEnemySpots (the engine's own EntityGroupManager, entity-group-model.js:116-131, on
 *   the same `spot.core.entityGroups` list aggroNearbyEnemy passes it) and ../config/aggro-tuning.js
 *   (the shared tunables: aggroShareRadius is ENGAGE_RADIUS); for the death half —
 *   EnemyCmp.prototype.onDeathHit (the owner seam, wrapped once) and g_vars (the engine's var
 *   store, which is where the per-spot dead-set lives); for the two Phase 4b halves, additionally
 *   CombatManager.prototype.onRestReset (the rest seam, wrapped once), EnemySpotEntity (the spot
 *   identity, tested with the engine's own instanceof) plus its flag/enum tables
 *   (ENEMY_SPOT_FLAG / ENEMY_PASSIVE, which say what a spot's enemy should have been),
 *   CombatManager/EnemySpotEntity both reached through terra.export; ./enemy-puppet.js, which owns the
 *   prototype patches and the actual puppet drive; window.terraTogether.playerId / playerNames /
 *   playerActors (published by ./session.js); performance.now() (the freshness clock). For the
 *   Phase 5a hit half, additionally ./enemy-puppet.js's setEnemyHitSink/readHitDescriptor (the
 *   suppressed-hit seam and its wire shape) and the engine's own combat primitives, reached
 *   through terra.export: DamagerCmp, HitForce, AttackInfo, CombatStats (getAttackStats /
 *   the level-scaled attack-stat stand-in) and COMBATANT_PARTY; for the Phase 5b reward half,
 *   additionally EnemyCmp.prototype.giveExp and EnemyCmp.prototype.dropItems (the owner-side reward
 *   gate, wrapped once per class and resolved per entity) and the engine's own player-proximity
 *   call, g_player.checkDistanceXY; for the Phase 6 effect half, ./fx-sync.js (the capture hooks
 *   that attribute an effect to an enemy through the probe registered below, the descriptor/replay
 *   helpers spawnRemoteFx / reconcilePersistentFx / spawnRemoteProjectile / clearRemoteEnemyFx) and
 *   ./actors.js's playSyncedSound (the one remote-sound replay, which needs nothing of its target
 *   but a core). For the damage-number half of a forwarded hit, additionally
 *   CombatantCmp.prototype.dealDamage (wrapped once, as the capture point) with the engine's own hit
 *   results (`dmgResult.damage`/`critical`/`defCritical`) and GUI (g_combat.gui.hitNumbers,
 *   HIT_NUM_STYLE, CRIT_TYPE), plus g_combat.hasDamageDisplay (the engine's own "would a number be
 *   drawn at all" gate) and Vec3 (the replayed number's position). For the hit-act half,
 *   additionally ACTION_STEP.[HIT_CIRCLE|HIT_SWEEP|HIT_LINE].prototype.start (the owner's capture
 *   seam: the step owns its authored props and creates the act), CombatAct.prototype.cancel (the
 *   owner's stop seam, and the peer's teardown call), g_combat.acts (where the step's own act is
 *   taken from, addCombatAct having just pushed it) and g_gState.pushContextEnt/popContextEnt (the
 *   engine's own context stack, which is what makes a step's self-relative Target resolve to the
 *   enemy -- and what makes running a hit act on the peer possible at all). Inbound routing:
 *   ./client.js (see the note at the handler registration below).
 * Notes: the module is a no-op, and holds no state, while its option is off or the client is
 *   not connected, which is what makes it safe to default on. Off or disconnected, its puppets
 *   are released too, so no enemy can stay suppressed (or frozen) because this module stopped
 *   running -- except a dying one, which is REMOVED rather than released, because releasing a dead
 *   enemy is exactly the locally-simulating zombie the dying latch exists to prevent. The option KEY
 *   is declared here as a literal instead of being imported from
 *   ../config/settings.js: that module imports ../debug/enemy-debug.js, which imports this
 *   one, so importing back would close a cycle (same reason ENEMY_DEBUG_OPTION is a literal
 *   in ../debug/enemy-debug.js).
 */

import { send, isConnected, addPeerMessageHandler } from "./client.js";
import {
	getRogueInfo, hasPeers, enemyQueues, activeEnemyFx, enemyOwnership, RUN_FX_SPEED_EPS,
} from "./session.js";
import { MSG } from "../net/protocol.js";
// The shared tunables of the aggro rebuild (both halves of the mod read this one file; see its own
// header for why nothing here is re-declared). Only aggroShareRadius is this module's: it IS the
// engagement radius below, and it is the same number the server arbitrates ownership with, so "near
// the fight" means one thing on both sides.
import { AGGRO_TUNING } from "../config/aggro-tuning.js";
import {
	installPuppetPatches, makePuppet, releasePuppet, readEnemyState, drivePuppet, adoptState,
	puppetInCombat, readHitDescriptor, setEnemyHitSink,
} from "./enemy-puppet.js";
import {
	spawnRemoteFx, reconcilePersistentFx, clearRemoteEnemyFx, spawnRemoteProjectile,
} from "./fx-sync.js";
import { playSyncedSound } from "./actors.js";

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

// How long a peer holds an enemy it has seen die before removing it regardless -- the bounded
// guarantee of the dying latch (Phase 4b). A landed despawn removes the enemy immediately; this is
// the backstop for a despawn that never arrives (a dropped frame, an owner that went away while the
// enemy was mid-death). It is deliberately far longer than any death animation -- an enemy still
// playing its death on the owner must not vanish early on the peer -- and it is the ONLY bound on
// how long a dying enemy can be held suppressed, so nothing here can leave a stuck entity behind.
// 3000ms is ~6x the freshness window above and comfortably past the engine's own death-fade
// sequence, whose length this code deliberately does not guess at (the despawn is the real signal).
const DYING_REMOVE_MS = 3000;

// How long the OWNER streams a dying enemy before announcing the despawn regardless. Normally the
// despawn is driven by the engine removing the entity (markDying -> syncEnemies' gone sweep), but a
// handful of engine states never remove it -- most notably a `manualKill` enemy that takes lethal
// damage: its boom() returns before playing any death action, so nothing ever reaches
// onPostAction's core.kill() and the entity stays. Without a bound that one enemy would publish
// state every frame forever. 5000ms is well past any real death animation, so it only ever fires on
// an enemy the engine has genuinely left behind, and it is a leak guard on the STREAM, not a guess
// at the animation: the despawn still normally rides the removal.
const DYING_STREAM_MAX_MS = 5000;

// How far from an enemy a player counts as engaged with it, in world units, measured on XY like
// the engine's own proximity tests (enemy-cmp.js:584 player.checkDistanceXY(..., 20) for aggro
// upkeep, and :1114 aggroNearbyEnemy(this, 8, true) when an enemy aggros). Sam's number, and
// deliberately a named constant because it is a TUNING knob, not a fact: "Near you can make it as
// [X], we can adjust it later". 15 is comfortably past melee reach and a couple of boss body
// widths, while still being "the same fight" for two players standing in it. Phase 5b (rewards)
// reads engagement through isEngaged()/engagedPlayers() rather than re-deriving a radius, so this
// one number stays the single definition of near.
// The number itself now lives in ../config/aggro-tuning.js (AGGRO_TUNING.aggroShareRadius), because
// the SERVER arbitrates a fought enemy's ownership with the same notion of "near the fight": the
// two halves must agree, and one shared key is the only way they cannot drift. The exported name
// stays as the client-side name of that knob, which withinEngageRadius (and anything reading the
// latch through isEngaged()/engagedPlayers()) is defined in terms of.
export const ENGAGE_RADIUS = AGGRO_TUNING.aggroShareRadius;

// How long an engagement sighting stays valid, in milliseconds -- the TTL of the latch isEngaged()
// reads. Deliberately LONGER than DYING_REMOVE_MS (3000ms) above, which is the longest gap there
// can be between an enemy's death on its owner and the definitive event (the despawn, or the peer's
// bounded removal) on a client that did not simulate it: a player whose last sighting was the frame
// before the killing blow must still be engaged when the reward is decided on that client. 4000
// leaves a second of slack over the longest gap, and is short enough that a fight which ended long
// ago is not still "engaged".
export const ENGAGEMENT_TTL_MS = 4000;

// How far from a killed enemy a player counts as "in that fight" without having been engaged with it,
// in world units -- the second half of Sam's reward rule (Phase 5b: every player in the map gets the
// reward, but only those NEAR the enemy or IN COMBAT with it). Measured with the ENGINE's own
// local-player proximity idiom, `g_player.checkDistanceXY(enemyPos, radius)` (player-model.js:188-194,
// the same call the enemy AI uses for its aggro upkeep at enemy-cmp.js:584, r=20, and for the on-hit
// aggro clause at :1102, r=12), so "near" means here exactly what it means to the engine -- note that
// that call is a FULL 3D distance despite its name (:190 `pos.distance`, vec3.js:469).
// Deliberately the same number as ENGAGE_RADIUS: the rule's two halves describe one notion of "in
// this fight", and two numbers for it would be a tuning trap. They stay two constants because they
// are two different questions asked of two different things -- engagement is a LATCH recorded while
// the enemy was FIGHTING (and is measured on XY, see withinEngageRadius), while this is a plain
// distance to where the enemy died, asked once, at the death -- and because Sam tunes them in game.
export const KILL_REWARD_RADIUS = 15;

// How long a hit that has already been applied is remembered by its signature, in milliseconds --
// the exactly-once guard for a re-delivered MSG.ENEMY_HIT frame (onEnemyHit). A duplicate of a
// frame arrives within the same round trip, while two DISTINCT hits that happen to share every
// forwarded field are at least an attack animation apart, so a window far below a second
// separates them without being able to swallow a real second hit.
const HIT_DEDUPE_MS = 250;

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

// Enemy ids this client owns and has KILLED locally, mapped to the clock reading of the death,
// whose entity the engine has not removed yet (Phase 4b): their state keeps being published (see
// syncEnemies) so a peer can watch the death play out, and the despawn is sent from the frame their
// entity actually leaves the world rather than at the killing blow (see markDying). The timestamp
// bounds the stream (DYING_STREAM_MAX_MS), so an enemy the engine never removes cannot be published
// forever. Owner-side bookkeeping only, dropped on every reset.
const dyingOwned = new Map();

// The enemies THIS client is currently driving as puppets: enemyId -> entity. Kept so every
// release path (stale state, ownership change, enemy gone, map change, disconnect, flag off)
// can undo exactly what was done without a second enumeration of the entity list, and so
// makePuppet() is called only on the transition into a puppet rather than every frame. The
// module does not need to consult the puppet module's isPuppet(): this map is its own record of
// what it puppeted.
const puppets = new Map();

// Enemies this client is driving as puppets that have been SHOWN to be dying: enemyId ->
// { at, state }, where `at` is the clock reading of the first death sighting and `state` is the
// last death pose to hold. This latch OVERRIDES the freshness gate in applyPeerState: a dying enemy
// is never released back to local simulation -- releasing one would leave a locally-simulating
// zombie of a dead enemy, the single thing this latch exists to stop -- and is instead held
// suppressed until the owner's despawn arrives or the bounded cap (DYING_REMOVE_MS) removes it.
// Every exit path removes it: despawn, cap, enemy gone, ownership change, disconnect, flag off.
const dyingPuppets = new Map();

// Drop every stored peer state. Part of the reset path: state stored for the map we are leaving
// can never be applied to the next one.
function clearPeerState() {
	peerState.clear();
}

// ─────────────────────────── hit forwarding (Phase 5a) state ───────────────────────────

// Hits this client has seen land on a PUPPET since the last frame, in the wire shape
// ./enemy-puppet.js readHitDescriptor produces them. One MSG.ENEMY_HIT per frame at most carries
// them all (sendHitQueue); the hit itself is NOT applied here -- the engine's own application of it
// was suppressed by the puppet patch, and the enemy's owner is the only party that may write its HP.
let pendingHits = [];

// The applied forwarded hits, by signature: signature -> the clock reading it was applied at. The
// exactly-once guard (see onEnemyHit): a frame that arrives twice must not apply its hits twice,
// and HIT_DEDUPE_MS bounds how long a signature is remembered.
const recentHits = new Map();

// enemyId -> Map<playerId, atMs>: which players have ENGAGED each enemy, and when each was last
// seen in that fight (Phase 5a). This is the input the reward phase (5b) consumes, through
// isEngaged()/engagedPlayers(): a LATCH with a TTL, not a predicate over the enemy's current state
// -- the engine de-aggros an enemy seven lines before it grants its rewards (see isEngaged).
// Seeded from the forwarded hits (the owner applied, and the sender queued -- both clients answer
// for their own player) and from proximity to an enemy that is in a fight (any player, owned or
// puppeted -- see updateEngagement). Entries live until they age out (ENGAGEMENT_TTL_MS) or the
// world they belong to goes (clearHitState), and they deliberately OUTLIVE the enemy: a reward is
// decided after the death, and often only once the despawn arrives.
const engagement = new Map();

// Drop everything the hit half holds: the hits waiting to be sent for a map we are leaving, the
// applied-signature memory (whose ids embed the old map path), and the engagement records (which
// belong to the ownerships that are ending). Part of every reset that also drops the peer state.
function clearHitState() {
	pendingHits = [];
	recentHits.clear();
	clearEngagement();
}

// Drop the engagement latch alone, for the one event that resets the WORLD without abandoning it: a
// rest (see dropEnemyCombatState). The hits themselves are untouched -- a hit in flight belongs to the
// frame it was made in, and the exactly-once marks of the reward path deliberately survive a rest
// (see clearKillRewardState) -- but the latch, whose records name the enemies of a world that has just
// been put back, does not.
function clearEngagement() {
	engagement.clear();
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
	for (const ent of puppets.values()) {
		releasePuppet(ent);
		// The stream that put fx/sounds on it is over (the feature went off, or the connection
		// dropped): nothing will ever tell us to stop them (Phase 6).
		clearRemoteEnemyFx(ent);
	}
	puppets.clear();
}

// Remove every enemy latched as dying (Phase 4b) instead of releasing it. Used by the paths that
// abandon the world this module was syncing (feature off, disconnect): a dying enemy is DEAD, so
// falling back to local simulation would leave a zombie on a client that has stopped syncing. It
// goes through the same removal a despawn uses, so the spot is marked defeated, the entity is taken
// out of the world and no reward path runs.
function removeDyingPuppets() {
	if (dyingPuppets.size === 0)
		return;
	for (const id of [...dyingPuppets.keys()])
		despawnEnemyLocally(id);
	dyingPuppets.clear();
}

// Stop driving one enemy and hand it back to local simulation WITHOUT ending the fight its owner left
// it in. The only difference from releasePuppet on its own: an enemy whose owner's last word was "in
// combat" is re-engaged here (engageLocally), because the enemy is about to be simulated by THIS
// client -- and left calm it would walk away from the player standing next to it, which is exactly the
// bug this rebuild fixes (Sam: "getting downed or pausing should not affect aggro").
//
// Used by the two release paths that keep the enemy in the world and put it under this client's
// simulation: a takeover (it is ours now) and an owner going quiet (its state went stale: nobody is
// speaking for the enemy any more, so this client simulates it -- the paused/downed host case). Every
// OTHER release is an abandonment -- the enemy was killed, or is being torn down with the map or with
// the sync -- where keeping a fight alive would be wrong, and those call releasePuppet directly.
function relinquishPuppet(ent) {
	const fighting = puppetInCombat(ent);
	releasePuppet(ent);
	if (fighting)
		engageLocally(ent);
}

// Put a locally simulated enemy into combat, through the engine's own entry point for it.
//
// setAggressive(true) is the call the engine itself makes when something aggros an enemy of a player
// (enemy-cmp.js:377-404), and a REAL engagement is what this needs to be: it registers the enemy in
// the shared attack-frequency manager (:391), which is not optional -- every attack choice is gated on
// `isFrequencyReady`, whose per-enemy progress is only advanced for the enemies in that list
// (attack-frequency.js:230-236 with enemy-state.js:86), so an aggressive enemy missing from it never
// attacks at all. The call also clears the enemy's passive (the aggressive state its owner was in),
// turns the HP bar red and sets the actor-FX range correctly.
//
// Deliberately NOT `enemy.triggerAggression()` (:1113-1118), the engine's other way in: that one also
// runs `combat.aggroNearbyEnemy(this, 8, true)` -- a recursive physics query that triggers the group's
// dormant spots and aggros every enemy in the neighbourhood. The group is the wake message's job (see
// the group-wake section), decided once per aggro event and shared with the other client, so running
// the local chain again here -- once per enemy a handover releases, in one frame -- would aggro (and
// possibly spawn) a second time what that pass already covers. The actor target needs no help either:
// the AI re-acquires it for an aggressive enemy that has none (enemy-type.js:233-235).
function engageLocally(ent) {
	const enemy = ent?.enemy;
	if (!enemy || enemy.aggressive === true || typeof enemy.setAggressive !== "function")
		return;
	// A dead or already-removed entity is not ours to re-engage: the engine refuses an aggressive flag
	// on a combatant that is not ALIVE anyway, and a killed core is on its way out of the world.
	if (ent.core?.isKilled?.() === true)
		return;
	if (typeof enemy.isAlive === "function" && !enemy.isAlive())
		return;
	enemy.setAggressive(true);
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
		// Dying enemies are REMOVED, never released: handing a dead enemy back to local simulation
		// is the zombie this whole latch exists to prevent (Phase 4b).
		removeDyingPuppets();
		releaseAllPuppets();
		clearTakeoverState();
		dyingOwned.clear();
		// The hit half holds no world either: a hit waiting to be sent belongs to a map we may have
		// left, and engagement is ownership bookkeeping (Phase 5a).
		clearHitState();
		// Phase 5b's exactly-once marks go with the world they were made in (see
		// clearKillRewardState). Safe whenever it happens: the enemies they name are the ones this
		// module has just released, and a grant needs the enemy's entity.
		clearKillRewardState();
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
		const id = wireEnemyId(core);
		if (id === null)
			continue;                      // runtime spawn / unknown map: not wire-addressable
		// Live enemies, plus the ones we have killed locally whose entity the engine has not
		// removed yet: a dying enemy keeps being published until its removal (Phase 4b), which is
		// what lets a peer watch the death animation instead of seeing the enemy vanish.
		if (!getLiveEnemy(core) && !dyingOwned.has(id))
			continue;
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

	// Owner-side bound on the death stream (see DYING_STREAM_MAX_MS): an enemy the engine never
	// removes stops being published here, and is handed to the gone sweep below as if it had gone,
	// so its despawn still goes out exactly once and its announcement is still withdrawn.
	if (dyingOwned.size > 0) {
		const now = nowMs();
		for (const [id, at] of dyingOwned) {
			if (now - at >= DYING_STREAM_MAX_MS)
				live.delete(id);
		}
	}

	const gone = [];
	for (const [id, entry] of registry) {
		if (live.has(id))
			continue;
		// A dying enemy we owned: its entity has now left the world, i.e. its death animation is
		// over. THIS is when the despawn goes out (Phase 4b) -- the state publishes have streamed
		// the death until this frame, so the peer animated it instead of losing it instantly.
		if (dyingOwned.delete(id))
			sendDespawnId(id);
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
	// The enemies whose state this frame publishes. It is also the gate for the frame's effect
	// batches: only an enemy we are speaking for may have its effects spoken for, and the peer can
	// only apply an effect to an enemy whose state it holds.
	const published = new Set();
	const list = [];
	// With no peer to tell there is nothing to read and nothing to publish, and the frame's effects
	// must then all be dropped -- which the drain does on an empty published set. This is the SOLO
	// hot path (a connected client alone in the room owns enemies and sends nothing), so it must
	// not pay for a state read it would throw away; the queues are still drained, or they would
	// leak into a later frame.
	if (!hasPeers()) {
		drainEnemyEffects(published);
		return;
	}
	for (const [id, core] of live ?? []) {
		if (!isOwner(id))
			continue;
		// Ours and simulating, or ours and dying. Not ours-in-transit: an enemy we own but have not
		// taken over yet is either a takeover that has not run this frame or one holding for the
		// handoff, and our copy is not authoritative then -- it is the position the previous owner's
		// state is about to replace -- so publishing it would be exactly the snap-to-spawn this path
		// exists to prevent (see adopted and takeOwnership). A DYING enemy is the exception: its
		// entity is going away and it will never reach adoption, but its death pose is real state the
		// peer needs (Phase 4b).
		if (!adopted.has(id) && !dyingOwned.has(id))
			continue;
		const state = readEnemyState(core.ent);
		// An enemy whose state cannot be read simply does not appear: the peer's copy of it goes
		// stale and resumes local simulation, which is better than publishing a half state.
		if (state) {
			list.push(state);
			published.add(id);
		}
	}
	// The frame's effect batches are drained whatever happens: a queue nobody empties leaks into a
	// later frame, so the drain is unconditional even on the frames that send nothing (no peers,
	// nothing owned, nothing readable).
	const effects = drainEnemyEffects(published);
	if (list.length === 0)
		return;
	// `owner` is our own playerId — the identity the server validates the sender against and
	// the one every recipient gates on. `map`/`variant` name the room this state belongs to,
	// exactly as the register does (they are part of the frozen payload both directions). The
	// effect batches ride along under the names the player channel uses for them (globalFx/
	// fxStops/persistentFx/sounds/soundStops/projectiles), each entry tagged with the enemy it
	// belongs to, and are absent entirely on a frame with none — the server relays the whole
	// message, so the extra arrays cost one key per batch and no additional traffic.
	const msg = { type: MSG.ENEMY_STATE, owner: localPlayerId(), map: activeMapPath(), variant: roomVariant(), list };
	if (effects)
		Object.assign(msg, effects);
	send(msg);
}

// ─────────────────── owner half: our enemies' effects (Phase 6) ───────────────────
//
// The fx, sounds and projectiles an enemy we own emits are captured by ./fx-sync.js -- its
// predicates ask THIS module which entity belongs to an enemy we own, through the probe registered
// at the bottom of this file -- into ./session.js's `enemyQueues`, and ride the SAME enemy_state
// frame as that enemy's state. The frame is the right carrier for reasons beyond "one message per
// frame either way": the server already validates it per entry against the arbiter (the one relay
// that is not taken on trust), the recipient already gates every entry on "is this sender the
// enemy's owner", and an effect therefore arrives in the same frame as the state of the enemy it
// belongs to -- so the peer never applies an effect to an enemy whose position it has not received.
//
// What travels, one batch per kind, every entry tagged with the enemy it belongs to (`enemy`, the
// same wire id the state entries carry):
//   globalFx       one descriptor per fx spawned on (or by) that enemy this frame -- the same shape
//                  the player channel uses (effect/alignment/offset/rel/pos/duration/group/part/
//                  looped/delay), so the replay is the same call. The aim/telegraph fx needs no
//                  channel of its own: it IS an infinite fx in group "__aimFx__" attached to the
//                  enemy (AimFx.showFx, enemy-aim-fx.js:57-71), so it is one of these, and its stop
//                  (AimFx.stopFx -> FxEntity.clearList -> stop(), :72-74) reaches the stop hook like
//                  any other.
//   fxStops        the stops of the fx above, with their enemy. An infinite fx never ends by
//                  itself, so this is the only way the peer ever learns to tear one down.
//   persistentFx   the snapshot of that enemy's still-live infinite fx, re-sent every frame, so a
//                  peer entering the room rebuilds the ones it missed (the player channel's
//                  pattern, ./snapshot.js). A telegraph shown while the peer was away comes back.
//   sounds         one-shot sounds tied to the enemy, played by the peer at that enemy's position.
//                  Volume ramps do NOT travel (see the note in ./snapshot.js): an enemy sound is
//                  replayed once and its stop is what ends it.
//   soundStops     those stops.
//   projectiles    the proxies the enemy fired, mirrored by the peer as visual-only copies.
//   hitNumbers     one damage number the owner has just DRAWN for a hit that was forwarded to this
//                  enemy (see the capture section further down): the number lives in the victim's
//                  damage pipeline, so it was drawn on the owner's screen and on the peer's screen
//                  nowhere -- the peer's own copy of the hit is suppressed, and its player's damage
//                  numbers come from this batch instead. An entry carries the amount, the landing
//                  point and the crit marking (the parts of the engine's own hit-number call that
//                  vary per hit; its style is a constant on this path -- see the capture section),
//                  plus the `enemy` every batch entry carries.
//
// Nothing is captured for an enemy this client does NOT own: it is puppeting that enemy, so its own
// action fx/sounds/projectiles are suppressed locally (./enemy-puppet.js's patches) and its owner
// is the one sending them. That is the mutual exclusivity in both directions: owned -> forward,
// never locally matched; puppet -> neither emitted by the engine nor forwarded here. The hit-number
// batch follows the same rule from a different end: it is only ever filled for an enemy this client
// owns, and only for a hit that reached it through the forwarding path.

// The enemy channel's queues, in one place: ./session.js's enemyQueues slots and - the same names -
// the batches they become on the wire (see the MSG.ENEMY_STATE table in ../net/protocol.js).
const ENEMY_EFFECT_KEYS = ["globalFx", "fxStops", "sounds", "soundStops", "projectiles", "hitNumbers", "hitActs", "hitActStops"];

// Drain this frame's enemy effect queues, keeping only what belongs to an enemy the frame
// publishes. Returns null when nothing survived, so a frame with no enemy effects keeps exactly the
// shape it had before this phase. Always empties the queues (see sendOwnerStates).
function drainEnemyEffects(published) {
	// The overwhelmingly common frame captures nothing, and these are per-frame queues: with every
	// one of them empty (and no lasting fx alive) there is nothing to drain, no batch to build and
	// no frame-shaped object to allocate.
	if (!ENEMY_EFFECT_KEYS.some((key) => enemyQueues[key].length > 0) && activeEnemyFx.size === 0)
		return null;
	const out = {};
	for (const key of ENEMY_EFFECT_KEYS)
		out[key] = takeQueued(enemyQueues, key, published);
	out.persistentFx = takePersistentEnemyFx(published);
	let any = false;
	for (const key of Object.keys(out)) {
		if (out[key] === null)
			delete out[key];
		else
			any = true;
	}
	return any ? out : null;
}

// The entries of one queue that belong to a published enemy, or null when none do. The queue itself
// is ALWAYS emptied: an entry kept for a later frame could name an enemy that has since stopped
// being ours, and a stale aim fx applied then would stick to an enemy we no longer simulate.
function takeQueued(holder, key, published) {
	const list = holder[key];
	holder[key] = [];
	if (list.length === 0)
		return null;
	const kept = [];
	for (const entry of list) {
		if (entry && published.has(entry.enemy))
			kept.push(entry);
	}
	return kept.length > 0 ? kept : null;
}

// The full snapshot of our enemies' lasting (infinite) fx, for the enemies this frame publishes.
// The liveness test is the one ./snapshot.js applies to the player channel: drop entries whose fx
// is gone, reused for another fx, ended, or already stopping -- an infinite fx has duration -1
// while alive and stop() sets it to 0, and `_ttFxId` is an identity check so a pooled FxEntity
// recycled for a new fx cannot keep an old id alive. Both channels prune their own registry (they
// are separate maps), so an entry cannot be kept alive by a frame that carries the other one.
function takePersistentEnemyFx(published) {
	if (activeEnemyFx.size === 0)
		return null;
	const persistent = [];
	for (const [id, entry] of activeEnemyFx) {
		if (!entry.fx || entry.fx._ttFxId !== id || entry.fx.hasEnded?.() || !(entry.fx.duration < 0)) {
			activeEnemyFx.delete(id);
			continue;
		}
		if (published.has(entry.desc.enemy))
			persistent.push(entry.desc);
	}
	return persistent.length > 0 ? persistent : null;
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
			// MARK, do not send (Phase 4b): the despawn rides the enemy's removal, so the peer gets
			// to watch the death animation instead of the enemy vanishing. Marking happens BEFORE the
			// engine's own death work runs, so a death that removes the entity within this same frame
			// is still recorded (the gone sweep in syncEnemies then sends the despawn next frame).
			if (isEnemySyncEnabled())
				markDying(this?.ent);
			return original.apply(this, args);
		};
		wrapper.__ttDespawnPatched = true;
		proto.onDeathHit = wrapper;
	}
	despawnPatched = true;
}

// An enemy THIS client owns has just been beaten (the onDeathHit wrapper above). Do NOT announce
// it yet (Phase 4b): the enemy is not gone. The engine is about to play its death animation and
// only removes the entity when that finishes (combatant boom -> the enemyDieFade action ->
// onPostAction -> core.kill, combatant-cmp.js:381-401, :364-370; the removal itself is a deferred
// deactivation, game-state.js:144-162). Announcing the despawn NOW, as the previous phase did, is
// exactly why the peer's enemy vanished instantly: the despawn removed it in the same frame its
// state stopped arriving. Instead the enemy is marked dying and its state keeps being published
// (syncEnemies) until the engine removes it, at which point the despawn goes out (syncEnemies'
// gone sweep, via sendDespawnId).
//
// Silent when the feature is off, while offline, for an enemy whose identity is not
// wire-addressable (a runtime spawn, or a spot whose map is already gone), and for an enemy the
// registry does not assign to us -- only the owner's word about an enemy is authoritative here,
// exactly as in the state publish. (The despawn is still not gated on hasPeers: it is one-shot and
// must survive a peer set that has not been populated yet.)
function markDying(ent) {
	if (!isEnemySyncEnabled() || !isConnected())
		return;
	const id = wireEnemyId(ent?.core);
	if (id === null || !isOwner(id))
		return;
	dyingOwned.set(id, nowMs());
	if (debugEnabled())
		debugLog(`enemy ${id} is dying: despawn deferred until its entity is removed`);
}

// The actual one-shot despawn frame. Sent by the deferred window decided in markDying (see
// syncEnemies): the same payload the old immediate path used, { owner, list: [{ id }] }.
function sendDespawnId(id) {
	send({ type: MSG.ENEMY_DESPAWN, owner: localPlayerId(), list: [{ id }] });
	if (debugEnabled())
		debugLog(`despawn sent for ${id}`);
}

// ────────────────── peer half: render an owned enemy's effects ──────────────────
//
// The effect half of the peer state: the fx/sounds/projectiles an enemy's owner sent in the same
// enemy_state frame as its state, applied to OUR copy of that enemy. Everything here runs exactly
// where the enemy is driven as a puppet (applyPeerState's fresh-state branch), for two reasons that
// are the same reason:
//   - an enemy this client SIMULATES locally must never take the owner's stream: its own engine fx
//     are the real ones, and a stale telegraph with no stop coming would stick to it;
//   - the fx are attached to the entity (spawnRemoteFx), so they must be attached to the entity the
//     frame's state was just applied to -- the local copy of the enemy, not a peer player's ghost.
// The batches are applied ONCE per frame entry (the `applied` mark), then dropped with it, so a
// descriptor is never spawned twice.
//
// Per kind:
//   globalFx      spawnRemoteFx -- the same replay the player channel uses (it takes any entity),
//                 so the descriptor shape, the offset/rel handling, the screen-step suppression
//                 and the "this is a peer replay" marks are all shared. Remembered under its sync
//                 id, which is what lets a stop find it and the persistent reconcile below see
//                 that a lasting fx reported by BOTH paths is already shown.
//   persistentFx  reconcilePersistentFx, the same reconcile the player channel runs: spawn what we
//                 are missing (a telegraph or status fx that started while we were away) and stop
//                 what the owner no longer reports. `running` is the puppet's own driven speed for
//                 the same reason the player path measures the ghost's: a run-group fx reported by
//                 an owner that has stopped moving is stale. This and globalFx share the fx map,
//                 so a lasting fx that came in as a one-shot is not spawned a second time.
//                 The speed threshold is the SHARED RUN_FX_SPEED_EPS imported from ./session.js --
//                 the very constant ./actors.js:188 measures a peer player's ghost with, because it
//                 is one concept ("is this driven entity running") and a second copy of the number
//                 is exactly the kind of duplicated shared logic this codebase has been bitten by
//                 before (see the enemyStableId note above).
//   fxStops       stop the tracked fx (an infinite telegraph ends no other way).
//   sounds        replay at the enemy's own position (./actors.js's playSyncedSound -- it needs
//                 nothing but a core, and an enemy has one), remembering the playback per sync id.
//   soundStops    stop that playback.
//   projectiles   spawnRemoteProjectile on the enemy, which mirrors it as a visual-only copy (the
//                 same `__ttVisual`/blocked-steps machinery the player channel uses): it shows and
//                 flies, and can land nothing.
//   hitNumbers    replayEnemyHitNumber, once per entry, through the engine's own hit-number API --
//                 the damage numbers the owner drew for this peer's forwarded hits (a GUI element,
//                 so it is the one batch here that is not an fx; see the capture section below for
//                 what travels and what the replay can and cannot reproduce).
function applyEnemyEffects(id, ent, entry) {
	if (!entry || entry.applied)
		return;
	entry.applied = true;

	const holder = enemyFxState(ent);
	for (const fx of entry.globalFx ?? []) {
		const live = spawnRemoteFx(ent, fx);
		if (live && fx.id != null)
			holder.fxMap[fx.id] = live;
	}
	const vel = ent.move?.vel;
	const running = !!vel && typeof vel.lengthXY === "function" && vel.lengthXY() > RUN_FX_SPEED_EPS;
	reconcilePersistentFx(ent, entry.persistentFx, running);
	for (const stop of entry.fxStops ?? [])
		stopSyncedEnemyFx(holder, stop);
	for (const s of entry.sounds ?? []) {
		const playback = playSyncedSound(ent, s);
		if (playback && s.id != null)
			holder.soundMap[s.id] = playback;
	}
	for (const stop of entry.soundStops ?? []) {
		const playback = holder.soundMap[stop?.id];
		if (!playback)
			continue;
		playback.stop();
		delete holder.soundMap[stop.id];
	}
	for (const p of entry.projectiles ?? [])
		spawnRemoteProjectile(ent, p);
	for (const n of entry.hitNumbers ?? [])
		replayEnemyHitNumber(n);
	// The melee/splash half: run the act on OUR copy of the enemy (applyRemoteHitAct) and cancel
	// the ones the owner has finished with (stopRemoteHitAct). Starts before stops, in the order
	// the owner queued them, so an act that began and ended within one frame nets out to nothing.
	for (const a of entry.hitActs ?? [])
		applyRemoteHitAct(ent, a);
	for (const s of entry.hitActStops ?? [])
		stopRemoteHitAct(ent, s);
}

// The per-enemy home of what an owner's stream has put on OUR copy of an enemy: the fx it spawned
// (by sync id, so a stop can find one and the persistent reconcile can tell what is already shown)
// and the sounds it started (by sync id). The same two maps ./fx-sync.js's replay keeps on a peer
// PLAYER's ghost (./actors.js), created here on first use -- an enemy entity carries nothing of
// ours until its owner's first effect arrives.
function enemyFxState(ent) {
	const holder = (ent.terraTogether ??= {});
	holder.fxMap ??= {};
	holder.soundMap ??= {};
	if (holder.persistentIds === undefined)
		holder.persistentIds = null;
	return holder;
}

// Stop one synced fx the owner reported stopping. Unknown ids are ignored: an fx the owner spawned
// before we started holding this enemy was never spawned here, and a stop for it means nothing.
function stopSyncedEnemyFx(holder, stop) {
	const live = holder.fxMap?.[stop?.id];
	if (!live)
		return;
	try { live.stop(stop.delay ?? 0, stop.softStop ?? false); } catch (e) { /* already gone */ }
	delete holder.fxMap[stop.id];
}

// ─────────── hit acts: melee and splash damage on the client that RECEIVES it ───────────
//
// The problem this closes. An enemy's hitbox is resolved by whoever SIMULATES the enemy, and an
// enemy this client owns is simulated here while the other client only holds a driven copy of it
// (Phase 2). So an enemy's melee/splash could only ever land on the OWNER's player: the other
// player's body is not on the owner's client as a combatant at all (its ghost has no CombatantCmp,
// so TerraActor.onHitCheck refuses every hit). The two players therefore lived in different fights
// with the same enemy.
//
// The model that closes it, and why it needs no arbitration: damage is resolved where it LANDS.
// Each client runs the enemy's hit act on its OWN copy of the enemy, against its OWN colliders, so
// a client can only ever damage its own player -- never the peer's, never an enemy's (the enemy's
// own attack carries the enemy party, which no enemy passes). A hit cannot be applied twice, and
// no client has to trust another's word about where anybody was: the peer resolves the hit at the
// position it SEES the enemy at, which is the fairness property the whole approach exists for.
//
// WHAT TRAVELS: the IDENTITY of the act, not its geometry and not the action around it.
//   action/idx/kind   which authored hit step fired: the enemy action's name, the step's index in
//                     a canonical walk of that action, and its step type. Both sides read the SAME
//                     shared game data: an enemy's actions are built from its sheet's own JSON
//                     (`EnemySheet.onJsonBuild`, enemy-type.js:87-90) and both clients load the same
//                     file, so the peer can look the very step up instead of being sent its
//                     parameters -- and it must, because the step's own props are live engine
//                     objects (HitCircleProps.target is a `Target` whose "self" resolves through
//                     g_gState.contextEntity, and hitDirFace/hitFaceFlip/hitFaceRot are
//                     NumExpressions): they cannot be serialised, and an act built from raw numbers
//                     could not be one.
// Nothing else rides: not a position (the enemy's position is already in the same frame's state,
// and the act is anchored to the enemy), not a duration (authored, and identical on both sides),
// not the action's other steps.
//
// WHY THE ACT CAN SIMPLY BE RE-RUN. The hit test is a WORLD COLLIDER QUERY, not a search for the
// player: HitCircleAct.update asks PhysicsQuery.getCollsInCircle for every coll in a circle
// (hit-circle-act.js:155), and the circle's centre is authored SELF-RELATIVELY -- the shipped
// HIT_CIRCLE uses all centre on the enemy or one of its own body nodes (the only exceptions are
// three hedgebird jump impacts that read a position out of a script var; see the gap below). So the
// same act started on the peer's copy of the enemy resolves the same shape, at the enemy's synced
// position, against the peer's own world -- and its hitbox finds that player's body and nothing
// else it may hit. HIT_SWEEP is the same argument one level down (its geometry is a hook of the
// enemy's own figure, sweep-act.js:169-177) and HIT_LINE's two ends are authored self-relative
// too.
//
// WHY NOT REPLAY THE WHOLE ACTION INSTEAD. Two independent reasons:
//   - it would not reach the hit step at all. 62 of the 96 shipped actions that contain a hit step
//     run an arrival step (TARGET_FOLLOW_JUMP, POINT_APPROACH, FALL_APPROACH, JUMP,
//     WAIT_UNTIL_ON_GROUND, NAV_TO) BEFORE that hit step, and a puppet's physics are pinned
//     (./enemy-puppet.js pinPuppet) precisely so it cannot move itself: those steps can never
//     complete, so the hit step behind them would never run. That is also why they were left out of
//     the puppet drive in Phase 2.
//   - the steps around the hit would fight the drive and duplicate what is already synced: pose
//     steps (SHOW_ANIMATION) set the very animationFixed pin the puppet owns, SPAWN_FX/CLEAR_FX
//     would double every fx Phase 6 already sends, and SET_COLL/SET_SPEED/SET_PHASE would fight the
//     position and velocity stream.
// The act is therefore run the engine's own way -- the step's `start` -- and nothing else of the
// action is.
//
// The four seams, both halves, in one place:
//   owner, capture   ACTION_STEP.{HIT_CIRCLE,HIT_SWEEP,HIT_LINE}.prototype.start, wrapped once.
//                    The step creates its act (HitCircleAct.get -> g_combat.addCombatAct) inside
//                    that call, so the act is taken from `g_combat.acts` immediately after it, and
//                    the capture only happens for an enemy THIS client owns (`ownedIdOf`, the same
//                    ownership answer ./fx-sync.js attributes an enemy fx with -- the owner is the
//                    only client simulating the attack, so it is the only one with anything to
//                    say about it).
//   owner, stop      CombatAct.prototype.cancel, wrapped once, for the acts the capture tagged: it
//                    is the engine's own "this act is over" path (`update` returning done ->
//                    updateActs' act.cancel(); STOP_COMBAT_ACTS -> entry.cancel(); the action
//                    ending -> onSubscriptionEnd -> cancel), and a repeating act (duration -1)
//                    ends no other way.
//   peer,  start     applyRemoteHitAct: resolve the step from the enemy's own sheet, run its
//                    `start` with the local copy of the enemy as the acting entity -- inside
//                    g_gState.pushContextEnt(core), which is what makes the step's self-relative
//                    `Target` resolve to that enemy -- and remember the act under the owner's id.
//   peer,  stop      stopRemoteHitAct: cancel that act; and enemy-puppet.js's clearPuppetHitActs,
//                    run from releasePuppet, is the backstop for a stream that stopped without
//                    saying so (owner gone, feature off, map change, ownership taken): an act left
//                    running on a released enemy is the one failure mode with no natural end, so it
//                    is cancelled everywhere the puppet itself is.
//
// Deliberately NOT replayed: HIT_DIRECT. Its step resolves its own target -- `actor.targetColl` /
// actor.getTarget() (combat-act-steps.js:261-268) -- and a puppet has no target: the AI seams that
// would acquire one are exactly what a puppet suppresses (./enemy-puppet.js patch (a)), and
// handing it the local player as a target would hand it the AI's own input. Two shipped attacks use
// it (swamp/scorpion shockFreeze/shockFreezeFly, both `party: PLAYER`, i.e. the attack hits its own
// party anyway) and both are left as a gap. Also not replayable, and left as a gap on the same
// rule: a hit act whose centre is not anchored on the enemy itself (the three hedgebird jump
// impacts read `ent.vars.tmpPos1`, a position the action wrote into a script var that the peer
// never ran) -- hitActAnchorIsSelf rejects those rather than resolving a circle at the peer's
// world origin.

// The hit-shaped steps, by ACTION_STEP key. These are the acts whose geometry is self-relative and
// whose effect is "damage whatever the engine finds in a shape around this enemy".
const HIT_ACT_KINDS = ["HIT_CIRCLE", "HIT_SWEEP", "HIT_LINE"];

// ...plus the ONE kind that is not an act at all, and needs a different replay: the TACKLE step
// (see the tackle section below). It is a step of the same family as far as the wire is concerned --
// an authored step of an authored action, identified by action+index and looked up on the peer -- so
// it rides the same batch and is resolved by the same lookup; only the replay differs.
const REPLAYABLE_ACT_KINDS = [...HIT_ACT_KINDS, "TACKLE"];

// Install-once flags. The step wrappers and the act-cancel wrapper are installed together, from
// the same per-frame hook the other owner-side seams use (see onPreUpdate): the first frame is
// early enough (an enemy cannot attack before the world runs), and a build whose ACTION_STEP or
// CombatAct is missing leaves the flag alone so a later frame can retry.
let hitActPatchesInstalled = false;

// Ids for the acts this client forwards. One namespace per client, like fxSyncId/`projSyncId` in
// ./fx-sync.js: the peer keys its live acts by this id inside one enemy's frame, so it only has to
// be unique among the acts one owner is reporting.
let hitActSyncId = 0;

// Set only while THIS module is starting a peer's hit act on a puppet (applyRemoteHitAct). The step
// wrapper below is the same wrapper that captures our own enemies' attacks, and the peer's copy of
// the step goes through it: this flag is what tells the wrapper that the call it is looking at is
// the replay, not an attack of ours to forward.
let replayingHitAct = false;

// The live step registry, the same lookup ./fx-sync.js patches its blocked steps through.
function actionStepRegistry() {
	return terra.export.ACTION_STEP ?? terra.file.stepBase?.ACTION_STEP ?? null;
}

// The act the call just started, taken from the engine's own list of running acts
// (CombatManager.addCombatAct pushes it, combat.js:276-278, synchronously inside the step's
// start). Exactly one act is expected: zero means the step found no attacker and started nothing
// (which is the answer we need -- the peer must not run an act the owner did not), and more than
// one means something else ran in between on a build we do not know, so the call is left alone.
function takenCombatAct(acts, before) {
	if (!Array.isArray(acts) || before < 0)
		return null;
	return acts.length === before + 1 ? acts[before] : null;
}

// The step type of a hit step, by identity against the live registry (the classes carry their key
// as a static, `_a.key = "HIT_CIRCLE"`, combat-act-steps.js:196, so instanceof is the fidelity
// check that matters). null for anything we do not replay.
function hitActKindOf(step) {
	const ACTION_STEP = actionStepRegistry();
	if (!ACTION_STEP || !step)
		return null;
	for (const kind of HIT_ACT_KINDS) {
		const StepClass = ACTION_STEP[kind];
		if (StepClass && step instanceof StepClass)
			return kind;
	}
	return null;
}

// ONE canonical walk of an action's steps, used by BOTH sides: the owner finds the index of the
// step that just fired, and the peer takes the step at that index out of its own copy of the same
// action. The two structures are built by the same code from the same JSON (StepSequence.build,
// step-base.js:470-520), so a deterministic walk over them yields the same index on both clients --
// which is what makes `idx` a usable identity without sending any of the step's data. `nextStep` is
// the sequence order, `branches` the sub-sequences of a branching step, and the guard set keeps a
// structure the engine linked into a cycle from walking forever.
function sequenceSteps(action) {
	const out = [];
	const seen = new Set();
	const walk = (step) => {
		while (step && !seen.has(step)) {
			seen.add(step);
			out.push(step);
			const branches = step.branches;
			if (branches) {
				for (const key of Object.keys(branches))
					walk(branches[key]);
			}
			step = step.nextStep;
		}
	};
	walk(action?.rootStep);
	return out;
}

// Where a hit act's shape is anchored, as the engine resolved it at init, so that the peer's own
// resolution can be trusted to land in the same place: the act's own target(s) must be the acting
// enemy. HIT_SWEEP needs no such test -- SweepProps has no target at all; its geometry is a hook of
// `damer.ent.view`'s own figure (sweep-act.js:169-177), i.e. self-relative by construction.
function hitActAnchorIsSelf(act, kind, ent) {
	if (kind === "HIT_CIRCLE")
		return act?.target?.entity === ent;
	if (kind === "HIT_LINE")
		return act?.target1?.entity === ent && act?.target2?.entity === ent;
	return kind === "HIT_SWEEP";
}

// Which action of this enemy is running the step, and where in it the step sits. The name is taken
// from the running sequence and then checked by IDENTITY against the enemy sheet's own action of
// that name: only an action the peer can also look up by name may travel. A sequence that is not in
// the sheet (the engine's own shared call-sequences, e.g. the boom/hide fades, which are not enemy
// actions) fails that check and is left alone.
function describeHitAct(step, ctx, ent) {
	const sequence = ctx?.sequenceState?.sequence;
	const name = typeof sequence?.name === "string" ? sequence.name : null;
	if (name === null)
		return null;
	const actions = ent?.enemy?.enemyType?.sheet?.actions;
	const action = actions?.[name];
	if (!action || action !== sequence)
		return null;
	const idx = sequenceSteps(action).indexOf(step);
	if (idx < 0)
		return null;
	return { action: name, idx };
}

// One hit act an enemy we simulate has just started: tag the act so its end can be reported, and
// queue its identity for the frame. A step that started no act has nothing to report (the engine
// found no attacker either), and an act anchored anywhere but on the enemy itself is not forwarded
// at all (see the gap note above) -- better an unreplayed attack than a hitbox resolved in the
// wrong place.
function captureHitAct(step, ctx, ent, enemyId, act) {
	if (!act)
		return;
	const kind = hitActKindOf(step);
	if (!kind || !hitActAnchorIsSelf(act, kind, ent))
		return;
	const ref = describeHitAct(step, ctx, ent);
	if (!ref)
		return;
	const tag = { id: ++hitActSyncId, enemy: enemyId };
	act.__ttHitAct = tag;
	enemyQueues.hitActs.push({ id: tag.id, enemy: enemyId, action: ref.action, idx: ref.idx, kind });
	if (debugEnabled())
		debugLog(`enemy ${enemyId}: hit act ${kind} (#${tag.id}) of ${ref.action}[${ref.idx}] forwarded`);
}

// The per-enemy registry of the hit acts an owner's stream has put on OUR copy of an enemy: owner's
// act id -> the local act, so the owner's stop can cancel exactly that one. Kept ON THE ENTITY (not
// in the terraTogether holder the fx/sound maps use) for one reason: ./enemy-puppet.js's
// releasePuppet has to drop it, and that module cannot import this one (this module imports it), so
// the key is a convention both files spell out -- exactly like `stateId`'s two lockstep copies. The
// KEY IS DUPLICATED IN ./enemy-puppet.js (PUPPET_HIT_ACTS): edit one, edit both.
const PUPPET_HIT_ACTS = "__ttPuppetHitActs";

function remoteHitActsOf(ent) {
	return (ent[PUPPET_HIT_ACTS] ??= new Map());
}

// The peer's step, resolved from the shared data: the enemy's own action of the sent name, the step
// at the sent index, checked against the live registry for the sent kind. Any mismatch (a build
// whose data differs, a stale or malformed entry, an action the enemy no longer has) resolves to
// null and the entry is dropped -- never acted on.
function resolveHitActStep(ent, entry) {
	const name = entry?.action;
	const idx = entry?.idx;
	const kind = entry?.kind;
	if (typeof name !== "string" || !Number.isInteger(idx) || idx < 0 || !REPLAYABLE_ACT_KINDS.includes(kind))
		return null;
	const StepClass = actionStepRegistry()?.[kind];
	const action = ent?.enemy?.enemyType?.sheet?.actions?.[name];
	if (!StepClass || !action)
		return null;
	const step = sequenceSteps(action)[idx];
	if (!(step instanceof StepClass) || typeof step.start !== "function")
		return null;
	return step;
}

// The engine's own context stack, around the replay: the step's `Target` ("how the circle is
// centred") resolves "self" through g_gState.contextEntity (step-arguments.js:67-72), NOT through
// the context it is handed, so the enemy has to be the pushed context while the act initialises --
// which is exactly what the engine does for every act it updates itself (combat.js:212-215). Null
// when the stack is not reachable on this build, in which case the act is not run at all rather than
// run around the world origin.
function pushActContext(core, fn) {
	const gState = terra.export.g_gState;
	const usable = gState && typeof gState.pushContextEnt === "function"
		&& typeof gState.popContextEnt === "function";
	if (!usable)
		return undefined;
	gState.pushContextEnt(core);
	try {
		return fn();
	}
	finally {
		gState.popContextEnt(core);
	}
}

// Run one peer's hit act on our copy of the enemy. The step's own `start` is the whole mechanism:
// it builds the act from the step's authored props (identical here, they came from the same game
// data), attaches it to the enemy's real attacker/damager -- so the damage, the party, the hit
// direction and the hit-stop all ride the engine's own path -- and hands it to g_combat, which
// updates every act every frame (combat.js:197-225) with the enemy as the pushed context. Nothing
// here enables the AI, restarts the action, or touches FX: only the act runs.
//
// Fail-soft and bounded: an unresolvable step, a missing context stack, a step that throws, or a
// step that starts no act all end in "nothing happens on this client" (a peer's payload is not
// trusted input, and this runs on the frame path).
function applyRemoteHitAct(ent, entry) {
	if (!entry || typeof entry !== "object")
		return;
	const id = entry.id;
	if (typeof id !== "number")
		return;
	const core = ent?.core;
	if (!core)
		return;
	const step = resolveHitActStep(ent, entry);
	if (!step)
		return;
	// A tackle is replayed by building the tackle, not by running an act (see the tackle section):
	// same batch, same identity, different replay.
	if (entry.kind === "TACKLE") {
		applyRemoteTackle(ent, entry);
		return;
	}
	const acts = terra.export.g_combat?.acts;
	const before = Array.isArray(acts) ? acts.length : -1;
	let act = null;
	replayingHitAct = true;
	try {
		pushActContext(core, () => step.start({ entity: ent }));
		act = takenCombatAct(acts, before);
	}
	catch (e) {
		act = takenCombatAct(acts, before);
		if (debugEnabled())
			debugLog(`hit act ${entry.kind} of ${entry.action} was not replayed: ${e?.message ?? e}`);
	}
	finally {
		replayingHitAct = false;
	}
	if (!act)
		return;
	remoteHitActsOf(ent).set(id, act);
	if (debugEnabled())
		debugLog(`enemy ${entry.enemy}: hit act ${entry.kind} (#${id}) of ${entry.action} `
			+ `[${entry.idx}] replayed on our copy`);
}

// The owner has finished with one of its acts: cancel ours. `CombatAct.cancel` is the engine's own
// teardown (it clears the act's subscriptions and drops its damager, which is what makes
// g_combat's next update remove and release it), so this is the same call the engine would make if
// the act had ended here -- which, on the peer, is a thing that can only be told to it.
function stopRemoteHitAct(ent, stop) {
	const acts = ent?.[PUPPET_HIT_ACTS];
	const id = stop?.id;
	if (!acts || typeof id !== "number")
		return;
	const act = acts.get(id);
	acts.delete(id);
	if (!act || typeof act.cancel !== "function")
		return;
	try { act.cancel(); } catch (e) { /* already gone */ }
}

// Install the four seams above, once (see hitActPatchesInstalled).
function ensureHitActPatches() {
	if (hitActPatchesInstalled)
		return;
	const ACTION_STEP = actionStepRegistry();
	const CombatAct = terra.export.CombatAct;
	if (!ACTION_STEP || !CombatAct?.prototype || typeof CombatAct.prototype.cancel !== "function") {
		if (debugEnabled())
			debugLog("cannot install the hit-act patches: ACTION_STEP or CombatAct is missing");
		return;
	}

	// A step class that is missing means a game build this mod does not know: naming it in a warning
	// is the difference between "this attack kind is not synced" and "enemy attacks are not synced",
	// which is a distinction nobody can make in game.
	const missing = [];
	for (const kind of HIT_ACT_KINDS) {
		const StepClass = ACTION_STEP[kind];
		if (!StepClass?.prototype || typeof StepClass.prototype.start !== "function") {
			missing.push(kind);
			continue;
		}
		if (StepClass.prototype.start.__ttHitActPatched === true)
			continue;
		const originalStart = StepClass.prototype.start;
		const wrapper = function (...args) {
			const ctx = args[0];
			const ent = ctx?.entity;
			// An enemy this client owns is the only one whose attacks travel (see ownedIdOf): for
			// everything else -- the local player's own hit acts, an enemy we only puppet, a call
			// while the feature is off -- this is a transparent passthrough.
			const enemyId = replayingHitAct ? null : enemyOwnership.ownedIdOf(ent);
			const acts = enemyId === null ? null : terra.export.g_combat?.acts;
			const before = Array.isArray(acts) ? acts.length : -1;
			const result = originalStart.apply(this, args);
			if (enemyId !== null)
				captureHitAct(this, ctx, ent, enemyId, takenCombatAct(acts, before));
			return result;
		};
		wrapper.__ttHitActPatched = true;
		StepClass.prototype.start = wrapper;
	}

	// The TACKLE step, wrapped once, exactly like the HIT_* classes above -- but read, not reused: the
	// step is what tells us WHICH authored attack is running, and the object it leaves on the entity
	// (`attacker.tackle`) is what the peer re-creates.
	const TackleStep = ACTION_STEP.TACKLE;
	if (TackleStep?.prototype && typeof TackleStep.prototype.start === "function"
		&& TackleStep.prototype.start.__ttHitActPatched !== true) {
		const originalTackleStart = TackleStep.prototype.start;
		const wrapper = function (...args) {
			const ctx = args[0];
			const ent = ctx?.entity;
			const enemyId = replayingHitAct ? null : enemyOwnership.ownedIdOf(ent);
			const result = originalTackleStart.apply(this, args);
			if (enemyId !== null)
				captureTackle(this, ctx, ent, enemyId);
			return result;
		};
		wrapper.__ttHitActPatched = true;
		TackleStep.prototype.start = wrapper;
	}

	// The tackle's end, wrapped once. clearTackle is the ONLY teardown (see the tackle section), so
	// this is where the owner's stop is reported from -- and it is load-bearing rather than
	// bookkeeping: the peer has nothing else that can end its tackle.
	const AttackerCmp = terra.export.AttackerCmp ?? terra.file.attackerCmp?.AttackerCmp ?? null;
	if (AttackerCmp?.prototype && typeof AttackerCmp.prototype.clearTackle === "function"
		&& AttackerCmp.prototype.clearTackle.__ttHitActStopPatched !== true) {
		const originalClearTackle = AttackerCmp.prototype.clearTackle;
		const wrapper = function (...args) {
			reportTackleStop(this.tackle);
			return originalClearTackle.apply(this, args);
		};
		wrapper.__ttHitActStopPatched = true;
		AttackerCmp.prototype.clearTackle = wrapper;
	}

	const proto = CombatAct.prototype;
	if (proto.cancel.__ttHitActStopPatched !== true) {
		const originalCancel = proto.cancel;
		const wrapper = function (...args) {
			// Only an act the capture above tagged reports a stop; every other act in the game
			// (including our own replays, which are never tagged this way) goes straight through.
			const tag = this.__ttHitAct;
			if (tag) {
				this.__ttHitAct = null;            // one stop per act, whatever calls cancel twice
				enemyQueues.hitActStops.push({ id: tag.id, enemy: tag.enemy });
				if (debugEnabled())
					debugLog(`enemy ${tag.enemy}: hit act #${tag.id} ended`);
			}
			return originalCancel.apply(this, args);
		};
		wrapper.__ttHitActStopPatched = true;
		proto.cancel = wrapper;
	}

	hitActPatchesInstalled = true;
	if (missing.length)
		console.warn("[TT enemy-sync] hit acts not synced for (unknown game build?): " + missing.join(", "));
}

// ───────────────────── tackle: the contact attack that has no act ─────────────────────
//
// The gap this closes. Every other enemy melee or splash in the game is an ACT: an authored
// HIT_CIRCLE/HIT_SWEEP/HIT_LINE step builds a CombatAct, and the act is what resolves the hitbox --
// which is why the section above can replay one step and get the whole attack. The TACKLE step is
// not that. TackleStep.start (combat-act-steps.js:302-338) builds NO act and lands NO hit: it hangs a
// `Tackle` on the AttackerCmp (`attacker.setTackle(this.attackInfo)`, attacker-cmp.js:183-187),
// points the entity's movement at it, and from then on the damage is resolved by PHYSICS CONTACT --
// AttackerCmp.onCollision (attacker-cmp.js:208-212), which the engine calls for every coll the moving
// entity touches, calls straight into `tackle.hit` (`:80-102`: isHitCompatible -> onHit -> hitCount++,
// `cancelOnHit` ends it, `addHitColl` starts the 1.0s repeat cooldown that IS the tackle's multi-hit
// semantics). A puppet produces no collisions at all (its physics are pinned and its position is
// teleported by the drive, ./enemy-puppet.js), so nothing about a tackle reaches the other player:
// the spiky balls' charge, the hedgebird's spin, the wasp's dash, the turtle's spin attack and the
// platapus's bite are all invisible to the peer.
//
// The model, and why it is the same one as the hit acts. Damage is resolved where it LANDS, so the
// peer re-runs the tackle's contact test against its OWN world -- but only against its own player
// (that is the whole victim-side property: a client can only ever damage itself), and using the
// engine's own `Tackle` object and the engine's own collision query rather than any new maths. What
// travels is the identity of the step, exactly as for a hit act: the tackle's damage, its party, its
// hit direction, its hit-stop and its multi-hit cooldown all come from the same authored props both
// clients loaded.
//
// WHAT TRAVELS: action + index + the kind "TACKLE", on the EXISTING hitActs batch -- no new message
// and no new batch key. Its end travels on hitActStops: this one is load-bearing rather than
// symmetry, because the tackle's window is NOT the step's duration. The step ends when
// `context.timer <= 0`, but the Tackle object outlives it (turtle `attackSpin` is authored with
// `duration: 0`, and either way a tackle stays live until something calls `attacker.clearTackle()`
// -- the next setTackle, a config/state apply, STOP_TACKLE, burying, resetting), which is precisely
// what `keepTackle` exists for. So the owner's own end is the only thing that can end the peer's.
//
// The four seams, both halves, in one place:
//   owner, start    ACTION_STEP.TACKLE.prototype.start, wrapped once (same shape as the HIT_* step
//                   wrappers above, and installed from the same place). The wrapper does nothing to
//                   the call: it runs the engine's own start and then reads the Tackle it left on
//                   the entity, which is the object whose contact test the peer will re-create.
//   owner, stop     AttackerCmp.prototype.clearTackle, wrapped once. It is the ONLY teardown of a
//                   tackle (every path above ends there -- see the callers in attacker-cmp.js:117,
//                   :148, :212 and combat-act-steps.js:409/:459), so it is the one place an end
//                   cannot be missed.
//   peer,  start    applyRemoteTackle: resolve the same step from the enemy's own sheet, build the
//                   same Tackle the owner's step would have built (`setTackle(step.attackInfo)`, plus
//                   the two flags TackleStep copies onto it), and register a per-frame driver.
//   peer,  tick     driveRemoteTackles: for each live tackle, ask the engine's own collision map for
//                   everything overlapping the enemy's own main coll (PhysicsQuery's rectangle query
//                   -- the very call HIT_CIRCLE resolves through), keep the local player, and hand
//                   each to AttackerCmp.onCollision. The engine's own Tackle.hit does the rest:
//                   hit test, party filter, damage, hit-stop, and the cooldown that stops a tackle
//                   from hitting the same body every frame.
//
// Nothing here enables the AI, restarts the action, moves the enemy or touches FX: a Tackle is a
// passive object on the entity, and the only thing this module does with it is ask the engine whether
// it touches the player.

// The AttackerCmp of an enemy, the same read ./fx-sync.js uses to find an enemy's damager
// (`ent.enemy.combatant.attacker`, combatant-cmp.js:233) -- the combatant is the enemy's own, and it
// is where the Tackle lives.
function attackerOf(ent) {
	return ent?.enemy?.combatant?.attacker ?? ent?.combatant?.attacker ?? null;
}

// Live tackles an owner's stream has put on OUR copy of an enemy, by the owner's act id, plus the
// entity and attacker they belong to so the per-frame driver can use them without re-deriving
// anything. This is a module-level map rather than the per-entity one (PUPPET_HIT_ACTS) because a
// tackle is not a CombatAct and cannot be cancelled the same way: the per-entity map still carries an
// entry (so ./enemy-puppet.js's clearPuppetHitActs keeps releasing it without knowing what it is),
// and its `cancel` is a closure that clears BOTH -- see registerRemoteTackle.
const remoteTackles = new Map();

// One tackle an enemy we simulate has just started: tag it so its end can be reported, and queue its
// identity for the frame. `describeHitAct` does the identity work (the same canonical walk), and the
// anchor question that guards a hit act does not arise: a tackle's geometry is the enemy's own
// collision, so it is self-relative by construction.
function captureTackle(step, ctx, ent, enemyId) {
	const tackle = attackerOf(ent)?.tackle ?? null;
	if (!tackle)
		return;
	const ref = describeHitAct(step, ctx, ent);
	if (!ref)
		return;
	const tag = { id: ++hitActSyncId, enemy: enemyId };
	tackle.__ttHitAct = tag;
	enemyQueues.hitActs.push({ id: tag.id, enemy: enemyId, action: ref.action, idx: ref.idx, kind: "TACKLE" });
	if (debugEnabled())
		debugLog(`enemy ${enemyId}: tackle (#${tag.id}) of ${ref.action}[${ref.idx}] forwarded`);
}

// One tackle an owner has finished with, reported from AttackerCmp.clearTackle. The tag is dropped
// first so a second teardown of the same tackle (clearTackle is called by setTackle, by reset, by
// bury and by the step itself, and the engine's own setTackle calls it unconditionally before making
// a new one) cannot report a stop twice.
function reportTackleStop(tackle) {
	const tag = tackle?.__ttHitAct;
	if (!tag)
		return;
	tackle.__ttHitAct = null;
	enemyQueues.hitActStops.push({ id: tag.id, enemy: tag.enemy });
	if (debugEnabled())
		debugLog(`enemy ${tag.enemy}: tackle #${tag.id} ended`);
}

// Build the owner's tackle on OUR copy of the enemy, and remember it for the per-frame driver. The
// step's own props are the whole mechanism, and they are identical here (same game data): attackInfo
// carries the damage/party/knockback, `cancelOnHit` ends the tackle at its first hit, `orthoDirFactor`
// decides the hit direction, `freeze` the hit-stop. Exactly what TackleStep.start does with them
// (combat-act-steps.js:325-327), so the contact test that follows behaves as the owner's does.
//
// Fail-soft and bounded, like the hit-act replay: an unresolvable step, an entity without an attacker
// or a build without setTackle all end in "nothing happens on this client".
function applyRemoteTackle(ent, entry) {
	const core = ent?.core;
	const attacker = attackerOf(ent);
	if (!core || !attacker || typeof attacker.setTackle !== "function")
		return;
	const step = resolveHitActStep(ent, entry);
	if (!step)
		return;
	const id = entry.id;
	let tackle = null;
	try { tackle = attacker.setTackle(step.attackInfo); }
	catch (e) {
		if (debugEnabled())
			debugLog(`tackle of ${entry.action} was not replayed: ${e?.message ?? e}`);
		return;
	}
	if (!tackle)
		return;
	// The two the step copies onto the tackle itself, so the peer's contact test reacts the way the
	// owner's does: it ends at the first hit, and the victim flies along the same axis.
	tackle.cancelOnHit = step.cancelOnHit === true;
	if (Number.isFinite(step.orthoDirFactor))
		tackle.orthoDirFactor = step.orthoDirFactor;
	if (Number.isFinite(step.freeze))
		tackle.freeze.init(step.freeze);

	// The stop path and the puppet's release path both call `cancel()` on what they find in the
	// per-entity map, so this is the whole interface they need: drop the driver entry and clear the
	// tackle, but only while it is still the one we made (a later tackle of the same enemy replaces
	// it, and clearing the replacement would cancel an attack the owner is still running).
	const handle = {
		cancel: () => {
			remoteTackles.delete(id);
			if (attacker.tackle === tackle)
				attacker.clearTackle();
		},
	};
	remoteTackles.set(id, { ent, attacker, tackle, handle });
	remoteHitActsOf(ent).set(id, handle);
	if (debugEnabled())
		debugLog(`enemy ${entry.enemy}: tackle (#${id}) of ${entry.action}[${entry.idx}] replayed on our copy`);
}

// The peer's contact test, run every frame for every tackle an owner's stream has started on OUR
// copy of an enemy -- the half of the replay that the owner's step gets for free from the physics
// engine and a pinned puppet does not.
//
// The query is the engine's own: the enemy's main coll box, handed to the same rectangle lookup
// HIT_CIRCLE resolves through (PhysicsQuery.getCollsInRectangleC -> g_gState.physics.collMap.getColls,
// physics.js:133-158 -- a grid walk over every coll whose box, expanded by its own hitPadding,
// overlaps; entity-collision.js:326-339), with the tackle's own hit list passed as the ignore list so
// its 1.0s repeat cooldown is honoured by the broadphase itself. Straight from `CollMap.getColls` is
// used rather than the PhysicsQuery wrapper because it is the same call one level down and needs no
// export the modloader may not have mapped.
//
// Only the LOCAL player is taken from the result. That is not a convenience: it is the victim-side
// model, and it is also what keeps this cheap and harmless -- a puppet's tackle can never hit
// another enemy (the party filter would refuse it anyway), never a peer's ghost (no combatant), and
// never the enemy itself.
//
// The rest is the engine's: AttackerCmp.onCollision -> Tackle.hit does the hit test, the party check,
// the damage, the hit-stop and the cooldown bookkeeping. Nothing is applied twice: the cooldown keeps
// one hit per coll per second, and each client resolves only its own player.
function driveRemoteTackles() {
	if (remoteTackles.size === 0)
		return;
	const localPlayer = terra.export.g_player?.entity ?? null;
	const collMap = terra.export.g_gState?.physics?.collMap ?? null;
	if (!localPlayer || !collMap || typeof collMap.getColls !== "function") {
		// Without the local player or the world's collision map there is nothing to test against and
		// nothing to clean up: the owner's stop (or the puppet's release) still ends every entry.
		return;
	}
	const colls = [];
	for (const [id, entry] of remoteTackles) {
		const { ent, attacker, tackle } = entry;
		// The tackle is gone (a state change, a bury, the owner's stop not yet applied), the entity is
		// gone, or the engine has already cleared it: nothing left to drive.
		if (!ent?.core || ent.core.isKilled?.() || attacker?.tackle !== tackle) {
			remoteTackles.delete(id);
			continue;
		}
		const mainColl = ent.move?.mainColl ?? ent.core.colls?.[0] ?? null;
		if (!mainColl)
			continue;
		colls.length = 0;
		try {
			collMap.getColls(colls, mainColl.pos.x, mainColl.pos.y, mainColl.pos.z,
				mainColl.size.x, mainColl.size.y, mainColl.size.z,
				ent.core, null, tackle.hitForce?.hitColls ?? null);
		}
		catch (e) { continue; }
		for (const coll of colls) {
			if (coll?.core?.ent !== localPlayer)
				continue;
			// The engine's own contact entry point, with the direction it never reads (the tackle
			// computes its hit point from the overlap) and `passive` false, which is the side of
			// onCollision's own condition that does not require the enemy to be standing still.
			try { attacker.onCollision(mainColl, coll, tackleDirArg(), false); }
			catch (e) { /* a hit the engine refused: nothing to undo */ }
		}
	}
}

// The `collDir` AttackerCmp.onCollision hands to Tackle.hit, which does not read it (it derives the
// hit point from the coll overlap, attacker-cmp.js:84). One shared Vec2 for every call, built on
// first use rather than at module load, because a build without the export must not stop this module
// from loading (and this runs inside the frame's collision pass, so it is not allocated per call).
let remoteTackleDir = undefined;
function tackleDirArg() {
	if (remoteTackleDir === undefined)
		remoteTackleDir = terra.export.Vec2 ? new terra.export.Vec2() : null;
	return remoteTackleDir;
}

// ──────────── damage numbers for a forwarded hit (owner capture / peer replay) ────────────
//
// A damage number is born inside the VICTIM's own damage pipeline: `CombatantCmp.dealDamage` ends
// with `g_combat.gui.hitNumbers.add(dmgResult, force.hitPoint, ...)` (combatant-cmp.js:904-905), so
// the number is drawn on whichever client ran that pipeline. `HitNumbers` is a GUI ELEMENT
// (combat-gui.js:24-25), not an FxEntity, so no fx channel can carry it either. A forwarded hit is
// applied by the OWNER -- the owner is the only party that writes an enemy's HP, which is the whole
// design of Phase 5a -- so the owner's screen is the one that drew the number while the peer, whose
// hit it was, saw nothing: its own copy of the hit is suppressed locally (./enemy-puppet.js patch
// (c)) and the owner's number was never on its screen. Neither player saw a number for that hit.
//
// The number therefore rides the same enemy frame as the HP change that produced it: the owner
// captures what it just drew for a hit that arrived on the FORWARDING path, and the peer replays it
// through the engine's own hit-number API. Scope, deliberately narrow: only a forwarded hit is
// captured. The owner's OWN hits draw their number on the owner's screen through the usual pipeline
// and are already visible to the player who dealt them; sending those too would put a number on the
// peer's screen for damage its player did not deal, and would have to carry every hit on every owned
// enemy instead of just the hits this client applies on a peer's behalf.

// WHY THE STYLE DOES NOT TRAVEL. The engine's own call picks the number's style with
// `attackInfo.isWise() ? WISE : isPLayer ? PLAYER : NORMAL` (combatant-cmp.js:903). On the forwarding
// path both arms are fixed: the victim is always an ENEMY, so it is never the local player's
// combatant and `isPLayer` is false; and `isWise()` is `attackInfo.limiter === WISE_DMG`
// (attack-info.js:126), which the rebuilt attack info can never be because `limiter` is one of the
// fields the hit descriptor deliberately does not carry (./enemy-puppet.js, the NOT-carried note in
// readHitDescriptor). The owner's number for a forwarded hit is therefore always a NORMAL one, so a
// style field would be a constant on the wire -- dead data that would misdescribe the protocol. The
// peer draws with HIT_NUM_STYLE.NORMAL and nothing else. (What DOES vary per hit, and so does
// travel, is the crit marking below: the crit is re-rolled on the owner and changes the number's
// sprite, its lifetime and its boom.)

// The crit marking the engine's own call reads off the damage result, as a wire code. It is
// `critical ? CRITICAL : defCritical ? DEF_CRITICAL : NONE` (hit-number.js:113-115) and the codes are
// CRIT_TYPE's own values (hit-number.js:47-53), read through the export here and on the peer, so
// neither side retypes the enum. The literals are the fallback for a build whose CRIT_TYPE is not
// exported; the value only selects a sprite.
function hitNumberCritCode(result) {
	const crit = terra.export.CRIT_TYPE;
	if (result?.critical)
		return crit?.CRITICAL ?? 1;
	if (result?.defCritical)
		return crit?.DEF_CRITICAL ?? 2;
	return 0;
}

// True when `force` is THE synthetic force this client applies a peer's forwarded hit with (see the
// phase 5a section below: one rebuilt HitForce per process, `forwardedRig`). It is an identity test
// on purpose, and it is the discriminator between the two ways a hit can reach an enemy on this
// client: a forwarded one (impossible to confuse with a local one, which the engine builds itself)
// and this client's own. Nothing else about the rig is inspected, so a rig that failed to build
// (`getForwardedRig` returned null) can never match and forwards no hit number.
function isForwardedForce(force) {
	return force !== null && force !== undefined && forwardedRig !== null && force === forwardedRig.force;
}

// Whether the GUI would draw a damage number at all: the engine gates its own hit-number call on
// `g_combat.hasDamageDisplay()` (combatant-cmp.js:904; combat.js:403-405 -- false in a cutscene,
// during a teleport and while a blocking event is up). Mirroring that gate here is what keeps the
// two screens showing the same thing: a hit the owner drew no number for sends no number. Fail-open
// when the export is missing, so an unknown build degrades to "always draw" rather than to "never
// send" -- the number is cosmetic, and a missing accessor is not a reason to lose it.
function damageDisplayOn() {
	const combat = terra.export.g_combat;
	if (typeof combat?.hasDamageDisplay !== "function")
		return true;
	return combat.hasDamageDisplay() === true;
}

// Install-once, called every frame from the addon (see onPreUpdate) alongside the other owner
// seams, for the same reason: a forwarded hit can arrive in any frame, whether or not this module
// has driven anything yet and whether or not the option was on at the last map start. The wrapper is
// inert while the feature is off (it re-tests it per call), and a missing export leaves the flag
// alone so a later frame can retry instead of giving up on the seam for the rest of the session.
let hitNumberPatched = false;

function ensureHitNumberPatch() {
	if (hitNumberPatched)
		return;
	const proto = terra.export.CombatantCmp?.prototype;
	if (!proto || typeof proto.dealDamage !== "function") {
		if (debugEnabled())
			debugLog("cannot install the hit-number patch: terra.export.CombatantCmp.dealDamage is missing");
		return;
	}
	const original = proto.dealDamage;
	if (original.__ttHitNumberPatched !== true) {
		const wrapper = function (...args) {
			// AFTER the original: the number the engine draws is what dealDamage leaves in
			// `dmgResult.damage` -- the engine's own hit-number call is its last statement, by which
			// point reduceHP has folded in the HP barriers and the clamp -- so a value read before it
			// could be one the owner's screen never showed.
			const result = original.apply(this, args);
			captureForwardedHitNumber(this, args);
			return result;
		};
		wrapper.__ttHitNumberPatched = true;
		proto.dealDamage = wrapper;
	}
	hitNumberPatched = true;
}

// Queue the number one forwarded hit just drew on THIS client's screen, for the peer that made the
// hit. `combatant` is the victim (the receiver of the engine's own call) and `args` is dealDamage's
// argument list -- (dmgReact, dmgResult, vel, force, defParams, coll, instant), the engine's own
// signature (combatant-cmp.js:835).
//
// Fail-soft in every direction: a hit that did not arrive on the forwarding path, a victim this
// client does not own, a result with no usable damage, a landing point that is missing or not
// finite, and a scene the engine would not have drawn in are all dropped rather than queued. A
// zero-damage hit is dropped too: the two ways the engine itself produces one (the NO_DMG limiter
// and a damage-ignore party) are exactly the two its own call site is gated against, so the owner
// draws no such number to forward.
function captureForwardedHitNumber(combatant, args) {
	if (!isEnemySyncEnabled())
		return;
	const force = args[3];
	if (!isForwardedForce(force))
		return;
	// The victim has to be an enemy THIS client owns, and its wire id is what the batch entry is
	// addressed by (the frame publishes that enemy, and the peer routes the entry back to its local
	// copy of it). The ownership probe is the same one ./fx-sync.js attributes effects through, so
	// there is one definition of "an enemy we own, and its id".
	const id = enemyOwnership.ownedIdOf(combatant?.ent);
	if (id === null)
		return;
	const result = args[1];
	const amount = result?.damage;
	if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)
		return;
	// The landing point is the vector the engine's own call passes as the number's position
	// (`force.hitPoint`, combatant-cmp.js:905). This is our own Vec3, read synchronously here and
	// copied into plain numbers: the rig, and the vector on it, are reused by the next hit.
	const point = force.hitPoint;
	if (!point)
		return;
	const x = point.x, y = point.y, z = point.z;
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
		return;
	if (!damageDisplayOn())
		return;
	enemyQueues.hitNumbers.push({
		enemy: id,
		amount,
		pos: [x, y, z],
		crit: hitNumberCritCode(result),
	});
}

// The crit marking on the wire, checked back against this build's own CRIT_TYPE: only the three
// values the engine's own call can carry (hit-number.js:113-115) are accepted, and anything else --
// a code from a build whose enum differs, a junk field on a malformed entry -- degrades to NONE
// rather than being handed to the engine as a sprite index it would never choose itself.
function wireHitCrit(code) {
	const crit = terra.export.CRIT_TYPE;
	const values = crit ? [crit.NONE, crit.CRITICAL, crit.DEF_CRITICAL] : [0, 1, 2];
	return values.includes(code) ? code : (crit?.NONE ?? 0);
}

// The engine's own endZ for an instantly placed number: `setInstantPos(pos, endZ = 2.0)`
// (hit-number.js:278). `addCustom`'s own default is 1.0, the convention of the SCORE style it
// targets by default (:152), so the value is passed explicitly to place a damage number the way the
// engine places an instant one.
const HIT_NUMBER_END_Z = 2.0;

// Replay one forwarded hit number on OUR copy of the enemy, through the engine's own hit-number API.
//
// WHICH API, and why. `HitNumbers` has two entries (hit-number.js:111, :152). `add(dmgRes, pos, dir,
// fly, stable, style, instant)` derives the number's TYPE from the damage result -- break, weak or
// strong (:118-128) -- and needs a direction vector to place a non-instant number: those two inputs
// are exactly what a forwarded hit cannot supply, because the type is a reading of the victim's own
// defence rolls and the direction is a velocity we do not carry. `addCustom(amount, pos, endZ, style,
// crit)` (:152-160) takes a FINISHED amount, positions the number instantly (:157 -> setInstantPos,
// :278-284, which is also where a pooled number is given its block entry) and leaves the type at
// DEFAULT -- which is what a damage number is drawn as when no break/weak/strong reading applies. It
// is therefore the API this replay uses, with the amount, the crit marking, the landing point and the
// one style a forwarded hit can carry (NORMAL, see the note above) all reproduced. NOT reproduced:
// the BREAK/WEAK/STRONG glyph the owner's number may have carried (that is a reading of the VICTIM's
// own defence rolls, which do not travel) and the popup's lerp along the hit direction (the position
// is the landing point and the rise is the engine's own instant one).
// `amount` goes over the wire un-rounded and is rounded by `init` here, exactly as it was on the
// owner's screen (hit-number.js:270-273).
//
// Fail-soft: a malformed entry, an unusable position, a missing GUI or style table, or an engine
// that throws while adding the number skips the number instead of breaking the frame it arrived in
// (a peer's payload is not trusted input, and a frame carries state too).
function replayEnemyHitNumber(entry) {
	if (!entry || typeof entry !== "object")
		return;
	const amount = entry.amount;
	if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)
		return;
	const pos = entry.pos;
	if (!Array.isArray(pos) || pos.length < 3)
		return;
	const x = pos[0], y = pos[1], z = pos[2];
	if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
		return;
	const style = terra.export.HIT_NUM_STYLE?.NORMAL;
	if (!style)
		return;
	const numbers = terra.export.g_combat?.gui?.hitNumbers;
	if (typeof numbers?.addCustom !== "function")
		return;
	const Vec3 = terra.export.Vec3;
	if (typeof Vec3 !== "function")
		return;
	try {
		numbers.addCustom(amount, new Vec3(x, y, z), HIT_NUMBER_END_Z, style, wireHitCrit(entry.crit));
	}
	catch (e) {
		if (debugEnabled())
			debugLog(`damage number from a peer's hit was not drawn: ${e?.message ?? e}`);
	}
}

// ───────────────────── peer half: drive what we do not own ─────────────────────

// The per-frame peer half, run before the frame's own update. For every live enemy this client
// does NOT own: drive it from the owner's state while that state is fresh, and release it back
// to local simulation the moment it is not. The release branch is not an error path — it is the
// normal outcome of an owner going quiet, and it is what turns a failed sync into "both
// clients simulate this enemy" instead of a frozen one.
//
// The ONE exception to that release is an enemy that has been SEEN to die (Phase 4b, dyingPuppets):
// releasing a dead enemy would let this client simulate a corpse, so a dying enemy whose state has
// gone QUIET is held suppressed on its last death pose until the bounded cap removes it. A dying
// enemy whose state is still arriving is just driven like any other puppet -- and that distinction
// is load-bearing in the other direction too: the owner keeps streaming a dying enemy every frame
// until it removes it, so a latch that removed on age alone would delete an enemy that is still very
// much there (a live enemy whose ratio merely rounds to 0 would be the false positive).
function applyPeerState(live) {
	if (!live)
		return;
	const now = nowMs();
	for (const [id, core] of live) {
		const ent = core.ent;

		// Ours: never a puppet. Becoming the owner (a rebalance) releases the enemy and starts
		// simulating and publishing it instead -- through takeOwnership(), which spends whatever
		// the previous owner left for us before this frame's update runs. The one exception is an
		// enemy we have SEEN die: takeover must not resurrect it (a locally-simulating zombie of a
		// dead enemy), so a latched dying enemy is removed rather than adopted.
		if (isOwner(id)) {
			if (dyingPuppets.delete(id)) {
				despawnEnemyLocally(id);
				continue;
			}
			if (puppets.delete(id)) {
				// Handing the enemy to local simulation, with the fight its owner left it in (see
				// relinquishPuppet): a takeover must not be the thing that ends a battle.
				relinquishPuppet(ent);
				// The owner's effect stream stops being applied to this enemy the moment it becomes
				// OURS (Phase 6): the fx it left on it are the previous owner's presentation of an
				// enemy we now simulate, and nothing will ever stop them.
				clearRemoteEnemyFx(ent);
			}
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
			// ...and the effects that arrived in the same frame as that state (Phase 6).
			applyEnemyEffects(id, ent, entry);
			// The owner's enemy is at 0 HP: it has been beaten (the engine's own defeat sets both
			// `defeated` and currentHP 0, combat-params.js reduceHP, so the ratio is 0 for the whole
			// dying window). Latch it dying and remember the death pose, so that when the owner STOPS
			// streaming it -- its entity removed, or the owner gone -- the enemy is HELD (below) rather
			// than released into local simulation. `at` is set ONCE, so the bounded window is measured
			// from the first sighting of the death however long the owner keeps streaming.
			if (entry.state?.hp === 0) {
				const seen = dyingPuppets.get(id);
				dyingPuppets.set(id, { at: seen ? seen.at : now, state: entry.state });
			}
			continue;
		}
		// No usable state: nobody owns this enemy right now, the owner has gone quiet (or never
		// had it), or its state predates the current assignment. Simulate it locally again --
		// UNLESS it is a latched dying enemy, which must never be released this way. Such an enemy
		// stays suppressed on its held death pose until the despawn lands or the bounded cap
		// removes it. The cap is measured from the first sighting of the death and only ever fires
		// here, on a frame the owner is no longer reporting the enemy at all.
		const held = dyingPuppets.get(id);
		if (held) {
			if (now - held.at >= DYING_REMOVE_MS) {
				dyingPuppets.delete(id);
				if (debugEnabled())
					debugLog(`dying enemy ${id}: no despawn and no state after ${DYING_REMOVE_MS}ms, removing`);
				despawnEnemyLocally(id);
				continue;
			}
			if (!puppets.has(id)) {
				ensurePuppetPatches();
				makePuppet(ent);
				puppets.set(id, ent);
			}
			drivePuppet(ent, held.state);
			continue;
		}
		if (puppets.delete(id)) {
			// The owner has gone quiet: this client simulates the enemy again (that is the whole
			// point of the freshness gate), and it keeps the fight that owner left it in -- the
			// paused or downed host whose enemies used to walk away. See relinquishPuppet.
			relinquishPuppet(ent);
			clearRemoteEnemyFx(ent);       // the owner stopped speaking for it: drop its effects too
		}
	}
	// Enemies that are gone (killed, unloaded, or no longer wire-addressable): nothing to drive,
	// and nothing may stay suppressed. Their stored state goes too, or it would be applied to
	// whatever holds the same id on the next map.
	for (const [id, ent] of puppets) {
		if (live.has(id))
			continue;
		puppets.delete(id);
		releasePuppet(ent);
		clearRemoteEnemyFx(ent);
	}
	for (const id of peerState.keys()) {
		if (!live.has(id))
			peerState.delete(id);
	}
	// A dying latch whose enemy is gone has nothing left to remove: its entity is already out of
	// the world, so the latch goes with it (there is no stuck entity to clean up).
	for (const id of dyingPuppets.keys()) {
		if (!live.has(id))
			dyingPuppets.delete(id);
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
		// The enemy was being FOUGHT when it changed hands: the fight travels with the state (the
		// carried `aggro` bit is the same one the per-frame peer half applies to a puppet), so this
		// client continues the battle instead of picking the enemy up calm and letting it walk off --
		// a handover is not a truce. After releaseHold(), so the engage is the engine's own call on
		// an entity that is no longer suppressed (see engageLocally).
		if (state.aggro === true)
			engageLocally(ent);
		if (debugEnabled())
			debugLog(`takeover ${id}: adopted ${handoff ? "handoff" : "cached peer"} state (x=${state.x} y=${state.y} z=${state.z}${state.aggro === true ? ", in combat" : ""})`);
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
	// The hit half goes with the map for the same reason: the ids its records are keyed by all embed
	// the old map path, and a hit queued while the old map was live must not be sent from the new one
	// (Phase 5a).
	clearHitState();
	// The old map's dying latches and deferred despawns go with the map: the entities they name are
	// being torn down with it, and neither a stale latch nor a despawn for the old map may survive
	// into the new one.
	dyingPuppets.clear();
	dyingOwned.clear();
	// The reward half's exactly-once marks belong to the world they were made in for the same reason
	// (Phase 5b): its entities are the ones being torn down here.
	clearKillRewardState();
	// The lasting-fx registry of the enemy channel goes too (Phase 6): the fx entities it names are
	// being torn down with the map, and an entry whose entity the engine never told us about would
	// otherwise sit there for the rest of the session, re-sent for an enemy id that cannot come
	// back. (The per-frame liveness prune cannot see it: a torn-down FxEntity is not "ended".)
	activeEnemyFx.clear();
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
//
// The frame also carries that owner's effects for those enemies (Phase 6: globalFx/fxStops/
// persistentFx/sounds/soundStops/projectiles, each entry tagged with its enemy) and, the same way,
// the damage numbers it drew for the hits this client forwarded to it (hitNumbers). They are stored
// with the state they arrived with and applied by the same per-frame half, for exactly the same
// reason: an effect belongs to the frame whose state it accompanied, and the enemy's own entity is
// only steered on the frame path (see applyEnemyEffects).
export function onEnemyState(msg) {
	if (!isEnemySyncEnabled())
		return;
	const owner = msg?.owner == null ? null : String(msg.owner);
	if (owner === null)
		return;
	const list = msg?.list;
	if (!Array.isArray(list))
		return;
	// The frame's effect batches (Phase 6), grouped by the enemy each entry belongs to. Grouping
	// once per message rather than scanning the arrays per enemy keeps this linear in the frame's
	// size; a frame with none (the common case, and every frame from a client that owns no enemy)
	// builds no maps at all.
	const fx = groupEnemyEffects(msg.globalFx);
	const fxStops = groupEnemyEffects(msg.fxStops);
	const sounds = groupEnemyEffects(msg.sounds);
	const soundStops = groupEnemyEffects(msg.soundStops);
	const projectiles = groupEnemyEffects(msg.projectiles);
	const persistentFx = groupEnemyEffects(msg.persistentFx);
	const hitNumbers = groupEnemyEffects(msg.hitNumbers);
	const hitActs = groupEnemyEffects(msg.hitActs);
	const hitActStops = groupEnemyEffects(msg.hitActStops);
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
		// The effects that arrived with this state, carried over from a frame we have not applied
		// yet (see carryBatch): the stored entry replaces the previous one, so without this a
		// one-shot effect that arrived in two messages between two frames would lose the first.
		const prev = peerState.get(id);
		const carried = prev && prev.applied === false ? prev : null;
		const entry = { state, at: now, from: owner, applied: false };
		carryBatch(entry, "globalFx", carried, fx.get(id));
		carryBatch(entry, "fxStops", carried, fxStops.get(id));
		carryBatch(entry, "sounds", carried, sounds.get(id));
		carryBatch(entry, "soundStops", carried, soundStops.get(id));
		carryBatch(entry, "projectiles", carried, projectiles.get(id));
		carryBatch(entry, "persistentFx", carried, persistentFx.get(id));
		carryBatch(entry, "hitNumbers", carried, hitNumbers.get(id));
		carryBatch(entry, "hitActs", carried, hitActs.get(id));
		carryBatch(entry, "hitActStops", carried, hitActStops.get(id));
		peerState.set(id, entry);
	}
}

// Group one of an enemy frame's effect batches by the enemy each entry names (`enemy`), which is
// the field that routes it back to the local copy of that enemy. Entries without a usable id are
// dropped rather than thrown on, the same rule the state entries follow.
function groupEnemyEffects(list) {
	const out = new Map();
	if (!Array.isArray(list))
		return out;
	for (const entry of list) {
		if (!entry || typeof entry !== "object")
			continue;
		const enemyId = entry.enemy;
		if (typeof enemyId !== "string" || enemyId === "")
			continue;
		const bucket = out.get(enemyId);
		if (bucket)
			bucket.push(entry);
		else
			out.set(enemyId, [entry]);
	}
	return out;
}

// Add one frame's batch for one enemy to the peer-state entry being stored, carrying over the
// batch of a previous frame this module has not applied yet. The server relays a frame every tick
// and the socket can deliver two before this client's next frame; the stored entry is replaced
// wholesale, so without the carry-over a one-shot effect (a hit impact, a sound) that arrived in
// the earlier message would simply vanish -- the same carry-over ./snapshot.js does for a peer
// player's update. The order is the arrival order (prev first, then fresh), which is what a
// spawn/stop pair needs: an fx spawned in the earlier message is stopped by the later one.
function carryBatch(entry, key, carried, fresh) {
	const prev = carried ? carried[key] : null;
	if (!prev) {
		if (fresh)
			entry[key] = fresh;
		return;
	}
	entry[key] = fresh ? prev.concat(fresh) : prev;
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
// doManualKill, enemy-cmp.js:344-357 disappear(skipFx)), so nothing is left half-torn-down. The
// engine's death hit itself is NOT replayed: giveExp and dropItems hang off `EnemyCmp.onDeathHit`
// (enemy-cmp.js:1127-1130) and are not called here, so none of the owner's own kill bookkeeping
// (rogue state, the defeat callback, screen shake, combat.setEnemyDefeated) can fire on a client
// that did not fight the enemy. The REWARD is the one thing this removal does pay, and deliberately:
// its caller grants the local player's share first (grantKillReward, Phase 5b), because for a client
// that did not simulate the death this removal IS the moment the death is certain.
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
//
// It is also where a client that did NOT simulate the death pays its own player (Phase 5b): the
// received despawn and the bounded removal of a latched dying puppet are the two events that make the
// death certain here, and both go through this one function -- as does the takeover of an enemy this
// client saw die as a puppet, whose death is certain for the same reason (it was latched dying from
// the owner's own 0 HP). The grant is asked BEFORE the removal, because granting needs the enemy: its
// type and level for the XP, and its position for the drops.
function despawnEnemyLocally(enemyId) {
	const core = findCoreById(enemyId);
	if (core) {
		grantKillReward(enemyId, core.ent);
		// The effects its owner's stream put on it go with it (Phase 6). Done before the removal
		// because stopping a tracked fx needs the entity it was attached to; the ones that are
		// world-position one-shots are not tracked and simply play out, as on the player path.
		clearRemoteEnemyFx(core.ent);
		removeDefeatedEnemy(core);
	}

	// The per-id bookkeeping goes either way. A killed entity is no longer live, so the per-frame
	// sweeps (syncEnemies, applyPeerState) would drop all of this on the next frame anyway; doing it
	// here means the frame after a despawn starts clean, and it is the only way to drop the bookkeeping
	// of an enemy that is already gone from the entity list.
	peerState.delete(enemyId);
	handoffState.delete(enemyId);
	adopted.delete(enemyId);
	dyingPuppets.delete(enemyId);               // a landed despawn ends the dying latch, if any
	dyingOwned.delete(enemyId);                 // and the owner-side deferred despawn, so it cannot linger
	releaseHold(enemyId);                       // releases the held entity's puppet mark, if any
	const puppeted = puppets.get(enemyId);
	if (puppeted) {
		puppets.delete(enemyId);
		releasePuppet(puppeted);
		clearRemoteEnemyFx(puppeted);      // its owner's effects go with it (Phase 6)
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

// ───────────────────── group wake: the cross-client half of group aggro ─────────────────────
//
// Aggro is a GROUP event in this engine: CombatManager.aggroNearbyEnemy (combat.js:226-271) walks the
// aggroed enemy's entity groups and an 8-unit recursive chain and aggressivises every enemy it
// reaches. That pass, however, runs on the SIMULATING client only, so the group members that client
// does not own stay calm on the client that owns them -- and the arbiter spreads a group across
// clients by proximity and balance as a matter of course. The result is visible in co-op: one player
// walks into a pack, the two enemies their client owns wake up, and the three the other client owns
// keep standing there and ignore the fight.
//
// MSG.ENEMY_WAKE closes that gap. The client that sees the aggro (detectWakes) lists the ids the
// engine's own pass reached and sends them once; the server relays them (no arbiter check -- see the
// contract in ../net/protocol.js) and every recipient wakes the ids it is simulating itself
// (onEnemyWake). Nothing arbitrates and nothing is authoritative: the ids are advisory, and a stale
// or foreign one is a no-op on the receiving side. Same coop trust as MSG.ENEMY_RESPAWN and
// MSG.ENEMY_HIT.

// The engine's own radius for the recursive part of group aggro (`aggroNearbyEnemy(this, 8, true)`,
// combat.js:226 with :248/:263). Deliberately NOT a tunable: it is the engine's authored number for a
// local chain, and widening it on the wire would wake enemies the engine's own pass would not have.
const WAKE_CHAIN_RADIUS = 8;

// The aggressive state this module last SAW on an entity, so the wake fires on the TRANSITION rather
// than on the state. On the ENTITY (entities are not pooled, components are -- the same reasoning as
// every mark in ./enemy-puppet.js), which is also what makes a spot that respawns report a fresh
// transition: the replacement is a different entity.
const OWNER_AGGRO_SEEN = "__ttOwnerAggroSeen";

// The ids a wake for `core`'s enemy has to reach: exactly the enemies the engine's own group pass
// would have woken, as wire ids, deduplicated. Computed once per aggro event, and small by
// construction (a group is authored per encounter; the chain only walks enemies).
//   (a) every enemy of a spot in the same ENTITY GROUPS as the aggroed enemy's spot, through the
//       engine's own EntityGroupManager on the very group list the engine passes it
//       (g_group.getEnemySpots(dest, spot.core.entityGroups), combat.js:238-239);
//   (b) the recursive 8-unit chain from the aggroed enemy and from those members.
// Two deliberate differences from the engine's pass, both of them things a wire list cannot carry: a
// dormant spot the engine would TRIGGER (spot.onEnemyTrigger(true, delay), combat.js:241-245) is
// skipped -- a wake names enemies that EXIST, and this client cannot spawn another client's enemy for
// it -- and only WIRE-ADDRESSABLE enemies are listed (wireEnemyId), since a client-local `u:<uid>` is
// a different enemy on the other client and so a no-op there.
function wakeIdList(core, live) {
	const ids = new Set();
	// The entity groups, through the engine's own manager. Its `groups` getter reads the main map, which
	// exists on any frame that has live enemies at all (syncEnemies only hands out a `live` map while a
	// world is running); the lookup is what is guarded, not the call.
	const map = terra.export.g_gState?.getMainMap?.();
	const group = map ? terra.export.g_group : null;
	const spot = terra.export.EnemyCmp?.get?.(core?.ent)?.sourceEntity;
	if (spot?.core?.entityGroups?.length && group && typeof group.getEnemySpots === "function") {
		for (const member of group.getEnemySpots([], spot.core.entityGroups))
			addWakeId(ids, member?.enemyEnt);
	}
	// The chain is walked over the frame's live enemies rather than through a physics query: the
	// engine's own loop drops every non-enemy core it finds and only ever recurses into ENEMIES
	// (combat.js:257-266), so over enemies the two walks are the same one -- and this one needs no
	// physics world, no scratch arrays and no query per step.
	let queue = [core];
	const visited = new Set([core]);
	while (queue.length > 0) {
		const next = [];
		for (const from of queue) {
			for (const [id, other] of live) {
				if (visited.has(other) || !withinWakeChain(from, other))
					continue;
				visited.add(other);
				next.push(other);
				ids.add(id);
			}
		}
		queue = next;
	}
	return [...ids];
}

// One group member's wire id. A spot that has not spawned its enemy yet contributes nothing (see the
// dormant-spot note above), and neither does an enemy with no map-placed identity.
function addWakeId(ids, ent) {
	const id = ent ? wireEnemyId(ent.core) : null;
	if (id !== null)
		ids.add(id);
}

// The engine's own radius test for the chain, on XY: `checkEnemy.ent.core.pos` minus 16 in z is the
// query centre the engine uses (combat.js:255) and the third dimension is ignored here for the same
// reason the mod's own proximity tests ignore it (see withinEngageRadius) -- two enemies stacked on a
// ledge are the same cluster for an 8-unit radius and a 32-unit z band.
function withinWakeChain(a, b) {
	const pa = a?.pos, pb = b?.pos;
	if (!pa || !pb)
		return false;
	const dx = pa.x - pb.x, dy = pa.y - pb.y;
	return dx * dx + dy * dy <= WAKE_CHAIN_RADIUS * WAKE_CHAIN_RADIUS;
}

// The owner-side detection, run on the frame path over the enemies this frame knows about. The
// trigger is the engine's own flag going false -> true on an enemy THIS client simulates: that is the
// one moment the engine's group pass cannot have covered the peer's members (it walked the group here
// and nowhere else), and it is one shot per event because the mark then stays true for as long as the
// enemy stays aggressive.
//
// A puppet's flag is skipped: on a driven enemy the bit is the OWNER's (applied by
// ./enemy-puppet.js), and that owner sends its own wake -- re-sending it from here would be a
// duplicate. An enemy this client does not (or not yet) simulate is skipped for the same reason.
//
// With no peer connected there is nobody to tell, so the whole walk is skipped -- including the
// marks, which means a peer that joins later sees every enemy already in combat as a fresh
// transition and gets a wake per group. That is the wanted outcome for a newcomer (its own members of
// those groups have to be woken too) and it costs one message per group, once.
function detectWakes(live) {
	if (!live || live.size === 0 || !hasPeers())
		return;
	for (const [id, core] of live) {
		const ent = core?.ent;
		const enemy = ent?.enemy;
		if (!enemy)
			continue;
		const aggressive = enemy.aggressive === true;
		if ((ent[OWNER_AGGRO_SEEN] === true) === aggressive)
			continue;
		ent[OWNER_AGGRO_SEEN] = aggressive;
		if (!aggressive || puppets.has(id) || !isOwner(id) || !adopted.has(id))
			continue;
		const ids = wakeIdList(core, live);
		wakeOwnGroup(ids, live);
		sendWake(ids);
	}
}

// Wake the members of `ids` this client simulates itself, exactly the way the engine's own pass wakes
// one (`setAggressive(true)` + `actor.cancelAction()`, combat.js:246-249): the local half of the
// message, and the reason the sender's own group is not left behind when an enemy aggros from a path
// that does NOT run the engine's group pass (an enemySpawner, a COMBAT step, a rest's respawn).
function wakeOwnGroup(ids, live) {
	for (const id of ids) {
		if (!isOwner(id) || !adopted.has(id))
			continue;
		const core = live.get(id);
		if (core)
			wakeEnemyAt(core);
	}
}

// One MSG.ENEMY_WAKE per aggro event, carrying the whole group in one `ids` list (the contract's
// shape). Silent when there is nothing to say: no id (an enemy in no group with nothing within 8
// units), no connection, or no peer to tell. `from` is our own playerId -- a convenience for the log
// only, the server stamps the sender's socket id over it exactly as it does for ENEMY_RESPAWN.
function sendWake(ids) {
	if (ids.length === 0 || !isConnected() || !hasPeers())
		return;
	if (debugEnabled())
		debugLog(`wake: ${ids.length} group member(s): ${ids.join(", ")}`);
	send({ type: MSG.ENEMY_WAKE, from: localPlayerId(), ids });
}

// Wake ONE enemy this client simulates: the engine's own single-enemy body from its group pass
// (`setAggressive(true)` + `actor.cancelAction()`, combat.js:246-249), with the engine's own guards --
// nothing to do for an enemy already in combat (:247) or one that is not alive (:246). The
// cancelAction is what makes a woken enemy pick a combat action instead of finishing whatever it was
// doing, and it is the engine's own choice there, not this module's.
function wakeEnemyAt(core) {
	const enemy = terra.export.EnemyCmp?.get?.(core?.ent);
	if (!enemy || enemy.aggressive === true || typeof enemy.setAggressive !== "function")
		return false;
	if (typeof enemy.isAlive === "function" && !enemy.isAlive())
		return false;
	enemy.setAggressive(true);
	if (enemy.actor && typeof enemy.actor.cancelAction === "function")
		enemy.actor.cancelAction();
	return true;
}

// Inbound MSG.ENEMY_WAKE (a client whose own simulation just stirred a group -> server -> everyone
// but the sender). Routed here from ./client.js. Each id is woken only where it is OURS to wake, and
// idempotently; everything else is ignored, which is what makes a stale or foreign id a no-op.
//
// "Ours to wake" is two cases, and the second is the one Sam reported:
//   * an enemy this client OWNS and has taken over -- the ordinary case;
//   * an enemy this client is simulating because nobody is streaming for it: its owner went quiet and
//     the puppet was handed back to local simulation (relinquishPuppet). A paused or downed host's
//     enemies are exactly that -- undriven, locally simulated, and before this message unreachable by
//     any wake, which is why they used to "completely ignore you".
// An enemy that is still DRIVEN is skipped: its combat state is its owner's to send and
// ./enemy-puppet.js applies the owner's bit every frame, so a local write here would be undone by the
// next frame that arrives.
//
// Nothing is verified about the SENDER (the payload names no enemy that aggros, only ids), and nothing
// needs to be: the worst a hostile or malformed message can do is wake an enemy this client already
// simulates, which is the same thing the engine does on its own when a player walks into the group.
// Malformed entries are skipped, never thrown on -- the same rule as every other peer payload here.
export function onEnemyWake(msg) {
	if (!isEnemySyncEnabled() || !isConnected())
		return;
	const ids = msg?.ids;
	if (!Array.isArray(ids))
		return;
	for (const id of ids) {
		if (typeof id !== "string" || id === "")
			continue;
		if (!(isOwner(id) && adopted.has(id)) && puppets.has(id))
			continue;                      // driven by its owner's stream: not ours to write
		const core = findCoreById(id);
		if (!core)
			continue;                      // an id this client does not hold at all
		if (wakeEnemyAt(core) && debugEnabled())
			debugLog(`wake applied to ${id} (sent by ${msg?.from == null ? "?" : msg.from})`);
	}
}

// ──────────────────────────── rest / respawn sync ────────────────────────────

// THE REST SEAM. Resting is the one world event that puts a map's enemy population back, and the
// engine does it by clearing a PER-CLIENT session dead-set:
//   waypoint-manager.js:233 onRestReset()  (the funnel BOTH rest steps call -- waypoint-steps.js:227
//   WAYPOINT_TELEPORT, which reloads the map, and :238 WAYPOINT_RESET, which does not)
//     -> combat.js:272-274 CombatManager.onRestReset()
//       -> vars.g_vars.clearMapSessionVars("_enemySpot") + ("_healPlant")   (vars.js:114-123)
// The dead-set itself is `session.map._enemySpot.<spot mapId>` -- or the rogue
// `session.map._rogue_enemySpot.<mapId>_<roomUid>` -- written by the spot on defeat
// (enemy-spot-entity.js getVarName :93-97, onEnemyDefeat :304-310) and read back in its constructor
// (:79-80). Because each client keeps its OWN dead-set, clearing it only respawns the rester's
// enemies: the other client's spots stay DEFEATED, they never respawn, and -- with nothing of theirs
// registered -- the arbiter hands every respawned enemy to the rester. That is Sam's report.
//
// The patch is on the engine's own reset METHOD rather than on g_vars.clearMapSessionVars, and that
// is deliberate: onRestReset is the EVENT ("a rest happened") and it is a named method on the one
// CombatManager singleton, while clearMapSessionVars is a general var-store primitive called for
// several keys from several places (vars.js itself, rogue-manager.js:472-475), where we would have
// to guess which clear means "rest". Wrapping onRestReset observes the rest and nothing else, and
// still lets the engine's own reset run (chained, like the death seam).
//
// SHARED, by product decision: anyone's rest respawns the enemies for everyone in the map. That is
// what the message says -- "this map's enemy population has reset" -- and it is why the sender
// announces the EVENT and each recipient runs the engine's own reset locally, rather than the
// sender trying to describe which enemies it respawned.
let respawnPatched = false;

function ensureRespawnPatch() {
	if (respawnPatched)
		return;
	const proto = terra.export.CombatManager?.prototype;
	if (!proto || typeof proto.onRestReset !== "function") {
		if (debugEnabled())
			debugLog("cannot install the rest patch: terra.export.CombatManager.onRestReset is missing");
		return;
	}
	const original = proto.onRestReset;
	if (original.__ttRespawnPatched !== true) {
		const wrapper = function (...args) {
			// Send AFTER the original: the local reset has then happened, so the message cannot announce
			// a rest that did not take effect locally.
			const result = original.apply(this, args);
			if (isEnemySyncEnabled()) {
				// The rester's own end of the world reset (see dropEnemyCombatState): the enemies already on
				// this map lose their fights, the engagement latch goes, and the cached peer state -- the
				// positions, HP and `busy`/`aggro` bits of a world that has just been reset -- goes with it.
				// Normally the de-aggro half is a no-op: the shipped rest reloads the map, so its enemies are
				// rebuilt fresh and calm anyway -- but a rest that does NOT reload (the engine's
				// WAYPOINT_RESET step, waypoint-steps.js:236-238) would otherwise leave the enemies already
				// on this map attacking. Gated like every other world write in this module: while it is not
				// syncing it changes nothing about local play.
				if (isConnected())
					dropEnemyCombatState();
				sendRespawn();
			}
			return result;
		};
		wrapper.__ttRespawnPatched = true;
		proto.onRestReset = wrapper;
	}
	respawnPatched = true;
}

// Announce the reset to the other clients: one message per rest, never per frame, and only while the
// feature is on and connected. `from` is our own playerId; the server overwrites it with the
// socket's id, so it is only ever a convenience for the log.
function sendRespawn() {
	if (!isEnemySyncEnabled() || !isConnected())
		return;
	send({ type: MSG.ENEMY_RESPAWN, from: localPlayerId(), map: activeMapPath(), variant: roomVariant() });
	if (debugEnabled())
		debugLog(`enemy respawn announced for ${activeMapPath()}`);
}

// Run the engine's own rest reset on THIS client, without the map reload the real rest does: clear
// the same session dead-set variables the engine clears and respawn the already-defeated spots.
//
// The variable half is the engine's rest reset, key for key and nothing more (combat.js:272-274):
// `_enemySpot` and `_healPlant`. It is NOT "every per-client dead-set we can find": the ROGUE
// prefixes (`_rogue_enemySpot`, `_rogue_healPlant`, rogue-manager.js:472-475) belong to a
// different event -- the end of a rogue RUN (clearRun) -- and the engine's rest does not clear
// them. Clearing `_rogue_enemySpot` here would respawn rogue enemies on this client that the
// resting client still has dead: the asymmetry this whole path exists to remove, re-created in the
// peer direction. The set is therefore exactly the one the engine's own reset writes.
//
// The variable half is also not enough on its own. It stops a re-init or a later map load from
// re-marking these spots defeated, but it does NOT touch a spot that is already loaded -- the
// rester's spots come back because the rest TELEPORTS (reloads) the map and the fresh spot then
// reads a cleared variable. A peer must not reload the map, so it needs the engine's own respawn
// path as well:
// EnemySpotEntity.respawn() (enemy-spot-entity.js:152-169) is the supported "bring back a defeated
// enemy" call (the engine's RESPAWN_ENEMY / RESPAWN_ENEMIES event steps use it, enemy-steps.js:248
// / :269). It flips the spot back to INIT, drops its stale enemyEnt/eggEnt and triggers the spawn,
// whose own `if (this.enemyEnt) return` guard (:254-256) keeps a repeat reset from building a
// second entity.
//
// Only DEFEATED spots are respawned: calling respawn() on a spot that is still INIT would trigger a
// spawn the map did not ask for (hidden and passive enemies), and on a TRIGGERED one it is a no-op
// anyway (:153-157).
//
// The respawned spots are not the whole of it: a fresh map load also leaves the enemies that were
// ALREADY alive calm, so the same pass the local end of a rest runs over them goes here too (see
// calmAllEnemies).
function applyLocalRespawn() {
	const gVars = terra.export.g_vars;
	if (gVars && typeof gVars.clearMapSessionVars === "function") {
		// Exactly CombatManager.onRestReset (combat.js:272-274), and only that: these two keys, in
		// this order. See the note above on why the rogue prefixes are not ours to clear here.
		gVars.clearMapSessionVars("_enemySpot");
		gVars.clearMapSessionVars("_healPlant");
	}
	const Spot = terra.export.EnemySpotEntity;
	if (typeof Spot !== "function")
		return;
	for (const core of terra.export.g_gState?.entities ?? []) {
		const ent = core?.ent;
		if (!ent || !(ent instanceof Spot))
			continue;
		if (typeof ent.isDefeated !== "function" || typeof ent.respawn !== "function")
			continue;
		if (ent.isDefeated())
			respawnSpotCalm(ent);
	}
	// The enemies the respawn loop did not touch: they were alive and attacking before the rest, and a
	// fresh map load would have left them calm. This is also where the rest's shared bookkeeping is
	// dropped (see dropEnemyCombatState) -- the fights, the engagement latch and the cached state of a
	// world that no longer exists.
	dropEnemyCombatState();
}

// The one place a rest drops the enemy state BOTH ends of it have to drop, called by the rester's own
// seam (ensureRespawnPatch) and by the peer end of MSG.ENEMY_RESPAWN (applyLocalRespawn).
//
// Sam's rule for a rest is total: "All aggro should be dropped when resting. For every player on every
// map it should completely respawn and reset all enemies." The engine does that by reloading the map,
// which rebuilds a calm population with no memory; a client that must not reload the map has to
// reproduce the whole of that state, which is three things and not just the first:
//   1. calmAllEnemies -- every enemy that is attacking stops (including the ones a respawned spot
//      would have brought back fighting, see respawnSpotCalm);
//   2. the ENGAGEMENT LATCH goes with it. Its records name enemies of the pre-rest world, and its
//      whole job is to decide who gets a kill's rewards: a player who was in a fight that the rest
//      just erased must not be paid for the next kill of that enemy id (the same enemy spot, back at
//      full HP, fought by somebody else). Reward bookkeeping that DOES survive a rest -- the
//      exactly-once marks, grantedKills -- is deliberately left alone (see clearKillRewardState);
//   3. the cached peer state goes too, which is where the OTHER client's `busy` and `aggro` bits live
//      on this side: the entries describe positions, HP and combat states of a world that has just
//      been reset, and the very next frame replaces them from that client's own post-rest frames.
//      Dropping them is also what stops a pre-rest `aggro: true` from driving an enemy back into combat
//      on the frame after the reset.
// Idempotent, like the rest itself: a repeat reset calms nothing already calm and clears empty
// collections.
function dropEnemyCombatState() {
	calmAllEnemies();
	clearEngagement();
	clearPeerState();
}

// Respawn one DEFEATED spot the way the rester's own path respawns it -- CALMLY.
//
// EnemySpotEntity.respawn() (enemy-spot-entity.js:152-169) is the engine's own "bring a defeated
// enemy back" call, but it triggers the spot AGGRESSIVE: its body ends in
// `this.onEnemyTrigger(true, maxDelay)` (:164), and that flag makes triggerEnemy call
// `setAggressive(true)` + `onSceneAggressionStart()` on the enemy it has just spawned (:228-231).
// That is deliberately right for respawn()'s own callers -- the scripted RESPAWN_ENEMY /
// RESPAWN_ENEMIES steps (enemy-steps.js:248 / :269), where "respawn" means a wave that arrives
// fighting -- and wrong for a rest: the rester does not respawn anything, it TELEPORTS
// (WAYPOINT_TELEPORT, waypoint-steps.js:227, the short/long rest branches of the waypoint sequence
// in data/database/call-sequence.json) and its map reload builds FRESH spots, whose enemies spawn
// through onShow -> spawnEnemy (:254) with `aggressive` left false (:151/:228) and their sheet's
// default state applied (:276). A peer cannot reload the map, so this is the difference the rest
// used to hide: without it the peer's respawned enemy comes back aggroed -- `aggressive` set,
// registered in g_attackFreq.activeEnemies, holding a navDanger handle, its actor target already
// pointed at this client's player, and its PASSIVE flag cleared -- i.e. a rest that puts the enemies
// back but leaves them attacking.
//
//   * clearing `triggerAggressive` covers the spot that has NOT spawned its enemy yet when respawn()
//     returns: a triggerDelay defers the spawn through attack_frequency's willAddDanger queue
//     (:201-205, :211) and an EGG_FLY spot spawns an egg that only reaches triggerEnemy when it
//     hatches (nyx-egg-entity.js:141) -- and the flag the later trigger reads is this one (:228).
//     Without it that enemy would come back aggressive a few frames after this helper had run.
// The enemy itself is then calmed by calmEnemy(), which both ends of the rest share.
function respawnSpotCalm(spot) {
	spot.respawn();
	// First, because the enemy below may not exist yet (see the triggerDelay / egg note above): this is
	// the intent every later trigger of this spot reads.
	spot.triggerAggressive = false;

	const enemy = spot.enemyEnt?.enemy;
	if (!enemy || enemy.aggressive !== true)
		return;								// nothing was aggressivised (deferred, egg, or no enemy)
	calmEnemy(enemy, spot);
}

// De-aggro ONE enemy into the state a fresh map load leaves it in, re-applying the passive flag the
// spot's own flags ask for. Every step is the engine's own:
//   * setAggressive(false) is the engine's own de-aggro (onKill enemy-cmp.js:338, onDeathHit :1122,
//     giveUp :1144, disappear :351, AttackFrequencyManager.stopAggression :150): it drops the flag,
//     the attack-frequency registration (:397) and the navDanger handle (:399). No skipHudUpdate, so
//     the HUD is put back too -- the trigger's own setAggressive(true) did update it (:388-389).
//   * setTarget(null) restores the actor target a fresh entity has (actor-cmp.js:337, the ActorCmp
//     reset): an aggressive enemy's target is pointed at the LOCAL player (enemy-type.js:233-235,
//     updateAction -> enemy-cmp.js updateTarget at :654-655), and nothing else would ever clear it.
//   * setPassive re-applies the spot's own flag, which the trigger's setAggressive(true) cleared
//     (:384-385 setPassive(ENEMY_PASSIVE.NONE)); the test is the one spawnEnemy uses (:264-268).
// The spot is OPTIONAL. A map-placed enemy always has one, but an enemy the spawner created rather
// than a spot (an act add, an enemySpawner) has no spot flags to restore -- and it is still an enemy
// this client simulates, whose fight a rest has to end like any other. For those the engine's own
// de-aggro and target clear are the whole job.
function calmEnemy(enemy, spot) {
	enemy.setAggressive(false);
	if (enemy.actor && typeof enemy.actor.setTarget === "function")
		enemy.actor.setTarget(null);

	const flags = terra.export.ENEMY_SPOT_FLAG;
	const passive = terra.export.ENEMY_PASSIVE;
	if (!spot || !flags || !passive || typeof enemy.setPassive !== "function")
		return;
	if (spot.init & flags.PASSIVE)
		enemy.setPassive(passive.PASSIVE);
	else if (spot.init & flags.PASSIVE_STILL)
		enemy.setPassive(passive.PASSIVE_STILL);
}

// EVERY enemy on the map loses aggro on a rest, not only the ones whose defeated spot was respawned --
// the report this pass answers: after a rest the enemies on the other client's screen are still angry.
// The engine's own rest does not de-aggro them; it reloads the map (the shipped rest is
// WAYPOINT_TELEPORT, waypoint-steps.js:227-229, both the short and the long branch in
// data/database/call-sequence.json) and the fresh load builds calm enemies. A client that cannot reload
// the map has to reproduce that state instead, so this walks the population and de-aggros the enemies
// that are actually attacking.
//
// The walk is over EVERY live entity rather than over the map's own EnemySpotEntity spots, because the
// spot is only needed for the passive half of the calm-down (calmEnemy takes it as optional) and a rest
// resets the whole population, not just the map-placed part of it: an enemy the spawner created has no
// spot flags to restore, but it is just as fighting as the rest, and the map reload a real rest does
// would have removed it along with everything else.
//
// It deliberately does NOT clear `spot.triggerAggressive`, unlike respawnSpotCalm: that flag can be
// map-authored (a not-yet-triggered hidden or passive spot), and blanket-clearing it would change
// authored behaviour. Only a spot this module actually respawned has it cleared.
function calmAllEnemies() {
	for (const core of terra.export.g_gState?.entities ?? []) {
		const ent = core?.ent;
		const enemy = ent ? terra.export.EnemyCmp?.get?.(ent) : null;
		// Only enemies that ARE aggressive: a calm one is already in the state a rest wants, and
		// setAggressive(false) would early-return on it anyway (enemy-cmp.js:377-379) -- so touching it
		// would be a write with no effect at best, and a setPassive mid-action at worst.
		if (!enemy || enemy.aggressive !== true)
			continue;
		calmEnemy(enemy, enemy.sourceEntity);
	}
}

// Inbound MSG.ENEMY_RESPAWN (a rester -> server -> everyone but the sender). Routed here from
// ./client.js. A reset for a map we are not on is ignored -- the local reset only makes sense for
// the map in play, and every reset is map-shaped -- as is one that names no map at all. Gated on the
// option AND the connection, like the send side: with the feature off, or offline, this module holds
// no world to reset and applies nothing. Idempotent: a repeat reset clears already-cleared variables
// and respawns no spot that is not defeated, and the re-split it leads to is the same one. The
// respawned enemies are re-announced by the ordinary per-frame registration diff, and the server's
// arbiter re-splits their room as those registrations arrive -- this handler does not touch
// ownership itself.
//
// The application is the WHOLE of a rest's reset (applyLocalRespawn -> dropEnemyCombatState), not just
// the respawn: every enemy that was fighting stops, the engagement latch is dropped, and the cached
// peer state -- the pre-rest positions, HP and `busy`/`aggro` bits -- goes with it. See the note on
// dropEnemyCombatState for why the last two are part of the event rather than an afterthought.
export function onEnemyRespawn(msg) {
	if (!isEnemySyncEnabled() || !isConnected())
		return;
	const map = typeof msg?.map === "string" ? msg.map : "";
	if (map === "" || map !== activeMapPath())
		return;
	applyLocalRespawn();
	if (debugEnabled())
		debugLog(`enemy respawn applied for ${map} (announced by ${msg?.from == null ? "?" : msg.from})`);
}

// ──────────────────── phase 5a: forwarding a hit we cannot apply ────────────────────

// The sink for the suppressed-hit seam (./enemy-puppet.js setEnemyHitSink). It is called for EVERY
// EnemyCmp.onHit this client sees, with `suppressed` telling the two cases apart:
//
//   suppressed === true -- the receiver is a PUPPET, i.e. an enemy another client simulates. Its
//   local application was skipped, so the hit would simply be lost; it is described here and queued
//   for this frame's MSG.ENEMY_HIT instead (sendHitQueue), to be applied by its owner through the
//   engine's own pipeline there. Nothing is applied here. The local player IS recorded as engaged
//   at this point, though (see the note at the engage() call below): this client has to be able to
//   answer for its OWN player, and its hit never comes back to it.
//
//   ...except for the one enemy that is suppressed yet OURS: an enemy we have been assigned but
//   have not taken over yet is held as a puppet while the takeover waits for the previous owner's
//   handoff (see takeOwnership). Forwarding its hit would address it to "its owner", which is US --
//   and no other client applies an entry for an enemy it does not own, so the hit would be silently
//   lost. `true` answers "apply this one here after all": the seam then runs the engine's own
//   application on the live force/coll, which is exact (no rebuild, no lossy round trip), is recorded
//   as engagement exactly like any other owned hit, and happens ONCE -- adoption applies state, never
//   a hit, so the takeover cannot replay it.
//   The residual, stated plainly: if the previous owner's handoff DOES arrive after that hit, the
//   adoption writes that older state over ours (`applyState` writes hp), undoing the damage locally.
//   That window is the hold itself (a frame or two in practice, HANDOFF_HOLD_FRAMES at worst), it is a
//   property of the handoff design rather than of this path, and applying here is still never worse
//   than losing the hit: whenever the hold expires without a handoff the damage stands, and nothing
//   re-applies the hit either way.
//
//   suppressed === false -- the receiver is an enemy THIS client simulates, and the engine's own
//   application of the hit is running right after this call. The only thing recorded is that the
//   local player is now engaged with that enemy: this is the owner's own half of the engagement
//   record, which a forwarded hit cannot supply (a hit on an enemy we own never leaves this client).
//   Note the party test: this seam sees hits from EVERYTHING (a hazard, a trap, another enemy, a
//   party ally), and only a PLAYER-party hit is the local player fighting -- the same distinction
//   the engine itself makes one line later in the real EnemyCmp.onHit (enemy-cmp.js:1101-1103,
//   `force.damager.getParty() == COMBATANT_PARTY.PLAYER`). Without it, an enemy walking into its own
//   map's spikes would count as the local player engaging it.
//
// The sink's own behaviour is total: it never throws (a throw would abort the engine's hit delivery
// on the attacker's side), and it holds nothing. Its return value is read on the suppressed path
// only, and only for `true` (the "apply it here" answer above); the other paths return undefined.
function onEnemyHitSeam(ent, force, coll, suppressed) {
	if (!isEnemySyncEnabled() || !isConnected())
		return;
	if (!isPlayerAttack(force))
		return;
	if (suppressed) {
		// Only a wire-addressable enemy can be addressed to an owner: a runtime spawn (`u:<uid>`)
		// means a different enemy on every client. readHitDescriptor derives the id the same way
		// readEnemyState does; this is the test the register and state paths use, so what travels is
		// exactly what the receiving registry can be keyed by.
		const id = wireEnemyId(ent?.core);
		if (id === null)
			return;
		// Ours-but-not-yet-adopted (the takeover hold): the assignment is already ours and this copy
		// is the one that will be authoritative, so the hit is applied HERE rather than forwarded to
		// an owner that would drop it. See the note on this case in the seam contract above.
		if (isOwner(id)) {
			engage(id, localPlayerId());
			return true;
		}
		const descriptor = readHitDescriptor(force, coll, ent);
		if (!descriptor)
			return;
		descriptor.id = id;
		pendingHits.push(descriptor);
		// The SENDING side records its own player as engaged at send time (5b's constraint: a peer
		// evaluates ITS OWN player's eligibility, and its hit never comes back to it -- the server
		// excludes the sender -- so the owner's record of it is not one this client can read). No wire
		// change is needed for it: the fact is already known here.
		engage(id, localPlayerId());
		return;
	}
	const id = wireEnemyId(ent?.core);
	if (id === null || !isOwner(id))
		return;
	engage(id, localPlayerId());
}

// True when this force is a PLAYER's attack, i.e. not a hazard, a trap, an enemy or anything else
// the world went and did on its own. `getParty()` is the engine's own answer (hit-force.js:277-279:
// the attack's own party override, else the damager's), and a damager without stats cannot answer
// at all -- those are not player attacks.
function isPlayerAttack(force) {
	if (!force?.damager?.stats)
		return false;
	if (typeof force.getParty !== "function")
		return false;
	return force.getParty() === (terra.export?.COMBATANT_PARTY?.PLAYER ?? 1);
}

// The peer half's flush: one MSG.ENEMY_HIT per frame at most, however many hits landed in it.
// Silent when nothing was queued. Gated on the feature and the connection, not on hasPeers(): a hit
// is one-shot, so it must not be dropped because the peer set has not been populated yet (the same
// reasoning as the one-shot despawn, see sendDespawnId). `owner` is our own playerId, which the
// server overwrites with the id of the socket the frame came from.
function sendHitQueue() {
	if (pendingHits.length === 0)
		return;
	const list = pendingHits;
	pendingHits = [];                      // one-shot, whatever happens below
	if (!isEnemySyncEnabled() || !isConnected())
		return;
	send({ type: MSG.ENEMY_HIT, owner: localPlayerId(), list });
	if (debugEnabled())
		debugLog(`forwarded ${list.length} hit(s) to their owners: ${list.map((e) => e.id).join(", ")}`);
}

// ─────────────────── phase 5a: applying a hit forwarded to us ───────────────────

// Inbound MSG.ENEMY_HIT (a client whose hit was suppressed -> server -> everyone but the sender):
// the description of hits that landed on enemies the SENDER does not simulate. Routed here from
// ./client.js, and applied by exactly one party -- the enemy's owner.
//
// The gates, in order:
//   * the feature must be on (a disabled module owns nothing and applies nothing);
//   * the entry must be shaped like a hit (see isForwardedHit) -- a peer's payload must not be able
//     to break this frame, not even the one it arrives in (the same rule as
//     onEnemyState/onEnemyHandoff/onEnemyDespawn), and must not be able to invent a damage number
//     out of a missing field;
//   * WE must own the enemy (isOwner). This is the gate that makes the type safe: the server
//     deliberately does not authorise the relay (anyone may hit anything), so the recipient's own
//     ownership is what decides whether the hit is ours to apply. An entry for an enemy somebody
//     else owns is dropped, not stored: a hit is an EVENT, not state, and applying it late -- after
//     the enemy changed hands -- would damage an enemy the sender never hit.
//   * the hit must not have been applied already. See the signature below.
//
// The attacker recorded as engaged is the SERVER-STAMPED sender (msg.owner), not the payload's own
// `attacker`: both are the same player on an honest client, but the stamped one came off the socket
// and cannot be forged, and it is also the right answer when the hit came from something else the
// sender's player owns (a party ally's blow). The payload's field is the fallback for a frame with
// no stamp at all.
export function onEnemyHit(msg) {
	if (!isEnemySyncEnabled())
		return;
	const list = msg?.list;
	if (!Array.isArray(list))
		return;
	const now = nowMs();
	const sender = msg?.owner == null ? null : String(msg.owner);
	for (const entry of list) {
		if (!entry || typeof entry !== "object")
			continue;
		if (!isForwardedHit(entry))
			continue;                      // malformed/partial: skipped, never applied with invented values
		const id = entry.id;
		if (!isOwner(id))
			continue;
		const signature = hitSignature(id, entry);
		const seen = recentHits.get(signature);
		if (seen !== undefined && now - seen < HIT_DEDUPE_MS)
			continue;                      // a re-delivered frame: this hit has already been applied
		recentHits.set(signature, now);
		const applied = applyForwardedHit(id, entry);
		if (debugEnabled()) {
			debugLog(applied
				? `hit applied to ${id} (from ${sender ?? entry.attacker ?? "?"}, x${entry.dmgFactor})`
				: `hit for ${id} dropped: no entity to apply it to`);
		}
		const attacker = sender ?? (typeof entry.attacker === "string" && entry.attacker !== "" ? entry.attacker : null);
		if (attacker !== null)
			engage(id, attacker);
	}
	pruneRecentHits(now);
}

// Is this entry a hit at all? The frozen payload carries 20 fields; an entry missing the ones the
// rebuild cannot do without is SKIPPED, never replayed with invented values:
//   id          which enemy it hit (already tested, but it is the entry's key)
//   dmgFactor   the damage the peer computed for this hit. Defaulting a MISSING one to 1 would
//               invent damage the peer never measured, which is exactly the failure mode a
//               malformed entry must not have.
//   atk         the attacker's RESOLVED attack basis (atk + str), i.e. the attacker-side term of the
//               damage the peer computed. There is no safe default for a missing one: guessing a
//               stand-in from a level is exactly the defect this field replaced, so its absence is a
//               reason to skip the entry.
//   hitPoint    where the hit landed: the position of its FX and hit number.
// Everything else (impact/fly/fx/element/hints/...) only tunes the reaction and degrades to the
// engine's own AttackInfo/damager defaults, which is what a partial entry can safely mean. A
// version-skewed sender therefore loses its hits rather than landing wrong ones -- failing closed.
function isForwardedHit(entry) {
	if (typeof entry.id !== "string" || entry.id === "")
		return false;
	if (typeof entry.dmgFactor !== "number" || !Number.isFinite(entry.dmgFactor))
		return false;
	if (typeof entry.atk !== "number" || !Number.isFinite(entry.atk))
		return false;
	return Array.isArray(entry.hitPoint) && entry.hitPoint.length >= 3;
}

// The identity of one forwarded hit, for the exactly-once guard: everything the descriptor carries
// that distinguishes one hit from the next, including its landing point. A re-delivered frame
// repeats it exactly, while two distinct hits of the same attack differ in at least their point (or
// in the attack's own factors), so the guard cannot swallow a real second hit.
function hitSignature(id, entry) {
	const point = Array.isArray(entry.hitPoint) ? entry.hitPoint.join(",") : "";
	return `${id}|${entry.attacker ?? ""}|${entry.part ?? 0}|${entry.dmgFactor}|${point}`;
}

// Forget signatures older than the dedupe window. Cheap: it walks the map only when a hit arrives.
function pruneRecentHits(now) {
	if (recentHits.size === 0)
		return;
	for (const [signature, at] of recentHits) {
		if (now - at >= HIT_DEDUPE_MS)
			recentHits.delete(signature);
	}
}

// The reusable synthetic force this client applies forwarded hits with -- built once, rewritten per
// hit. The engine's own precedent for exactly this shape is `g_selfDamageForce`
// (hit-force.js:329-353): one HitForce + AttackInfo pair for the whole process, its fields set per
// application, because an application is synchronous and nothing outlives it.
let forwardedRig = null;

// Build the rig, or null on a game build whose combat primitives are not exported (in which case
// there is nothing to apply a forwarded hit with, and the hit is dropped rather than half-done).
function getForwardedRig() {
	if (forwardedRig)
		return forwardedRig;
	const exp = terra.export ?? {};
	const { DamagerCmp, HitForce, AttackInfo } = exp;
	if (typeof DamagerCmp !== "function" || typeof HitForce !== "function" || typeof AttackInfo !== "function")
		return null;

	// The force's SOURCE is what supplies the hit direction/velocity to the damage path
	// (hit-force.js:280-299: getHitVel/getHitDir/getHitRotDir are delegated to it). The real source
	// is the attacker's act, which this client does not have; these stand-ins return the vectors the
	// peer measured, so the victim is knocked the same way.
	const source = {
		hitVel: [0, 0],
		hitDir: [0, 0],
		hitRotDir: [0, 0],
		getHitVel(dest) { dest.setC(this.hitVel[0], this.hitVel[1]); return dest; },
		getHitDir(dest) { dest.setC(this.hitDir[0], this.hitDir[1]); return dest; },
		getHitRotDir(dest) { dest.setC(this.hitRotDir[0], this.hitRotDir[1]); return dest; },
	};
	const damager = new DamagerCmp();       // an unregistered, reusable attacker stand-in
	const force = new HitForce(source);
	forwardedRig = { source, damager, force, attackInfo: new AttackInfo({}, false) };
	return forwardedRig;
}

// The attack-stat stand-in for the forwarded attacker: the SHELL the engine's own factory builds
// ("an attack-scaled stats set with no combatant" -- no entity, no modifiers, hp/def 1, the party the
// rebuilt hit is attributed to; the same call TerraActorEntity uses to give an NPC an attacker,
// terra-actor-entity.js:95), with the FORWARDED attack basis written over the basis the factory would
// have invented from a level.
//
// WHAT THIS DOES AND DOES NOT REPRODUCE. The attacker-side term of the damage formula is the resolved
// `atk` of CombatParams.calculateDamage (:201, `force.stats.getStat("atk") +
// force.stats.getStat("str")`) and nothing else -- every other read of `force.stats` in that formula
// is a modifier lookup, which this stand-in answers with 0 -- so writing the peer's own sum into
// `base.atk` (with `base.str` left at 0) reproduces the peer's attacker-side term EXACTLY. The
// owner's `baseDamage` (damage-formula.js) is then the same function of the same atk against ITS OWN
// defender, which is the authoritative copy -- which is why the resulting number is the peer's:
//   * exact: the damage factor chain (:95, hit-force.js:108-117) -- the peer's whole
//     force.getDamageFactor(true) rides on `damager.dmgFactor` while the rebuilt attack info's own
//     factor is 1, ceiling included.
//   * exact: the defender-side terms (def, resistances, weakFactor, the part): read from the OWNER's
//     params/defParams, which is the authoritative copy by construction.
//   * NOT reproduced: the attacker's MODIFIERS (ARTS_DMG / SNIPER_DMG / CRIT_DMG / STAT_CRIT ...,
//     :100-171), which live in the attacker's own stats and are deliberately not on the wire -- a
//     stand-in has none, so those branches contribute nothing.
//   * NOT reproduced: the engine's own per-application rolls (crit, the +/-5% variance, :187-207).
//     They are re-rolled on the owner, which is inherent to forwarding a basis rather than a number:
//     the deterministic part of the damage is the peer's to the bit, the dice are not.
//   * `params.level` is now irrelevant to the number: the factory only used it to scale the basis we
//     overwrite, and it is 1 for a player anyway (combat-params.js:44) -- which IS the defect this
//     replaced, because the wire used to carry that level and every forwarded player hit therefore
//     landed as a level-1 one.
function attackStatsFor(atk) {
	const CombatStats = terra.export?.CombatStats;
	const party = terra.export?.COMBATANT_PARTY?.PLAYER ?? 1;
	if (typeof CombatStats?.getAttackStats !== "function" || !Number.isFinite(atk))
		return null;
	try {
		const stats = CombatStats.getAttackStats(1, party);
		// The forwarded basis, exactly: CombatStats.getStat rounds per stat and the peer's sum is
		// already an integer, so `atk + 0` is the number the peer's own calculation used.
		stats.base.atk = atk;
		stats.base.str = 0;
		return stats;
	}
	catch (e) {
		return null;
	}
}

// Write one forwarded descriptor onto the rig and apply it to `ent` through the ENGINE's own entry
// point -- TerraActorEntity.onHit (terra-actor-entity.js:252-258 -> EnemyCmp.onHit -> the
// combatant's damage pipeline: onHit -> onDamage -> getDamage -> dealDamage -> onPreDamage ->
// reduceHP). That is what makes a forwarded hit behave like a local one: part damage, hp-break,
// poise/break trackers, the hit reaction/stun, the damage FX, the hit number and a defeat that
// reaches the engine's own death chain all happen exactly as they do for the owner's own hits. The
// two things that do NOT are named where they are set below (a status condition, which needs the
// attacker's combatant, and the attack info's two live-object fields, which cannot be serialised).
//
// `coll`: the real coll that hit lives on the attacker and is not serialisable, so it is rebuilt
// from the one field the pipeline reads from it (`coll.part`, the body part the attack landed on:
// EnemyCmp.getHitDefense, enemy-cmp.js:750-754, maps it through the enemy's own part list, and the
// damage FX flash it). `getFlashPart()` is what the engine's own coll answers with for that.
//
// Returns false when the hit could not be applied at all (no entity behind the id any more, no
// rebuild available): the engagement record above still counts it, because the hit did happen.
function applyForwardedHit(id, entry) {
	const rig = getForwardedRig();
	if (!rig)
		return false;
	const core = findCoreById(id);
	const ent = core?.ent;
	if (!ent || typeof ent.onHit !== "function")
		return false;

	const { force, damager, attackInfo, source } = rig;
	const stats = attackStatsFor(entry.atk);
	if (!stats)
		return false;

	attackInfo.damageFactor = 1;           // the fold: the peer's factor rides on damager.dmgFactor
	attackInfo.element = numField(entry.element, 0);
	attackInfo.impact = numField(entry.impact, 0);
	attackInfo.fly = numField(entry.fly, 0);
	attackInfo.fx = numField(entry.fx, 0);
	attackInfo.triggerFactor = numField(entry.triggerFactor, 1);
	// statusFactor is CARRIED on the wire (the frozen payload) and deliberately NOT applied here: the
	// engine's status branch (combatant-cmp.js:861-878) attributes the condition to the ATTACKER's
	// combatant -- `combatant.params.stats.modifiers` and `statusState.start(this, strength,
	// combatant, modifier)` on `combatant = force.getCombatant()` -- and a forwarded hit has no
	// attacker combatant on this client (the peer's player is not an entity here). A non-zero factor
	// therefore throws inside the engine's own hit delivery (:870), so the effect is dropped rather
	// than crashed: the damage, the reaction, the FX and the hit number all still land.
	attackInfo.statusFactor = 0;
	// spGain travels and is written onto the attack info (the engine's own hit delivery draws it down
	// as it lands), but it cannot REACH the attacker from here: applying it is
	// `force.applySpOnHit` -> `applySpGain` -> `force.getCombatant()` (hit-force.js:91-101), and the
	// stand-in above has no combatant -- the peer's player is not an entity on this client. So no SP is
	// granted to the attacker for a forwarded hit, for the same missing-attacker reason as statusFactor.
	attackInfo.spGain = numField(entry.spGain, 0);
	attackInfo.hitPause = numField(entry.hitPause, 0);
	attackInfo.hints = Array.isArray(entry.hints) ? entry.hints.slice() : [];
	// Live engine objects, not data: they cannot travel (see readHitDescriptor's note), and null is
	// the value the engine's own code guards every use of them with (`if (attackInfo.lock)` etc.).
	attackInfo.lock = null;
	attackInfo.details = null;
	// IMPLICIT for a melee hit: HitForce.reset turns it into MELEE (hit-force.js:66-67), which is
	// the engine's own defaulting for a non-proxy force. A ranged hit keeps the peer's own answer.
	attackInfo.attackType = entry.ranged === true ? (terra.export?.ATTACK_TYPE?.RANGED ?? 2) : (terra.export?.ATTACK_TYPE?.IMPLICIT ?? 0);

	// The attacker stand-in, carrying the FORWARDED basis, and the folded factor. A missing/invalid
	// factor degrades to 1 (the engine's own default for both fields) rather than to 0, which would
	// mean "this hit does no damage" and quietly delete the hit the peer just made.
	const factor = numField(entry.dmgFactor, 1);
	damager.stats = stats;
	damager.dmgFactor = factor;
	damager.dmgCeiling = null;             // the peer's ceiling effect is already inside `factor`

	force.reset(damager, attackInfo);
	// `reset` derives the force's element from the attack info just written (and, for a stats object
	// whose entity is a player, from the damager's variant instead -- not our case, since the stand-in
	// has no entity). Setting it explicitly keeps the peer's own reading the one the hit uses.
	force.element = attackInfo.element;
	force.forceRanged = entry.ranged === true;

	const point = Array.isArray(entry.hitPoint) ? entry.hitPoint : [];
	if (force.hitPoint && typeof force.hitPoint.setC === "function")
		force.hitPoint.setC(numField(point[0], 0), numField(point[1], 0), numField(point[2], 0));

	source.hitVel = wirePair(entry.hitVel);
	source.hitDir = wirePair(entry.hitDir);
	source.hitRotDir = wirePair(entry.hitRotDir);

	// The coll, rebuilt from what the wire carries. It is passed to the engine's own hit code, so it
	// has to answer the two things that code reads from it:
	//   part           the body part index the attack landed on (this is the VICTIM's own part index:
	//                  EnemyCmp.getHitDefense maps it through that enemy's part list,
	//                  enemy-cmp.js:750-754, and the damage FX flash it).
	//   getFlashPart   what the engine's own coll answers with for the flash part (combatant-cmp.js
	//                  :829 uses it when no part flash was set by defence).
	//   core.ent       the one other read on this path: a SHIELD's block-FX alignment
	//                  (combat-shield.js:130 `blockFxAlign.get(force.hitPoint, coll.core.ent)`). Since
	//                  the part index above is the victim's, a coll belonging to the victim's own core
	//                  is the coherent stand-in, and it keeps that engine path from dereferencing
	//                  nothing.
	const coll = {
		part: numField(entry.part, 0),
		core,
		getFlashPart() { return this.part; },
	};
	ent.onHit(force, coll);
	return true;
}

// One numeric wire field, or `fallback` when it is missing/skewed.
function numField(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// An [x, y] wire pair, or a zero pair. The array is stored on the rig's source as-is: it is this
// client's own parsed payload, and only ever read synchronously by the application right after.
function wirePair(value) {
	if (!Array.isArray(value) || value.length < 2)
		return [0, 0];
	return [numField(value[0], 0), numField(value[1], 0)];
}

// ───────────────────────────── phase 5a: engagement ─────────────────────────────

// Record that `playerId` has engaged `enemyId` RIGHT NOW, as a latch: the entry stores when the
// player was last seen in the fight, and it is refreshed on every later sighting (each proximity
// pass, each hit). Nothing here ever reads the enemy's live state back -- see isEngaged.
function engage(enemyId, playerId, at = nowMs()) {
	if (typeof playerId !== "string" || playerId === "")
		return;
	let players = engagement.get(enemyId);
	if (!players) {
		players = new Map();
		engagement.set(enemyId, players);
	}
	players.set(playerId, at);
}

// Has `playerId` engaged `enemyId`? THE reader Phase 5b consumes, and deliberately a LATCH with a
// TTL rather than a predicate over the enemy's current state:
//
//   * It answers from what was RECORDED earlier in the fight (the last sighting inside
//     ENGAGEMENT_TTL_MS), never from `enemy.aggressive` right now. That is required, not stylistic:
//     the engine's own death path de-aggros the enemy seven lines before it grants the rewards
//     (enemy-cmp.js:1122 setAggressive(false, true) -> :1129-1130 giveExp/dropItems), so at the
//     moment an eligibility question is asked the live flag is already false on both clients.
//   * The TTL must outlive the gap between a death and the definitive event a peer can act on: on
//     a client that does not simulate the enemy, the death is only certain when the owner's despawn
//     arrives, which is up to DYING_REMOVE_MS (3000ms) later. ENGAGEMENT_TTL_MS is 4000, so a
//     player whose last sighting was the frame before the killing blow is still engaged when that
//     despawn lands. A shorter window would deny the killer's own reward.
//   * It is recorded for the enemies this client OWNS and for the ones it puppets, because BOTH
//     clients evaluate their own player's eligibility (see updateEngagement).
//
// False while the feature is off (a disabled module records nothing, and reports nothing).
export function isEngaged(enemyId, playerId) {
	if (!isEnemySyncEnabled())
		return false;
	const at = engagement.get(enemyId)?.get(String(playerId));
	return at !== undefined && nowMs() - at < ENGAGEMENT_TTL_MS;
}

// Every player id engaged with `enemyId` and still inside the TTL, in the order they were first
// recorded. A fresh array (the caller may keep or sort it), empty for an enemy nobody engaged. This
// is the reusable shape Phase 5b consumes: it never needs to re-derive a radius or re-read the
// enemy, and it is the only definition of "engaged" there is.
export function engagedPlayers(enemyId) {
	if (!isEnemySyncEnabled())
		return [];
	const players = engagement.get(enemyId);
	if (!players)
		return [];
	const now = nowMs();
	const out = [];
	for (const [playerId, at] of players) {
		if (now - at < ENGAGEMENT_TTL_MS)
			out.push(playerId);
	}
	return out;
}

// Where each player is, as far as this client can know: the local player from its own entity, and
// each peer from its ghost actor (./actors.js moves it to the position the peer reported, and
// window.terraTogether.playerActors is ./session.js's live map of them). A player whose actor is
// not in the world (or has no core yet) simply has no position and is skipped.
function playerPositions() {
	const out = [];
	const me = localPlayerId();
	const myPos = terra.export.g_player?.entity?.core?.pos;
	if (me !== null && myPos)
		out.push([me, myPos]);
	const actors = window.terraTogether?.playerActors;
	if (actors) {
		for (const [id, actor] of actors) {
			const pos = actor?.core?.pos;
			if (pos)
				out.push([String(id), pos]);
		}
	}
	return out;
}

// XY distance, the engine's own flavour of proximity (enemy-cmp.js:584
// player.checkDistanceXY(this.ent.core.pos, 20) for aggro upkeep; :1114 aggroNearbyEnemy(this, 8,
// true)). Height is deliberately not part of it: two players on a ledge above a fight are in it.
function withinEngageRadius(a, b) {
	if (!a || !b)
		return false;
	const dx = a.x - b.x, dy = a.y - b.y;
	return dx * dx + dy * dy <= ENGAGE_RADIUS * ENGAGE_RADIUS;
}

// Is this enemy in a fight, for the proximity rule below? The entity itself answers whenever this
// client has one, which is the only answer that stays true across a handover: an enemy we OWN and an
// enemy we simulate because its owner went quiet (the puppet was handed back to local simulation,
// relinquishPuppet) are both read from the engine's own `aggressive` flag -- and for a driven PUPPET
// that flag IS the owner's carried `aggro` bit, because this module APPLIES it (./enemy-puppet.js,
// engagePuppet). One source, three cases, and no possibility of the two disagreeing.
//
// The owner's carried bit is the FALLBACK for an entity that cannot answer -- one this client knows
// of but holds no EnemyCmp for yet -- read through the same gate the peer half applies to state: it
// must be the enemy's CURRENT owner's frame, and a fresh one.
function enemyInFight(id, core) {
	const aggressive = core?.ent?.enemy?.aggressive;
	if (typeof aggressive === "boolean")
		return aggressive === true;
	const entry = peerState.get(id);
	if (!entry || entry.from !== currentOwner(id))
		return false;
	if (nowMs() - entry.at >= PEER_STATE_FRESH_MS)
		return false;
	return entry.state?.aggro === true;
}

// The per-frame engagement pass, over every live enemy this client holds -- owned OR puppeted,
// because both clients evaluate their OWN player's eligibility and each can only answer for the
// enemies it can see:
//   * PROXIMITY. Sam's rule: "if player comes near enemies after other player already in battle,
//     they should aggro as well" -- so every player inside ENGAGE_RADIUS of an enemy that is IN A
//     FIGHT is (re-)recorded, whenever they arrive. Gating on "in a fight" is what stops standing
//     next to a calm enemy nobody is fighting from counting, and refreshing on every frame is what
//     keeps a participant's stamp younger than ENGAGEMENT_TTL_MS for as long as the fight lasts.
//     Height is ignored (see withinEngageRadius).
//   * THE HITS' OWN SEED is not here: a forwarded hit is recorded when it is applied
//     (onEnemyHit, owner side) or when it is queued (onEnemyHitSeam, sending side).
//   * PRUNING is by AGE ALONE -- deliberately not "the enemy is gone" or "we no longer own it".
//     A record has to survive the enemy's death and the despawn that follows it (see isEngaged), so
//     dropping it when the enemy leaves would delete exactly the answer Phase 5b asks for. Map
//     changes, disconnects and the feature going off clear the whole thing (clearHitState).
function updateEngagement(live) {
	if (live && live.size > 0) {
		let positions = null;
		for (const [id, core] of live) {
			if (!enemyInFight(id, core))
				continue;
			if (positions === null)
				positions = playerPositions();
			for (const [playerId, pos] of positions) {
				if (withinEngageRadius(pos, core.pos))
					engage(id, playerId);
			}
		}
	}
	if (engagement.size === 0)
		return;
	const now = nowMs();
	for (const [id, players] of engagement) {
		for (const [playerId, at] of players) {
			if (now - at >= ENGAGEMENT_TTL_MS)
				players.delete(playerId);
		}
		if (players.size === 0)
			engagement.delete(id);
	}
}

// ────────────────────────────── phase 5b: kill rewards ──────────────────────────────

// The enemies this client has ALREADY paid a kill reward for, keyed by the ENEMY ENTITY's own uid
// (see killRewardKey). The exactly-once guard of the phase, written by BOTH grant paths: the gated
// engine call below (the owner's own death) and grantKillReward (a death that became certain here
// without the engine's death path ever running). Both halves need it, because the same enemy can
// arrive twice: the dying entity is still in the world when a peer's despawn for it lands (the
// engine removes it only when the death animation ends), and the bounded removal of a latched dying
// puppet can be followed by the despawn that was in flight. Entries live until the resets that
// abandon the world clear them (clearKillRewardState -- a REST deliberately does not: see there).
const grantedKills = new Set();

// The exactly-once key of a kill reward: the enemy ENTITY's own uid -- the engine's per-entity
// counter (`++Entity.globalUid`, so it is unique inside one client) -- i.e. THIS incarnation of this
// enemy on THIS client, which is what "grant once per kill" means. Deliberately not the wire id: a
// wire id names a SPOT, and a spot's enemy can come back (a rest, a scripted RESPAWN_ENEMY) as a
// brand-new entity that must be able to be paid on its own account, with a new uid. The wire id is
// only the fallback for an entity that carries no uid (the engine always sets one; see the same
// `?? "?"` fallback in enemyStableId) -- coarser, and in that degenerate case it can only ever
// over-suppress, which is the safe direction for a double-grant guard.
function killRewardKey(ent, enemyId) {
	const uid = ent?.core?.uid;
	if (typeof uid === "number")
		return uid;
	return typeof enemyId === "string" && enemyId !== "" ? enemyId : null;
}

// Is the LOCAL player entitled to a share of `enemyId`'s reward? Sam's rule in one place, asked by
// BOTH halves of the split -- which is the point of having it here rather than inline twice: the
// peer that grants and the owner that gates must agree on what "in this fight" means.
//
//   * IN COMBAT is isEngaged(enemyId, myId): Phase 5a's latch -- this player hit the enemy, or was
//     inside ENGAGE_RADIUS of it while it was in a fight. It has to be the LATCH rather than the
//     enemy's live state, because the engine de-aggros an enemy seven lines before it grants its
//     rewards (enemy-cmp.js:1122 vs :1129), and because on a client that did not simulate the death
//     the question is asked after the enemy is gone.
//   * NEAR is the engine's own player-proximity call against the enemy's position (player-model.js:
//     188-194, see KILL_REWARD_RADIUS): a player who walked up to the corpse of an enemy they never
//     touched shares in it, which is what Sam asked for, and it is what pays the case the latch
//     cannot -- a player who arrived after the last hit.
// The question is asked when the death is CERTAIN on the asking client (its own death path, or the
// definitive event), never off streamed state: a streamed `hp === 0` can be a live enemy whose HP
// merely rounds to 0 (see the dying latch and suite 08).
function eligibleForKillReward(enemyId, ent) {
	const me = localPlayerId();
	if (me === null)
		return false;
	if (isEngaged(enemyId, me))
		return true;
	const pos = ent?.core?.pos;
	if (!pos)
		return false;
	return terra.export.g_player?.checkDistanceXY?.(pos, KILL_REWARD_RADIUS) === true;
}

// Pay the LOCAL player their share of an enemy that has just been established as DEAD on this
// client -- the peer half of the phase, for an enemy this client did not simulate. Its callers are
// the two deaths that become certain here without the engine's own death path ever running locally:
// the owner's MSG.ENEMY_DESPAWN, and the bounded removal of a latched dying puppet (both through
// despawnEnemyLocally).
//
// That a client can grant for an enemy it never simulated is the whole mechanism: giveExp and
// dropItems take NO ARGUMENTS and read only per-client state (the local g_player, this client's own
// drop rolls, the enemy's own type/level), so each client answers for itself from facts it already
// has -- which is why this phase adds nothing to the wire.
//
// What deliberately does NOT happen here is the owner's own kill bookkeeping:
// rogue.onEnemyKilled, the defeatCallback / BattleSequence flow (the wave counters), screen shake
// and combat.setEnemyDefeated. Those describe the kill to the client that fought it -- aim handles,
// trackers, scripted progression -- and replaying them on a client that did not would double-count
// exactly what markSpotDefeated is careful to avoid. A peer's grant is the two reward calls and
// nothing else.
//
// KNOWN GAP, documented rather than worked around: `this.hitExp`, which giveExp uses for the
// weapon-experience share, is written in EnemyCmp.onPreDamage -- and a puppet's onHit is suppressed
// before it (./enemy-puppet.js patch (c), which reports the hit instead of applying it), so on a
// peer that map is empty and the weapon-XP part of the share is lost. The base XP and the drops are
// unaffected; only the weapon-XP split of a kill you did not simulate is missing.
function grantKillReward(enemyId, ent) {
	if (!isEnemySyncEnabled() || !isConnected())
		return false;
	if (!ent)
		return false;
	const key = killRewardKey(ent, enemyId);
	if (key !== null && grantedKills.has(key))
		return false;
	if (!eligibleForKillReward(enemyId, ent)) {
		if (debugEnabled())
			debugLog(`kill reward for ${enemyId}: our player was neither in combat with nor near it, nothing paid`);
		return false;
	}
	const enemy = terra.export.EnemyCmp?.get?.(ent);
	if (!enemy || typeof enemy.giveExp !== "function" || typeof enemy.dropItems !== "function")
		return false;
	// Marked BEFORE the calls: a grant that throws half-way must not be repeatable, and the mark is
	// "this kill has been paid", not "the calls returned".
	if (key !== null)
		grantedKills.add(key);
	// Through the ORIGINAL methods, never the wrappers below: those are the owner's GATE, and this
	// path has just made the same decision for itself (asking it twice could only disagree with
	// itself, and would log a second, misleading "skipped").
	callRewardGrant(enemy, "giveExp");
	callRewardGrant(enemy, "dropItems");
	if (debugEnabled())
		debugLog(`kill reward for ${enemyId}: paid to our player (${isEngaged(enemyId, localPlayerId()) ? "in combat" : "near"})`);
	return true;
}

// One of the two engine reward calls, through the stored original when the gate below is installed
// (see ensureRewardPatch) and directly otherwise.
function callRewardGrant(enemy, name) {
	const original = rewardGrants?.[name];
	(original ?? enemy[name]).call(enemy);
}

// Drop the exactly-once marks. Part of the resets that abandon the world they belong to (a map
// change, the feature going off, a disconnect -- the same paths that drop the peer state and the
// engagement records). A REST is deliberately not one of them: it puts the map's enemies back, and a
// respawned enemy is a new ENTITY with a new uid, so its own death must be payable on its own
// account. Nothing that could still be paid is forgotten here: a grant needs the enemy's entity, and
// the entities these keys name have left the world.
function clearKillRewardState() {
	grantedKills.clear();
}

// ── the owner's own grant, gated ──
//
// The engine grants a beaten enemy's reward unconditionally, in its own death path
// (enemy-cmp.js:1129-1130, reached only from onDeathHit :1119). With rewards following the FIGHT
// rather than ownership, that is the wrong answer for an owner whose own player is nowhere near the
// enemy -- and an owner legitimately CAN be far from it, because ownership is a load-balancing
// decision, not a proximity one. So the two calls are wrapped, per entity: when the feature is on,
// this client is connected and the enemy is one WE own, a grant whose own player is neither engaged
// with nor near it is skipped. Everything else -- solo play, the feature off, offline, an enemy we
// do not own, a runtime spawn with no wire id -- runs the engine's own code untouched.
//
// This is the OWNER half of the phase, i.e. the one place a reward is granted where the engine has
// always granted one; the peer half is grantKillReward above. Nothing else in the death path is
// touched: the spot's defeat, the HUD, the screen shake, the defeat callback and the wave
// bookkeeping all still run for the owner, whose kill it is.
function ownerRewardBlocked(enemy) {
	if (!isEnemySyncEnabled() || !isConnected())
		return false;
	const ent = enemy?.ent;
	const id = wireEnemyId(ent?.core);
	if (id === null || !isOwner(id))
		return false;
	return !eligibleForKillReward(id, ent);
}

// The unpatched reward calls, kept so the peer half (grantKillReward) can grant without re-entering
// the gate above. Filled by ensureRewardPatch; null until it has run (an unknown game build leaves
// it null and the peer half falls back to calling the method itself).
let rewardGrants = null;
let rewardPatched = false;

// Install the two reward seams. Install-once, called every frame from the addon (see onPreUpdate)
// for the same reason the death seam is: an enemy can die in any frame, and this must be in place
// BEFORE the first enemy dies, whether or not this module has driven anything yet, and whether or
// not the option was on at the last map start. The wrappers are inert while the feature is off (they
// re-test it per call), so installing them unconditionally costs nothing and covers a flag switched
// on mid-map. A missing export leaves the flag alone so a later frame can retry, and is reported
// when the trace is on: silently believing rewards are gated would be worse than not gating them.
function ensureRewardPatch() {
	if (rewardPatched)
		return;
	const proto = terra.export.EnemyCmp?.prototype;
	if (!proto || typeof proto.giveExp !== "function" || typeof proto.dropItems !== "function") {
		if (debugEnabled())
			debugLog("cannot install the reward patch: terra.export.EnemyCmp.giveExp/dropItems is missing");
		return;
	}
	const grants = {};
	for (const name of ["giveExp", "dropItems"]) {
		const original = proto[name];
		if (original.__ttRewardPatched === true) {
			grants[name] = original;
			continue;
		}
		const wrapper = function (...args) {
			// OURS, and our own player is ineligible: the engine's grant is skipped, so an owner who
			// is nowhere near the enemy is not paid for it. The death itself is untouched -- the rest
			// of onDeathHit still runs (see the note on ownerRewardBlocked).
			if (ownerRewardBlocked(this)) {
				if (debugEnabled())
					debugLog(`kill reward for ${wireEnemyId(this?.ent?.core)}: our player is neither in combat with nor near it, granting nothing`);
				return undefined;
			}
			// A grant the engine is making for us right now: recorded, so no later event for the same
			// enemy (a peer's despawn while its dying entity is still in the world) can pay it twice.
			const key = killRewardKey(this?.ent, wireEnemyId(this?.ent?.core));
			if (key !== null)
				grantedKills.add(key);
			return original.apply(this, args);
		};
		wrapper.__ttRewardPatched = true;
		proto[name] = wrapper;
		grants[name] = original;
	}
	rewardGrants = grants;
	rewardPatched = true;
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

// The assigned owner's playerId, as the string the wire carries, or null when there is no
// assignment to report (feature off, offline, not yet assigned, enemy unknown). This is the
// identity behind getEnemyOwnerName: a name can be missing for a peer that never set a username
// (the server relays PROFILE verbatim, an empty one included, and the display layer sanitises it
// away), and a caller that has the id can still say who the owner IS instead of falling back to a
// guess -- see ownerLine in ../debug/enemy-debug.js.
export function getEnemyOwnerId(enemyId) {
	if (!isEnemySyncEnabled())
		return null;
	return registry.get(enemyId)?.owner ?? null;
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
// module graph a DAG. ./session.js has the inbound cases that hand these types to
// ./client.js (see the dispatch there).
addPeerMessageHandler(MSG.ENEMY_OWNER, onEnemyOwner);
addPeerMessageHandler(MSG.ENEMY_STATE, onEnemyState);
addPeerMessageHandler(MSG.ENEMY_HANDOFF, onEnemyHandoff);
addPeerMessageHandler(MSG.ENEMY_DESPAWN, onEnemyDespawn);
addPeerMessageHandler(MSG.ENEMY_RESPAWN, onEnemyRespawn);
addPeerMessageHandler(MSG.ENEMY_HIT, onEnemyHit);
addPeerMessageHandler(MSG.ENEMY_WAKE, onEnemyWake);

// The suppressed-hit seam's sink (./enemy-puppet.js setEnemyHitSink): registered here, at load,
// because the module that owns the wire is the one that must decide what a hit means -- the puppet
// module only reports the seam. Registering it is harmless while the feature is off (the sink
// re-tests the option per call), and it must exist before the first hit of the session.
setEnemyHitSink(onEnemyHitSeam);

// The ownership probe ./fx-sync.js attributes an effect to an enemy with (Phase 6; see the note on
// ./session.js's holder). Its capture hooks cannot import this module (it imports ./client.js), so
// like the handler table above, the answer is registered rather than imported. It is deliberately a
// RE-TEST per call rather than a cached list: ownership moves under a rebalance, the connection and
// the feature flag can go at any time, and an effect must be attributed by what is true when it is
// emitted. isOwner() is the whole test, so:
//   - the local player's own entities are never an owned enemy (no registry entry, and the id they
//     resolve to is a client-local `u:<uid>`);
//   - an enemy ANOTHER client owns -- the one this client puppets -- is never one, which is what
//     keeps a puppet from forwarding the effects it is being shown, or from forwarding the ones its
//     own suppressed copy would have emitted (it emits none: see ./enemy-puppet.js);
//   - a runtime spawn, which has no wire-addressable identity (`u:<uid>`, not correlated across
//     clients), is never one: there is no id the peer could route an effect back on;
//   - and an owned enemy we have not taken over yet IS one, which is deliberate: the fx we captured
//     before its takeover are drained against the frame's published set instead (see
//     drainEnemyEffects), the one place that knows what we are actually speaking for.
enemyOwnership.ownedIdOf = (ent) => {
	if (!ent || !isEnemySyncEnabled())
		return null;
	const id = enemyStableId(ent.core);
	return id && isOwner(id) ? id : null;
};

// ──────────────────────────────────── addon ────────────────────────────────────

// The per-frame loop, in two halves. onPreUpdate reads the frame's opening set — a freshly
// loaded map's enemies are announced before this frame's update consumes them — and drives the
// enemies this client does not own from the owner's state, before that same update runs, so a
// release lands in time for the enemy to simulate this frame rather than the next. onPostUpdate
// runs the same identity diff (so enemies the frame itself spawned or killed are reported in the
// frame that did it) and then publishes this frame's state for the enemies we own. The diff is
// silent when nothing changed, so registering still costs one message per identity change; only
// the state publish is per-frame, and only while there is a peer and something we own to send.
// Phase 5a adds two more end-of-frame duties to onPostUpdate, both owner-side bookkeeping: the
// queue of hits this client could not apply (sendHitQueue) and the engagement pass
// (updateEngagement). Phase 5b adds nothing to the loop: its peer half hangs off the death events
// (despawnEnemyLocally), and its owner half is a prototype gate installed by onPreUpdate.
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
		// The engine seams that hang off a per-entity decision -- the death seam (ensureDespawnPatch),
		// the rest seam (ensureRespawnPatch), Phase 5b's reward gate (ensureRewardPatch), the
		// damage-number capture for a forwarded hit (ensureHitNumberPatch, which wraps dealDamage) and
		// the hit-act seams (ensureHitActPatches: the HIT_* step starts an enemy's attack is captured
		// from, the CombatAct.cancel that reports its end, and the TACKLE pair that does the same for
		// the one attack that has no act -- the step that starts it and AttackerCmp.clearTackle, the
		// only call that ends it) -- are installed once, and this hook is
		// where it happens because it runs before this frame's entity updates: an enemy can die, and
		// another can attack, in any frame, whether or not this module has driven anything yet, so the
		// map-start install the puppet patches use would not cover a flag switched on mid-map.
		// Installed while the option is off too: the wrappers are inert then (they re-test the option
		// per call), and there is no hook that fires on the moment the option changes.
		ensureDespawnPatch();
		ensureRespawnPatch();
		ensureRewardPatch();
		ensureHitNumberPatch();
		ensureHitActPatches();
		applyPeerState(syncEnemies());
		// The tackles an owner's stream started on the enemies we hold have no physics of their own to
		// land (see the tackle section), so they are tested here, on the frame path, after the peer
		// state has put the enemy where its owner says it is.
		driveRemoteTackles();
	}

	onPostUpdate() {
		// One identity diff for both halves of the publish: the state of the enemies we own, and the
		// final state of the ones we have just lost (see sendHandoffs).
		const live = syncEnemies();
		sendOwnerStates(live);
		sendHandoffs(live);
		// The group wake, one shot per aggro EVENT (see the group-wake section): the frame's diff is
		// what says which enemies this client is simulating, and the engine's own flag on those is what
		// says one of them has just gone into combat. Placed with the other owner-side, per-frame
		// duties -- after the state publish, so the wake never delays it -- and cheap when nothing
		// changed: one boolean read per enemy we hold.
		detectWakes(live);
		// Phase 5a, owner side: apply nothing here -- the hits this client could NOT apply left in one
		// batch (sendHitQueue), and the engagement record is updated for the enemies the frame's diff
		// has just confirmed are ours (updateEngagement). Both are cheap and silent when there is
		// nothing to do: an empty queue, and an engagement map walked only while it is non-empty.
		sendHitQueue();
		updateEngagement(live);
	}
}

export { EnemySync };

//# sourceURL=/mods/terra-together/client/enemies.js
