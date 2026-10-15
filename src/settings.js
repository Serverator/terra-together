// Options-menu glue: the mod's settings category (createModSettings) and its tab
// (SettingsTab). main.js wires these in.

import { createTextOption, createButtonOption } from "./option-types.js";
import { createOption } from "./helper.js";
import { ENEMY_DEBUG_OPTION } from "./enemy-debug.js";
import * as client from "./client.js";
import * as server from "./server.js";
import { createSkinSetting } from "./skin.js";

// Options category; also used as the Options-menu tab key.
export const CATEGORY = "MULTIPLAYER";
export const TAB_LABEL = "Multiplayer";

// Host-authoritative revive toggle. The option value is the source of truth; the runtime
// mirror window.terraTogether.reviveEnabled is what revive.js reads. Clients can't edit
// it (the checkbox is disabled unless we run the server) and obey the value the host
// pushes (server.js setHostSetting -> host_setting -> client.js).
export const REVIVE_OPTION = "tt-revive";

// Host-authoritative area-heal toggle ("Estus Heals Allies"). Off by default.
export const ESTUS_OPTION = "tt-estus-share";

export function isReviveEnabled() {
	return terra.export.g_options?.get(REVIVE_OPTION) === true;
}

// Reads the option, keeps the runtime mirror in sync and, when we host, (re)broadcasts it
// to clients. Call on start-up, on change and whenever hosting starts.
export function syncRevive() {
	window.terraTogether ??= {};
	window.terraTogether.reviveEnabled = isReviveEnabled();
	if (server.isHosting())
		server.setHostSetting(REVIVE_OPTION, isReviveEnabled());
}

export function isEstusShareEnabled() {
	return terra.export.g_options?.get(ESTUS_OPTION) === true;
}

// Same host-authoritative mirroring as syncRevive(), for the estus area heal.
export function syncEstusShare() {
	window.terraTogether ??= {};
	window.terraTogether.estusShareEnabled = isEstusShareEnabled();
	if (server.isHosting())
		server.setHostSetting(ESTUS_OPTION, isEstusShareEnabled());
}

// The game's CHECKBOX option type has no enable predicate, so patch its GUI once: grey out
// and refuse changes when the option's getEnabled() returns false (host-only setting).
function installHostOnlyCheckbox() {
	const Gui = terra.export.OptionGuiTypeBuilder?.builders?.get("CHECKBOX");
	if (!Gui?.prototype?.submitChange || Gui.prototype._ttHostOnly)
		return;
	Gui.prototype._ttHostOnly = true;

	const submit = Gui.prototype.submitChange;
	Gui.prototype.submitChange = function (value) {
		const enabled = this.option?.getEnabled;
		if (typeof enabled === "function" && !enabled.call(this.option)) {
			terra.export.g_menuSFX?.blocked?.();
			return;
		}
		return submit.call(this, value);
	};

	if (Gui.prototype.updateCurrent) {
		const update = Gui.prototype.updateCurrent;
		Gui.prototype.updateCurrent = function (focus = false) {
			update.call(this, focus);
			const enabled = this.option?.getEnabled;
			if (typeof enabled === "function" && !enabled.call(this.option)) {
				const grey = terra.export.ColorDecorator?.GREY ?? null;
				this.on?.setDecorator(grey);
				this.off?.setDecorator(grey);
			}
		};
	}
}

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

	// Independent of the nameplate option: the HP bar can be shown even when the
	// name is off, and vice versa.
	let hpBarData = {
		category: CATEGORY,
		local: true,
		label: { en_US: "Player Health Bars" },
		description: { en_US: "Show player health bars above characters." },
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

	let hpBars = new (terra.export.OptionTypeBuilder.builders.get('RADIO_GROUP'))("tt-hpbar", hpBarData);
	g_options.settings["tt-hpbar"] = hpBars;
	if (g_options.values["tt-hpbar"] === undefined)
		g_options.values["tt-hpbar"] = hpBarData.type.default;

	let nameplateScaleData = {
		category: CATEGORY,
		local: true,
		label: { en_US: "Nameplate Scale" },
		description: { en_US: "Size of player nameplates and health bars." },
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

	// === Gameplay ===

	// Host-authoritative boolean. Only whoever runs the server can toggle it; clients
	// see and obey the host's value. getEnabled() gates the (patched) checkbox.
	installHostOnlyCheckbox();
	const reviveOption = createOption(REVIVE_OPTION, {
		header: "Gameplay",
		category: CATEGORY,
		local: true,
		label: { en_US: "Revive Teammates" },
		description: { en_US: "When a player would die with a living teammate nearby, they go down instead of respawning, and a teammate can revive them.\n\nSet by the host; other players obey." },
		type: { default: false, type: "CHECKBOX" }
	}, "CHECKBOX");
	// Editable only while we host (or are offline); otherwise we follow the host's value.
	reviveOption.getEnabled = () => server.isHosting() || (!client.isConnected() && !client.isConnecting());

	// Host-authoritative boolean: drinking your flask also heals nearby players. Off by default.
	const estusShareOption = createOption(ESTUS_OPTION, {
		category: CATEGORY,
		local: true,
		label: { en_US: "Estus Heals Allies" },
		description: { en_US: "Drinking your estus flask also heals nearby players by the same amount. A downed teammate in range is revived. Only your own flask is consumed.\n\nSet by the host; other players obey." },
		type: { default: false, type: "CHECKBOX" }
	}, "CHECKBOX");
	// Editable only while we host (or are offline); otherwise we follow the host's value.
	estusShareOption.getEnabled = () => server.isHosting() || (!client.isConnected() && !client.isConnecting());

	// Mirror the stored host preference into the runtime flag at start-up.
	syncRevive();
	syncEstusShare();

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
			// Only join once the server is actually listening: joining immediately races
			// the bind, so the first attempt is refused and logs a connection error.
			server.startServer("0.0.0.0", port)
				.then(() => { client.joinServer(undefined, { force: true }); syncRevive(); syncEstusShare(); })
				.catch(() => { /* startServer already logged the failure */ });
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

	let autoHostData = {
		category: CATEGORY,
		local: true,
		label: { en_US: "Auto Host" },
		description: { en_US: "Start hosting a multiplayer server automatically when the game starts." },
		type: {
			default: false,
			type: 'CHECKBOX'
		}
	};
	let autoHost = new (terra.export.OptionTypeBuilder.builders.get('CHECKBOX'))("tt-auto-host", autoHostData);
	g_options.settings["tt-auto-host"] = autoHost;
	if (g_options.values["tt-auto-host"] === undefined)
		g_options.values["tt-auto-host"] = autoHostData.type.default;

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

	let skipLogosData = {
		category: CATEGORY,
		local: true,
		label: { en_US: "Skip Intro Logos" },
		description: { en_US: "Skip the developer and promo logo screens shown before the title menu." },
		type: {
			default: false,
			type: 'CHECKBOX'
		}
	};
	let skipLogos = new (terra.export.OptionTypeBuilder.builders.get('CHECKBOX'))("tt-skip-logos", skipLogosData);
	g_options.settings["tt-skip-logos"] = skipLogos;
	if (g_options.values["tt-skip-logos"] === undefined)
		g_options.values["tt-skip-logos"] = skipLogosData.type.default;

	// === Debug ===

	// Enemy debug overlay (see enemy-debug.js): draws the owning player plus the current
	// state/action above every enemy. Off by default; also toggleable live from the
	// devtools console with window.ttEnemyDebug = true.
	createOption(ENEMY_DEBUG_OPTION, {
		category: CATEGORY,
		header: "Debug",
		local: true,
		label: { en_US: "Enemy Debug Overlay" },
		description: { en_US: "Show a debug label above every enemy: the player who owns it and its current state and action.\n\nAlso toggleable live from the devtools console: window.ttEnemyDebug = true" },
		type: { default: false, type: "CHECKBOX" }
	}, "CHECKBOX");
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
