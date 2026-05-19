window.terraTogether ??= {};

import * as server from './server.js';
import * as client from './client.js';

const Figure = terra.export.Figure;

server.startServer();

let figures = {};

terraTogether.figures = figures;

const DEFAULT_COLORS = {
	blue: "media/juno_b.png",
	green: "media/juno_g.png",
	yellow: "media/juno_y.png",
};

function changeSkin(id) {
	let figure = null;

	switch (id) {
		case 0:
			figure = figures.default;
			break;
		case 1:
			figure = figures.blue;
			break;
		case 2:
			figure = figures.green;
			break;
		case 3:
			figure = figures.yellow;
			break;
		default:
			figure = figures.default;
	};

	terra.export.g_player.entity?.view?.setFigure(figure);
}

class Multiplayer extends terra.export.Observable {
	onGameMapStart() {
		let skinId = terra.export.g_options.get("tt-skin") ?? 0;
		changeSkin(skinId);

		let hideParty = terra.export.g_options.get("tt-hide-party") ?? false;
		if (hideParty) {
			for (const party of terra.export.g_party?.entities ?? []) {
				party.core.hide(true);
			}
		}
	}

	onOptionEvent(event, key) {
		if (key = 'tt-skin') {
			let skinId = terra.export.g_options.get("tt-skin") ?? 0;
			changeSkin(skinId);
		}

		if (key = "tt-hide-party") {
			let hideParty = terra.export.g_options.get("tt-hide-party") ?? false;
			if (hideParty) {
				for (const party of terra.export.g_party?.entities ?? []) {
					party.core.hide();
				}
			} else {
				for (const party of terra.export.g_party?.entities ?? []) {
					party.core.show();
				}
			}
		}

		if (key = "tt-always-focused") {
			let alwaysFocused = terra.export.g_options.get("tt-always-focused") ?? false;

			window.IG_KEEP_WINDOW_FOCUS = alwaysFocused;
			terra.export.g_system.setWindowFocus(false);
		}
	}

	onLoopStart() {
		// Create multiple versions of Juno Figure
		let junoFigure = Figure.get("FIG:char.player.juno#default");

		figures.default = junoFigure;

		for (const [color, file] of Object.entries(DEFAULT_COLORS)) {
			let figure = Figure.getFromSheet(junoFigure, color);
			let sheet = terra.export.SpriteSheet.get("map", `../mods/terra-together/${file}`);

			figure.info = junoFigure.info;
			figure.spriteSheets.juno = sheet;

			figures[color] = figure;
		}


		let optionManager = terra.export.g_options;

		let skinOptionData = {
			category: "MODS",
			header: "Terra Together",
			label: { en_US: "Skin" },
			description: { en_US: "Select your skin. It will be visible to other players. \n\n{c:2}Note{c}: Currently skins only apply to Juno. If you add your own skins, they will not sync between players (yet), so make sure all players have the same skins installed." },
			type: {
				default: 0,
				list: [{ en_US: "Default" }, { en_US: "Blue" }, { en_US: "Green" }, { en_US: "Yellow" }],
				type: 'RADIO_GROUP'
			}
		};
		let skinOption = new (terra.export.OptionTypeBuilder.builders.get('RADIO_GROUP'))("tt-skin", skinOptionData);

		optionManager.settings["tt-skin"] = skinOption;
		// TODO: Options do not save for some reason
		optionManager.restore("tt-skin");

		let hidePartyData = {
			category: "MODS",
			label: { en_US: "Hide Party" },
			description: { en_US: "Hides all party members like Filia.\n\n{c:4}WARNING!{c} This may break your game in cutscenes and WILL break any puzzles that use Filia." },
			type: {
				default: false,
				type: 'CHECKBOX'
			}
		};
		let hideParty = new (terra.export.OptionTypeBuilder.builders.get('CHECKBOX'))("tt-hide-party", hidePartyData);

		optionManager.settings["tt-hide-party"] = hideParty;
		// TODO: Options do not save for some reason
		optionManager.restore("tt-hide-party");

		let alwaysFocusedData = {
			category: "MODS",
			label: { en_US: "Always Focused" },
			description: { en_US: "Disable game pause on lost focus." },
			type: {
				default: false,
				type: 'CHECKBOX'
			}
		};
		let alwaysFocused = new (terra.export.OptionTypeBuilder.builders.get('CHECKBOX'))("tt-always-focused", alwaysFocusedData);

		optionManager.settings["tt-always-focused"] = alwaysFocused;
		// TODO: Options do not save for some reason
		optionManager.restore("tt-always-focused");

		let mainMenu = terra.export.g_gui.hooks.find(x => x.gui?.constructor.name == "MainMenu").gui;
		let optionsMenu = Object.entries(mainMenu.submenus).map(x => x[1].menu).find(x => x.constructor.name == "OptionsMenu");

		let tab = optionsMenu.tabs.addTab("MODS", { label: "Mods", icon: "option-cat-ROGUE" });

		terra.export.g_options.observers.push(this);
	}
}

terra.addAddon(new Multiplayer(), { onLoopStart: 35000, onGameMapStart: 35000 });

//# sourceURL=/mods/terra-together/main.js
