/**
 * src/features/skins.js
 * Juno skin picker: loads skin folders from the mod's skins/ directory and swaps the
 * local player's figure when the "tt-skin" option changes.
 * Responsibilities:
 *   - Scan the skins/<name>/skin.json manifests and build the skin table.
 *   - Apply the selected skin to g_player (Juno only) on map start / option change.
 *   - Provide the RADIO_GROUP option values + labels and register the addon.
 * Public surface: skins, createSkinSetting
 * Engine touchpoints: terra.export.Figure, SpriteSheet, OptionTypeBuilder,
 *   g_options (listProviders/observers/settings), g_player.entity.view.setFigure;
 *   terra.addAddon(new SkinManager(), { onAddonInit: 35000, onLoopStart: -10000,
 *   onGameMapStart: 35000 }) runs at import time — main.js imports this module for
 *   that side effect. Node fs/path via require() (the mod host provides them).
 * Notes: Skins do not sync between players (each client needs the same skins/ folder).
 *   `changeSkin` no-ops unless the local player is CHA:main#Juno.
 */

export { skins }

const fs = require("fs");
const path = require("path");

let skins = {};

function changeSkin(id) {
	if (terra.export.g_player.entity?.npc?.char?.path != "CHA:main#Juno") return;
	
	let skinName = id ?? "default";
	let skin = skins[skinName] ?? skins.default;
	terra.export.g_player.entity?.view?.setFigure(skin.figure);
}

// Lives inside the packaged mod (mods/terra-together/skins), not the game data dir.
const SKIN_DIR = "./mods/terra-together/skins";

function loadSkins() {
	let defaultFigure = terra.export.Figure.get("FIG:char.player.juno#default");
	// Inserted first on purpose: getOptionList() returns the "default" key as the option's
	// default value, and it must exist in the pushed values array (here index 0 of both
	// values and labels).
	skins.default = { name: "Default", figure: defaultFigure };

	for (const folder of fs.readdirSync(SKIN_DIR)) {
		const folderPath = path.join(SKIN_DIR, folder);
		if (!fs.statSync(folderPath).isDirectory()) continue;

		const manifestPath = path.join(folderPath, "skin.json");
		if (!fs.existsSync(manifestPath)) continue;

		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			let id = manifest.id || folder;

			// NOTE: Figure.getFromSheet(sheet, figure) expects a FigureSheet (see the engine's
			// own Figure.getFromSheet(this.sheet, name) calls), but `skins.default` is the
			// {name, figure} wrapper built above. Read the engine before "correcting" this
			// (engine/figure/figure.js:367 and Figure's constructor at :338):
			//   - `sheet.path` is undefined here, so the figure cache (keyed on path + name) is
			//     bypassed and every call builds a fresh Figure instead of reusing one;
			//   - the constructor then takes its `not instanceof FigureSheet` branch and calls
			//     FigureSheet.get(<the wrapper>); FileResource.get() treats a non-string as
			//     "build from data", so it hands back a throwaway EMPTY FigureSheet that reports
			//     itself loaded and is built from the wrapper (no `figures` key => no figures).
			// Harmless today only because the lines below repair the result: buildContent() has
			// run by then, so spriteSheets is {} rather than undefined and info is empty, and
			// everything the renderer reads -- allAnims, animAdd, info -- is copied from the
			// default Juno figure, with spriteSheets.juno swapped for the skin's sheet. Nothing
			// renders through figure.sheet, so the empty sheet and the missed cache lookup are
			// the only artefacts.
			// If those copying lines are ever removed, this call must be given a real FigureSheet
			// (e.g. skins.default.figure.sheet) so the engine's buildContent() fills info and
			// spriteSheets itself -- and the result is then cacheable and ref-counted, so it must
			// not be mutated per-skin (the spriteSheets.juno swap) the way it is here.
			let figure = terra.export.Figure.getFromSheet(skins.default, id);
			let sheet = terra.export.SpriteSheet.get("map", `../mods/terra-together/skins/${folder}/${manifest.sprite_file}`);

			figure.allAnims = skins.default.figure.allAnims;
			figure.animAdd = skins.default.figure.animAdd;
			figure.info = skins.default.figure.info;


			// "juno" is the figure's body sheet slot (data/figures/char/player/juno.json);
			// only that slot is swapped, the rest of the default figure is reused.
			figure.spriteSheets.juno = sheet;
			figure.skin_name = id;

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
		if (key === 'tt-skin') {
			let skinId = terra.export.g_options.get("tt-skin") ?? "default";
			changeSkin(skinId);
		}
	}

	onAddonInit() {
		terra.export.g_options.listProviders.set("tt-skin", this);
		terra.export.g_options.observers.push(this);
	}

	// Returns the option's default *value* (a skin key), not an index: the engine stores
	// it in config.default (engine/options/option-sub-types.js:74). "default" is always
	// present because loadSkins() inserts it first.
	getOptionList(values) {
        for (let key in skins) {
            values.push(key);
        }
		return "default";
	}

	// Labels are matched to getOptionList()'s values by index, so both must iterate
	// `skins` in the same (insertion) order.
	getOptionLabels(labels) {
		for (let key in skins) {
			let skin = skins[key];
            labels.push(skin.name);
        }
    }

	onLoopStart() {
		// No loop work: the manager is driven by option events and map starts.
	}
}

function createSkinSetting() {
	loadSkins();
	
	let g_options = terra.export.g_options;

	let skinList = [];

	for (const name in skins) {
		let skin = skins[name];
		skinList.push({ en_US: skin.name });
	}

	let skinOptionData = {
		category: "MULTIPLAYER",
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

terra.addAddon(new SkinManager(), { onAddonInit: 35000, onLoopStart: -10000, onGameMapStart: 35000 });

export { createSkinSetting }

//# sourceURL=/mods/terra-together/features/skins.js