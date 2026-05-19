export { joinServer, leaveServer, send }

import { loadConfig } from "./helper.js";
import { skins } from "./skin.js";

const actor = terra.file.terraActorEntity;
const player = terra.file.playerModel;
const figure = terra.file.figureState;
const Vec2 = terra.export.Vec2;
const Vec3 = terra.export.Vec3;

let client = null;
let playerId = null;

const playerActors = new Map();
const playerUpdates = new Map();

let config = loadConfig();

class MultiplayerClient extends terra.export.Observable {
	onPreUpdate() {
		sendPlayerData();
		updateOtherPlayers();
	}

	// When entering new map clean up the reference
	onGameMapLoad() {
		playerActors.clear();
		playerUpdates.clear();

		let map = terra.export.g_game.map.active?.path;
		if (map)
			send({ type: "left_map", map });
	}

	// Create second actor on map start
	onGameMapStart() {
		if (!client)
			joinServer();

		playerActors.clear();
		playerUpdates.clear();

		let map = terra.export.g_game.map.active?.path;
		send({ type: "join_map", map });
	}
}

terra.addAddon(new MultiplayerClient(), { onGameMapStart: 35000 });

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
					movePlayerActor(msg.id, msg.state);
					break;

				case "player_joined":
					console.log(`[TT Client] Player ${msg.id} joined`);
					movePlayerActor(msg.id, msg.state);
					break;

				case "player_left":
					deletePlayerActor(msg.id);
					console.log(`[TT Client] Player ${msg.id} left`);
					break;

				case "left_map":
					console.log(`[TT Client] Player ${msg.id} left map '${msg.map}'`);
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
		client = null;
		playerId = null;
	});

	client.addEventListener("error", (err) => {
		console.error("Connection error:", err.message);
		client = null;
		playerId = null;
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

function createPlayerActor(id, state) {
	if (!state?.char) {
		return;
	}
	
	// We are creating new Actor (NPC)
	var actor = new terra.export.TerraActor();
	
	// Get character from the character sheet
	var char = terra.export.Character.get(state.char);

	// Set sprite of this actor
	actor.setNpc(char, false);

	let figure = skins[state.figure].figure;
	if (figure) {
		actor.view?.setFigure(figure);
	}

	// Copy position of our player
	actor.core.setPos(new Vec3(state.position[0], state.position[1], state.position[2]));
	if (actor.move?.vel) {
		actor.move.vel = new Vec3(state.velocity[0], state.velocity[1], state.velocity[2]);
	}

	// Copy current animation state
	actor.view?.figState?.setAnim(state.animation || "idle", null);
	actor.view?.figState?.setAnimTime(state.anim_time);

	// Disable friction -- movement looks smoother
	if (actor.move?.friction) {
		// actor.move.friction.air = 0;
		// actor.move.friction.ground = 0;
	}

	// Face is the direction character is looking
	actor.actor?.setFace(new Vec2(state.face_dir[0], state.face_dir[1]), true);

	// Clone weapons of Juno to the clone
	// Maybe incorrect, but it works, ey?
	actor.view.figState.addedFig = [];
	for (const added of state.figures) {
		let figure = terra.export.Figure.get(added);
		actor.view.figState.addFigure(figure);
	}

	// Inserts that entity in the world
	terra.export.g_gState.addEntity(actor, false, false);

	playerActors.set(id, actor);
	return actor;
}

function movePlayerActor(id, state) {
	if (!state)
		return;
	
	const actor = playerActors.get(id);

	if (!actor) {
		createPlayerActor(id, state);
		return;
	}

	if (!actor.core) {
		return;
	}

	if (!actor.core.isVisible()) {
		actor.core.show();
	}

	let currentFigure = terra.export.g_player.entity?.view?.getFigure().name;
	if (currentFigure != state.figure) {
		let figure = skins[state.figure].figure;
		if (figure) {
			actor.view?.setFigure(figure);
		}
	}

	actor.core.setPos(new Vec3(state.position[0], state.position[1], state.position[2]));
	if (actor.move?.vel) {
		actor.move.vel = new Vec3(state.velocity[0], state.velocity[1], state.velocity[2]);
	}

	actor.view?.figState?.setAnim(state.animation || "idle", null);
	actor.view?.figState?.setAnimTime(state.anim_time);

	actor.actor?.setFace(new Vec2(state.face_dir[0], state.face_dir[1]), true);

	actor.view.figState.addedFig = [];
	for (const added of state.figures) {
		let figure = terra.export.Figure.get(added);
		actor.view.figState.addFigure(figure);
	}
}

function deletePlayerActor(id) {
	playerActors.get(id)?.core?.hide();
}

function sendPlayerData() {
	if (!player.g_player?.entity?.core?.pos?.v || player.g_player.entity.core.pos.v.every(v => v === 0)) {
		return;
	}

	let state = {}

	state.char = terra.export.g_player.entity?.npc?.char?.cacheKey;
	state.figure = terra.export.g_player.entity?.view?.getFigure()?.name;

	state.map = terra.export.g_game.map.active?.path;

	state.position = player.g_player.entity.core.pos.clone().v;
	state.velocity = player.g_player.entity.move.vel.clone().v;

	// Copy current animation state
	state.animation = player.g_player.entity.view.figState?.anim?.name || "idle";
	state.anim_time = player.g_player.entity.view.figState?.time;

	// Copy the look direcition
	state.face_dir = player.g_player.entity.actor.face.clone().v;

	// Clone weapons of Juno to the clone
	state.figures = [];
	for (const added of player.g_player.entity.view.figState?.addedFig ?? []) {
		state.figures.push(added.figure.cacheKey);
	}

	send({ type: "update", state });
}

function updateOtherPlayers() {
	const allUpdates = [...playerUpdates.entries()];
	playerUpdates.clear();

	for (const [player, state] of allUpdates) {
		movePlayerActor(player, state);
	}
}

//# sourceURL=/mods/terra-together/client.js
