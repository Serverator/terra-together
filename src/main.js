import { loadConfig } from "./helper.js";
import * as skin from './skin.js';
import * as server from './server.js';
import * as client from './client.js';

window.terraTogether ??= {};

class Multiplayer extends terra.export.Observable {
	onGameMapStart() {
		let hideParty = terra.export.g_options.get("tt-hide-party") ?? false;
		if (hideParty) {
			for (const party of terra.export.g_party?.entities ?? []) {
				party.core.hide(true);
			}
		}
	}

	onOptionEvent(event, key) {
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
		let config = loadConfig();

		if (config?.server && config.server.enabled) {
			server.startServer(config.server.host ?? '0.0.0.0', config.server.port ?? 17005);
		}

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

		let optionManager = terra.export.g_options;
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
