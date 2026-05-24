
export { SkinManager, skins }

const fs = require("fs");
const path = require("path");

let skins = {};

function changeSkin(id) {
	if (terra.export.g_player.entity?.npc?.char?.path != "CHA:main#Juno") return;
	
	let skinName = id ?? "default";
	let skin = skins[skinName] ?? skins.default;
	terra.export.g_player.entity?.view?.setFigure(skin.figure);
}

const SKIN_DIR = "./mods/terra-together/skins";

function loadSkins() {
	let defaultFigure = terra.export.Figure.get("FIG:char.player.juno#default");
	skins.default = { name: "Default", figure: defaultFigure };

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
		} catch (err) {
			console.warn(`[TerraTogether] Failed to load skin in ${folderPath}:`, err);
		}
	}
}

class SkinManager extends terra.export.Observable {
	onGameMapStart() {
		let skinId = terra.export.g_options.get("tt-skin") ?? "default";
		changeSkin(skinId);
	}

	onOptionEvent(event, key) {
		if (key = 'tt-skin') {
			let skinId = terra.export.g_options.get("tt-skin") ?? "default";
			changeSkin(skinId);
		}
	}

	onAddonInit() {
		terra.export.g_options.listProviders.set("tt-skin", this);
		terra.export.g_options.observers.push(this);
	}

	getOptionList(values) {
        for (let key in skins) {
            values.push(key);
        }
		return "default";
	}

	getOptionLabels(labels) {
		for (let key in skins) {
			let skin = skins[key];
            labels.push(skin.name);
        }
    }

	onLoopStart() {
		loadSkins();
		
		let g_options = terra.export.g_options;

		let skinList = [];

		for (const name in skins) {
			let skin = skins[name];
			skinList.push({ en_US: skin.name });
		}

		let skinOptionData = {
			category: "MODS",
			header: "Terra Together",
			label: { en_US: "Skin" },
			description: { en_US: "Select your skin. It will be visible to other players. \n\n{c:2}Note{c}: Currently skins only apply to Juno. If you add your own skins, they will not sync between players (yet), so make sure all players have the same skins installed." },
			type: {
				default: 0,
				external: "tt-skin",
				list: [],
				type: 'RADIO_GROUP'
			}
		};
		let skinOption = new (terra.export.OptionTypeBuilder.builders.get('RADIO_GROUP'))("tt-skin", skinOptionData);

		g_options.settings["tt-skin"] = skinOption;
	}
}

terra.addAddon(new SkinManager(), { onAddonInit: 35000, onLoopStart: -10000, onGameMapStart: 35000 });

//# sourceURL=/mods/terra-together/skin.js