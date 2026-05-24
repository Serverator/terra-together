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

	onAddonInit() {
		terra.export.g_options.observers.push(this);
	}

	onLoopStart() {		
		let config = loadConfig();

		if (config?.server && config.server.enabled) {
			server.startServer(config.server.host ?? '0.0.0.0', config.server.port ?? 17005);
		}

		let g_options = terra.export.g_options;

		// Add settings
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
		g_options.settings["tt-hide-party"] = hideParty;

		
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
		g_options.settings["tt-always-focused"] = alwaysFocused;
	}
}

class SettingsTab extends terra.export.Observable {
	onLoopStart() {		
		// Create mods tab
		let mainMenu = terra.export.g_gui.hooks.find(x => x.gui?.constructor.name == "MainMenu").gui;
		let optionsMenu = Object.entries(mainMenu.submenus).map(x => x[1].menu).find(x => x.constructor.name == "OptionsMenu");
		optionsMenu.tabs.addTab("MODS", { label: "Mods", icon: "option-cat-ROGUE" });

		// TODO: Shitty workaround while I figure out how to import my own labels properly
		let localeEntry = { en_US: "Mods" };
		localeEntry.get = () => { return "Mods"; };
		terra.export.g_label.labelFiles.gui.labels.menu.sub.options.sub.tabs.sub.titles.sub.MODS = { entry: localeEntry };

		
	}
}

terra.addAddon(new Multiplayer(), { onAddonInit: 35000, onLoopStart: -10000, onGameMapStart: 35000 });
terra.addAddon(new SettingsTab(), { onLoopStart: 40000 });

//# sourceURL=/mods/terra-together/main.js
