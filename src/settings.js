// Options-menu glue: the mod's settings category (createModSettings) and its tab
// (SettingsTab). main.js wires these in.

import { createTextOption, createButtonOption } from "./option-types.js";
import * as client from "./client.js";
import * as server from "./server.js";
import { createSkinSetting } from "./skin.js";

// Options category; also used as the Options-menu tab key.
export const CATEGORY = "MULTIPLAYER";
export const TAB_LABEL = "Multiplayer";

// Adds the mod's settings. Call once at startup, before Options builds its lists.
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

	const addressOption = createTextOption("tt-server-address", {
		header: "Connection",
		category: CATEGORY,
		local: true,
		label: { en_US: "Address" },
		description: { en_US: "Address used when connecting to a multiplayer server." },
		type: { default: "", placeholder: "127.0.0.1" }
	});

	const portOption = createTextOption("tt-server-port", {
		category: CATEGORY,
		local: true,
		label: { en_US: "Port" },
		description: { en_US: "Port used when connecting and hosting a multiplayer server." },
		type: { default: "", maxLength: 5, placeholder: "17005" }
	});

	// Address and port can only be edited while not connected/connecting/hosting.
	const connectionEditable = () => !client.isConnected() && !client.isConnecting() && !server.isHosting();
	addressOption.isEnabled = connectionEditable;
	portOption.isEnabled = connectionEditable;

	const connectButton = createButtonOption("tt-connect-server", {
		category: CATEGORY,
		label: { en_US: "Connect" },
		description: { en_US: "Click to connect/disconnect from a multiplayer server" },
		type: { text: { en_US: "Connect" }, width: 220 }
	}, () => {
		if (client.isConnected() || client.isConnecting())
			client.disconnect();
		else
			client.joinServer();
	});
	// Disabled while hosting: the local connection is then mandatory.
	connectButton.isEnabled = () => !server.isHosting();
	connectButton.getButtonText = () => {
		if (server.isHosting())
			return "Connected (Hosting)";
		if (client.isConnected())
			return "Connected!";
		if (client.isConnecting())
			return "Connecting...";
		return "Connect";
	};

	// === Hosting ===
	const hostButton = createButtonOption("tt-host-server", {
		header: "Hosting",
		category: CATEGORY,
		label: { en_US: "Hosting" },
		description: { en_US: "Start or stop hosting a multiplayer server on this machine. Hosting connects you automatically" },
		type: { text: { en_US: "Start Hosting" }, width: 220 }
	}, () => {
		if (server.isHosting()) {
			// Stop hosting: the host connection (and any peer connections) are dropped.
			server.stopServer();
			client.disconnect();
		}
		else {
			const port = parseInt(terra.export.g_options.get("tt-server-port"), 10) || 17005;
			// Leave any existing connection before hosting (joinServer replaces it anyway).
			client.disconnect();
			server.startServer("0.0.0.0", port);
			client.joinServer(undefined, { force: true });
		}
	});
	// Enabled to stop hosting, or to start hosting only when not already connected
	// to another server. Hosting itself keeps the button enabled so it can be stopped.
	hostButton.isEnabled = () => server.isHosting() || (!client.isConnected() && !client.isConnecting());
	hostButton.getButtonText = () => {
		if (server.isHosting())
			return `Hosting on :${server.getHostPort()}`;
		return "Start Hosting";
	};

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

// Adds the mod's tab to the Options menu (as an addon, after the menu is built).
export class SettingsTab extends terra.export.Observable {
	onLoopStart() {
		let mainMenu = terra.export.g_gui.hooks.find(x => x.gui?.constructor.name == "MainMenu").gui;
		let optionsMenu = Object.entries(mainMenu.submenus).map(x => x[1].menu).find(x => x.constructor.name == "OptionsMenu");
		optionsMenu.tabs.addTab(CATEGORY, { label: TAB_LABEL, icon: "lore-type-PEOPLE" });

		// Register the tab title so OptionsMenu's "Restore <tab>" lookup doesn't ENOENT.
		let localeEntry = { en_US: TAB_LABEL };
		localeEntry.get = () => { return TAB_LABEL; };
		let tabTitles = terra.export.g_label?.labelFiles?.gui?.labels?.menu?.sub?.options?.sub?.tabs?.sub?.titles?.sub;
		if (tabTitles)
			tabTitles[CATEGORY] = { entry: localeEntry };
	}
}
