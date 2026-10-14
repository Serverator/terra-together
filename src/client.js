export { joinServer, leaveServer, disconnect, isConnected, isConnecting, send }

import { skins } from "./skin.js";
import { isHosting, getHostPort } from "./server.js";
import { Reviver } from "./revive.js";

const { SCENE_STATE, SCENE_EVENT } = terra.file.sceneTypes;

const Vec2 = terra.export.Vec2;
const Vec3 = terra.export.Vec3;

let lastScene = "INIT";

let client = null;
let clientHandlers = null;
let playerId = null;
let connected = false;
let connecting = false;
// True while the connection is pinned to our own hosted server (cannot be dropped
// by the player; it follows hosting state instead).
let forced = false;

const playerActors = new Map();
const playerNames = new Map();

window.terraTogether ??= {};
window.terraTogether.playerActors = playerActors;
window.terraTogether.playerNames = playerNames;

const playerUpdates = new Map();
const playerActions = new Map();

// Network ids of other connected players (drives hasPeers()).
const peers = new Set();

// Downed/revive state (see revive.js): whether our own player is down, and per-peer
// down state propagated through the normal player state sync.
let localDowned = false;
const peerDowned = new Map();
function setLocalDowned(value) { localDowned = !!value; }
function getPeerDowned() { return peerDowned; }

// Last known rogue identity per peer: { seed, variant }. Kept sticky (not cleared
// every frame) so an in-progress run's seed stays available to adopt later.
const peerRogue = new Map();

// All config lives in the in-game options (Options > Mods tab); there is no config.json.
function getSetting(key, fallback) {
	const value = terra.export.g_options?.get(key);
	return (value === undefined || value === null || value === "") ? fallback : value;
}

function getUsername() {
	const name = String(getSetting("tt-username", "")).trim();
	return name === "" ? null : name;
}

function getServerUrl() {
	// When hosting, the connection is pinned to our own server on localhost.
	if (forced && isHosting())
		return `ws://127.0.0.1:${getHostPort()}`;
	const host = getSetting("tt-server-address", "127.0.0.1");
	const port = getSetting("tt-server-port", 17005);
	return `ws://${host}:${port}`;
}

// True while at least one other player is connected.
function hasPeers() {
	return peers.size > 0;
}

// Downed/revive handling lives in its own module.
const reviver = new Reviver({
	send,
	isConnected,
	hasPeers,
	getLocalId: () => playerId,
	getPlayerActors: () => playerActors,
	getPeerDowned,
	setLocalDowned,
});

let actorFxQueue = [];
let globalFxQueue = [];
let fxStopQueue = [];
let soundQueue = [];
let windboxQueue = [];
let projectileQueue = [];
let projSyncId = 0;
// True only during a receiver-initiated mirror spawn (see spawnRemoteProjectile).
let spawningVisualCopy = false;

// Sound resources by buffer path; sounds sync by path and re-resolve on the peer.
const soundRegistry = new Map();

// >0 while inside a sound source intentionally not synced here (see actorFx).
let soundSyncSuppress = 0;

let fxSyncId = 0;
let syncHooksInstalled = false;
let projectileHooksInstalled = false;

let soundSyncId = 0;
let soundStopQueue = [];
const activeSyncedSounds = new Map();

// Player-owned *infinite* fx (status conditions, hold loops, ...) currently alive on the
// local player, keyed by their sync id: id -> { fx: FxEntity, desc: descriptor }. Re-sent
// every frame so a peer entering our room can rebuild lasting fx whose one-shot spawn they
// dropped while apart.
const activePersistentFx = new Map();

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

// Local player's rogue sublayout identity. `variant` is the seeded layout of the
// current room and is null outside an active rogue run, so it only affects syncing
// while in the roguelike mode.
function getRogueInfo() {
	const g = terra.export.g_rogue;
	if (!g || !g.isActive())
		return { seed: null, variant: null };
	const room = g.getCurrentRoom?.();
	return {
		seed: g.run ? g.run.getRunState().seed : null,
		variant: room?.config ? room.variant : null,
	};
}

// Seed of any peer currently in a rogue run, so a fresh run can reuse it.
function getPeerRogueSeed() {
	for (const info of peerRogue.values()) {
		if (info?.seed)
			return info.seed;
	}
	return null;
}

// Patch RogueManager.startRun so a run started without an explicit seed adopts an
// in-progress peer's seed, keeping floor layouts identical between players.
let rogueSeedHookInstalled = false;
function installRogueSeedHook() {
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
		if (effective && window.terraTogether?.rogueDebug)
			console.debug("[TT rogue] adopting peer seed", effective);
		return originalStartRun.call(this, effective);
	};
}

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

function spawnRemoteProjectile(actor, p) {
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

class MultiplayerClient extends terra.export.Observable {
	onPreUpdate() {
		updateOtherPlayers();
		reviver.onPreUpdate();
	}

	onPostUpdate() {
		sendPlayerData();
	}

	// Clear peer actors when entering a new map.
	onGameMapLoad() {
		for (const actor of playerActors.values())
			clearPeerFx(actor);
		playerActors.clear();
		playerUpdates.clear();
		reviver.onMapLoad();
	}

	onOptionEvent(event, key) {
		if (key = 'tt-skin') {
			sendPlayerData(true);
		}
	}

	// Join the server and hook the player's actorFx on map start.
	onGameMapStart() {
		if (!client)
			joinServer(undefined, { force: isHosting() });

		for (const actor of playerActors.values())
			clearPeerFx(actor);
		playerActors.clear();
		playerUpdates.clear();

		let map = terra.export.g_game.map.active?.path;
		let variant = getRogueInfo().variant;
		send({ type: "join_map", map, variant });

		let player = terra.export.g_player.entity;
		if (player?.actorExt?.actorFx) {
			let actorFx = player.actorExt.actorFx;

			if (!actorFx._injected) {
				let originalOnPlayerFx = actorFx.onActorFx;
				player.actorExt.actorFx.onActorFx = function (...args) {
					const result = originalOnPlayerFx.apply(player.actorExt.actorFx, args);
					const FX_TYPE = terra.export.ACTOR_FX_TYPE;
					if (args[1] != FX_TYPE.POST_MOVE)
						actorFxQueue.push({ type: args[1], vary: args[2] });
					return result;
				};
				actorFx._injected = true;
			}


		}
	}

	onFocusChange(focused) {
		if (focused)
			return;
		// Only meaningful while in a world: at the title the character is already
		// unloaded, and a focus change must not re-show it for other players.
		const scene = SCENE_STATE[terra.export.g_scene?.currentState ?? 0];
		if (scene != "RUNNING")
			return;
		send({ type: "scene_changed", scene: "PAUSED" });
		sendPlayerData(true, "PAUSED");
	}

	onLoopStart() {
		installRogueSeedHook();
		reviver.onLoopStart();

		terra.export.g_scene.observers.push(this);
		terra.export.g_options.observers.push(this);

		let focusChange = this.onFocusChange;
		let originalsetWindowFocus = terra.export.System.prototype.setWindowFocus;
		terra.export.System.prototype.setWindowFocus = function (...args) {
			const result = originalsetWindowFocus.apply(this, args);
			focusChange(!args[0]);
			return result;
		};

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
				if (client)
					windboxQueue.push(windbox);
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
					if (client)
						globalFxQueue.push(fx);
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
					for (let i = globalFxQueue.length - 1; i >= 0; i--) {
						if (globalFxQueue[i].id === this._ttFxId) {
							globalFxQueue.splice(i, 1);
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
					if (client)
						fxStopQueue.push({ id: this._ttFxId, delay: args[0] ?? 0, softStop: args[1] ?? false });
				}
				return originalFxStop.apply(this, args);
			};

			// Effect sounds are already replayed by the peer's effect, so don't sync
			// them here (they'd double).
			let originalFxDeferredUpdate = terra.export.FxEntity.prototype.deferredUpdate;
			terra.export.FxEntity.prototype.deferredUpdate = function (...args) {
				soundSyncSuppress++;
				try { return originalFxDeferredUpdate.apply(this, args); }
				finally { soundSyncSuppress--; }
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
						const tied = client && !soundSyncSuppress && this.path &&
							isSyncableBus(this.settings?.type) &&
							(isPlayerTied(args[0]?.targetRes?.entity) || isPlayerTied(ctxEnt));
						if (window.terraTogether?.soundDebug)
							console.debug("[TT sound]", this.path, "bus=" + (this.settings?.type?.bus ?? "?"), "tied=" + tied, "suppress=" + soundSyncSuppress);
						if (tied) {
							const id = ++soundSyncId;
							playback._ttSoundId = id;
							activeSyncedSounds.set(id, { playback, lastVol: -1 });
							soundQueue.push({ id, key: this.path, vol: args[1] ?? 1, speed: args[2] ?? 1 });
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
						const tied = client && !soundSyncSuppress && this.cacheKey &&
							isSyncableBus(this.type) &&
							(isPlayerTied(args[0]?.targetRes?.entity) || isPlayerTied(ctxEnt));
						if (window.terraTogether?.soundDebug)
							console.debug("[TT event]", this.cacheKey, "bus=" + (this.type?.bus ?? "?"), "tied=" + tied, "suppress=" + soundSyncSuppress);
						if (tied) {
							const id = ++soundSyncId;
							instance.playback._ttSoundId = id;
							activeSyncedSounds.set(id, { playback: instance.playback, lastVol: -1 });
							soundQueue.push({ id, event: this.cacheKey });
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
						if (client) soundStopQueue.push({ id: this._ttSoundId });
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
					soundSyncSuppress++;
					try { return original.apply(this, args); }
					finally { soundSyncSuppress--; }
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
						if (client && mirrored && !isMirror
							&& terra.export.g_player?.isPlayer?.(damager?.getRoot?.())) {
							projectileQueue.push({
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

	onSceneStateEvent(event) {
		let scene = SCENE_STATE[terra.export.g_scene.currentState];
		if (event != SCENE_EVENT.SCENE_CHANGED && scene != lastScene) return;
		lastScene = scene;

		if (client)
			send({ type: "scene_changed", scene });
	}
}

terra.addAddon(new MultiplayerClient(), { onGameMapStart: 35000, onLoopStart: 35000 });

function updatePlayerState(id, state) {
	// Remember the peer's rogue seed/variant even while it is hidden (menu/pause),
	// so variant matching stays correct and its seed can still be adopted.
	if (state)
		peerRogue.set(id, { seed: state.seed ?? null, variant: state.variant ?? null });
	peerDowned.set(id, !!state?.downed);

	let scene = SCENE_STATE[terra.export.g_scene?.currentState ?? 0];
	let lastUpdate = playerUpdates.get(id);

	// If the previous update hasn't been consumed yet, carry its one-shot events over.
	if (lastUpdate && scene == "RUNNING") {
		state.globalFx ??= [];
		state.actorFx ??= [];
		state.sounds ??= [];
		state.soundVols ??= [];
		state.fxStops ??= [];
		state.soundStops ??= [];
		state.windboxes ??= [];
		state.projectiles ??= [];

		for (const fx of lastUpdate.actorFx ?? []) {
			state.actorFx.push(fx);
		}

		// Sounds/volumes were previously dropped here: with the server on the same
		// machine updates can outpace frames, losing a peer's one-shot sounds.
		for (const s of lastUpdate.sounds ?? []) {
			state.sounds.push(s);
		}

		for (const v of lastUpdate.soundVols ?? []) {
			state.soundVols.push(v);
		}

		for (const fx of lastUpdate.globalFx ?? []) {
			state.globalFx.push(fx);
		}

		for (const fx of lastUpdate.fxStops ?? []) {
			state.fxStops.push(fx);
		}

		for (const st of lastUpdate.soundStops ?? []) {
			state.soundStops.push(st);
		}

		for (const fx of lastUpdate.windboxes ?? []) {
			state.windboxes.push(fx);
		}

		for (const p of lastUpdate.projectiles ?? []) {
			state.projectiles.push(p);
		}
	}
	
	playerUpdates.set(id, state);
}

function joinServer(address, options = {}) {
	// Replace any existing connection (e.g. switching from a remote server to hosting).
	if (client)
		detachClient();

	forced = !!options.force;
	connecting = true;
	address = address ?? getServerUrl();

	let ws;
	try {
		ws = new WebSocket(address);
	}
	catch (err) {
		console.error(`[TT Client] Invalid server address '${address}':`, err);
		connecting = false;
		forced = false;
		return;
	}
	client = ws;

	const onOpen = () => {
		if (client !== ws) return;
		connected = true;
		connecting = false;
		console.log("[TT Client] Connected to server");
	};

	const onMessage = (event) => {
		if (client !== ws) return;
		try {
			let msg = JSON.parse(event.data);

			switch (msg.type) {
				case "welcome":
					console.log("[TT Client] Connected to the server");
					playerId = msg.id;
					// Username is sent exactly once per connection, not with every update.
					send({ type: "profile", username: getUsername() });
					break;

				case "host_setting":
					// Host-authoritative: the host's revive toggle, obeyed by every client.
					// Apply with skipNotify so it does NOT re-fire CHANGED (which would
					// re-broadcast it and loop); set the runtime flag directly instead.
					if (msg.key === "tt-revive") {
						const on = msg.value === true;
						window.terraTogether.reviveEnabled = on;
						const g = terra.export.g_options;
						if (g?.settings?.["tt-revive"] && g.get("tt-revive") !== on)
							g.set("tt-revive", on, true);
					}
					break;

				case "player_profile":
					playerNames.set(msg.id, msg.username);
					peers.add(msg.id);
					break;

				case "update":
					updatePlayerState(msg.id, msg.state);
					break;

				case "player_joined":
					console.log(`[TT Client] Player ${msg.id} joined`);
					peers.add(msg.id);
					updatePlayerState(msg.id, msg.state);
					break;

				case "scene_changed":
					// Title screen: unload this player's character for everyone else.
					if (msg.scene == "LOADING" || msg.scene == "TITLE") {
						playerActions.set(msg.id, "HIDE");
					}
					// In-game menu / window focus lost: keep them in place but frozen.
					if (msg.scene == "MENU" || msg.scene == "PAUSED") {
						playerActions.set(msg.id, "PAUSE");
					}
					break;

				case "player_left":
					playerActions.set(msg.id, "HIDE");
					playerNames.delete(msg.id);
					peers.delete(msg.id);
					peerRogue.delete(msg.id);
					peerDowned.delete(msg.id);
					console.log(`[TT Client] Player ${msg.id} left`);
					break;

				case "join_map":
					console.log(`[TT Client] Player ${msg.id} joined map '${msg.map}'`);
					break;

				case "revive":
				case "revive_progress":
					reviver.onMessage(msg);
					break;
			}
		} catch (err) {
			console.warn("Error on client 'message':", err);
			return;
		}
	};

	const onClose = () => {
		if (client !== ws) return;
		connecting = false;
		console.log("Disconnected from server.");
		onDisconnected();
	};

	const onError = () => {
		if (client !== ws) return;
		connecting = false;
		// A WebSocket 'error' event is a plain Event with no message, so logging
		// err.message just prints "undefined". A hosted connection recovers through
		// onDisconnected()'s forced retry.
		console.error("[TT Client] Connection error (server unreachable)");
		onDisconnected();
	};

	ws.addEventListener("open", onOpen);
	ws.addEventListener("message", onMessage);
	ws.addEventListener("close", onClose);
	ws.addEventListener("error", onError);

	clientHandlers = { open: onOpen, message: onMessage, close: onClose, error: onError };
}

// Tear down a connection without its close/error events reaching onDisconnected.
function detachClient() {
	if (!client)
		return;
	const ws = client;
	if (clientHandlers) {
		ws.removeEventListener("open", clientHandlers.open);
		ws.removeEventListener("message", clientHandlers.message);
		ws.removeEventListener("close", clientHandlers.close);
		ws.removeEventListener("error", clientHandlers.error);
	}
	clientHandlers = null;
	try { ws.close(); } catch (e) { /* ignore */ }
	client = null;
	connected = false;
	clearPeers();
}

// Drop all per-connection state. Shared by detachClient() and onDisconnected().
function clearPeers() {
	// Hide any existing peer actors before dropping references, otherwise they stay
	// rendered in the world as untracked orphans.
	for (const actor of playerActors.values()) {
		clearPeerFx(actor);
		setActorTimeFactor(actor, 1);
		actor.core?.hide();
	}
	playerActors.clear();
	playerUpdates.clear();
	playerNames.clear();
	peerRogue.clear();
	peers.clear();
	peerDowned.clear();
	localDowned = false;
	reviver.onConnectionReset();
	playerId = null;
	connecting = false;
}

function leaveServer() {
	// Manual disconnect also clears the forced (hosting) flag.
	forced = false;
	if (!client) {
		connecting = false;
		return console.log("Not connected.");
	}
	client.close();
}

// Alias used by the settings menu.
function disconnect() {
	leaveServer();
}

function isConnected() {
	return connected && !!client && client.readyState === WebSocket.OPEN;
}

function isConnecting() {
	return connecting;
}

// Clean up local state after a disconnect. The player is never moved out of their
// current scene: a dropped connection just clears the peers until they reconnect.
function onDisconnected() {
	if (!client && !connected)
		return;
	client = null;
	clientHandlers = null;
	connected = false;
	clearPeers();

	// A hosted connection is mandatory: rejoin our own server while it is up.
	if (forced && isHosting()) {
		setTimeout(() => {
			if (forced && isHosting() && !client)
				joinServer(undefined, { force: true });
		}, 1000);
	}
}

function send(data) {
	if (client && client.readyState === WebSocket.OPEN) {
		client.send(JSON.stringify(data));
	}
}

// Spawn one synced fx on a peer actor from a descriptor sent by its owner. Shared by the
// one-shot globalFx path and the persistent-fx reconcile below.
function spawnRemoteFx(actor, fxState) {
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
	fx.start(fxState.duration);
	return fx;
}

// Keep a peer's lasting (infinite) fx in step with the owner's current snapshot: spawn the
// ones we're missing (e.g. a debuff gained while they were away) and stop the ones they no
// longer have. The owner re-sends the snapshot every frame.
function reconcilePersistentFx(actor, list) {
	const map = actor.terraTogether.fxMap;
	const prev = actor.terraTogether.persistentIds ?? new Set();
	const next = new Set();

	for (const fxState of list ?? []) {
		if (fxState?.id == null || !fxState.effect)
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
function clearPeerFx(actor) {
	if (!actor)
		return;
	try { terra.export.FxEntity?.clearEntity?.(actor.core); } catch (e) { /* actor already gone */ }
	if (actor.terraTogether) {
		actor.terraTogether.fxMap = {};
		actor.terraTogether.persistentIds = null;
	}
	stopActorSounds(actor);
}

function createPlayerActor(id) {
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

	// Client-side step sound/fx is inconsistent, so suppress it for peer actors and
	// replay from the server instead. TODO: visual fx can still get lost.
	let originalOnPostMove = actor.actor.onPostMove;
	actor.actor.onPostMove = function (...args) {
		const originalOnActorFx = this.fxCallback?.onActorFx;

		if (originalOnActorFx) {
			this.fxCallback.onActorFx = function (core, type, vary) {
				if (type === terra.export.ACTOR_FX_TYPE.STEP || type === terra.export.ACTOR_FX_TYPE.STEP_2) {
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
function movePlayerActor(id, state) {
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

	// HP ratio (0..1) for the nameplate HP bar (see nameplates.js).
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
	// while away), and drop the ones they no longer report.
	reconcilePersistentFx(actor, state.persistentFx);

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

function setActorTimeFactor(actor, time) {
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

function playSyncedSound(actor, s) {
	if (!s || !actor?.core)
		return null;

	// Sounds emitted while replaying must not be re-broadcast.
	soundSyncSuppress++;
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
		soundSyncSuppress--;
	}
}

function applySyncedVolume(playback, vol) {
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

function stopActorSounds(actor) {
	const map = actor?.terraTogether?.soundMap;
	if (!map) return;
	for (const id in map)
		map[id]?.stop();
	actor.terraTogether.soundMap = {};
}


// Mirror the sender's equipped weapon (figure + fade fx) onto the peer actor.
function updateWeaponState(actor, newWeapon) {
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

// Send only one paused state
let pausedSent = false;

function sendPlayerData(forceSend = false, scene = null) {
	let g_player = terra.export.g_player;
	let g_system = terra.export.g_system;

	if (!scene)
		scene = SCENE_STATE[terra.export.g_scene?.currentState ?? 0];

	// Don't send state when not in game.
	if (scene == "INIT" || scene == "TITLE" || scene == "LOADING" || g_player.entity == null)
		return;
	
	let state = {}

	// Effective *animation* speed of the local player, not the raw world slow factor.
	// Slow-motion abilities use ADD_SLOW_MOTION with invert:"ALL"/"LOGIC", which makes
	// the caster ignore the slow-mo (its core.time.factor/logicFactor compensate). The
	// figure advances by core.getTick(true) = g_tick.world * factor * logicFactor, so
	// sending timeFactor.world alone slowed the peer actor during the wind-up — before
	// the explosion FX (sent a few frames later) had even arrived.
	let timeFactor = 0;
	if (!g_system.loopPaused) {
		const t = g_player.entity?.core?.time;
		timeFactor = g_system.timeFactor.global * g_system.timeFactor.world
			* (t ? t.factor * t.logicFactor : 1);
	}

	// Throttle only on a real engine pause (menu/cutscene), NOT on a slow-motion that
	// bottoms out at 0: a scripted slow-mo (e.g. the tutorial dodge) still moves/faces the
	// player, so position/face must keep flowing while the ghost itself stays frozen
	// (timeFactor 0 makes the peer snap its facing; see movePlayerActor).
	if (g_system.loopPaused) {
		if (pausedSent && !forceSend) return;
		pausedSent = true;
	} else {
		pausedSent = false;
	}

	state.timeFactor = timeFactor;

	state.char = g_player.entity?.npc?.char?.path;
	state.figure = g_player.entity?.view?.getFigure()?.name;

	state.scene = scene;

	state.downed = localDowned;
	state.downedFrac = reviver.downedFraction();

	state.map = terra.export.g_game.map.active?.path;

	// Rogue sublayout identity: variant must match to render a peer; seed is shared so
	// a player starting a run can adopt an in-progress run's seed.
	const rogue = getRogueInfo();
	state.variant = rogue.variant;
	state.seed = rogue.seed;

	state.position = g_player.entity?.core?.pos?.clone().v;
	state.velocity = g_player.entity?.move?.vel?.clone().v;

	// Copy current animation state
	state.animation = g_player.entity?.view?.figState?.anim?.name || "idle";
	state.anim_time = g_player.entity?.view?.figState?.time;

	// Copy the look direction
	state.face_dir = g_player.entity?.actor?.face?.clone().v;

	// HP ratio (0..1) for the peer nameplate HP bar.
	state.hp = g_player.combat?.params?.getHPRatio?.() ?? 1;
	// HP ratio including pending heals (HoT) — the "will stop here" preview the HUD shows.
	state.hp_target = g_player.combat?.params?.getHPRatio?.(0, true) ?? state.hp;

	let weapon = g_player.entity?.player?.weapon;
	state.weapon = { weapon: weapon?.current?.name, back: weapon?.back ?? false, timer: weapon?.timer ?? 0 };

	// Send effect data
	state.actorFx = [...actorFxQueue];
	actorFxQueue = [];

	state.globalFx = [...globalFxQueue];
	globalFxQueue = [];

	// Full snapshot of our lasting (infinite) fx, re-sent every frame (NOT cleared like the
	// queues above) so a peer entering the room rebuilds debuffs it missed while we were
	// apart. Ended instances are pruned here as a backstop.
	const persistent = [];
	for (const [id, entry] of activePersistentFx) {
		if (!entry.fx || entry.fx.hasEnded?.()) {
			activePersistentFx.delete(id);
			continue;
		}
		persistent.push(entry.desc);
	}
	state.persistentFx = persistent;

	state.fxStops = [...fxStopQueue];
	fxStopQueue = [];

	state.sounds = [...soundQueue];
	soundQueue = [];

	// Current volume of still-active synced sounds (e.g. charge loops).
	const vols = [];
	for (const [id, entry] of activeSyncedSounds) {
		const pb = entry.playback;
		if (!pb || pb.stopped) {
			activeSyncedSounds.delete(id);
			continue;
		}
		const v = pb.currentVolume;
		if (typeof v === "number" && (entry.lastVol < 0 || Math.abs(v - entry.lastVol) > 0.005)) {
			entry.lastVol = v;
			vols.push({ id, vol: v });
		}
	}
	state.soundVols = vols;

	state.soundStops = [...soundStopQueue];
	soundStopQueue = [];

	state.windboxes = [...windboxQueue];
	windboxQueue = [];

	state.projectiles = [...projectileQueue];
	projectileQueue = [];

	send({ type: "update", state });
}

function updateOtherPlayers() {
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

//# sourceURL=/mods/terra-together/client.js
