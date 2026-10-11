// Settings-menu glue for "Terra Together".
//
// Everything that plugs the mod into the game's Options menu lives here:
//   * the mod's options category (createModSettings), and
//   * the category's tab in the Options menu (SettingsTab).
// main.js keeps the multiplayer logic and just wires these in.

import { createTextOption, createButtonOption } from "./option-types.js";
import * as server from "./server.js";
import { createSkinSetting } from "./skin.js";

// The options category. Doubles as the Options-menu tab key, so the settings
// below and the tab all use the same string.
export const CATEGORY = "MULTIPLAYER";
export const TAB_LABEL = "Multiplayer";

/**
 * Adds the mod's settings to its category. Call once at startup, before the
 * Options menu builds its lists.
 */
export function createModSettings() {
	let g_options = terra.export.g_options;

	// === Appearance ===

	createTextOption("tt-username", {
		header: "Appearance",
		category: CATEGORY,
		local: true,
		label: { en_US: "Username" },
		description: { en_US: "Your name as shown to other players." },
		type: { default: "", maxLength: 24, placeholder: "Username" }
	});

	createSkinSetting()

	let nameplateData = {
		category: CATEGORY,
		local: true,
		label: { en_US: "Player Nameplates" },
		description: { en_US: "Show player usernames above characters." },
		type: {
			default: 1,
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

	let nameplateScaleData = {
		category: CATEGORY,
		local: true,
		label: { en_US: "Nameplate Scale" },
		description: { en_US: "Size of player nameplates." },
		type: {
			default: 1,
			list: [
				{ en_US: "Small" },
				{ en_US: "Normal" },
				{ en_US: "Large" }
			],
			type: 'RADIO_GROUP'
		}
	};
	let nameplateScale = new (terra.export.OptionTypeBuilder.builders.get('RADIO_GROUP'))("tt-nameplate-scale", nameplateScaleData);
	g_options.settings["tt-nameplate-scale"] = nameplateScale;
	if (g_options.values["tt-nameplate-scale"] === undefined)
		g_options.values["tt-nameplate-scale"] = nameplateScaleData.type.default;

	// === Connection ===

	createTextOption("tt-server-address", {
		header: "Connection",
		category: CATEGORY,
		local: true,
		label: { en_US: "Server Address" },
		description: { en_US: "Host used when connecting to a multiplayer server." },
		type: { default: "127.0.0.1", placeholder: "127.0.0.1" }
	});

	createTextOption("tt-server-port", {
		category: CATEGORY,
		local: true,
		label: { en_US: "Server Port" },
		description: { en_US: "Port used when connecting to a multiplayer server." },
		type: { default: "17005", maxLength: 5, placeholder: "17005" }
	});

	// === Hosting ===
	const hostButton = createButtonOption("tt-host-server", {
		header: "Hosting",
		category: CATEGORY,
		label: { en_US: "Hosting" },
		description: { en_US: "Start a multiplayer server on this machine. Default port is 17005" },
		type: { text: { en_US: "Start Hosting" }, disabledText: { en_US: "Hosting!" }, width: 150 }
	}, () => {
		const port = parseInt(terra.export.g_options.get("tt-server-port"), 10) || 17005;
		server.startServer("0.0.0.0", port);
		console.log(`[TerraTogether] Hosting on ws://0.0.0.0:${port}`);
	});
	hostButton.isEnabled = () => !server.isHosting();

	// === Miscellaneous ===
	let alwaysFocusedData = {
		category: CATEGORY,
		header: "Miscellaneous",
		label: { en_US: "Always Focused" },
		description: { en_US: "Disable game pause on lost focus." },
		type: {
			default: false,
			type: 'CHECKBOX'
		}
	};
	let alwaysFocused = new (terra.export.OptionTypeBuilder.builders.get('CHECKBOX'))("tt-always-focused", alwaysFocusedData);
	g_options.settings["tt-always-focused"] = alwaysFocused;

	let hidePartyData = {
		category: CATEGORY,
		label: { en_US: "Hide Party" },
		description: { en_US: "Hides all party members like Filia.\n\n{c:4}WARNING!{c} This may break your game in cutscenes and WILL break any puzzles that use Filia." },
		type: {
			default: false,
			type: 'CHECKBOX'
		}
	};
	let hideParty = new (terra.export.OptionTypeBuilder.builders.get('CHECKBOX'))("tt-hide-party", hidePartyData);
	g_options.settings["tt-hide-party"] = hideParty;
}

/**
 * Adds the mod's tab to the game's Options menu. Registered as an addon so it
 * runs after the menu has been built.
 */
export class SettingsTab extends terra.export.Observable {
	onLoopStart() {
		// Create the category tab
		let mainMenu = terra.export.g_gui.hooks.find(x => x.gui?.constructor.name == "MainMenu").gui;
		let optionsMenu = Object.entries(mainMenu.submenus).map(x => x[1].menu).find(x => x.constructor.name == "OptionsMenu");
		optionsMenu.tabs.addTab(CATEGORY, { label: TAB_LABEL, icon: "lore-type-PEOPLE" });

		// Register the tab's title under "gui.menu.options.tabs.titles.<key>".
		// The game (OptionsMenu.updateRestoreButton) looks the tab title up there
		// for the "Restore <tab>" button; without it you get "ENOENT: <key>".
		let localeEntry = { en_US: TAB_LABEL };
		localeEntry.get = () => { return TAB_LABEL; };
		let tabTitles = terra.export.g_label?.labelFiles?.gui?.labels?.menu?.sub?.options?.sub?.tabs?.sub?.titles?.sub;
		if (tabTitles)
			tabTitles[CATEGORY] = { entry: localeEntry };
	}
}
