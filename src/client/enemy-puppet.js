/**
 * src/client/enemy-puppet.js
 * The enemy PUPPET mechanism (enemy-sync Phase 2a): how a remote-owned enemy is stopped from
 * simulating itself and driven purely from externally supplied state, reversibly.
 * Responsibilities:
 *   - installPuppetPatches(): install ONCE the prototype seams that let a per-entity check
 *     suppress an enemy's AI decisions, its local damage application, and the death/reward/FX
 *     side-effects it would otherwise emit -- while leaving the entity tick chain and every
 *     non-puppet actor byte-for-byte unaffected.
 *   - makePuppet/releasePuppet/isPuppet: the per-ENTITY puppet mark plus the entity state the
 *     mechanism pins (actor.animationFixed, actor.facing.type, move.physics.skip), its exact
 *     restoration on release, and the ACTION hygiene both transitions run (clearAction, below), so
 *     an entity can neither inherit a half-finished action nor be handed back holding one.
 *   - readEnemyState (OWNER side) / drivePuppet (PEER side, every frame) / adoptState (ONCE, for an
 *     entity this client is about to simulate itself): the per-frame state snapshot and its
 *     application to an entity.
 * Public surface: installPuppetPatches, makePuppet, releasePuppet, isPuppet, readEnemyState,
 *   drivePuppet, adoptState
 * Engine touchpoints: terra.export.{EnemySheet, EnemyCmp, ActorCmp, LoopCheckReaction,
 *   ACTOR_FACING, ACTOR_FX_TYPE, Vec2, Vec3, g_game}. Patched seams (all prototypes, all gated on
 *   the ENTITY mark): EnemySheet.updateAction (AI choice/action selection, the one funnel every
 *   AI entry point reaches), EnemyCmp.checkAutoAggro / triggerAggression / updateTarget (aggro and
 *   target acquisition, reached from EnemyCmp.update outside updateAction), LoopCheckReaction.
 *   checkTrigger (the auto/dodge reactions, which act outside updateAction too), EnemyCmp.onHit
 *   (local damage -> local HP), EnemyCmp.onDeathHit (giveExp/dropItems/rogue.onEnemyKilled/screen
 *   shake/combat.setEnemyDefeated), EnemyCmp.onNotify (scripted reactions can start actions), and
 *   ActorCmp.onPostMove (the per-frame actor-FX sink: step dust/sounds and the run glow).
 * Notes: the AI is NOT switched off; only its decision points are. The puppet keeps ticking --
 *   TerraActor.update -> EnemyCmp.update -> CombatantCmp.update -> AttackerCmp.update ->
 *   ActorCmp.update -> ActionState.update -> postActionUpdate -> EnemyCmp.onPostAction -- because
 *   a puppet that stops ticking will not animate, resolve or bury. That same tick chain is why the
 *   suppression is only half the story: suppressing the DECISION does not stop the action SEQUENCE
 *   the entity was already in (ActionState.update keeps running it), so both handoff directions run
 *   clearAction() -- see the long comment on it. Every patch is a transparent passthrough for a
 *   non-puppet, and the mark lives on the entity, never on a component:
 *   EnemyCmp/ActorCmp are pooled (EnemyCmp.pooling = true, entity-component reset on bury), so a
 *   component flag would leak into an unrelated later entity; entities are not pooled.
 *   Phase 2 deliberately does NOT forward damage or death: local hits, local HP loss, local
 *   rewards and local defeat bookkeeping are all suppressed rather than mirrored, so nothing on a
 *   peer can diverge from the owner. Applying the peer's `state`/`action` fields is likewise out
 *   of scope -- driving a figure animation is enough to look right, and playing the action would
 *   run local action steps (hitboxes, FX) which is exactly what a puppet must not do.
 * Decompiled refs: enemy-type.js:219 updateAction (choice -> startChoice -> actor.setAction, and
 *   enemy.updateTarget at :234) called from enemy-cmp.js:556 onSceneAggressionStart, :596 update
 *   and :736 onPostAction; enemy-cmp.js:601 checkAutoAggro / :626 -> :1113 triggerAggression /
 *   :654 updateTarget, all reached from :558 update; :595 LoopCheckReaction.checkTrigger; :1100
 *   onHit -> :1106 combatant.onHit (combatant-cmp.js:733) from terra-actor-entity.js:253; :1119
 *   onDeathHit (giveExp :1163, dropItems :1191, rogue.onEnemyKilled :1128) from
 *   combatant-cmp.js:988; :1260 onNotify -> notify-reaction.js:31. ActorCmp.onPostMove
 *   (actor-cmp.js:1093) emits POST_MOVE/STEP/STEP_2 from move-cmp.js:457 every frame;
 *   actor-cmp.js:645 is the `animationFixed` gate that keeps the local walk/idle selection from
 *   overwriting a driven animation, and MainActorConfigData.apply (actor-cmp.js:170, the :205/:210
 *   lines) restores animationFixed=false and facing.type from an action config, which is why the
 *   pin is re-asserted every frame rather than set once.
 *   The action teardown both transitions use is ActorCmp.cancelAction (actor-cmp.js:1009 ->
 *   ActionState.cancelSequence, step-base.js:75) plus ActorCmp.resetToDefault (actor-cmp.js:1180);
 *   the engine's own precedent for that pair is EnemyCmp.setState (enemy-cmp.js:692-694 -> :713) and
 *   ActorCmp.onDeactivate (actor-cmp.js:378-386). actionState.sequence is the whole of
 *   `isActionRunning()` (steps/action.js:106-108), which monster AI returns on (enemy-type.js:231).
 *   The mod's own remote-actor driving is src/client/actors.js (position/anim/face/fx); the game's
 *   view-only actor precedent is features/char/entity/fake-char.js:58-61.
 */

// ─────────────────────────────── entity marks ───────────────────────────────
//
// Both live on the ENTITY (entities are not pooled; components are). PUPPET_MARK is the only
// authoritative test -- every patch below resolves the entity first and checks it per call, which
// is also what makes a patch installed before any puppet exists completely inert.
const PUPPET_MARK = "__ttPuppet";

// The exact state makePuppet pinned, so releasePuppet can put it back rather than guess. Set
// (and read) on the entity, next to the mark, for the same pooling reason.
const PUPPET_SAVED = "__ttPuppetSaved";

export function isPuppet(ent) {
	return !!ent && ent[PUPPET_MARK] === true;
}

// ─────────────────────────────── tmp vectors ───────────────────────────────
//
// One scratch Vec3/Vec2 for the whole frame, like the engine's own `tmp` modules: drivePuppet
// runs per enemy per frame, and setPos/setFace copy their argument immediately so reusing these
// is safe. They are built lazily so that importing this module never depends on terra.export
// being populated yet.
let tmpVec3 = null;
let tmpVec2 = null;

function getTmpVec3() {
	if (!tmpVec3 && terra.export?.Vec3)
		tmpVec3 = new terra.export.Vec3();
	return tmpVec3;
}

function getTmpVec2() {
	if (!tmpVec2 && terra.export?.Vec2)
		tmpVec2 = new terra.export.Vec2();
	return tmpVec2;
}

// ───────────────────────── makePuppet / releasePuppet ─────────────────────────

// The two engine fields the mechanism pins, plus the single-frame physics skip. animationFixed
// stops ActorCmp.update's local walk/idle/brake animation selection (actor-cmp.js:645) from
// fighting the driven animation; facing.type FIXED stops the same update from rewriting the
// driven face vector from move.accelDir (:535) or the target (:521). Both are re-asserted every
// frame by drivePuppet because an action config resets them (MainActorConfigData.apply,
// actor-cmp.js:205/:210) and actor.resetToDefault() applies one.
function pinPuppet(ent) {
	const actor = ent.actor;
	if (actor) {
		actor.animationFixed = true;
		if (actor.facing)
			actor.facing.type = terra.export?.ACTOR_FACING?.FIXED ?? 1;
	}
	if (ent.move?.physics)
		ent.move.physics.skip = true;
}

// ───────────────────────── action + pose hygiene ─────────────────────────
//
// Hand an ACTION and a POSE back to the engine, in the engine's own way. Called by BOTH transitions:
// taking an entity over (makePuppet) and handing it back (releasePuppet).
//
// Why suppressing the AI is not enough. Our patches stop the puppet's DECISIONS; they do not stop
// the action SEQUENCE it is already in the middle of:
//   * `actionState.sequence` is the whole of `isActionRunning()` (steps/action.js:106-108), and
//     EnemySheet.updateAction returns on it at enemy-type.js:231 -- the one funnel every AI entry
//     point reaches (enemy-cmp.js:556 / :596 / :736). A sequence that never ends is therefore a
//     permanent AI blackout: no new action is ever chosen.
//   * `ActionState.update()` keeps running that sequence every frame regardless of our mark
//     (actor-cmp.js:491 -- the puppet chain is deliberately left ticking), so the leftover steps go
//     on executing. And the enemy data is full of steps that CANNOT finish for a puppet, because
//     pinPuppet freezes the entity every frame (`move.physics.skip`, physics.js:382 zeroes the frame
//     delta and skips the z/gravity branch) and drivePuppet overwrites `move.vel`:
//       - WAIT_UNTIL_ON_GROUND (move-steps.js:1500-1528): `maxTime` is absent in 65 of its 89
//         shipped enemy uses, and with `this.maxTime = 0` its only escape (the first line of run())
//         is disabled, so it waits for a landing that never happens;
//       - MOVE_TO (move-steps.js:130-182) also defaults `maxTime` to 0 and waits for an arrival;
//       - NAV_TO / NAV_TO_RANGE / DASH_APPROACH / FALL_APPROACH / POINT_APPROACH / TARGET_FOLLOW_JUMP
//         / TARGET_FOLLOW_DASH / STICKY_MOVE / KEEP_MOVING are the same shape.
//     `sequence` is only ever taken off by cancelSequence/clear (step-base.js:75-82, :187-194).
//   * `actor.animationFixed` is the POSE gate: while it is true, ActorCmp.update never touches the
//     figure animation (actor-cmp.js:645), so the figure keeps replaying whatever it was left with.
//     The pin is set by the steps themselves -- SHOW_ANIMATION sets it in start() (core-steps.js:1836)
//     and only clears it in run() while `wait` is set and the animation has ended (core-steps.js:1843),
//     and it is used 883 times in the shipped enemy data -- and by the stun/death/respawn paths
//     (combatant-cmp.js:392, :458, :581; actor-ext-cmp.js:229). It is cleared ONLY by re-applying the
//     actor config (MainActorConfigData.apply, actor-cmp.js:205), i.e. by resetToDefault
//     (actor-cmp.js:1180), and nothing calls that periodically. So an entity interrupted mid-action is
//     very often `animationFixed === true` -- and SAVING that value and restoring it on release hands
//     the entity back with the local walk/idle selection switched off (actor-cmp.js:645) and no action
//     left that could clear it again. The figure loops its last animation forever, on an enemy this
//     client now simulates itself. (Sam's report: "changing hosts, enemy can sometimes be stuck in
//     forever animation loop", and it can hit a locally-owned enemy that was puppeted earlier.)
//
// cancelAction + resetToDefault is the engine's own recipe for exactly this situation, so we use it
// rather than hand-mutating internals: EnemyCmp.setState does the same pair on every enemy state
// change (`if (!keepAction && actor.isActionRunning()) actor.cancelAction(...)`, enemy-cmp.js:692-694,
// followed by `actor.setDefaultConfig(state.config)`, :713 -> resetToDefault), and ActorCmp.onDeactivate
// does it when the actor is torn down (actor-cmp.js:378-386). The sequence's broadcast is drained by
// cancelSequence itself (resetState -> broadcast.notifyAndClear, step-base.js:83-87).
//
// Ordering note: `noResetAfterEnd` decides whether cancelSequence's resetState runs the actor reset at
// all (step-base.js:76-79, :84, :88). It is only ever set by `setAction(action, keepStateBefore,
// keepStateAfter)`, and it is re-cleared at the top of EVERY setSequence (step-base.js:40) -- it is a
// plain re-entrancy flag, not deep state, and ActorCmp.onDeactivate (:382) clears it by hand in the
// same situation. Clearing it here makes the reset unconditional; the explicit resetToDefault() after
// it then guarantees the pose pin is canonical (false) even when there was no sequence to cancel or no
// sequence reset ran, so what makePuppet SAVES can never be a stalled pose pin.
function clearAction(ent) {
	const actor = ent?.actor;
	if (!actor || typeof actor.cancelAction !== "function" || typeof actor.resetToDefault !== "function")
		return;
	if (actor.actionState)
		actor.actionState.noResetAfterEnd = false;
	actor.cancelAction();
	actor.resetToDefault();
}

export function makePuppet(ent) {
	installPuppetPatches();
	if (!ent || typeof ent !== "object")
		return false;

	// Already a puppet: keep the ORIGINAL saved state from the first entry, so a repeated
	// makePuppet (every frame, on every ownership refresh) cannot overwrite it with the pinned
	// values and break releasePuppet.
	if (ent[PUPPET_MARK] === true) {
		pinPuppet(ent);
		return true;
	}

	// Take the entity out of whatever it was doing BEFORE recording what to restore. This is what
	// makes the two saved values canonical instead of the transient pose of an action we are about to
	// cut (see clearAction), and it is what frees whoever owns the entity next from the
	// isActionRunning() guard at enemy-type.js:231.
	clearAction(ent);

	const actor = ent.actor;
	ent[PUPPET_SAVED] = {
		animationFixed: actor ? actor.animationFixed : undefined,
		facingType: actor?.facing ? actor.facing.type : undefined,
	};
	ent[PUPPET_MARK] = true;
	pinPuppet(ent);
	return true;
}

export function releasePuppet(ent) {
	if (!isPuppet(ent))
		return false;

	const actor = ent.actor;
	const saved = ent[PUPPET_SAVED];
	delete ent[PUPPET_MARK];
	delete ent[PUPPET_SAVED];

	// The mark is gone, so the patches are transparent again and the AI is allowed to decide from the
	// next tick -- but only if nothing is still "running". Our patches never stopped the sequence
	// itself, and an action can also be started on a puppet by an engine path we do not patch (parry,
	// attacker/tackle, giveUp/onBoom), so clear it here too instead of trusting makePuppet's one-shot
	// cancel: a leftover sequence would hold EnemySheet.updateAction at enemy-type.js:231 forever and
	// the entity would never select another action. Same recipe as makePuppet -- see clearAction.
	clearAction(ent);

	if (actor) {
		// Restore what makePuppet pinned; fall back to the ActorCmp.reset()/actor-config defaults
		// (actor-cmp.js:323 MOVE_DIR, :327 false) if the save is missing, so a released entity is
		// always in a state the engine itself would have produced. `saved.animationFixed` is the
		// engine's canonical post-reset value rather than a pin inherited from the interrupted action
		// (clearAction above), which is what lets the next local tick select walk/idle again
		// (actor-cmp.js:645) instead of looping the last driven animation forever.
		actor.animationFixed = saved?.animationFixed === undefined ? false : saved.animationFixed;
		if (actor.facing)
			actor.facing.type = saved?.facingType === undefined ? (terra.export?.ACTOR_FACING?.MOVE_DIR ?? 0) : saved.facingType;
	}
	// physics.skip is a single-frame flag the physics step always clears (physics.js:431), so
	// `false` is its resting state; clear it explicitly so a release that lands between our drive
	// and this frame's physics step cannot leave the entity frozen for one more frame.
	if (ent.move?.physics)
		ent.move.physics.skip = false;

	// Deliberately NOT restored: the driven animation (the next local tick picks walk/idle again
	// now that animationFixed is false), the driven velocity and HP (both are real state the
	// released entity continues from), and actor.target (which the released AI re-acquires).
	return true;
}

// ─────────────────────────────── patch table ───────────────────────────────

// Install-once guard. Deliberately flipped only after the whole table has been attempted, and the
// seams that could not be installed are named in a warning: a missing export means a game build
// this mod does not know, and silently believing the AI is suppressed would be far worse.
let installed = false;

// A no-op seam. Keeps the patch table declarative; the return value matches what the real method
// returns for the puppets that use it (undefined, except onNotify/checkTrigger below).
function noop() { }

// Wrap one prototype method so that a puppet takes the puppet path and every other receiver --
// the SAME client's owned enemies, other actors, NPCs -- goes to the original untouched, with the
// identical argument list and the identical return value.
//   resolveEnt(self, args): where the ENTITY is for this seam. Components carry `.ent`
//   (entity.js:270 sets it on every component); the EnemySheet/reaction seams take the EnemyCmp as
//   their first argument and must go through it.
function patch(proto, name, resolveEnt, apply) {
	if (!proto || typeof proto[name] !== "function")
		return false;
	const original = proto[name];
	if (original.__ttPuppetPatched === true)
		return false;

	const wrapper = function (...args) {
		const ent = resolveEnt(this, args);
		if (!ent || ent[PUPPET_MARK] !== true)
			return original.apply(this, args);
		return apply.call(this, ent, original, args);
	};
	wrapper.__ttPuppetPatched = true;
	proto[name] = wrapper;
	return true;
}

export function installPuppetPatches() {
	if (installed)
		return false;

	const exp = terra.export ?? {};
	const missing = [];
	// [label, receiver, method, entity resolver, puppet handler] -- one row per seam, evaluated
	// below, so the label a failure is reported with can never drift from the seam it names.
	const table = [
		// (a) The AI choice / action selection. EVERY AI entry point funnels into
		// EnemySheet.updateAction: enemy-cmp.js:596 (update), :736 (onPostAction) and :556
		// (onSceneAggressionStart). Gating this one seam is what the old enemy-sync branch got
		// wrong by patching EnemyCmp.update instead, which left the onPostAction call site live.
		// Inside it reach enemy.currentState.getChoice -> startChoice -> actor.setAction and
		// enemy.updateTarget (:234).
		["EnemySheet.updateAction", exp.EnemySheet?.prototype, "updateAction", entOfEnemyArg, noop],

		// (b) Auto-aggro / target selection. checkAutoAggro is called from EnemyCmp.update:582,
		// i.e. OUTSIDE updateAction; it reaches triggerAggression (:626 -> :1113), which
		// setAggressive(true) + combat.aggroNearbyEnemy + actor.cancelAction + updateTarget.
		["EnemyCmp.checkAutoAggro", exp.EnemyCmp?.prototype, "checkAutoAggro", entOfSelf, noop],
		["EnemyCmp.triggerAggression", exp.EnemyCmp?.prototype, "triggerAggression", entOfSelf, noop],
		["EnemyCmp.updateTarget", exp.EnemyCmp?.prototype, "updateTarget", entOfSelf, noop],

		// (b') The loop-check reactions (auto-reaction, dodge-reaction) are checked from
		// EnemyCmp.update:595 -- again outside updateAction -- and their trigger() can
		// enemy.setState(), enemy.actor.doImmediateAction() and show a dramatic zoom directly, so
		// gating updateAction alone would not stop them. Its only caller is that one line.
		["LoopCheckReaction.checkTrigger", exp.LoopCheckReaction, "checkTrigger", entOfEnemyArg, () => false],

		// (c) LOCAL hit application: terra-actor-entity.js:253 -> EnemyCmp.onHit -> :1106
		// combatant.onHit, which is where local damage, stun, knockback and local death are
		// decided. Suppressed (not mirrored) in Phase 2, so local HP cannot diverge; the attacker
		// still counts the hit and its hit-stop (attacker-cmp.js:100-104 ignores our return value).
		["EnemyCmp.onHit", exp.EnemyCmp?.prototype, "onHit", entOfSelf, noop],

		// (d) The death/reward hooks. onDeathHit is the ONLY caller of giveExp (:1129), dropItems
		// (:1130), rogue.onEnemyKilled (:1128) and of the screen shake + combat.setEnemyDefeated
		// (:1135-:1139); the owner grants those, and the peer must not double-grant them. Reached
		// from combatant-cmp.js:988 (and :318/:407 internal death paths).
		["EnemyCmp.onDeathHit", exp.EnemyCmp?.prototype, "onDeathHit", entOfSelf, noop],

		// (d') Scripted notify reactions (enemy-cmp.js:1260 -> notify-reaction.js:31) run outside
		// the AI cycle and can setState()/doImmediateAction()/show a dramatic zoom on a stale
		// reaction set the peer never kept in sync. Its return value is only "did I handle it".
		["EnemyCmp.onNotify", exp.EnemyCmp?.prototype, "onNotify", entOfSelf, () => false],

		// (d'') The per-frame actor-FX sink. ActorCmp.onPostMove (actor-cmp.js:1093) is called
		// from the physics step (move-cmp.js:457) for every live entity and emits POST_MOVE (the
		// run glow), STEP / STEP_2 (dust + step sounds) and anim-flagged sounds. A puppet plays
		// real (driven) walk/run animations, so its STEP hooks fire every frame even though the
		// owner's copy is the one simulating the movement: same suppression the mod already
		// applies to peer player ghosts (src/client/actors.js:70-90), for the same reason.
		["ActorCmp.onPostMove", exp.ActorCmp?.prototype, "onPostMove", entOfSelf, puppetOnPostMove],
	];

	for (const [label, proto, name, resolveEnt, apply] of table) {
		if (!patch(proto, name, resolveEnt, apply))
			missing.push(label);
	}

	installed = true;
	if (missing.length)
		console.warn("[TT enemy-puppet] could not install puppet patches (unknown game build?): " + missing.join(", "));
	return true;
}

// The entity behind a component receiver (every component carries `.ent`, entity.js:270).
function entOfSelf(self) {
	return self?.ent;
}

// The entity behind the EnemyCmp first argument of the EnemySheet / reaction seams.
function entOfEnemyArg(self, args) {
	return args[0]?.ent;
}

// Puppet onPostMove: run the real body (it also fixes up figState.mod.shiftZ against the ground,
// which the driven figure still needs) with the actor-FX sink wrapped for the duration, so the
// three movement FX a position-driven actor cannot own are dropped. Mirrors actors.js:70-90.
function puppetOnPostMove(ent, original, args) {
	const fxCallback = this.fxCallback;
	const fxType = terra.export?.ACTOR_FX_TYPE;
	if (!fxCallback || typeof fxCallback.onActorFx !== "function" || !fxType)
		return original.apply(this, args);

	const originalOnActorFx = fxCallback.onActorFx;
	fxCallback.onActorFx = function (core, type, vary) {
		if (type === fxType.POST_MOVE || type === fxType.STEP || type === fxType.STEP_2)
			return;
		return originalOnActorFx.call(this, core, type, vary);
	};
	try {
		return original.apply(this, args);
	} finally {
		fxCallback.onActorFx = originalOnActorFx;
	}
}

// ───────────────────────────── OWNER side: snapshot ─────────────────────────────
//
// The wire shape, produced here exactly as the contract freezes it:
//   { id, x, y, z, vx, vy, vz, fx, fy, anim, animTime, hp, state, action }
// Numbers are quantised on the way out, because this is built per enemy per frame and every field
// is a float that carries far more precision than the wire (or the eye) needs:
//   x/y/z, vx/vy/vz, fx/fy, animTime -> 3 decimals (mm and ms);
//   hp -> 4 decimals, so a 0..1 ratio still resolves 1 HP on a 10000 HP boss.
// Strings (id, anim, state, action) are passed through verbatim.

function round3(value) {
	return Math.round(value * 1000) / 1000;
}

function round4(value) {
	return Math.round(value * 10000) / 10000;
}

// The enemy's stable map-scoped identity -- the same derivation src/client/enemies.js uses
// (enemySpotId, enemies.js:135-142: the SOURCE SPOT's map path + mapId, never the actor's own
// core, whose mapId is 0 for every runtime-spawned enemy; `u:<uid>` when there is no spot). It is
// duplicated here because this module is self-contained and enemies.js imports it, and it has to
// agree byte-for-byte with the id that module keys its peer-state map and its puppet set on: the
// receiving side routes an incoming state by exactly this field.
//
// The two copies are kept in LOCKSTEP, and the guard line below is character-for-character the
// same as the one in enemySpotId (enemies.js, the canonical form): do not reword it in one file
// alone. The guard is a REJECT guard -- `mapId < 0` only, so 0 (a real map id) and NaN both pass
// -- and matching it exactly is what stopped the copies drifting on a numeric edge case, where a
// malformed map's non-numeric entity key once gave the same enemy an id of `m:<map>#NaN` on one
// side and `u:<uid>` on the other. Edit one guard, edit both.
function stateId(core, enemy) {
	const src = enemy?.sourceEntity;
	const mapPath = src?.core?.gMap?.path ?? terra.export?.g_game?.map?.active?.path ?? "";
	const mapId = src?.core?.mapId;
	if (mapPath === "" || typeof mapId !== "number" || mapId < 0)
		return "u:" + (core?.uid ?? "?");
	return "m:" + mapPath + "#" + mapId;
}

// Snapshot a live enemy's state, or null when the entity cannot be represented (not an enemy, no
// core, already killed, or not far enough through initialisation to have HP). Position and HP are
// treated as required -- they are the fields a peer cannot fall back on -- while the purely
// cosmetic ones (animation, facing, velocity) are optional and degrade to null/0.
export function readEnemyState(ent) {
	const core = ent?.core;
	const enemy = ent?.enemy;
	const combatant = enemy?.combatant;
	if (!core || !core.pos || !enemy || !combatant?.params || core.isKilled?.())
		return null;

	const move = ent.move;
	const actor = ent.actor;
	const figState = ent.view?.figState;
	const params = combatant.params;

	return {
		id: stateId(core, enemy),
		x: round3(core.pos.x),
		y: round3(core.pos.y),
		z: round3(core.pos.z),
		vx: move?.vel ? round3(move.vel.x) : 0,
		vy: move?.vel ? round3(move.vel.y) : 0,
		vz: move?.vel ? round3(move.vel.z) : 0,
		fx: actor?.face ? round3(actor.face.x) : 0,
		fy: actor?.face ? round3(actor.face.y) : 0,
		// figure-state.js:166 (`animName`) and :274 (`getTotalTime`, the playhead in seconds) --
		// the main figure state the engine's own view-only actor drives/reads, fake-char.js:58-61.
		anim: figState?.animName ?? null,
		animTime: typeof figState?.getTotalTime === "function" ? round3(figState.getTotalTime()) : 0,
		// The ratio the enemy's own HP bar is drawn from (combat-hud.js:187 params.getHPRatio()).
		hp: round4(Math.max(0, Math.min(1, params.getHPRatio ? params.getHPRatio() : 0))),
		state: enemy.currentState?.name ?? null,
		action: actor?.actionState?.sequence?.name ?? null,
	};
}

// ───────────────────────────── PEER side: drive ─────────────────────────────
//
// `applyState` is the ONE place a wire state's fields are written onto an entity. It is shared by
// drivePuppet (every frame, on a puppet) and adoptState (once, on an entity this client is about to
// simulate itself) so the two can never drift. It writes nothing that belongs to the puppet
// mechanism: no entity mark, no `animationFixed` / `facing.type` pin and no physics skip -- the pin
// lives in pinPuppet/drivePuppet (step 1 of drivePuppet below). That is precisely what makes it safe
// to call on a locally simulated entity.
//
// Every field is optional and each is skipped when absent or of the wrong type: a version-skewed or
// malformed peer must never throw on the per-frame path (the same discipline as
// src/client/actors.js movePlayerActor). Returns false when the entity cannot be written to at all
// (no core), true otherwise -- including for an empty or partial state.
function applyState(ent, state) {
	const core = ent?.core;
	if (!core || typeof core.setPos !== "function")
		return false;
	const move = ent.move;
	const actor = ent.actor;

	// 1. Position. setPos(pos, keepActorState, keepVel) -- both flags true: the entity keeps its
	//    actor state (no cancelActorState, which would reset the actor mid-animation) and its
	//    velocity, and setPos itself re-flags physics.skip via move.onPosReset
	//    (core-cmp.js:203-217 -> move-cmp.js:555-566). Snapping rounds to the collision grid.
	if (typeof state?.x === "number" && typeof state?.y === "number" && typeof state?.z === "number") {
		const pos = getTmpVec3();
		if (pos) {
			pos.setC(state.x, state.y, state.z);
			core.setPos(pos, true, true);
		}
	}

	// 2. Velocity: not integrated while physics.skip is honoured, but it keeps a one-frame skip
	//    miss moving in the owner's direction instead of freezing, feeds the figure pitch
	//    (actor-cmp.js:744 PITCH_MOVE_DIR) and is what the attacker's hit direction reads.
	if (move?.vel && typeof move.vel.setC === "function"
		&& typeof state?.vx === "number" && typeof state?.vy === "number" && typeof state?.vz === "number") {
		move.vel.setC(state.vx, state.vy, state.vz);
	}

	// 3. Facing and animation. On the puppet path drivePuppet has already re-asserted the facing type
	//    and animationFixed (its step 1); on the adoptState path neither is touched at all.
	if (actor) {
		// setFace(vec2, skipRotation=true) snaps the FIGURE rotation to the driven vector instead
		// of interpolating it; the FIXED facing type from drivePuppet's step 1 stops actor.update from
		// rewriting it. A zero vector is ignored by setFace (actor-cmp.js:435), which leaves the last
		// facing in place.
		if (typeof state?.fx === "number" && typeof state?.fy === "number") {
			const face = getTmpVec2();
			if (face && typeof actor.setFace === "function") {
				face.setC(state.fx, state.fy);
				actor.setFace(face, true);
			}
		}

		// Animation: setAnim FIRST, then the playhead. A switch resets figState.time to -1
		// (figure-state.js:247) and setAnimTime is what places it (figure-state.js:853-858), so the
		// reverse order would be wiped; and setAnim returns early for an unchanged anim (:226), so
		// driving the same anim every frame does not restart it. Only the MAIN figure state is
		// driven -- view.setFigAnim would also hit attached figures (weapon/mode addFigures), which
		// the peer does not own. Same two calls as the engine's own view-only actor,
		// fake-char.js:58-61.
		const figState = ent.view?.figState;
		if (figState) {
			if (typeof state?.anim === "string")
				figState.setAnim(state.anim, null);
			if (typeof state?.animTime === "number" && typeof figState.setAnimTime === "function")
				figState.setAnimTime(state.animTime);
		}
	}

	// 4. HP. Written as the owner's 0..1 ratio (the same convention the mod uses for players),
	//    converted with the enemy's own max HP -- the accessor its HP bar reads. setCurrentHP with
	//    skipTransition=true fires HP_RESET, which snaps the bar instead of animating a drain we
	//    never saw (hp-hud.js:194-200), and it does NOT touch params.defeated: a puppet can never
	//    be pushed into local death logic by a driven HP value (defeat is owner-driven, and
	//    params.isDefeated() reads that flag, combat-params.js:443). Unchanged values are not
	//    re-written, so an idle peer stream does not spam HP_RESET at the HUD.
	const params = ent.combatant?.params;
	if (params && typeof state?.hp === "number" && typeof params.setCurrentHP === "function") {
		const maxHp = params.stats?.getStat?.("hp");
		if (typeof maxHp === "number" && maxHp > 0) {
			const ratio = Math.max(0, Math.min(1, state.hp));
			// Math.max(1, ...) mirrors the engine's own "a living enemy keeps at least 1 HP" idiom
			// (combat-params.js:351) and stops a tiny non-zero ratio from rounding to a 0 that means
			// something else.
			const hp = ratio > 0 ? Math.max(1, Math.round(ratio * maxHp)) : 0;
			if (params.currentHP !== hp)
				params.setCurrentHP(hp, true);
		}
	}

	return true;
}

// Apply one state object to a puppet. Called once per frame per puppet, from a pre-update hook:
// `move.physics.skip` is a SINGLE-FRAME flag (physics.js:382 reads it, :431 clears it), so it has
// to be re-asserted on every call for the entity to stop integrating its own velocity -- and this
// call has to happen before this frame's physics step.
//
// Returns true when the entity is a puppet and was driven, false when it is not a puppet (the
// caller must never steer an owned enemy with a peer's state) or has no core.
export function drivePuppet(ent, state) {
	// Fail closed: only an entity this client has explicitly marked can be driven.
	if (!isPuppet(ent))
		return false;

	// Re-assert the pins FIRST, before anything else this frame: the physics skip has to be set
	// before this frame's physics step even if every field below is missing or skewed, and
	// animationFixed / facing.type have to be back in place if an action config cleared them.
	pinPuppet(ent);

	return applyState(ent, state);
}

// Adopt a peer's snapshot ONCE onto an entity this client is about to simulate itself -- the
// ownership handoff where an enemy stops being a puppet: applying the owner's last known state to
// the local copy stops it snapping back to where/when the local simulation left off, and puts the
// figure on the animation the enemy is actually playing at the moment of the handoff instead of
// whatever the local figure happened to hold.
//
// Same field application as drivePuppet (the same applyState helper), minus everything that only
// makes sense for a puppet: no entity mark, no `animationFixed` / `facing.type` pin, no physics skip.
// It therefore leaves the entity's AI and its local animation selection fully active: the pose gate
// (actor-cmp.js:645) is untouched, so the next local tick is free to select walk/idle/run, and the
// AI is free to decide, from the state applyState just put the entity in. (The one flag it can still
// touch is `move.physics.skip`, and only for the single frame in which core.setPos snaps the position
// -- core-cmp.js:203-217 -> move-cmp.js:555-566. That is the engine's own "this position is
// authoritative, do not re-integrate it" marker and the physics step clears it again at
// physics.js:431, so it is not a pin; clearing it here would fight what setPos just asked for.)
//
// Deliberately tolerant: a partial or absent snapshot skips the fields it does not carry and never
// throws (a peer's state is not trusted input), and an entity with no core is simply skipped. Void
// return -- it is only ever a one-shot side-effect, unlike drivePuppet whose boolean tells the caller
// whether the entity was actually a puppet.
export function adoptState(ent, state) {
	if (!ent || typeof ent !== "object")
		return;
	applyState(ent, state);
}

// `state` and `action` are carried in the snapshot for the wire and for debugging, and are
// deliberately NOT applied by drivePuppet: applying them would mean enemy.setState() (cancels the
// running actor action and applies an action config) or actor.setAction() (resets actionState,
// then runs the action's steps -- hitboxes and all) per frame, i.e. re-enabling exactly the local
// simulation a puppet exists to suppress. `id` is not applied either: it is the peer's identity for
// the receiving side to route on, and every field drivePuppet does apply is listed in its steps
// above. adoptState applies the same field set and for the same reason leaves `state`/`action` to
// the local AI, which takes over with its own state machine on the very next tick.

//# sourceURL=/mods/terra-together/client/enemy-puppet.js
