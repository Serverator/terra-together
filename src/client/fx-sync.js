/**
 * src/client/fx-sync.js
 * Peer effect / sound / projectile synchronisation: the local capture hooks that fill the
 * sync queues, and the replay that rebuilds a peer's fx and sounds on our side.
 * Responsibilities:
 *   - FX predicates (isPlayerEntity/isPlayerTied/ownedEnemyId, clampAlignToFigure) and the
 *     screen-global step suppression (vignette/blur/shake must not replay onto the peer's
 *     screen), plus the LOCAL_ONLY_FX deny list.
 *   - Local capture: FxEntity/Sound/AudioEvent/Playback/ProxyDef patches, the SPAWN_WINDBOX
 *     knockback hook and the local player's actorFx injection — all feeding `queues` in
 *     ./session.js — and the ENEMY half of every one of those: an fx, sound or projectile
 *     belonging to an enemy this client OWNS (ownedEnemyId) is captured too, into the
 *     `enemyQueues`/`activeEnemyFx` slots ./enemies.js drains into the enemy frame. An enemy
 *     this client only puppets emits none of them here (its owner sends them).
 *   - Remote replay: spawnRemoteFx/reconcilePersistentFx/clearUntrackedRunFx, plus the
 *     per-peer teardown clearPeerFx (its fx *and* its synced sounds) and the narrower
 *     clearRemoteEnemyFx for an enemy whose owner's stream has stopped being applied to it.
 *   - Rogue seed/variant sync (installRogueSeedHook) and the sound-bus sync policy.
 * Public surface: installFxSyncHooks, installActorFxInjection, installRogueSeedHook,
 *   spawnRemoteFx, reconcilePersistentFx, clearUntrackedRunFx, clearPeerFx,
 *   spawnRemoteProjectile, stopActorSounds, clearRemoteEnemyFx
 * Engine touchpoints: terra.export.{FxEntity,Effect,Projectile,ProxyDef,GenericProxy,HitForce,
 *   ACTION_STEP,FX_STEPS,ACTOR_FX_TYPE,TARGET_RES_TYPE,COMBATANT_PARTY,DamagerCmp,CombatStats,
 *   getEntAlign,getEntAlignFigure,addFigureToEntAlign,g_rogue,g_player,g_actorGlobals,g_gState},
 *   terraTogether.steps.SPAWN_WINDBOX, terra.file.{sound,audioEvent,playback,actorSound,
 *   hitSounds,playerCombat,fxBase,stepBase}; Vec3 and the peer-actor map (playerActors) come
 *   from ./session.js.
 * Notes: the sync queues/registries are NOT declared here: they are shared with
 *   ./snapshot.js, ./actors.js and ./enemies.js and live in ./session.js (see its header). This
 *   module owns only capture-local state (fxSyncId, soundSyncId, projSyncId, spawningVisualCopy,
 *   syncHooksInstalled, projectileHooksInstalled, rogueSeedHookInstalled) and the patch
 *   caches. Import graph: session <- fx-sync <- (actors, enemies). The enemy ownership question
 *   (ownedEnemyId) is answered by ./enemies.js through the holder in ./session.js -- this module
 *   cannot import that one (it imports ./client.js), the same seam that routes its inbound types.
 *   Decompiled refs: fx-light.js:92 (LIGHT step's global climate darkening),
 *   actor-fx.js:77-89 (POST_MOVE run glow, group "__runFX__"), enemy-aim-fx.js:33/:57-74 (the
 *   "__aimFx__" telegraph: an infinite fx attached to the enemy, target2 at the shooter),
 *   enemy-type.js:83-85 + combat-act-steps.js:481/:521 (an enemy's own proxy list, which is what
 *   its shots are resolved from on both sides).
 */

import {
	queues, soundRegistry, activeSyncedSounds, activePersistentFx, soundSyncSuppress,
	RUN_FX_GROUPS, hasClient, getPeerRogueSeed, Vec3, enemyQueues, activeEnemyFx, enemyOwnership,
	playerActors, getLocalId,
} from "./session.js";

// --- Capture-local sync state -------------------------------------------------
let fxSyncId = 0;
let syncHooksInstalled = false;
let projectileHooksInstalled = false;

let projSyncId = 0;
// True only during a receiver-initiated mirror spawn (see spawnRemoteProjectile).
let spawningVisualCopy = false;
// True only during a receiver-initiated mirror spawn of an ENEMY's own proxy, i.e. the one kind of
// mirror whose hit is allowed to land on this client's own player (see the HitForce guard in the
// projectile hooks, and spawnRemoteProjectile). Cleared with `spawningVisualCopy`.
let spawningVictimMirror = false;

let soundSyncId = 0;

// --- FX predicates -----------------------------------------------------------
// Effects aligned to a figure-indexed node fall back to the entity center when
// the peer's figure lacks that index; clamp to the base figure so they land on it.
function clampAlignToFigure(ent, align) {
	if (!align) return align;
	const getEntAlign = terra.export.getEntAlign;
	const getEntAlignFigure = terra.export.getEntAlignFigure;
	const addFigureToEntAlign = terra.export.addFigureToEntAlign;
	if (!getEntAlign || !getEntAlignFigure || !addFigureToEntAlign)
		return align;
	const figIdx = getEntAlignFigure(align);
	const count = ent?.view?.figStates?.length ?? 0;
	if (figIdx > 0 && figIdx >= count)
		return addFigureToEntAlign(getEntAlign(align), 0);
	return align;
}

function isPlayerEntity(ent) {
	return !!ent && ent == terra.export.g_player?.entity;
}

function isPlayerTied(ent) {
	if (!ent) return false;
	const player = terra.export.g_player?.entity;
	if (!player) return false;
	// player-owned effect entities are tagged by the FxEntity.start hook
	return ent == player || ent._ttFxId || ent.target?.entity == player;
}

// --- Enemy attribution (enemy-sync Phase 6) -----------------------------------
// The enemy THIS client owns and simulates, when `ent` is one — and its wire id, which is what
// an effect descriptor is keyed by. null for everything else: the local player's own entities,
// another client's enemy (this client only puppets those — the OWNER sends their effects, and
// forwarding them here as well would double every one of them), an enemy with no wire-addressable
// identity (a runtime spawn), and any time the feature flag is off or the client is offline (the
// implementation in ./enemies.js re-tests all of that per call, see the note on ./session.js's
// holder).
//
// This is THE predicate that makes the three capture hooks below attribute an effect to an enemy,
// and it is deliberately the same ownership question the state half asks (isOwner): the one client
// that may speak for an enemy's position is the one that may speak for its effects. It answers for
// an enemy this client owns but has not taken over yet as well (ownership IS ours — the capture
// must record what our own copy emitted either way); what may actually travel is decided later, by
// the frame's published set (see drainEnemyEffects in ./enemies.js), which is the one place that
// knows what this client is really speaking for.
function ownedEnemyId(ent) {
	if (!ent) return null;
	return enemyOwnership.ownedIdOf(ent) ?? null;
}

// --- Screen-global FX step suppression ---------------------------------------
// FX steps that modify *global, screen-space* state: the screen vignette/climate,
// the radial blur and the camera shake. These are strictly per-client — replaying
// one on a peer would tint, blur or shake that peer's whole screen. This is what
// leaked the low-HP red vignette and the Sommu's-dream black vignette onto every
// other player. We do NOT drop such effects wholesale (that also removed genuinely
// shared world visuals, e.g. an aether/lightning explosion); instead we keep the
// effect synced and neutralise only the global parts when the peer replays it.
//
// LIGHT is a special case: it spawns a world-space light *and*, if it carries
// darkness/grayness, a global climate darkening (fx-light.js:92). On a peer replay
// we keep the world light but strip the darkening.
const SCREEN_FX_STEP_KEYS = ["CLIMATE", "RADIAL_BLUR", "SHAKE_SCREEN"];
const SCREEN_FX_STEP_NAMES = ["FxClimateStep", "FxRadialBlurStep", "FxShakeScreenStep"];
const LIGHT_FX_STEP_NAME = "FxLightStep";

function isScreenGlobalStep(step) {
	if (!step) return false;
	// Prefer the live step registry (robust to renamed classes)...
	const FX_STEPS = terra.export.FX_STEPS ?? terra.file.fxBase?.FX_STEPS;
	if (FX_STEPS) {
		for (const key of SCREEN_FX_STEP_KEYS) {
			const StepClass = FX_STEPS[key];
			if (StepClass && step instanceof StepClass)
				return true;
		}
	}
	// ...and fall back to class names, which the shipped bundle preserves (the
	// modloader already relies on that elsewhere).
	return SCREEN_FX_STEP_NAMES.includes(step.constructor?.name);
}

// Patch a step class's start() so it behaves correctly on a peer replay:
//  - "skip"  : do nothing at all (the step is purely screen-global).
//  - "light" : run normally but drop the global climate darkening.
const patchedStepClasses = new WeakMap();
function patchStepClassForRemote(cls, kind) {
	if (!cls?.prototype || patchedStepClasses.has(cls))
		return;
	const originalStart = cls.prototype.start;
	if (typeof originalStart !== "function")
		return;
	patchedStepClasses.set(cls, kind);
	if (kind === "light") {
		cls.prototype.start = function (fx) {
			if (!fx?._ttRemote)
				return originalStart.apply(this, arguments);
			// Keep the world light, suppress its global climate mod.
			const darkness = this.darkness, grayness = this.grayness;
			this.darkness = 0;
			this.grayness = 0;
			try {
				return originalStart.apply(this, arguments);
			}
			finally {
				this.darkness = darkness;
				this.grayness = grayness;
			}
		};
	}
	else {
		cls.prototype.start = function (fx) {
			if (fx?._ttRemote)
				return undefined;
			return originalStart.apply(this, arguments);
		};
	}
}

// Effect definitions are shared/cached, so scan each one at most once. Our step
// instances keep real class names, so we can grab the classes to patch without
// relying on FX_STEPS being exposed.
const scannedFxEffects = new WeakSet();
function installScreenStepSuppression(effect) {
	if (!effect?.steps || scannedFxEffects.has(effect))
		return;
	scannedFxEffects.add(effect);
	for (const step of effect.steps) {
		const cls = step?.constructor;
		if (!cls)
			continue;
		if (cls.name === LIGHT_FX_STEP_NAME)
			patchStepClassForRemote(cls, "light");
		else if (isScreenGlobalStep(step))
			patchStepClassForRemote(cls, "skip");
	}
}

// --- Locally-only effects ----------------------------------------------------
// Player-attached effects that are purely local feedback and must never be sent to
// peers. The in-game A/B loadout quick-switch is the canonical case: its light and
// particles, and the "loadout-switch-01" sound baked into the effect, belong only to
// the player doing the switch. (The menu loadout sound is on the UI bus and is
// already excluded.)
//
// The defeat "preDeath" blink (a red multiply fade + looping red particles) is spawned
// on death with an infinite duration (combatant-cmp.js:977 onDeathHit -> :985-986 start(-1)). On
// respawn the game tears it down without calling FxEntity.stop(), so the peer's synced
// copy is never told to stop and flashes red forever. It is local death feedback, so
// don't sync it at all. Key format is the effect's cacheKey: "FX:<sheet>#<name>".
const LOCAL_ONLY_FX = new Set([
	"FX:player.actions#changeLoadout",
	"FX:combat.defeat#preDeath",
]);
function isLocalOnlyEffect(effect) {
	return !!effect && LOCAL_ONLY_FX.has(effect.cacheKey);
}

// --- Rogue seed / variant sync ----------------------------------------------
// Patch RogueManager.startRun so a run started without an explicit seed adopts an
// in-progress peer's seed, keeping floor layouts identical between players.
// (getRogueInfo/getPeerRogueSeed and the peerRogue map live in ./session.js.)
let rogueSeedHookInstalled = false;
export function installRogueSeedHook() {
	if (rogueSeedHookInstalled)
		return;
	const g = terra.export.g_rogue;
	if (!g || typeof g.startRun !== "function")
		return;
	rogueSeedHookInstalled = true;

	const originalStartRun = g.startRun;
	g.startRun = function (seed) {
		// The game treats 0/null as "random"; prefer a running peer's seed instead.
		const effective = seed || getPeerRogueSeed() || null;
		return originalStartRun.call(this, effective);
	};
}

// --- Sound bus policy --------------------------------------------------------
function registerSound(sound) {
	if (sound?.path)
		soundRegistry.set(sound.path, sound);
	return sound;
}

// Only world/gameplay sounds sync; Menu/UI, music and ambience are single-client.
function isSyncableBus(type) {
	const bus = type?.bus;
	return !bus || (bus !== "UI" && bus !== "MUSIC" && bus !== "AMBIENCE");
}

// --- Projectile sync ---------------------------------------------------
// Ranged projectiles are real `Projectile` entities created at one choke point
// (ProxyDef.spawn). Peers mirror them as "visual" copies owned by the sending
// player's ghost actor -- or, since Phase 6, by the local copy of the enemy that fired them.
// A mirror carries no damage (see the HitForce guard below) with ONE exception: an ENEMY's own
// shot is replayed so that it lands on whoever it reaches, which is the victim-side model -- the
// client that receives the hit decides it, so a mirrored enemy shot is allowed through the
// engine's own hit path and damages the local player it collides with (`__ttVictimMirror`).
// Because that one is a real attack, it is also CONSUMED like one: it stops on the body it reaches
// even when that body is another player's ghost -- the one body the engine itself refuses to stop
// it on (see the checkHit note in the projectile hooks).

// Resolve a proxy def by name. An entity that fired the shot is asked FIRST when one is given: an
// enemy's own proxies live on its enemy sheet (enemy-type.js:83-85 builds `EnemySheet.proxies`,
// which enemy-cmp.js:264 hands to its combatant's damager), and that is the very list the firing
// step resolved the def from on the owner's side (ProxyKey.getProxyDef(attacker.damager.proxies),
// combat-act-steps.js:481/:521) -- so the peer resolves the same def for the same name. Then the
// local player's config proxies (weapon proxies are local names like "arrow"), then global
// actor-globals proxies.
function resolveProxyDef(name, ent) {
	if (!name)
		return null;
	const own = ent?.combatant?.attacker?.damager?.proxies?.[name]
		?? ent?.enemy?.enemyType?.sheet?.proxies?.[name];
	if (own)
		return own;
	const local = terra.export.g_player?.config?.proxies?.[name];
	if (local)
		return local;
	return terra.export.g_actorGlobals?.getProxy?.(name) ?? null;
}

// A cosmetic projectile needs an owner damager whose .ent is the receiving entity and whose
// .stats is non-null (Projectile.init reads owner.stats.getCombatant()). Create one
// lazily per ghost; no AttackerCmp, so the ghost is not registered as an attacker.
function getVisualDamager(actor) {
	if (!actor)
		return null;
	// getVisualDamager is also reachable for an entity the mod hangs nothing on yet (see
	// getMirrorDamager below), and the holder is where the lazily-created damager is cached.
	actor.terraTogether ??= {};
	if (actor.terraTogether.ttDamager)
		return actor.terraTogether.ttDamager;
	const DamagerCmp = terra.export.DamagerCmp;
	const CombatStats = terra.export.CombatStats;
	if (!DamagerCmp || !CombatStats)
		return null;
	const damager = actor.addCmp(DamagerCmp);
	// Party is cosmetic here (damage is disabled); 1 = COMBATANT_PARTY.PLAYER.
	const party = terra.export.COMBATANT_PARTY?.PLAYER ?? 1;
	damager.setStatProxies(CombatStats.getAttackStats(1, party), {});
	actor.terraTogether.ttDamager = damager;
	return damager;
}

// The damager a MIRRORED projectile is spawned from, for the entity it is mirrored under.
//   - A player ghost has no damager of its own: the mod adds one (getVisualDamager), provisioned
//     with a stand-in stat block, and marks it with the sender's element (Projectile.init copies
//     `owner.variant`, proxy-projectile.js:568-569).
//   - An enemy HAS one -- `AttackerCmp.damager` (attacker-cmp.js:146), provisioned from its own
//     sheet (enemy-cmp.js:264 -> combatant-cmp.js:1048-1051) and the very damager its real attacks
//     fire from. It is already a valid parent (stats, proxies, party), so it is used AS IT IS:
//     addCmp would hand back exactly that instance and re-provisioning it would overwrite a live
//     enemy's real attack stats and proxy list with a level-1 player stand-in. Its `variant` is
//     left alone too -- only player-cmp ever writes it (player-cmp.js:1629/:2838/:2852), so an
//     enemy's is already the 0 the mirror would write.
function getMirrorDamager(actor) {
	if (!actor)
		return null;
	if (actor.enemy)
		return actor.enemy?.combatant?.attacker?.damager ?? null;
	return getVisualDamager(actor);
}

// The players this client is NOT: ./actors.js's ghost actors, the only bodies a mirrored enemy
// shot can be consumed by on this side (see the mirrored-projectile consumption note in the
// projectile hooks). Membership of ./session.js's live map is the one authoritative test -- the
// same map ./enemies.js reads for peer positions and ./actors.js fills -- so nothing has to be
// marked on the entity itself.
function isPeerPlayerActor(ent) {
	if (!ent)
		return false;
	for (const actor of playerActors.values()) {
		if (actor === ent)
			return true;
	}
	return false;
}

// Which PLAYER an entity is, as the id the wire uses, or null for anything that is not a player.
// It is the inverse of the lookup the aim replication below needs on the receiving side, and it is
// the only question that side has to answer -- "is this mine, or is it that peer's?" -- so both
// halves are kept together and deliberately small. The local player is tested first because it is
// not in the peer map (./session.js fills `playerActors` with peers only).
function playerSyncIdOf(ent) {
	if (!ent)
		return null;
	if (ent === terra.export.g_player?.entity)
		return getLocalId();
	for (const [id, actor] of playerActors) {
		if (actor === ent)
			return id;
	}
	return null;
}

// The player a synced id names, on THIS client, or null while we cannot see them (no such peer, or
// its actor is not in the world yet). Mirrors playerSyncIdOf: a peer's own id resolves to our own
// player entity, because a synced target id is the owner's idea of a player and the only player a
// mirrored attack can possibly be aimed at here is the one we are.
function playerEntityOfId(id) {
	if (id == null)
		return null;
	const local = getLocalId();
	if (local !== null && String(id) === String(local))
		return terra.export.g_player?.entity ?? null;
	return playerActors.get(id) ?? playerActors.get(Number(id)) ?? null;
}

// Cosmetic copies must not take the local player's ranged-weapon extension
// (Projectile.init keys off the *local* player's weaponRanged + def.metaType).
// Spawn from a shallow clone with metaType forced to NONE; cache per def so the
// shared game def is never mutated.
const visualDefCache = new WeakMap();
function visualDef(def) {
	let clone = visualDefCache.get(def);
	if (clone)
		return clone;
	clone = Object.create(Object.getPrototypeOf(def));
	Object.assign(clone, def);
	clone.metaType = 0; // PROJ_META_TYPE.NONE
	visualDefCache.set(def, clone);
	return clone;
}

// Step types a mirrored (visual) proxy must never execute: proxy/enemy spawning
// (would duplicate or spawn real, damaging entities) and local-global effects
// (camera, slow-motion, player control, nav danger). Guarded by `__ttVisual`, so
// real actors that use the same steps are unaffected.
const VISUAL_BLOCKED_STEPS = [
	"SHOOT_PROXY", "SHOOT_PROXY_RANGE", "SPAWN_ENEMY", "SPAWN_ENEMY_RANGE",
	"CALL_PROXY_ACTION", "SET_ON_HIT_PROXY", "CLEAR_ON_HIT_PROXY",
	"SET_VAR_ENTITY_PROXY", "SET_VAR_NUMBER_PROXY_COUNT", "NOTIFY_PROXY_GROUP",
	"MODIFY_GENERIC_PROXY", "SET_PROXY_LIFE",
	"SET_CAMERA_TARGET", "RESET_CAMERA", "ADD_SLOW_MOTION", "CLEAR_SLOW_MOTION",
	"SET_PLAYER_BLOCK", "CLEAR_PLAYER_ARROW_CHARGE",
	"SET_DAMAGER_DMG_FACTOR", "MARK_NAV_DANGER",
];

// Spawn one mirrored projectile on a peer actor -- the local player's ghost, or the local copy of
// an enemy this client is puppeting (receiver side; see the ProxyDef.spawn hook for the sender
// side). Either way it is a VISUAL copy: `spawningVisualCopy` below makes the ProxyDef.spawn
// wrapper mark the proxy `__ttVisual`, which is what makes HitForce.isHitCompatible ignore every
// hit it could land, the blocked action steps no-op and its sub-proxies refuse to spawn.
//
// The ONE exception is an ENEMY's own proxy: it is the enemy's real attack, replayed on the client
// that can receive it, so it is marked a VICTIM mirror as well (`__ttVictimMirror`) and the HitForce
// guard lets its hit reach the engine. It still lands only on what the engine's own rules allow --
// the enemy-party filter keeps it off the enemy that fired it and off every other enemy, and a peer
// PLAYER's ghost is refused by TerraActor.onHitCheck (no combatant) -- so in practice it lands on
// this client's own player, at the position this client SEES the enemy and the projectile at. That
// is the whole fairness property of the model: the victim resolves the hit, no arbitration, no
// rewind, and it cannot be applied twice because no other client can damage this player.
export function spawnRemoteProjectile(actor, p) {
	const def = resolveProxyDef(p.name, actor);
	if (!def)
		return;
	const damager = getMirrorDamager(actor);
	if (!damager)
		return;

	// Element is the variant index (0 neutral, 1 aether, 2 ignis, 3 cryo). init copies it from the
	// owner damager, so set it right before spawning -- on the ghost's own damager only, which is
	// the mirror-owned instance the sender's element belongs on (see getMirrorDamager).
	if (!actor.enemy)
		damager.variant = p.variant ?? 0;

	const pos = new Vec3(p.pos[0], p.pos[1], p.pos[2]);
	const dir = new Vec3(p.dir[0], p.dir[1], p.dir[2] ?? 0);

	// Mark the spawn as a mirror for the ProxyDef.spawn wrapper. Proxies are pooled,
	// so the flag is (re)assigned on every spawn rather than trusting the instance. An enemy's
	// mirror is additionally a VICTIM mirror: the one kind whose hit is allowed to land (see the
	// HitForce guard and the note on spawnRemoteProjectile).
	spawningVisualCopy = true;
	spawningVictimMirror = !!actor.enemy;
	let proxy = null;
	try {
		proxy = visualDef(def).spawn(pos, dir, damager, p.group ?? null);
	}
	finally {
		spawningVisualCopy = false;
		spawningVictimMirror = false;
	}

	applyRemoteAim(proxy, p);
}

// Point a mirrored shot where its owner was pointing it, so it curves the same way on this client
// (see the recordAim note on the capture side for what carries this and why the engine needs it).
//
// The id the owner sent is a PLAYER, resolved here to the entity this client has for that player --
// our own player when the id is ours (the usual case: only the victim's client has a reason to be
// shown the shot, and both sides aim at whoever the enemy is attacking), a peer's ghost otherwise.
// A peer's ghost works because the aim is only geometry: `initAim`/`adjustToTarget` read a position
// and steer a direction, so a hit still resolves on this client's own world through the engine's
// own hit path, exactly as it does for an unaimed mirror.
//
// Nothing is set when the owner did not state an aim, or when that player is not in this world yet:
// the mirror then keeps the straight flight it had before this, which is the correct fallback (a
// shot with no target does not curve on the owner's side either). Fail-soft throughout -- a pooled
// proxy, a missing export or a target entity without a core all end in "no aim applied".
function applyRemoteAim(proxy, p) {
	if (!proxy || p?.target == null || typeof proxy.setTarget !== "function")
		return;
	const targetEnt = playerEntityOfId(p.target);
	if (!targetEnt?.core)
		return;
	const TargetResult = terra.export.TargetResult ?? terra.file.target?.TargetResult;
	const ENT_ALIGN = terra.export.ENT_ALIGN;
	if (!TargetResult)
		return;
	const res = new TargetResult();
	res.setEntity(targetEnt, ENT_ALIGN?.CENTER ?? 0);
	if (res.isInvalid?.())
		return;
	const aim = Number.isFinite(p.aim) ? p.aim : 0;
	try { proxy.setTarget(res, aim); }
	catch (e) { /* a build where this proxy cannot be aimed: leave it flying straight */ }
}

// --- Local capture hooks -----------------------------------------------------
// Hook the local player's actorFx so every non-POST_MOVE fx it emits is queued for the
// peers. Idempotent per actor via the `_injected` flag; called on every map start.
export function installActorFxInjection() {
	let player = terra.export.g_player.entity;
	if (player?.actorExt?.actorFx) {
		let actorFx = player.actorExt.actorFx;

		if (!actorFx._injected) {
			let originalOnPlayerFx = actorFx.onActorFx;
			player.actorExt.actorFx.onActorFx = function (...args) {
				const result = originalOnPlayerFx.apply(player.actorExt.actorFx, args);
				const FX_TYPE = terra.export.ACTOR_FX_TYPE;
				// POST_MOVE is not a one-shot spawn: it drives the local run/move state machine
				// (actor-fx.js:62-95), which the peer rebuilds from the owner's synced run glow.
				if (args[1] != FX_TYPE.POST_MOVE)
					queues.actorFx.push({ type: args[1], vary: args[2] });
				return result;
			};
			actorFx._injected = true;
		}
	}
}

// Install the outbound capture hooks. The windbox hook is (re)wrapped on every call; the heavier
// Fx/Sound/Projectile patches install once per session (module-level flags).
export function installFxSyncHooks() {
	// Sync windbox knockback the player receives.
	let originalStart = terraTogether.steps.SPAWN_WINDBOX.prototype.start;
	terraTogether.steps.SPAWN_WINDBOX.prototype.start = function (...args) {
		let context = args[0];
		if (context && context?.entity == terra.export.g_player.entity) {
			let dts = this.displacementTypeSettings;
			let windbox = {
				displacementTypeSettings: {
					directionAxes: dts.directionAxes.clone().v,
					directionOrigin: dts.directionOrigin.clone().v,
					gradient: dts.gradient,
					gradientAxes: dts.gradientAxes.clone().v,
					gradientOrigin: dts.gradientOrigin.clone().v,
					perpendicular: dts.perpendicular
				},
				displacementSettings: structuredClone({ ...this.displacementSettings }),
				handleTiming: structuredClone({ ...this.handleTiming }),
				followTarget: this.followTarget,
				alignment: this.target.alignment
			};
			if (hasClient())
				queues.windboxes.push(windbox);
		}
		return originalStart.apply(this, args);
	};

	if (!syncHooksInstalled) {
		syncHooksInstalled = true;

		// --- Effects ------------------------------------------------------
		// Spawn: tag player-owned fx with a sync id and send its descriptor.
		let originalFxStart = terra.export.FxEntity.prototype.start;
		terra.export.FxEntity.prototype.start = function (...args) {
			this._ttFxStopSent = false;

			// Consume the peer-replay marker set by movePlayerActor just before
			// start(). Resetting here (rather than trusting the pooled instance) keeps
			// a recycled entity from suppressing a *local* effect's screen steps.
			this._ttRemote = this._ttRemotePending === true;
			this._ttRemotePending = false;

			// Make sure this effect's screen-global steps no-op on peer replays.
			installScreenStepSuppression(this.effect);

			// Player-owned = attached to the player or spawned by a player step
			// (SPAWN_FX), so ground impacts count too.
			//
			// Deliberately test the raw attachment entity, NOT getFollowEntity():
			// that accessor resolves FOLLOWING/FOLLOW_TARGET alignments to the
			// attach-entity's *target*. Enemy aim/telegraph fx are attached to the
			// enemy but aligned onto the player, so getFollowEntity() reports the
			// player and syncs a stray targeting circle onto the peer.
			const owner = this.stepContext?.entity;
			const attachedEnt = this.target?.entity ?? null;
			const onPlayer = isPlayerEntity(attachedEnt);

			// ...or owned by an ENEMY this client simulates (enemy-sync Phase 6): the enemy fx is
			// attached to, or was spawned by, an enemy the server assigned to this client. The
			// other client holds that enemy as a puppet, so it renders this fx on its own copy
			// instead of emitting one of its own (a puppet's AI -- and so its action fx -- is
			// suppressed, ./enemy-puppet.js). An fx from an enemy this client does NOT own is
			// never attributed: the owner sends those.
			const enemyId = onPlayer || isPlayerEntity(owner) ? null : (ownedEnemyId(attachedEnt) ?? ownedEnemyId(owner));

			// Screen-global effects are still synced for their world visuals, but the
			// sender's own vignette/blur/shake steps are dropped on the peer above.
			// Local-only feedback (e.g. the A/B loadout quick-switch, and the defeat blink every
			// client plays for itself) is never synced -- including on an enemy.
			if ((onPlayer || isPlayerEntity(owner) || enemyId) && !isLocalOnlyEffect(this.effect)) {
				let id = (this._ttFxId = ++fxSyncId);
				this._ttFxEnemy = enemyId;
				let fx = {
					id,
					effect: this.effect?.cacheKey,
					// -1 means "loop forever" and must reach the peer unchanged; infinite
					// effects are torn down via the stop() hook below.
					duration: args[0] ?? 0,
					delay: this.delay,
					group: this.attachGroup,
					looped: this.looped,
					// Raw numeric values: alignments can carry a bit-encoded figure index.
					part: this.part,
					alignment: this.target.alignment
				};
				// Preserve the target offset/relative flag too.
				if (this.target?.posOrOffset && !this.target.posOrOffset.isZero())
					fx.offset = this.target.posOrOffset.v;
				if (terra.export.TARGET_RES_TYPE && this.target?.type == terra.export.TARGET_RES_TYPE.ENT_REL_OFFSET)
					fx.rel = true;
				// Unattached effects (e.g. ground impacts) keep their world position at spawn. An
				// enemy-owned fx attached to its enemy is NOT one of those: it travels with that
				// enemy, so the peer re-attaches it to the copy it holds (as the player case above
				// re-attaches to the ghost) rather than pinning it to a world position -- which is
				// what makes a telegraph follow the enemy and a status fx sit on it.
				if (!onPlayer && !enemyId) {
					const v = new Vec3();
					if (this.target?.get(v))
						fx.pos = v.v;
					else if (this.core?.pos)
						fx.pos = this.core.pos.clone().v;
				}
				if (enemyId) {
					fx.enemy = enemyId;
					// The aim/telegraph fx (AimFx.showFx, enemy-aim-fx.js:57-71) also points its
					// SECONDARY target at the shooter (`selfPos` -> setTarget2Entity(entity, ...),
					// :64/:66), which is the enemy itself and what the line/laser/homing fx draw
					// towards (fx-line.js:69, fx-laser.js:110, fx-homing.js:91). On the peer that
					// entity is the local copy of the enemy it holds, so mirroring the alignment and
					// offset reproduces the same geometry; without it a line fx falls back to a
					// default direction and the telegraph points nowhere. Only mirrored when target2
					// really follows the entity the fx is attached to, and only for an enemy fx --
					// the verified player path is left byte-identical.
					const t2ent = typeof this.target2?.getFollowEntity === "function" ? this.target2.getFollowEntity() : null;
					if (t2ent && t2ent === attachedEnt) {
						fx.t2align = this.target2.alignment;
						if (this.target2.posOrOffset && !this.target2.posOrOffset.isZero())
							fx.t2off = this.target2.posOrOffset.v;
						if (terra.export.TARGET_RES_TYPE && this.target2.type == terra.export.TARGET_RES_TYPE.ENT_REL_OFFSET)
							fx.t2rel = true;
					}
					// ...and the entity the fx's OWN alignment resolves through, when that entity is a
					// player: an aim/telegraph fx is authored as "on the shooter, aimed at whoever the
					// shooter is following" (AIM_FX_POS.TARGETING shares the value of ENT_ALIGN.FOLLOWING --
					// enemy-aim-fx.js:21-26 vs entity-types.js:13-15 -- and EntityTools.getAlignedPos routes
					// that alignment through `entity.core.following.getTargetingPos`,
					// engine/entity/entity.js:441-447). On this client the enemy follows the player it is
					// attacking; on the peer the enemy is a driven puppet, whose following is whatever the
					// drive left behind -- so the same fx, replayed with the same alignment, is placed from
					// the wrong reference and lands nowhere the fight is. The old enemy-sync branch carried
					// exactly this and set it at the far end (setFollowTarget in its `enemy_aim` handler);
					// the id is what the peer needs to reproduce it, and it is one string.
					//
					// Read with getFollowEntity when the target is a TargetResult (the AimFx path) and with
					// getEntity when it is a Target (the SPAWN_FX-step path); only a non-null answer that is
					// NOT the enemy itself may travel, so every self-relative fx keeps its geometry.
					const followEnt = typeof this.target?.getFollowEntity === "function"
						? this.target.getFollowEntity()
						: (typeof this.target?.getEntity === "function" ? this.target.getEntity() : null);
					if (followEnt && followEnt !== attachedEnt) {
						const followId = playerSyncIdOf(followEnt);
						if (followId !== null)
							fx.follow = followId;
					}
				}
				// Infinite fx (e.g. status conditions use start(-1)) never end on their own, so a
				// peer only ever learns of them from a spawn. Remember them to re-send every frame
				// until they stop, so peers entering our room can rebuild the ones they missed --
				// on the enemy's own registry for an enemy-owned one, so the lasting-fx snapshot
				// travels in the message that enemy's state travels in.
				if (fx.duration < 0) {
					if (enemyId)
						activeEnemyFx.set(id, { fx: this, desc: fx });
					else
						activePersistentFx.set(id, { fx: this, desc: fx });
				}
				if (hasClient()) {
					if (enemyId)
						enemyQueues.globalFx.push(fx);
					else
						queues.globalFx.push(fx);
				}
			}
			else {
				this._ttFxId = 0;
				this._ttFxEnemy = null;
			}
			return originalFxStart.apply(this, args);
		};

		// Enter/exit appear/disappear fx fade the target's figure. Each client plays
		// its own, so they must NOT sync (a replayed fade can leave the peer invisible).
		let originalInitHideShowChange = terra.export.FxEntity.prototype.initHideShowChange;
		terra.export.FxEntity.prototype.initHideShowChange = function (...args) {
			if (this._ttFxId) {
				const list = this._ttFxEnemy ? enemyQueues.globalFx : queues.globalFx;
				for (let i = list.length - 1; i >= 0; i--) {
					if (list[i].id === this._ttFxId) {
						list.splice(i, 1);
						break;
					}
				}
				this._ttFxId = 0;
				this._ttFxEnemy = null;
			}
			return originalInitHideShowChange.apply(this, args);
		};

		// Despawn: stop() is the real teardown path for looped/infinite fx, so
		// hooking it removes them on peers too.
		let originalFxStop = terra.export.FxEntity.prototype.stop;
		terra.export.FxEntity.prototype.stop = function (...args) {
			if (this._ttFxId) {
				if (this._ttFxEnemy)
					activeEnemyFx.delete(this._ttFxId);
				else
					activePersistentFx.delete(this._ttFxId);
			}
			// Report each spawn's stop at most once: clearEntity() calls stop() again on every
			// entry it removes (effect-entity.js clearList), which is not a second stop.
			if (this._ttFxId && !this._ttFxStopSent) {
				this._ttFxStopSent = true;
				if (hasClient()) {
					// An enemy-owned fx stops in the batch that enemy's state travels in (see
					// ./session.js enemyQueues), carrying the id it must be routed back on.
					if (this._ttFxEnemy)
						enemyQueues.fxStops.push({ id: this._ttFxId, delay: args[0] ?? 0, softStop: args[1] ?? false, enemy: this._ttFxEnemy });
					else
						queues.fxStops.push({ id: this._ttFxId, delay: args[0] ?? 0, softStop: args[1] ?? false });
				}
			}
			return originalFxStop.apply(this, args);
		};

		// Effect sounds are already replayed by the peer's effect, so don't sync
		// them here (they'd double).
		let originalFxDeferredUpdate = terra.export.FxEntity.prototype.deferredUpdate;
		terra.export.FxEntity.prototype.deferredUpdate = function (...args) {
			soundSyncSuppress.depth++;
			try { return originalFxDeferredUpdate.apply(this, args); }
			finally { soundSyncSuppress.depth--; }
		};

		// --- Sounds -------------------------------------------------------
		const Sound = terra.file.sound?.Sound;
		if (Sound?.prototype?.play) {
			// Index every Sound resource as it loads.
			let originalSoundFetch = Sound.fetch;
			Sound.fetch = function (...args) {
				return registerSound(originalSoundFetch.apply(this, args));
			};

			let originalSoundPlay = Sound.prototype.play;
			Sound.prototype.play = function (...args) {
				const playback = originalSoundPlay.apply(this, args);
				registerSound(this);
				// Playback is bound to targetRes.entity (PLAY_SOUND defaults to the
				// player); fall back to the ambient context for global/offset sounds. Both are
				// the ACTING entity while a step runs (an enemy's own action pushes its core as
				// the context entity, enemy-cmp.js initInternal), so an enemy's sounds are
				// attributed the same way a player's are -- and only for an enemy THIS client
				// owns (see ownedEnemyId).
				const ctxEnt = terra.export.g_gState?.contextEntity?.ent;
				if (playback) {
					const enemyId = ownedEnemyId(args[0]?.targetRes?.entity) ?? ownedEnemyId(ctxEnt);
					const tied = hasClient() && !soundSyncSuppress.depth && this.path &&
						isSyncableBus(this.settings?.type) &&
						(enemyId !== null || isPlayerTied(args[0]?.targetRes?.entity) || isPlayerTied(ctxEnt));
					if (tied) {
						const id = ++soundSyncId;
						playback._ttSoundId = id;
						// `enemy` marks the entry as an enemy's: it travels on the enemy frame and
						// its volume is not synced (./snapshot.js's volume pass skips it; see the
						// note in ./enemies.js on what an enemy sound does and does not carry).
						activeSyncedSounds.set(id, { playback, lastVol: -1, enemy: enemyId });
						const entry = { id, key: this.path, vol: args[1] ?? 1, speed: args[2] ?? 1 };
						if (enemyId) {
							entry.enemy = enemyId;
							enemyQueues.sounds.push(entry);
						}
						else {
							queues.sounds.push(entry);
						}
					}
					else {
						playback._ttSoundId = 0;
					}
				}
				return playback;
			};
		}
		else {
			console.warn("[TT Client] Sound export not found; sound sync disabled.");
		}

		// Audio events (multi-track) bypass Sound.play(), so hook them directly.
		const AudioEvent = terra.file.audioEvent?.AudioEvent;
		if (AudioEvent?.prototype?.playInstance) {
			let originalEventPlay = AudioEvent.prototype.playInstance;
			AudioEvent.prototype.playInstance = function (...args) {
				const ctxEnt = terra.export.g_gState?.contextEntity?.ent;
				const instance = originalEventPlay.apply(this, args);
				if (instance?.playback) {
					const enemyId = ownedEnemyId(args[0]?.targetRes?.entity) ?? ownedEnemyId(ctxEnt);
					const tied = hasClient() && !soundSyncSuppress.depth && this.cacheKey &&
						isSyncableBus(this.type) &&
						(enemyId !== null || isPlayerTied(args[0]?.targetRes?.entity) || isPlayerTied(ctxEnt));
					if (tied) {
						const id = ++soundSyncId;
						instance.playback._ttSoundId = id;
						activeSyncedSounds.set(id, { playback: instance.playback, lastVol: -1, enemy: enemyId });
						const entry = { id, event: this.cacheKey };
						if (enemyId) {
							entry.enemy = enemyId;
							enemyQueues.sounds.push(entry);
						}
						else {
							queues.sounds.push(entry);
						}
					}
					else {
						instance.playback._ttSoundId = 0;
					}
				}
				return instance;
			};
		}

		// A synced sound being stopped must stop on peers.
		const Playback = terra.file.playback?.Playback;
		if (Playback?.prototype?.stop) {
			let originalPlaybackStop = Playback.prototype.stop;
			Playback.prototype.stop = function (...args) {
				if (this._ttSoundId) {
					if (hasClient()) {
						// Routed by what started it: an enemy's sound stops in the enemy frame,
						// carrying the enemy it must be stopped on (its entry in the registry is
						// the only record of that, so read it before dropping the entry).
						const entry = activeSyncedSounds.get(this._ttSoundId);
						if (entry?.enemy)
							enemyQueues.soundStops.push({ id: this._ttSoundId, enemy: entry.enemy });
						else
							queues.soundStops.push({ id: this._ttSoundId });
					}
					activeSyncedSounds.delete(this._ttSoundId);
					this._ttSoundId = 0;
				}
				return originalPlaybackStop.apply(this, args);
			};
		}

		// Sources that must NOT be synced through this path.
		const suppress = (proto, method) => {
			if (!proto || !proto[method] || proto[method]._ttSuppressed)
				return;
			const original = proto[method];
			const wrapped = function (...args) {
				soundSyncSuppress.depth++;
				try { return original.apply(this, args); }
				finally { soundSyncSuppress.depth--; }
			};
			wrapped._ttSuppressed = true;
			proto[method] = wrapped;
		};

		// movement sounds are already replayed through actorFx
		for (const m of ["playActorFxSound", "playAnimSound", "playMoveSound", "playMoveLoop"])
			suppress(terra.file.actorSound?.ActorSound?.prototype, m);
		// combat hit sounds are out of scope until enemies are synced
		for (const name of ["HitSoundCollection", "HitSoundsBase", "HitSoundsWeapon", "HitSoundsActor"])
			suppress(terra.file.hitSounds?.[name]?.prototype, "play");
		// weapon / loadout swap sounds are local to the switching player only
		for (const m of ["switchLoadout", "setLoadout", "equipWeapon"])
			suppress(terra.file.playerCombat?.PlayerCombat?.prototype, m);

		// --- Projectiles -----------------------------------------------
		if (!projectileHooksInstalled) {
			projectileHooksInstalled = true;

			const Projectile = terra.export.Projectile;
			const ProxyDef = terra.export.ProxyDef;

			if (Projectile?.prototype && ProxyDef?.prototype) {
				const GenericProxy = terra.export.GenericProxy;
				const HitForce = terra.export.HitForce;
				const ACTION_STEP = terra.export.ACTION_STEP ?? terra.file.stepBase?.ACTION_STEP;

				// Universal no-damage guard: a hit-force owned by a mirrored proxy can
				// never land a hit, whichever act produced it (projectile hits or HIT_*
				// steps). Movement, wall/ground collide and despawn are untouched.
				//
				// The one exception is a VICTIM mirror: a proxy mirrored from an ENEMY this client
				// is holding (spawnRemoteProjectile with `actor.enemy`, marked `__ttVictimMirror` at
				// spawn). That one IS the enemy's own attack -- the enemy is simulated by the other
				// client, which sends the shot instead of resolving it here -- so its hit is left to
				// the engine's own path, where the party filter (HitForce.getParty, the enemy's own
				// party) and the receiver's own onHitCheck leave it with exactly one possible victim:
				// the local player it reaches, resolved where THIS client sees the shot. A mirror of
				// a peer PLAYER's shot is not marked, so player-fired mirrors behave exactly as they
				// did before.
				if (HitForce?.prototype?.isHitCompatible) {
					let originalIsHitCompatible = HitForce.prototype.isHitCompatible;
					HitForce.prototype.isHitCompatible = function (...args) {
						const mirrored = this.damager?.ent;
						if (mirrored?.__ttVisual && !mirrored.__ttVictimMirror)
							return 0; // HIT_RESULT.IGNORE
						return originalIsHitCompatible.apply(this, args);
					};
				}

				// A mirrored proxy must not re-run steps that spawn proxies/enemies or
				// hijack the local camera/time/player (real actors are unaffected).
				if (ACTION_STEP) {
					for (const key of VISUAL_BLOCKED_STEPS) {
						const StepClass = ACTION_STEP[key];
						if (!StepClass?.prototype?.start || StepClass.prototype.start._ttVisualGuard)
							continue;
						let originalStart = StepClass.prototype.start;
						const wrapped = function (...args) {
							if (args[0]?.entity?.__ttVisual)
								return undefined;
							return originalStart.apply(this, args);
						};
						wrapped._ttVisualGuard = true;
						StepClass.prototype.start = wrapped;
					}
				}

				// A mirrored copy must never spawn (possibly damaging) sub-proxies, so
				// block the single spawn path for its sub-proxies too -- with ONE exception, a victim
				// mirror.
				//
				// A victim mirror IS an enemy's real attack replayed on the client that can receive it
				// (see spawnRemoteProjectile), and a whole family of enemy attacks carries its payload as
				// a sub-proxy: the bomb a mortar drops, the ground explosion a slime leaves, the thunder
				// orb a bird calls down. The parent travels (it is a proxy like any other), so the shot
				// flies and the impact lands -- but the sub-proxy never existed here, and with it went
				// everything the sub-proxy IS: its telegraph (shroomBomb's first steps are FORCE_TO_GROUND
				// then START_AIM_FX), its spawn/aura/boom fx, its own fxDie. That is the visible half of
				// the attack going missing while its damage still arrives.
				//
				// So a victim mirror MAY spawn its sub-proxy, and it is spawned as a VISUAL copy: the flag
				// is re-set around the call, which is what the ProxyDef.spawn wrapper reads (it assigns
				// `__ttVisual` unconditionally, so a spawn inside a mirror stays a mirror) and what keeps
				// the sub-proxy inert -- its hits are refused by the HitForce guard and its own
				// spawn/camera/nav steps no-op (see VISUAL_BLOCKED_STEPS), while every purely visual step
				// it has runs. `spawningVictimMirror` is deliberately NOT set: the explosion is not being
				// re-derived here, so it must not damage. A sub-proxy of a sub-proxy is refused as before
				// (the child is `__ttVisual` and not itself a victim mirror), so nothing cascades.
				let originalSpawnSubProxy = Projectile.prototype.spawnSubProxy;
				Projectile.prototype.spawnSubProxy = function (...args) {
					if (this.__ttVisual && !this.__ttVictimMirror)
						return undefined;
					if (!this.__ttVictimMirror)
						return originalSpawnSubProxy.apply(this, args);
					spawningVisualCopy = true;
					try { return originalSpawnSubProxy.apply(this, args); }
					finally { spawningVisualCopy = false; }
				};

				// A VICTIM mirror is consumed by the body it reaches, exactly as the shot it mirrors is
				// consumed on the owner's side -- including when that body is a PEER's, which the engine
				// will not consume on its own.
				//
				// On the client that simulates the enemy, an enemy shot flies into the player it was
				// aimed at and stops there: `checkHit` resolves HIT against that combatant and takes the
				// "it was hit, stick" branch (`Projectile.onStuck`, proxy-projectile.js:1050-1055). On the
				// other client the same shot is a mirror and the player it hit is a GHOST: a TerraActor
				// with no CombatantCmp, whose `onHitCheck` refuses every hit it could take
				// (terra-actor-entity.js:240-241). The result is IGNORE, `checkHit` leaves through
				// :1025-1028 before that branch, and the shot visibly flies THROUGH that player's body and
				// on past them instead of stopping where the owner's stopped -- the one thing an observer
				// sees the two clients disagree about.
				//
				// Damage is deliberately NOT this hook's business: the victim's own client already resolved
				// the hit, a ghost must never become damageable (it exists to be seen, not fought), and only
				// the local player can be damaged here. This re-creates the STOP alone -- at the engine's own
				// hit point, through the engine's own call (`onStuck`, which is also what plays the shot's
				// hit fx) -- and only for a mirror of an ENEMY's shot: a mirrored PLAYER shot keeps passing
				// through a ghost, exactly as a friendly shot always has.
				const PROJECTILE_STATE_FLYING = 0; // proxy-projectile.js:490 -- the enum is module-local
				let originalCheckHit = Projectile.prototype.checkHit;
				Projectile.prototype.checkHit = function (...args) {
					const result = originalCheckHit.apply(this, args);
					// Still FLYING after the engine looked at this coll means it did not consume the shot
					// here, which is the ghost case above: a real player hit would have left it STUCK.
					if (this.__ttVictimMirror && this.state === PROJECTILE_STATE_FLYING
						&& isPeerPlayerActor(args[0]?.core?.ent))
						this.onStuck(this.hitForce.hitPoint);
					return result;
				};

				// How a shot is AIMED, which the spawn above cannot see: every ranged attack points its
				// proxy at something a moment after spawning it (ShootAct.spawn, acts/shoot-act.js:123-150
				// -- `proxy.setFollowing(actor.following, aimType, ...)` when the shooter follows
				// something, or `proxy.setTarget(res.setEntity(actor.getTarget(), CENTER), aimType)`),
				// and that call is what makes the shot CURVE: initAim turns the aimType plus the target
				// into `following.adjustSpeed`/`refCoords` (proxy-projectile.js:706-770) and `adjustToTarget`
				// steers the projectile with it every frame (:771-870, driven from update() at :1496-1505).
				// A mirror spawned without any of this flies the straight line it was launched on: it
				// shows the shot at the right place but with the wrong flight, and the flyUp aim fx a
				// mortar shows is placed from that same reference.
				//
				// So the two calls are wrapped to write what they were told into the entry the spawn above
				// queued, and the target travels as the id of the PLAYER it names -- the one thing the
				// receiver can resolve, since it has a different entity for that player than we do.
				// Everything the peer cannot use is left out: an aim the shooter did not state stays
				// unset, and a target that is not a player (a destructible, another enemy) does not
				// travel at all, which is a known limit rather than a wrong curve.
				const recordAim = (proxy, targetRes, aimType) => {
					const entry = proxy?.__ttProjEntry;
					if (!entry)
						return;
					if (Number.isFinite(aimType))
						entry.aim = aimType;
					const targetId = playerSyncIdOf(targetRes?.entity);
					if (targetId !== null)
						entry.target = targetId;
				};
				let originalSetTarget = Projectile.prototype.setTarget;
				Projectile.prototype.setTarget = function (targetRes, aimType, coll) {
					recordAim(this, targetRes, aimType);
					return originalSetTarget.apply(this, arguments);
				};
				let originalSetFollowing = Projectile.prototype.setFollowing;
				Projectile.prototype.setFollowing = function (follow, aimType, coll) {
					recordAim(this, follow?.target ?? null, aimType);
					return originalSetFollowing.apply(this, arguments);
				};

				// One choke point for every proxy (weapon shots, HIT proxies, sub-proxies).
				let originalSpawn = ProxyDef.prototype.spawn;
				ProxyDef.prototype.spawn = function (pos, dir, damager, group) {
					const proxy = originalSpawn.apply(this, arguments);

					// Proxies are pooled and reused, so a stale __ttVisual from a previous
					// life must never leak. A spawn is a "mirror" only when the receiver
					// initiated it; assign unconditionally to clear recycled state.
					const isMirror = spawningVisualCopy;
					proxy.__ttVisual = isMirror;
					// ...and the victim-mirror mark, cleared on the same rule: only a mirror
					// spawned for an ENEMY (see spawnRemoteProjectile) may land its hit.
					proxy.__ttVictimMirror = isMirror && spawningVictimMirror;

					// Ranged attacks spawn both Projectile and Generic proxies (e.g. the
					// crossbow's "shoot down" fires Generic arrowUp), so mirror both. Only from
					// the local player, or from an ENEMY this client owns and simulates (enemy-sync
					// Phase 6: its shots are as invisible on the peer as its fx were): peers'
					// copies are owned by ghosts and already marked visual, so they never echo
					// back, and an enemy this client merely puppets is not the one that fired.
					const mirrored = proxy instanceof Projectile
						|| (GenericProxy && proxy instanceof GenericProxy);
					if (hasClient() && mirrored && !isMirror) {
						const root = damager?.getRoot?.();
						const enemyId = ownedEnemyId(root);
						if (enemyId !== null || terra.export.g_player?.isPlayer?.(root)) {
							const entry = {
								id: ++projSyncId,
								name: this.name,
								pos: [pos.x, pos.y, pos.z],
								dir: [dir.x, dir.y, dir.z ?? 0],
								variant: damager?.variant ?? 0,
								group: group ?? null,
							};
							if (enemyId !== null) {
								entry.enemy = enemyId;
								// The shot's OWN aim is not known yet: a projectile leaves this choke point
								// before `ShootAct.spawn` aims it (shoot-act.js:123-150 calls setFollowing/
								// setTarget AFTER the spawn), so the two wrappers below fill these in,
								// writing back through this backlink. Only an ENEMY entry carries one: the
								// player channel's payload is frozen and its mirrors never had an aim.
								proxy.__ttProjEntry = entry;
								enemyQueues.projectiles.push(entry);
							}
							else {
								queues.projectiles.push(entry);
							}
						}
					}
					return proxy;
				};
			}
			else {
				console.warn("[TT Client] Projectile export not found; projectile sync disabled.");
			}
		}
	}
}

// --- Remote replay -----------------------------------------------------------
// Spawn one synced fx on a peer actor from a descriptor sent by its owner. Shared by the
// one-shot globalFx path, the persistent-fx reconcile below and the enemy frame's own effects.
// Make a replayed enemy's aim resolve against the player its owner was aiming at, so an
// alignment that reads "whoever this entity is following" lands where the owner drew it (see the
// caller). Only ever called for a synced enemy fx whose owner named a player, so the player-path
// replay -- and every self-relative enemy fx -- is untouched.
//
// Writes straight onto the entity's own `following` (the same object as `core.following`, see
// TargetFollowing.setCore): the puppet runs no action and its physics are pinned, so nothing else
// reads it, and this is what the old enemy-sync branch did at the far end of its aim relay
// (setFollowTarget in its `enemy_aim` handler). Failure is silent: a missing export, an entity
// without a following, or a target result that refuses the entity all end in no placement change.
function pointFollowAt(actor, playerId) {
	const TargetResult = terra.export.TargetResult ?? terra.file.target?.TargetResult;
	const following = actor?.core?.following ?? actor?.actor?.following ?? null;
	if (!TargetResult || !following?.target?.setEntity)
		return;
	const targetEnt = playerEntityOfId(playerId);
	if (!targetEnt?.core)
		return;
	try { following.target.setEntity(targetEnt, terra.export.ENT_ALIGN?.CENTER ?? 0); }
	catch (e) { /* nothing to place it against: leave the fx's own reference alone */ }
}

export function spawnRemoteFx(actor, fxState) {
	if (!fxState?.effect)
		return null;

	const effect = terra.export.Effect.get(fxState.effect);
	if (!effect)
		return null;

	// A synced enemy fx that is anchored to the player its shooter is aiming at (the aim/telegraph
	// family, see the `follow` note in the capture hook) can only be placed if the entity it is
	// attached to follows the same player here: the alignment resolves through
	// `core.following.getTargetingPos` (engine/entity/entity.js:441-447), and on this client the
	// enemy is a driven puppet whose following the owner never set. Done before the spawn, because
	// the fx resolves its position as it starts.
	if (fxState.enemy != null && fxState.follow != null)
		pointFollowAt(actor, fxState.follow);

	const align = clampAlignToFigure(actor, fxState.alignment);
	const offset = fxState.offset
		? new Vec3(fxState.offset[0], fxState.offset[1], fxState.offset[2])
		: undefined;

	let fx;
	if (fxState.pos) {
		const p = fxState.pos;
		fx = effect.spawnPos(new Vec3(p[0], p[1], p[2]));
	}
	else {
		fx = effect.spawnEntity(actor, align, offset, fxState.rel ?? false);
	}

	if (!fx)
		return null;

	fx.setDelay(fxState.delay ?? 0);
	fx.setPart(fxState.part);
	fx.looped = fxState.looped ?? false;
	fx.attachGroup = fxState.group;
	// The owner's secondary target, when it followed the very entity the fx is attached to (an
	// enemy attack telegraph does: enemy-aim-fx.js:64/:66 points it at the shooter). `actor` IS the
	// receiver's counterpart of that entity -- the ghost for a player fx, the local copy of the
	// enemy for an enemy fx -- so re-pointing target2 at it reproduces the owner's geometry. Only
	// sent for an enemy fx (see the capture hook), so this is inert on the player path.
	if (fxState.t2align !== undefined && typeof fx.setTarget2Entity === "function") {
		const t2offset = fxState.t2off
			? new Vec3(fxState.t2off[0], fxState.t2off[1], fxState.t2off[2])
			: undefined;
		fx.setTarget2Entity(actor, clampAlignToFigure(actor, fxState.t2align), t2offset, fxState.t2rel ?? false);
	}
	// Mark this spawn as a peer replay: its screen-global steps (vignette/blur/shake) are
	// suppressed so they don't affect the local player's screen.
	fx._ttRemotePending = true;
	fx._ttSynced = true;
	fx.start(fxState.duration);
	return fx;
}

// Remove run-glow fx the *ghost* spawned through its own player-side logic (the peer actor
// ends up running PlayerCmp show/dash/float code, which spawns sprint/float fx locally).
// Those copies are not owner-reported, so no stop ever arrives for them and they outlive the
// owner's run. Only untagged fx are cleared, so the synced copies (tagged in spawnRemoteFx)
// are left alone. This runs per visible frame and is cheap (a handful of subscribers).
export function clearUntrackedRunFx(actor) {
	const watcher = actor?.core?.broadcast;
	if (!watcher?.list)
		return;
	for (let i = watcher.list.length - 1; i >= 0; i--) {
		const entry = watcher.list[i];
		if (!(entry instanceof terra.export.FxEntity))
			continue;
		if (entry._ttSynced || !RUN_FX_GROUPS.includes(entry.attachGroup))
			continue;
		watcher.removeIdx(i, entry);
		try { entry.stop(0, false); } catch (e) { /* already gone */ }
	}
}

// Keep a peer's lasting (infinite) fx in step with the owner's current snapshot: spawn the
// ones we're missing (e.g. a debuff gained while they were away) and stop the ones they no
// longer have. The owner re-sends the snapshot every frame.
export function reconcilePersistentFx(actor, list, running) {
	// A caller that has not put this entity's sync state in place yet has nothing to reconcile
	// with; the two callers (./actors.js for a ghost, ./enemies.js for an enemy) both do, but this
	// runs on the frame path, where a throw would take the rest of the frame down with it.
	if (!actor?.terraTogether)
		return;
	const map = actor.terraTogether.fxMap;
	const prev = actor.terraTogether.persistentIds ?? new Set();
	const next = new Set();

	for (const fxState of list ?? []) {
		if (fxState?.id == null || !fxState.effect)
			continue;
		// The sprint/float glow only exists while the owner is actually running. If the ghost
		// isn't moving, treat run-group entries as absent — the owner can otherwise keep
		// reporting a stale run fx that it never stopped.
		if (!running && RUN_FX_GROUPS.includes(fxState.group))
			continue;
		next.add(fxState.id);
		// Already shown (matched by id, whether spawned here or by the one-shot globalFx
		// path): leave the live instance alone.
		const existing = map[fxState.id];
		if (existing && !existing.hasEnded?.())
			continue;
		const fx = spawnRemoteFx(actor, fxState);
		if (fx)
			map[fxState.id] = fx;
	}

	// Anything shown last frame but no longer reported has ended on the owner's side.
	for (const id of prev) {
		if (next.has(id))
			continue;
		const fx = map[id];
		if (fx) {
			try { fx.stop(0, false); } catch (e) { /* already gone */ }
			delete map[id];
		}
	}

	actor.terraTogether.persistentIds = next;
}

// Drop every fx/sound we spawned on a peer. Called when they leave the room or disconnect;
// while they are away we never see their one-shot fxStops, so nothing else cleans up.
// FxEntity.clearEntity with no group clears all fx attached to the core; world-position
// one-shots aren't attached and simply play out.
export function clearPeerFx(actor) {
	if (!actor)
		return;
	try { terra.export.FxEntity?.clearEntity?.(actor.core); } catch (e) { /* actor already gone */ }
	if (actor.terraTogether) {
		actor.terraTogether.fxMap = {};
		actor.terraTogether.persistentIds = null;
	}
	stopActorSounds(actor);
}

// Stop every synced sound we are playing on a peer actor and drop its playbacks. Lives here
// (next to clearPeerFx, its only caller) so actors.js can stay above fx-sync.js in the
// import DAG.
export function stopActorSounds(actor) {
	const map = actor?.terraTogether?.soundMap;
	if (!map) return;
	for (const id in map)
		map[id]?.stop();
	actor.terraTogether.soundMap = {};
}

// Drop the effects a PEER OWNER's stream put on one enemy this client was puppeting, and the
// sounds it started on it. Called by ./enemies.js wherever an enemy stops being a puppet (the
// owner handed it over, it went stale and is simulated locally again, it despawned, the map went,
// the feature was switched off): from that moment no stop will ever arrive for them, so an
// infinite fx (an attack telegraph, a status marker) would stay on an enemy that is now THIS
// client's own business.
//
// Deliberately narrower than clearPeerFx: that one clears the entity's whole fx broadcast, which
// is right for a peer PLAYER's ghost (every fx on it came from the stream) but wrong for an enemy,
// whose entity can carry engine-owned effects of its own. Only the descriptors this stream spawned
// are tracked here, so only those are stopped. World-position one-shots (a hit impact) aren't
// tracked and simply play out, exactly as on the player path.
export function clearRemoteEnemyFx(ent) {
	const holder = ent?.terraTogether;
	if (!holder)
		return;
	const map = holder.fxMap ?? {};
	for (const id in map) {
		try { map[id]?.stop(0, false); } catch (e) { /* already gone */ }
	}
	holder.fxMap = {};
	holder.persistentIds = null;
	stopActorSounds(ent);
}

//# sourceURL=/mods/terra-together/client/fx-sync.js
