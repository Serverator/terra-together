export { joinServer, leaveServer, send }

import { loadConfig } from "./helper.js";
import { skins } from "./skin.js";

const { SCENE_STATE, SCENE_EVENT } = terra.file.sceneTypes;

const Vec2 = terra.export.Vec2;
const Vec3 = terra.export.Vec3;

let lastScene = "INIT";

let client = null;
let playerId = null;

const playerActors = new Map();
const playerUpdates = new Map();
const playerActions = new Map();

window.terraTogether ??= {};

window.terraTogether.playerActors = playerActors;

let config = loadConfig();

let fxQueue = [];

class MultiplayerClient extends terra.export.Observable {
	onPreUpdate() {
		updateOtherPlayers();
	}

	onPostUpdate() {
		sendPlayerData();
	}

	// When entering new map clean up the reference
	onGameMapLoad() {
		playerActors.clear();
		playerUpdates.clear();
	}

	onOptionEvent(event, key) {
		if (key = 'tt-skin') {
			sendPlayerData(true);
		}
	}

	// Create second actor on map start
	onGameMapStart() {
		if (!client)
			joinServer();

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
						fxQueue.push({ type: args[1], vary: args[2] });
					return result;
				};
				console.debug("Player FX injected!")
				actorFx._injected = true;
			}


		}
	}

	onFocusChange(focused) {
		if (!focused) {
			send({ type: "scene_changed", scene: "PAUSED" });
			sendPlayerData(true, "PAUSED");
		}
	}

	onLoopStart() {
		terra.export.g_scene.observers.push(this);
		terra.export.g_options.observers.push(this);

		// Add observer to window focus change
		let focusChange = this.onFocusChange;
		let originalsetWindowFocus = terra.export.System.prototype.setWindowFocus;
		terra.export.System.prototype.setWindowFocus = function (...args) {
			const result = originalsetWindowFocus.apply(this, args);
			focusChange(!args[0]);
			return result;
		};
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

function joinServer(address = 'ws://127.0.0.1:17005') {
	client = new WebSocket(address);

	client.on("open", () => {
		console.log("[TT Client] Connected to server");
	});

	client.addEventListener("message", (event) => {
		try {
			let msg = JSON.parse(event.data);

			switch (msg.type) {
				case "welcome":
					console.log("Welcome from server!");
					playerId = msg.id;
					break;

				case "update":
					playerUpdates.set(msg.id, msg.state);
					break;

				case "player_joined":
					console.log(`[TT Client] Player ${msg.id} joined`);
					playerUpdates.set(msg.id, msg.state);
					break;

				case "scene_changed":
					if (msg.scene == "LOADING" || msg.scene == "TITLE") {
						playerActions.set(msg.id, "HIDE");
					}
					if (msg.scene == "MENU" || msg.scene == "PAUSED") {
						playerActions.set(msg.id, "PAUSE");
					}
					break;

				case "player_left":
					playerActions.set(msg.id, "HIDE");
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
	});

	client.addEventListener("close", () => {
		console.log("Disconnected from server.");
		for (const player of playerActors.keys()) {
			playerActions.set(player, "HIDE");
		}
		client = null;
		playerId = null;
		playerActors.clear();
		playerUpdates.clear();
	});

	client.addEventListener("error", (err) => {
		console.error("Connection error:", err.message);
		for (const player of playerActors.keys()) {
			playerActions.set(player, "HIDE");
		}
		client = null;
		playerId = null;
		playerActors.clear();
		playerUpdates.clear();
	});
}

function leaveServer() {
	if (!client) return console.log("Not connected.");
	client.close();
}

function send(data) {
	if (client && client.readyState === WebSocket.OPEN) {
		client.send(JSON.stringify(data));
	}
}

function createPlayerActor(id) {
	// We are creating new Actor (NPC)
	var actor = new terra.export.TerraActor();

	// Inserts that entity in the world
	terra.export.g_gState.addEntity(actor, false, false);

	if (actor.actor)
		actor.actor.phaseOn = false;

	actor.move?.mainColl?.setType(terra.export.COLL_TYPE.ACTOR);

	actor.move.misc.groundConnect |= terra.export.COLL_GROUND_FLAGS.NO_PUSH;

	actor.actorExt.actorFx.dust = terra.export.g_fxConnect.effects.dust.entries.ActorM;
	actor.actorExt.actorFx.sound = terra.export.g_fxConnect.sounds.actor.entries.Cloth1;

	// Client-side stepping sound/fx is really inconsistent for some reason
	// So here we disable `onActorFx` to disable that client-side behaviour for player actors
	// Getting them from the server is more consistent, but visual fx still gets lost sometimes
	// TODO: Find out why and properly implement
	let originalOnPostMove = actor.actor.onPostMove;
	actor.actor.onPostMove = function (...args) {
		const originalOnActorFx = this.fxCallback.onActorFx;

		this.fxCallback.onActorFx = function (core, type, vary) {
			if (type === terra.export.ACTOR_FX_TYPE.STEP || type === terra.export.ACTOR_FX_TYPE.STEP_2) {
				return;
			}
			return originalOnActorFx.call(this, core, type, vary);
		};

		try {
			return originalOnPostMove.apply(this, args);
		} finally {
			this.fxCallback.onActorFx = originalOnActorFx;
		}
	};

	playerActors.set(id, actor);
	return actor;
}

function movePlayerActor(id, state) {
	if (!state)
		return;

	let actor = playerActors.get(id);

	if (!actor) {
		actor = createPlayerActor(id);
	}

	if (!actor.core) {
		return;
	}

	if (state.scene == "LOADING" || state.scene == "TITLE" || state.map != terra.export.g_game.map.active?.path) {
		actor.core?.hide(false);
		return;
	} else {
		actor.core?.show(false);
	}

	if (state.char && actor.npc?.char?.path != state.char) {
		// Get character from the character sheet
		var char = terra.export.Character.get(state.char);
		actor.setNpc(char, false);
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
		if (state.scene == "RUNNING") {
			actor.move.vel = new Vec3(state.velocity[0], state.velocity[1], state.velocity[2]);
		} else {
			actor.move.vel = new Vec3(0, 0, 0);
		}
	}

	if (actor.view?.figState) {
		if (state.scene == "RUNNING") {
			actor.view.figState.animSpeed = 1;
		} else {
			actor.view.figState.animSpeed = 0;
		}
	}

	if (actor.actorExt.actorFx) {
		for (const fx of state.actorFx ?? []) {
			actor.actorExt.actorFx.onActorFx(actor.core, fx.type, fx.vary);
		}
	}

	actor.view?.figState?.setAnim(state.animation || "idle", null);
	actor.view?.figState?.setAnimTime(state.anim_time);

	actor.actor?.setFace(new Vec2(state.face_dir[0], state.face_dir[1]), false);

	actor.view.figState.addedFig = [];
	for (const added of state.figures) {
		let figure = terra.export.Figure.get(added);
		actor.view.figState.addFigure(figure);
	}
}

// Send only one paused state
let pausedSent = false;

function sendPlayerData(forceSend = false, scene = null) {
	let g_player = terra.export.g_player;
	if (!scene)
		scene = SCENE_STATE[terra.export.g_scene?.currentState ?? 0];

	if (scene == "INIT" || scene == "TITLE" || scene == "LOADING" || g_player.entity == null)
		return;

	if (scene == "MENU") {
		if (pausedSent && !forceSend) {
			return;
		} else {
			pausedSent = true;
		}
	} else {
		pausedSent = false;
	}

	let state = {}

	state.char = g_player.entity?.npc?.char?.path;
	state.figure = g_player.entity?.view?.getFigure()?.name;

	state.scene = scene;

	state.map = terra.export.g_game.map.active?.path;

	state.position = g_player.entity?.core?.pos?.clone().v;
	state.velocity = g_player.entity?.move?.vel?.clone().v;

	// Copy current animation state
	state.animation = g_player.entity?.view?.figState?.anim?.name || "idle";
	state.anim_time = g_player.entity?.view?.figState?.time;

	// Copy the look direcition
	state.face_dir = g_player.entity?.actor?.face?.clone().v;

	// Clone weapons of Juno to the clone
	state.figures = [];
	for (const added of g_player.entity?.view?.figState?.addedFig ?? []) {
		state.figures.push(added.figure.cacheKey);
	}

	// Send effect data
	state.actorFx = [...fxQueue];
	fxQueue = [];

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
			playerActors.get(id)?.core?.hide();
		} else if (action == "PAUSE") {
			let actor = playerActors.get(id);
			if (!actor) return;

			if (actor.view?.figState)
				actor.view.figState.animSpeed = 0;

			if (actor.move?.vel)
				actor.move.vel = new Vec3(0, 0, 0);

			actor.move.acceleration = 0;
		}
	}
}

//# sourceURL=/mods/terra-together/client.js
