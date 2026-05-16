export { joinServer, leaveServer, send }

const require = makeRequire(import.meta.url);

const WebSocket = require('ws');
const actor = terra.file.terraActorEntity;
const player = terra.file.playerModel;
const char_sheet = terra.file.charSheet;
const figure = terra.file.figureState;

let client = null;
let playerId = null;

const playerActors = new Map();
const playerUpdates = new Map();

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17005;

class MultiplayerClient extends terra.export.Observable {
	onPreUpdate() {
		sendPlayerData();
		updateOtherPlayers();
	}

	// When entering new map clean up the reference
	onGameMapLoad() {
		playerActors.clear();
		playerUpdates.clear();

		send({ type: "left_map", map: "some" });
	}

	// Create second actor on map start
	onGameMapStart() {
		send({ type: "join_map", map: "some" });
	}
}

terra.addAddon(new MultiplayerClient(), { onGameMapStart: 35000 });

function parseAddress(input) {
	let addr = input || DEFAULT_HOST;
	if (!addr.startsWith("ws://") && !addr.startsWith("wss://")) addr = "ws://" + addr;
	if (!/:\d+$/.test(addr)) addr = `${addr}:${DEFAULT_PORT}`;
	return addr;
}

function joinServer(address = DEFAULT_HOST) {
	client = new WebSocket(parseAddress(address));

	client.on("open", () => {
		console.log("Connected to server");
	});

	client.on("message", (raw) => {
		let msg;

		try {
			msg = JSON.parse(raw);
		} catch {
			console.warn("Invalid JSON from server");
			return;
		}

		switch (msg.type) {
			case "welcome":
				console.log("Welcome from server!");
				playerId = msg.id;
				for (const player of msg.players) {
					createPlayerActor(player.id, player.state);
				}
				break;

			case "update":
				playerId = msg.id;
				break;

			case "player_joined":
				console.log(`Player ${msg.id} joined`);
				createPlayerActor(msg.id, msg.state);
				break;

			case "player_left":
				playerActors.delete(msg.id);
				console.log(`Player ${msg.id} left`);
				break;

			case "left_map":
				console.log(`Player ${msg.id} left map ${msg.map}`);
				break;

			case "join_map":
				console.log(`Player ${msg.id} joined map ${msg.map}`);
				break;
		}
	});

	client.on("close", () => {
		console.log("Disconnected from server.");
		client = null;
		playerId = null;
	});

	client.on("error", (err) => {
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
	// Get Juno character from the character sheet
	var char = char_sheet.Character.get("CHA:main#Juno");

	// We are creating new Actor (NPC)
	var new_actor = new actor.TerraActor();

	// Copy position of our player
	new_actor.core.setPos(player.g_player.entity.core.pos);

	// Set sprite of this actor as Juno
	new_actor.setNpc(char, false);

	// Copy current animation state
	if (player.g_player.entity.view.figState.anim) {
		new_actor.view.figState.anim = player.g_player.entity.view?.figState?.anim || "idle";
		new_actor.view.figState.time = player.g_player.entity.view.figState.time;
	} else {
		new_actor.view.figState.setAnim("idle", null);
	}

	// Disable friction -- movement looks smoother
	new_actor.move.friction.air = 0;
	new_actor.move.friction.ground = 0;

	// Face is the direction character is looking
	new_actor.actor.face = player.g_player.entity.actor.face.clone();
	new_actor.view.figState.faceAngles = player.g_player.entity.view.figState.faceAngles;

	// Clone weapons of Juno to the clone
	// Maybe incorrect, but it works, ey?
	new_actor.view.figState.addedFig = [];
	for (const added of player.g_player.entity.view.figState.addedFig) {
		var add_figure = new figure.FigureAddState();
		add_figure.figure = added.figure;
		add_figure.parent = new figure.FigureState(added.parent.view, added.figure, null);
		new_actor.view.figState.addedFig.push(add_figure);
	}

	// Inserts that entity in the world
	terra.export.g_gState.addEntity(new_actor, true, false);

	playerActors.set(id, new_actor);
	return new_actor;
}

function movePlayerActor(id, state) {
	const playerActor = playerActors.get(id);

	if (!playerActor) {
		createPlayerActor(id, state);
		return;
	}

	playerActor.core.setPos(state.position);
	playerActor.move.vel = state.velocity;
	playerActor.view.figState.anim = state.animation;
	playerActor.view.figState.time = state.anim_time;
	playerActor.actor.face = state.face_dir;
	playerActor.view.figState.addedFig = state.figures;
}

function deletePlayerActor(id) {
	const playerActor = playerActors.get(id);

	if (playerActor) {

		playerActor.core
	}

}

function sendPlayerData() {
	if (!player.g_player?.entity?.core?.pos?.v || player.g_player.entity.core.pos.v.every(v => v === 0)) {
		return;
	}

	let state = {}

	state.position = player.g_player.entity.core.pos.clone().v;
	state.velocity = player.g_player.entity.move.vel.clone().v;

	// Copy current animation state
	state.animation = player.g_player.entity.view.figState.anim?.name  || "idle";
	state.anim_time = player.g_player.entity.view.figState.time;

	// Copy the look direcition
	state.face_dir = player.g_player.entity.actor.face.clone().v;

	// Clone weapons of Juno to the clone
	state.figures = [];
	for (const added of player.g_player.entity.view.figState.addedFig) {
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

//# sourceURL=mods/multiplayer/client.js
