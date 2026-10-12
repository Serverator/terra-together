export { joinServer, leaveServer, disconnect, isConnected, isConnecting, send }

import { skins } from "./skin.js";
import { isHosting, getHostPort } from "./server.js";

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

let actorFxQueue = [];
let globalFxQueue = [];
let fxStopQueue = [];
let soundQueue = [];
let windboxQueue = [];

// Sound resources by buffer path; sounds sync by path and re-resolve on the peer.
const soundRegistry = new Map();

// >0 while inside a sound source intentionally not synced here (see actorFx).
let soundSyncSuppress = 0;

let fxSyncId = 0;
let syncHooksInstalled = false;

let soundSyncId = 0;
let soundStopQueue = [];
const activeSyncedSounds = new Map();

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

class MultiplayerClient extends terra.export.Observable {
	onPreUpdate() {
		updateOtherPlayers();
	}

	onPostUpdate() {
		sendPlayerData();
	}

	// Clear peer actors when entering a new map.
	onGameMapLoad() {
		stopAllActorSounds();
		playerActors.clear();
		playerUpdates.clear();
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

		playerActors.clear();
		playerUpdates.clear();

		let map = terra.export.g_game.map.active?.path;
		send({ type: "join_map", map });

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

				// Player-owned = attached to the player or spawned by a player step
				// (SPAWN_FX), so ground impacts count too.
				const owner = this.stepContext?.entity;
				const targetEnt = this.target?.getFollowEntity?.() ?? this.target?.entity ?? null;
				const onPlayer = isPlayerEntity(targetEnt);

				if (onPlayer || isPlayerEntity(owner)) {
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
	let scene = SCENE_STATE[terra.export.g_scene?.currentState ?? 0];
	let lastUpdate = playerUpdates.get(id);

	// If the previous update hasn't been consumed yet, carry its one-shot events over.
	if (lastUpdate && scene == "RUNNING") {
		state.globalFx ??= [];
		state.fxStops ??= [];
		state.soundStops ??= [];
		state.windboxes ??= [];

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

				case "player_profile":
					playerNames.set(msg.id, msg.username);
					break;

				case "update":
					updatePlayerState(msg.id, msg.state);
					break;

				case "player_joined":
					console.log(`[TT Client] Player ${msg.id} joined`);
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
					console.log(`[TT Client] Player ${msg.id} left`);
					break;

				case "join_map":
					console.log(`[TT Client] Player ${msg.id} joined map '${msg.map}'`);
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
		stopActorSounds(actor);
		setActorTimeFactor(actor, 1);
		actor.core?.hide();
	}
	playerActors.clear();
	playerUpdates.clear();
	playerNames.clear();
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

function createPlayerActor(id) {
	// A peer is represented by a TerraActor (NPC) added to the world.
	var actor = new terra.export.TerraActor();

	terra.export.g_gState.addEntity(actor, true, false);

	if (actor.actor)
		actor.actor.phaseOn = false;

	actor.terraTogether = { fxMap: {}, soundMap: {} };

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
	if (state.scene == "LOADING" || state.scene == "TITLE" || state.map != terra.export.g_game.map.active?.path) {
		actor.core?.hide(justCreated);
		return;
	} else {
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

	if (actor.actorExt.actorFx) {
		for (const fx of state.actorFx ?? []) {
			actor.actorExt.actorFx.onActorFx(actor.core, fx.type, fx.vary);
		}
	}

	for (const fxState of state.globalFx ?? []) {
		if (!fxState.effect)
			continue;
		
		let effect = terra.export.Effect.get(fxState.effect);

		if (!effect)
			continue;

		let align = clampAlignToFigure(actor, fxState.alignment);
		let offset = fxState.offset
			? new Vec3(fxState.offset[0], fxState.offset[1], fxState.offset[2])
			: undefined;

		let fx;
		if (fxState.pos) {
			let p = fxState.pos;
			fx = effect.spawnPos(new Vec3(p[0], p[1], p[2]));
		}
		else {
			fx = effect.spawnEntity(actor, align, offset, fxState.rel ?? false);
		}

		if (!fx)
			continue;

		fx.setDelay(fxState.delay ?? 0);
		fx.setPart(fxState.part)
		fx.looped = fxState.looped ?? false;
		fx.attachGroup = fxState.group;
		fx.start(fxState.duration);

		if (fxState.id != null)
			actor.terraTogether.fxMap[fxState.id] = fx;
	}

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

	actor.view?.figState?.setAnim(state.animation || "idle", null);
	actor.view?.figState?.setAnimTime(state.anim_time);

	let rotateInstantly = terra.export.g_scene?.currentState == SCENE_STATE.MENU || justCreated;
	actor.actor?.setFace(new Vec2(state.face_dir[0], state.face_dir[1]), rotateInstantly);

	updateWeaponState(actor, state.weapon)
}

function setActorTimeFactor(actor, time) {
	if (actor.core?.time) {
		actor.core.time.factor = time;
		actor.core.time.logicFactor = time;
	}

	if (actor.move?.influencer) {
		actor.move.influencer.globalInvTime = time;
		actor.move.influencer.globalInvLogic = time;
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

function stopAllActorSounds() {
	for (const actor of playerActors.values())
		stopActorSounds(actor);
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

	// Time factor of this client
	let timeFactor = g_system.loopPaused ? 0 : g_system.timeFactor.world; 

	if (timeFactor === 0) {
		if (pausedSent && !forceSend) return;
		pausedSent = true;
	} else {
		pausedSent = false;
	}

	state.timeFactor = timeFactor;

	state.char = g_player.entity?.npc?.char?.path;
	state.figure = g_player.entity?.view?.getFigure()?.name;

	state.scene = scene;

	state.map = terra.export.g_game.map.active?.path;

	state.position = g_player.entity?.core?.pos?.clone().v;
	state.velocity = g_player.entity?.move?.vel?.clone().v;

	// Copy current animation state
	state.animation = g_player.entity?.view?.figState?.anim?.name || "idle";
	state.anim_time = g_player.entity?.view?.figState?.time;

	// Copy the look direction
	state.face_dir = g_player.entity?.actor?.face?.clone().v;

	let weapon = g_player.entity?.player?.weapon;
	state.weapon = { weapon: weapon?.current?.name, back: weapon?.back ?? false, timer: weapon?.timer ?? 0 };

	// Send effect data
	state.actorFx = [...actorFxQueue];
	actorFxQueue = [];

	state.globalFx = [...globalFxQueue];
	globalFxQueue = [];

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
				stopActorSounds(actor);
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
