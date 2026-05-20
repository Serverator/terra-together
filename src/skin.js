
export { SkinManager, skins, skinOrder }

const fs = require("fs");
const path = require("path");

let skins = {};
let skinOrder = [];

function changeSkin(id) {
	if (terra.export.g_player.entity?.npc?.char?.path != "CHA:main#Juno") return;
	
	let skinName = skinOrder[id] ?? "default";
	let skin = skins[skinName] ?? skins.default;
	terra.export.g_player.entity?.view?.setFigure(skin.figure);
}

const SKIN_DIR = "./mods/terra-together/skins";

function loadSkins() {
	let defaultFigure = terra.export.Figure.get("FIG:char.player.juno#default");
	skins.default = { name: "Default", figure: defaultFigure };
	skinOrder.push("default");

	let i = 0;
	
	for (const folder of fs.readdirSync(SKIN_DIR)) {
		const folderPath = path.join(SKIN_DIR, folder);
		if (!fs.statSync(folderPath).isDirectory()) continue;

		const manifestPath = path.join(folderPath, "skin.json");
		if (!fs.existsSync(manifestPath)) continue;

		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			let id = manifest.id || folder;

			let figure = terra.export.Figure.getFromSheet(skins.default, id);
			let sheet = terra.export.SpriteSheet.get("map", `../mods/terra-together/skins/${folder}/${manifest.sprite_file}`);

			figure.info = skins.default.figure.info;
			figure.spriteSheets.juno = sheet;
			figure.skin_name = id;

			i += 1;

			skins[id] = { name: manifest.name ?? manifest.id, figure };
			skinOrder.push(id);
		} catch (err) {
			console.warn(`[TerraTogether] Failed to load skin in ${folderPath}:`, err);
		}
	}
}

class SkinManager extends terra.export.Observable {
	onGameMapStart() {
		let skinId = terra.export.g_options.get("tt-skin") ?? 0;
		changeSkin(skinId);
	}

	onOptionEvent(event, key) {
		if (key = 'tt-skin') {
			let skinId = terra.export.g_options.get("tt-skin") ?? 0;
			changeSkin(skinId);
		}
	}

	onLoopStart() {
		loadSkins();
		
		let optionManager = terra.export.g_options;

		let skinList = [];

		for (const skinName of skinOrder) {
			let skin = skins[skinName];
			skinList.push({ en_US: skin.name });
		}

		let skinOptionData = {
			category: "MODS",
			header: "Terra Together",
			label: { en_US: "Skin" },
			description: { en_US: "Select your skin. It will be visible to other players. \n\n{c:2}Note{c}: Currently skins only apply to Juno. If you add your own skins, they will not sync between players (yet), so make sure all players have the same skins installed." },
			type: {
				default: 0,
				list: skinList,
				type: 'RADIO_GROUP'
			}
		};
		let skinOption = new (terra.export.OptionTypeBuilder.builders.get('RADIO_GROUP'))("tt-skin", skinOptionData);

		optionManager.settings["tt-skin"] = skinOption;
		// TODO: Options do not save for some reason
		optionManager.restore("tt-skin");

		terra.export.g_options.observers.push(this);
	}
}

terra.addAddon(new SkinManager(), { onLoopStart: 34500, onGameMapStart: 35000 });

//# sourceURL=/mods/terra-together/skin.js