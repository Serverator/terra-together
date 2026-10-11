import { registerOptionTypes, createTextOption, createButtonOption } from "./option-types.js";
import * as skin from './skin.js';
import * as server from './server.js';
import * as client from './client.js';
import * as nameplates from './nameplates.js';

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
		// Keep the server informed when the player renames themselves.
		if (key === "tt-username") {
			const name = String(terra.export.g_options.get("tt-username") ?? "").trim();
			client.send({ type: "profile", username: name === "" ? null : name });
		}

		if (key === "tt-hide-party") {
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

		// Apply on change, and whenever the options are (re)loaded. The latter is
		// what makes a stored value take effect on startup, not only when toggled.
		const OPTION_EVENT = terra.export.OPTION_EVENT;
		if (key === "tt-always-focused"
			|| event === OPTION_EVENT.SETTINGS_UPDATED
			|| event === OPTION_EVENT.SETTINGS_LOADED) {
			this.applyAlwaysFocused();
		}
	}

	applyAlwaysFocused() {
		const alwaysFocused = terra.export.g_options.get("tt-always-focused") ?? false;
		window.IG_KEEP_WINDOW_FOCUS = alwaysFocused;
		terra.export.g_system.setWindowFocus(false);
	}

	onAddonInit() {
		// Add the extra setting types (TEXT + BUTTON) before any menu is built.
		registerOptionTypes();

		terra.export.g_options.observers.push(this);

		let stepArray = terra.export.GAME_CONF.FEATURES.flatMap(f => f.steps ?? []).flat();
		terraTogether.steps = Object.fromEntries(stepArray.map(step => [step.key, step]));
	}

	onLoopStart() { 		
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

		let nameplateData = {
			header: "Terra Together",
			category: "MODS",
			local: true,
			label: { en_US: "Player Nameplates" },
			description: { en_US: "Show player usernames above characters.\n\nUsernames are configured in the Player Name setting below." },
			type: {
				default: 2,
				list: [
					{ en_US: "Off" },
					{ en_US: "Others" },
					{ en_US: "Others + Self" }
				],
				type: 'RADIO_GROUP'
			}
		};
		let nameplates = new (terra.export.OptionTypeBuilder.builders.get('RADIO_GROUP'))("tt-nameplates", nameplateData);
		g_options.settings["tt-nameplates"] = nameplates;
		if (g_options.values["tt-nameplates"] === undefined)
			g_options.values["tt-nameplates"] = nameplateData.type.default;

		// In-game client configuration. There is no config.json: everything is
		// stored as game options, so settings persist without editing files.
		// These are `local` options, persisted in the game's local options storage.
		createTextOption("tt-username", {
			header: "Terra Together",
			category: "MODS",
			local: true,
			label: { en_US: "Player Name" },
			description: { en_US: "Your name as shown to other players.\n\nLeave empty to show no nameplate.\n\nPress confirm to edit, then confirm again (or click away) to save." },
			type: { default: "", maxLength: 24, placeholder: "Anonymous" }
		});

		createTextOption("tt-server-address", {
			category: "MODS",
			local: true,
			label: { en_US: "Server Address" },
			description: { en_US: "Host used when connecting to a multiplayer server." },
			type: { default: "127.0.0.1", placeholder: "127.0.0.1" }
		});

		createTextOption("tt-server-port", {
			category: "MODS",
			local: true,
			label: { en_US: "Server Port" },
			description: { en_US: "Port used when connecting to a multiplayer server." },
			type: { default: "17005", maxLength: 5, placeholder: "17005" }
		});

		// A BUTTON setting: pressing it runs custom JS from the mod.
		// Hosting is opt-in — the server only starts when this is pressed, and the
		// button becomes non-pressable once a server is running.
		const hostButton = createButtonOption("tt-host-server", {
			header: "Terra Together",
			category: "MODS",
			label: { en_US: "Hosting" },
			description: { en_US: "Start a multiplayer server on this machine.\n\nOther players connect using the Server Address and Server Port above." },
			type: { text: { en_US: "Start Hosting" }, disabledText: { en_US: "Hosting…" }, width: 150 }
		}, () => {
			const port = parseInt(terra.export.g_options.get("tt-server-port"), 10) || 17005;
			server.startServer("0.0.0.0", port);
			console.log(`[TerraTogether] Hosting on ws://0.0.0.0:${port}`);
		});
		hostButton.isEnabled = () => !server.isHosting();

		// Baseline: apply the stored Always Focused value as soon as the game
		// starts. (A load also re-applies it via SETTINGS_UPDATED.)
		this.applyAlwaysFocused();
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

terra.addAddon(new Multiplayer(), { onAddonInit: -10000, onLoopStart: -10000, onGameMapStart: 35000 });
terra.addAddon(new SettingsTab(), { onLoopStart: 40000 });

//# sourceURL=/mods/terra-together/main.js
