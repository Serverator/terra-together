/**
 * src/client/actors.js
 * Peer actor lifecycle: create/move the remote player actors, mirror their sounds and
 * equipped weapon, and run the per-frame apply loop.
 * Responsibilities:
 *   - createPlayerActor: the TerraActor ghost (NPC proxy) plus its local movement-fx
 *     suppression, so the ghost does not spawn its own run glow.
 *   - movePlayerActor: apply one peer state snapshot (room/visibility gate, transform,
 *     animations, nameplate bars, fx/sound/projectile replay, weapon mirror).
 *   - setActorTimeFactor: the single place the ghost's time scaling is set.
 *   - updateOtherPlayers: drain the peer update/action maps into the actors.
 *   - Remote sound replay (playSyncedSound/applySyncedVolume) and updateWeaponState.
 * Public surface: createPlayerActor, movePlayerActor, setActorTimeFactor, updateOtherPlayers,
 *   playSyncedSound, applySyncedVolume, updateWeaponState
 * Engine touchpoints: terra.export.{TerraActor,g_gState,Character,COLL_TYPE,
 *   COLL_GROUND_FLAGS,g_fxConnect,ACTOR_FX_TYPE,Target,g_windboxManager,ACTOR_FACING,Vec2,
 *   Vec3,g_player,g_combat,FrameRepeatEntity,ENT_ALIGN,FIGURE_PART,PLAYER_CONFIG},
 *   terra.file.playback.PlaybackDetails, terra.file.audioEvent.AudioEvent,
 *   terra.file.sound.Sound, actor.actor.onPostMove hook, addon hooks via MultiplayerClient.
 * Notes: updateOtherPlayers lives here rather than in ./snapshot.js because every call it
 *   makes (movePlayerActor, clearPeerFx, setActorTimeFactor) is an actor operation, and
 *   snapshot.js's import list is frozen to ../net/protocol.js + ./session.js.
 *   Import graph: session <- fx-sync <- actors.
 *   Decompiled refs: actor-fx.js:77-89 (POST_MOVE run glow, group "__runFX__"),
 *   actor-cmp.js:535-536 (MOVE_DIR overwrites the synced face from accelDir),
 *   actor-cmp.js:630 (maxRotate ∝ g_tick.entity), player-cmp.js:2480/2544 (FIXED facing
 *   set by dodge/perfect-dodge).
 */

import {
	playerActors, playerUpdates, playerActions, getRogueInfo, SCENE_STATE,
	Vec2, Vec3, RUN_FX_SPEED_EPS, soundRegistry, soundSyncSuppress,
} from "./session.js";
import {
	spawnRemoteFx, reconcilePersistentFx, clearUntrackedRunFx, clearPeerFx,
	spawnRemoteProjectile,
} from "./fx-sync.js";
import { skins } from "../features/skins.js";

export function createPlayerActor(id) {
	// A peer is represented by a TerraActor (NPC) added to the world.
	var actor = new terra.export.TerraActor();

	terra.export.g_gState.addEntity(actor, true, false);

	if (actor.actor)
		actor.actor.phaseOn = false;

	actor.terraTogether = { fxMap: {}, soundMap: {}, persistentIds: null, fxHidden: false };

	actor.move?.mainColl?.setType(terra.export.COLL_TYPE.ACTOR);

	actor.move.misc.groundConnect |= terra.export.COLL_GROUND_FLAGS.NO_PUSH;

	actor.move.friction.air = 0;
	actor.move.friction.ground = 0;

	actor.actorExt.actorFx.dust = terra.export.g_fxConnect.effects.dust.entries.ActorM;
	actor.actorExt.actorFx.sound = terra.export.g_fxConnect.sounds.actor.entries.Cloth1;

	// Client-side movement fx is inconsistent and, worse, the ghost never settles: it is
	// driven by teleported position, so `move.acceleration`/`runStopTimer` can latch. The
	// POST_MOVE run glow (actor-fx.js:77-89, group "__runFX__") is spawned per-observer from
	// that local state and then never stops, so it sticks after the owner stops running.
	// STEP dust is likewise unreliable. Both are replayed from the owner instead — the run
	// glow is an infinite fx synced through globalFx/persistentFx — so don't let the ghost
	// produce its own. TODO: visual fx can still get lost.
	const ACTOR_FX_TYPE = terra.export.ACTOR_FX_TYPE;
	let originalOnPostMove = actor.actor.onPostMove;
	actor.actor.onPostMove = function (...args) {
		const originalOnActorFx = this.fxCallback?.onActorFx;

		if (originalOnActorFx) {
			this.fxCallback.onActorFx = function (core, type, vary) {
				if (type === ACTOR_FX_TYPE.STEP || type === ACTOR_FX_TYPE.STEP_2 || type === ACTOR_FX_TYPE.POST_MOVE) {
					return;
				}
				return originalOnActorFx.call(this, core, type, vary);
			};
		}

		try {
			return originalOnPostMove.apply(this, args);
		} finally {
			if (originalOnActorFx) {
				this.fxCallback.onActorFx = originalOnActorFx;
			}
		}
	};

	playerActors.set(id, actor);
	return actor;
}

// Apply a state snapshot to a peer actor, creating it on first sight.
export function movePlayerActor(id, state) {
	if (!state)
		return;

	let actor = playerActors.get(id);

	let justCreated = false;

	if (!actor) {
		actor = createPlayerActor(id);
		justCreated = true;
	}

	if (!actor.core) {
		return;
	}

	// Show/hide transitions are local and unsynced (see initHideShowChange);
	// justCreated skips the appear fx before the actor has any data.
	// Rogue rooms share a map name but differ per seeded sublayout (variant), so a
	// peer is only in the same room when BOTH map and variant match (null outside rogue).
	if (state.scene == "LOADING" || state.scene == "TITLE"
		|| state.map != terra.export.g_game.map.active?.path
		|| (state.variant ?? null) !== (getRogueInfo().variant ?? null)) {
		// Leaving our room: strip the fx/sounds we spawned on this peer. While they're away
		// we drop their one-shot fxStops (see the early return below), so nothing else does.
		if (!actor.terraTogether.fxHidden) {
			clearPeerFx(actor);
			actor.terraTogether.fxHidden = true;
		}
		actor.core?.hide(justCreated);
		return;
	} else {
		actor.terraTogether.fxHidden = false;
		actor.core?.show(justCreated);
	}

	if (state.char && actor.npc?.char?.path != state.char) {
		// Get character from the character sheet
		var char = terra.export.Character.get(state.char);
		actor.setNpc(char, justCreated);
	}

	if (state.char == "CHA:main#Juno") {
		let currentFigure = actor?.view?.getFigure().name;
		if (state.figure && currentFigure != state.figure) {
			let figure = skins[state.figure].figure;
			if (figure) {
				actor.view?.setFigure(figure);
			}
		}
	}

	actor.core.setPos(new Vec3(state.position[0], state.position[1], state.position[2]), true, true);
	if (actor.move?.vel) {
		actor.move.vel = new Vec3(state.velocity[0], state.velocity[1], state.velocity[2]);
	}

	setActorTimeFactor(actor, state.timeFactor);

	// HP ratio (0..1) for the nameplate HP bar (see ../features/nameplates.js).
	actor.terraTogether.hp = typeof state.hp === "number" ? Math.max(0, Math.min(1, state.hp)) : 1;
	// Where HP will stop once pending heals (HoT) tick in.
	actor.terraTogether.hpTarget = typeof state.hp_target === "number" ? Math.max(0, Math.min(1, state.hp_target)) : actor.terraTogether.hp;
	// Downed bleed-out fraction (0..1 left) for the purple nameplate bar.
	actor.terraTogether.downedFrac = state.downed
		? (typeof state.downedFrac === "number" ? Math.max(0, Math.min(1, state.downedFrac)) : 1)
		: null;

	if (actor.actorExt.actorFx) {
		for (const fx of state.actorFx ?? []) {
			actor.actorExt.actorFx.onActorFx(actor.core, fx.type, fx.vary);
		}
	}

	for (const fxState of state.globalFx ?? []) {
		const fx = spawnRemoteFx(actor, fxState);
		if (fx && fxState.id != null)
			actor.terraTogether.fxMap[fxState.id] = fx;
	}

	// Rebuild our lasting fx the peer missed while we were apart (e.g. a debuff gained
	// while away), and drop the ones they no longer report. Run-group fx are additionally
	// dropped when the ghost isn't moving, in case the owner never stopped reporting them.
	const moveVel = actor.move?.vel;
	const running = !!moveVel && moveVel.lengthXY() > RUN_FX_SPEED_EPS;
	reconcilePersistentFx(actor, state.persistentFx, running);
	// Strip the ghost's own sprint/float glow (it runs player-side run logic locally).
	clearUntrackedRunFx(actor);

	for (const windbox of state.windboxes ?? []) {
		let handle = terra.export.g_windboxManager.add();

		let dts = windbox.displacementTypeSettings;
		let displacementTypeSettings = {
			gradient: dts.gradient,
			perpendicular: dts.perpendicular,
			directionAxes: new Vec2(dts.directionAxes[0], dts.directionAxes[1]),
			directionOrigin: new Vec2(dts.directionOrigin[0], dts.directionOrigin[1]),
			gradientAxes: new Vec2(dts.gradientAxes[0], dts.gradientAxes[1]),
			gradientOrigin: new Vec2(dts.gradientOrigin[0], dts.gradientOrigin[1]),
		};

		handle.setDisplacementType(displacementTypeSettings);
		handle.setDisplacementSettings(windbox.displacementSettings);
		handle.setTimingData(windbox.handleTiming);
		let target = new terra.export.Target();
		target.setEntity(actor, windbox.alignment);
		handle.setTarget(target, windbox.followTarget);
		handle.setToTargetPosition();
	}

	for (const stop of state.fxStops ?? []) {
		let fx = actor.terraTogether.fxMap[stop.id];
		if (fx) {
			fx.stop(stop.delay ?? 0, stop.softStop ?? false);
			delete actor.terraTogether.fxMap[stop.id];
		}
	}

	for (const s of state.sounds ?? []) {
		const pb = playSyncedSound(actor, s);
		if (pb && s.id != null)
			actor.terraTogether.soundMap[s.id] = pb;
	}

	for (const v of state.soundVols ?? []) {
		const pb = actor.terraTogether.soundMap[v.id];
		if (pb)
			applySyncedVolume(pb, v.vol);
	}

	for (const st of state.soundStops ?? []) {
		const pb = actor.terraTogether.soundMap[st.id];
		if (pb) {
			pb.stop();
			delete actor.terraTogether.soundMap[st.id];
		}
	}

	for (const p of state.projectiles ?? []) {
		spawnRemoteProjectile(actor, p);
	}

	actor.view?.figState?.setAnim(state.animation || "idle", null);
	actor.view?.figState?.setAnimTime(state.anim_time);

	// The player flips its own facing mode between MOVE_DIR and FIXED (e.g. a dodge/
	// perfect-dodge sets FIXED to hold the facing, player-cmp.js:2480/2544), but the mod
	// only syncs the face *vector*. If the ghost stays MOVE_DIR, its update() overwrites
	// the synced face with move.accelDir (actor-cmp.js:535-536) — the *movement* direction
	// — so it renders backwards (e.g. faces up while the caster faces down) and never
	// recovers. Pin the ghost to FIXED so the synced face vector is always authoritative.
	if (actor.actor)
		actor.actor.facing.type = terra.export.ACTOR_FACING?.FIXED ?? 1;

	// A frozen ghost (time factor ~0) can't interpolate its figure rotation
	// (maxRotate ∝ g_tick.entity, actor-cmp.js:630), so snap the facing instead —
	// otherwise it keeps its old orientation while the caster turns during a freeze.
	let rotateInstantly = terra.export.g_scene?.currentState == SCENE_STATE.MENU || justCreated;
	const frozen = !(state.timeFactor > 1e-4);
	actor.actor?.setFace(new Vec2(state.face_dir[0], state.face_dir[1]), rotateInstantly || frozen);

	updateWeaponState(actor, state.weapon)
}

export function setActorTimeFactor(actor, time) {
	// The figure advances by core.getTick(true) = g_tick.world * factor * logicFactor,
	// so scale only ONE of the two: setting both to `time` squared the speed.
	if (actor.core?.time) {
		actor.core.time.factor = time;
		actor.core.time.logicFactor = 1;
	}

	// The move influencer copies these back onto core.time each physics step.
	if (actor.move?.influencer) {
		actor.move.influencer.globalInvTime = time;
		actor.move.influencer.globalInvLogic = 1;
	}
}

// Replay one synced sound on a peer actor: either a multi-track audio event, or a Sound
// resource re-resolved by path from the registry.
export function playSyncedSound(actor, s) {
	if (!s || !actor?.core)
		return null;

	// Sounds emitted while replaying must not be re-broadcast.
	soundSyncSuppress.depth++;
	try {
		if (s.event) {
			const event = terra.file.audioEvent?.AudioEvent?.get(s.event);
			if (event?.loaded)
				return event.play(terra.file.playback.PlaybackDetails.get().setPos(actor.core.pos));
			return null;
		}

		if (!s.key)
			return null;

		let sound = soundRegistry.get(s.key);
		if (!sound) {
			try {
				sound = terra.file.sound?.Sound?.fetch({ sound: s.key });
				if (sound)
					soundRegistry.set(s.key, sound);
			} catch (err) {	}
		}
		if (!sound)
			return null;

		return sound.play(terra.file.playback.PlaybackDetails.get().setPos(actor.core.pos), s.vol ?? 1, s.speed ?? 1);
	} catch (err) {
		console.warn("[TT Client] Failed to play synced sound:", err);
		return null;
	} finally {
		soundSyncSuppress.depth--;
	}
}

export function applySyncedVolume(playback, vol) {
	if (!playback?.gain?.gain || typeof vol !== "number")
		return;
	try {
		const time = terra.export.g_audio?.time ?? 0;
		playback.gain.gain.cancelScheduledValues(time);
		playback.gain.gain.setValueAtTime(vol, time);
	} catch (err) {
		// ignore
	}
}

// Mirror the sender's equipped weapon (figure + fade fx) onto the peer actor.
export function updateWeaponState(actor, newWeapon) {
	actor.terraTogether.weapon ??= {};
	let weaponState = actor.terraTogether.weapon;
	let playerFx = terra.export.g_player?.entity?.player?.fx;
	let weapon = terra.export.g_player?.combat?.weapons?.get(newWeapon.weapon);

	if (!weapon) {
		if (weaponState.attach) {
			if (!weaponState.back) {
				const fx = terra.export.g_combat.hyperMode ? playerFx.weaponFrameRepeatHyper : playerFx.weaponFrameRepeat;
				terra.export.FrameRepeatEntity.get(actor, fx).start();
			}
			weaponState.timer = 0;
			actor.view.figState.removeFigure(weaponState.attach);
			weaponState.current = null;
			weaponState.attach = null;
		}
		return;
	}

	let targetWeapon = weapon.config.getFigure(newWeapon.back);
	let swapped = false;
	if (!weaponState.attach || weaponState.attach.figure != targetWeapon) {
		if (weaponState.attach)
			actor.view.figState.removeFigure(weaponState.attach);
		weaponState.attach = actor.view.figState.addFigure(targetWeapon);
		swapped = true;
	}
	if (swapped || newWeapon.back != weaponState.back || (!newWeapon.back && weaponState.timer > 0)) {
		terra.export.FxEntity.clearEntity(actor.core, "weaponFade");
		const fx = newWeapon.back ? playerFx.weaponShowBack : playerFx.weaponShow;
		fx.spawnEntity(actor, terra.export.ENT_ALIGN.NODE_WEAPON_R).setPart(terra.export.FIGURE_PART.PART_7).setGroup("weaponFade").start();
		weaponState.timer = 0;
	}

	if (weaponState.timer > terra.export.PLAYER_CONFIG.WEAPON_FLASH_HIDE && newWeapon.timer <= terra.export.PLAYER_CONFIG.WEAPON_FLASH_HIDE) {
		playerFx.weaponHide.spawnEntity(actor, terra.export.ENT_ALIGN.NODE_WEAPON_R).setPart(terra.export.FIGURE_PART.PART_7).setGroup("weaponFade").start();
	}
	weaponState.current = weapon;
	weaponState.back = newWeapon.back;
	weaponState.timer = newWeapon.timer;
}

// Drain the inbound peer updates and scene actions into the actors. Called once per frame
// from MultiplayerClient.onPreUpdate() (before the game updates the world).
export function updateOtherPlayers() {
	const allUpdates = [...playerUpdates.entries()];
	playerUpdates.clear();

	for (const [id, state] of allUpdates) {
		movePlayerActor(id, state);
	}

	const allActions = [...playerActions.entries()];
	playerActions.clear();

	for (const [id, action] of allActions) {
		if (action == "HIDE") {
			const actor = playerActors.get(id);
			if (actor) {
				clearPeerFx(actor);
				actor.terraTogether.fxHidden = true;
				// The in-game menu freezes peer actors (time factor 0), which also
				// freezes the hide fade. Restore normal speed so it can play.
				setActorTimeFactor(actor, 1);
				actor.core?.hide();
			}
		} else if (action == "PAUSE") {
			let actor = playerActors.get(id);
			if (!actor) continue;

			setActorTimeFactor(actor, 0);
		}
	}
}

//# sourceURL=/mods/terra-together/client/actors.js
