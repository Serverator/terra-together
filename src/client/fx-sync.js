/**
 * src/client/fx-sync.js
 * Peer effect / sound / projectile synchronisation: the local capture hooks that fill the
 * sync queues, and the replay that rebuilds a peer's fx and sounds on our side.
 * Responsibilities:
 *   - FX predicates (isPlayerEntity/isPlayerTied, clampAlignToFigure) and the screen-global
 *     step suppression (vignette/blur/shake must not replay onto the peer's screen), plus
 *     the LOCAL_ONLY_FX deny list.
 *   - Local capture: FxEntity/Sound/AudioEvent/Playback/ProxyDef patches, the SPAWN_WINDBOX
 *     knockback hook and the local player's actorFx injection — all feeding `queues` in
 *     ./session.js.
 *   - Remote replay: spawnRemoteFx/reconcilePersistentFx/clearUntrackedRunFx, plus the
 *     per-peer teardown clearPeerFx (its fx *and* its synced sounds).
 *   - Rogue seed/variant sync (installRogueSeedHook) and the sound-bus sync policy.
 * Public surface: installFxSyncHooks, installActorFxInjection, installRogueSeedHook,
 *   spawnRemoteFx, reconcilePersistentFx, clearUntrackedRunFx, clearPeerFx,
 *   spawnRemoteProjectile, stopActorSounds
 * Engine touchpoints: terra.export.{FxEntity,Sound? via terra.file.sound,AudioEvent,
 *   Playback,Projectile,ProxyDef,GenericProxy,HitForce,ACTION_STEP,Effect,Target,Vec3,
 *   g_windboxManager,g_rogue,g_player,g_actorGlobals,g_fxConnect,g_gState},
 *   terraTogether.steps.SPAWN_WINDBOX, terra.file.{sound,audioEvent,playback,actorSound,
 *   hitSounds,playerCombat,fxBase}
 * Notes: the sync queues/registries are NOT declared here: they are shared with
 *   ./snapshot.js and ./actors.js and live in ./session.js (see its header). This module
 *   owns only capture-local state (fxSyncId, soundSyncId, projSyncId, spawningVisualCopy,
 *   syncHooksInstalled, projectileHooksInstalled, rogueSeedHookInstalled) and the patch
 *   caches. Import graph: session <- fx-sync.
 *   Decompiled refs: fx-light.js:92 (LIGHT step's global climate darkening),
 *   actor-fx.js:77-89 (POST_MOVE run glow, group "__runFX__").
 */

import {
	queues, soundRegistry, activeSyncedSounds, activePersistentFx, soundSyncSuppress,
	RUN_FX_GROUPS, hasClient, getPeerRogueSeed, Vec3,
} from "./session.js";

// --- Capture-local sync state -------------------------------------------------
let fxSyncId = 0;
let syncHooksInstalled = false;
let projectileHooksInstalled = false;

let projSyncId = 0;
// True only during a receiver-initiated mirror spawn (see spawnRemoteProjectile).
let spawningVisualCopy = false;

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
// on death with an infinite duration (`combatant-cmp.js` onDeathHit -> start(-1)). On
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
// player's ghost actor; damage is suppressed so shots only show up.

// Resolve a proxy def by name: the local player's config proxies (weapon proxies
// are local names like "arrow") first, then global actor-globals proxies.
function resolveProxyDef(name) {
	if (!name)
		return null;
	const local = terra.export.g_player?.config?.proxies?.[name];
	if (local)
		return local;
	return terra.export.g_actorGlobals?.getProxy?.(name) ?? null;
}

// A cosmetic projectile needs an owner damager whose .ent is the ghost and whose
// .stats is non-null (Projectile.init reads owner.stats.getCombatant()). Create one
// lazily per ghost; no AttackerCmp, so the ghost is not registered as an attacker.
function getVisualDamager(actor) {
	if (!actor)
		return null;
	if (actor.terraTogether?.ttDamager)
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

// Spawn one mirrored projectile on a peer actor (receiver side; see the ProxyDef.spawn
// hook for the sender side).
export function spawnRemoteProjectile(actor, p) {
	const def = resolveProxyDef(p.name);
	if (!def)
		return;
	const damager = getVisualDamager(actor);
	if (!damager)
		return;

	// Element is the variant index (0 neutral, 1 aether, 2 ignis, 3 cryo). init
	// copies it from the owner damager, so set it right before spawning.
	damager.variant = p.variant ?? 0;

	const pos = new Vec3(p.pos[0], p.pos[1], p.pos[2]);
	const dir = new Vec3(p.dir[0], p.dir[1], p.dir[2] ?? 0);

	// Mark the spawn as a mirror for the ProxyDef.spawn wrapper. Proxies are pooled,
	// so the flag is (re)assigned on every spawn rather than trusting the instance.
	spawningVisualCopy = true;
	try {
		visualDef(def).spawn(pos, dir, damager, p.group ?? null);
	}
	finally {
		spawningVisualCopy = false;
	}
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
				if (args[1] != FX_TYPE.POST_MOVE)
					queues.actorFx.push({ type: args[1], vary: args[2] });
				return result;
			};
			actorFx._injected = true;
		}
	}
}

// Install the outbound capture hooks. The windbox hook is re-wrapped on every call (as in
// the monolith); the heavier Fx/Sound/Projectile patches install once per session.
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

			// Screen-global effects are still synced for their world visuals, but the
			// sender's own vignette/blur/shake steps are dropped on the peer above.
			// Local-only feedback (e.g. the A/B loadout quick-switch) is never synced.
			if ((onPlayer || isPlayerEntity(owner)) && !isLocalOnlyEffect(this.effect)) {
				let id = (this._ttFxId = ++fxSyncId);
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
				// Unattached effects (e.g. ground impacts) keep their world position at spawn.
				if (!onPlayer) {
					const v = new Vec3();
					if (this.target?.get(v))
						fx.pos = v.v;
					else if (this.core?.pos)
						fx.pos = this.core.pos.clone().v;
				}
				// Infinite fx (e.g. status conditions use start(-1)) never end on their own, so a
				// peer only ever learns of them from a spawn. Remember them to re-send every frame
				// until they stop, so peers entering our room can rebuild the ones they missed.
				if (fx.duration < 0)
					activePersistentFx.set(id, { fx: this, desc: fx });
				if (hasClient())
					queues.globalFx.push(fx);
			}
			else {
				this._ttFxId = 0;
			}
			return originalFxStart.apply(this, args);
		};

		// Enter/exit appear/disappear fx fade the target's figure. Each client plays
		// its own, so they must NOT sync (a replayed fade can leave the peer invisible).
		let originalInitHideShowChange = terra.export.FxEntity.prototype.initHideShowChange;
		terra.export.FxEntity.prototype.initHideShowChange = function (...args) {
			if (this._ttFxId) {
				for (let i = queues.globalFx.length - 1; i >= 0; i--) {
					if (queues.globalFx[i].id === this._ttFxId) {
						queues.globalFx.splice(i, 1);
						break;
					}
				}
				this._ttFxId = 0;
			}
			return originalInitHideShowChange.apply(this, args);
		};

		// Despawn: stop() is the real teardown path for looped/infinite fx, so
		// hooking it removes them on peers too.
		let originalFxStop = terra.export.FxEntity.prototype.stop;
		terra.export.FxEntity.prototype.stop = function (...args) {
			if (this._ttFxId)
				activePersistentFx.delete(this._ttFxId);
			if (this._ttFxId && !this._ttFxStopSent) {
				this._ttFxStopSent = true;
				if (hasClient())
					queues.fxStops.push({ id: this._ttFxId, delay: args[0] ?? 0, softStop: args[1] ?? false });
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
				// player); fall back to the ambient context for global/offset sounds.
				const ctxEnt = terra.export.g_gState?.contextEntity?.ent;
				if (playback) {
					const tied = hasClient() && !soundSyncSuppress.depth && this.path &&
						isSyncableBus(this.settings?.type) &&
						(isPlayerTied(args[0]?.targetRes?.entity) || isPlayerTied(ctxEnt));
					if (tied) {
						const id = ++soundSyncId;
						playback._ttSoundId = id;
						activeSyncedSounds.set(id, { playback, lastVol: -1 });
						queues.sounds.push({ id, key: this.path, vol: args[1] ?? 1, speed: args[2] ?? 1 });
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
					const tied = hasClient() && !soundSyncSuppress.depth && this.cacheKey &&
						isSyncableBus(this.type) &&
						(isPlayerTied(args[0]?.targetRes?.entity) || isPlayerTied(ctxEnt));
					if (tied) {
						const id = ++soundSyncId;
						instance.playback._ttSoundId = id;
						activeSyncedSounds.set(id, { playback: instance.playback, lastVol: -1 });
						queues.sounds.push({ id, event: this.cacheKey });
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
					if (hasClient()) queues.soundStops.push({ id: this._ttSoundId });
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
				if (HitForce?.prototype?.isHitCompatible) {
					let originalIsHitCompatible = HitForce.prototype.isHitCompatible;
					HitForce.prototype.isHitCompatible = function (...args) {
						if (this.damager?.ent?.__ttVisual)
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
				// block the single spawn path for its sub-proxies too.
				let originalSpawnSubProxy = Projectile.prototype.spawnSubProxy;
				Projectile.prototype.spawnSubProxy = function (...args) {
					if (this.__ttVisual)
						return undefined;
					return originalSpawnSubProxy.apply(this, args);
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

					// Ranged attacks spawn both Projectile and Generic proxies (e.g. the
					// crossbow's "shoot down" fires Generic arrowUp), so mirror both. Only
					// the local player's: peers' copies are owned by ghosts and already
					// marked visual, so they never echo back.
					const mirrored = proxy instanceof Projectile
						|| (GenericProxy && proxy instanceof GenericProxy);
					if (hasClient() && mirrored && !isMirror
						&& terra.export.g_player?.isPlayer?.(damager?.getRoot?.())) {
						queues.projectiles.push({
							id: ++projSyncId,
							name: this.name,
							pos: [pos.x, pos.y, pos.z],
							dir: [dir.x, dir.y, dir.z ?? 0],
							variant: damager?.variant ?? 0,
							group: group ?? null,
						});
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
// one-shot globalFx path and the persistent-fx reconcile below.
export function spawnRemoteFx(actor, fxState, source = "oneshot") {
	if (!fxState?.effect)
		return null;

	const effect = terra.export.Effect.get(fxState.effect);
	if (!effect)
		return null;

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
		const fx = spawnRemoteFx(actor, fxState, "persist");
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

//# sourceURL=/mods/terra-together/client/fx-sync.js
