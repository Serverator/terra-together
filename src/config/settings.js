/**
 * src/config/settings.js
 * Options-menu glue: the mod's settings category (createModSettings) and its tab (SettingsTab).
 * Responsibilities:
 *   - Declare every TerraTogether option: Appearance, Gameplay, Connection, Hosting,
 *     Miscellaneous and Debug.
 *   - Own the host-authoritative revive / estus-share / enemy-sync toggles and the two runtime
 *     mirrors the features read.
 *   - Patch the game's CHECKBOX gui so a host-only option greys out and refuses changes.
 * Public surface: CATEGORY, TAB_LABEL, REVIVE_OPTION, ESTUS_OPTION, ENEMY_SYNC_OPTION,
 *   isReviveEnabled, syncRevive, isEstusShareEnabled, syncEstusShare, syncEnemySync,
 *   createModSettings, SettingsTab
 * Engine touchpoints: terra.export.g_options, OptionTypeBuilder, OptionGuiTypeBuilder,
 *   g_menuSFX, ColorDecorator, g_gui, g_label, Observable; window.terraTogether.{reviveEnabled,
 *   estusShareEnabled}; addon hooks — main.js calls createModSettings() from its
 *   Multiplayer.onLoopStart and registers SettingsTab as an addon at onLoopStart: 40000.
 * Notes: the stored option value (g_options.values[key], read through g_options.get()) is
 *   the source of truth; the terraTogether mirrors are read by revive.js (reviveEnabled) and
 *   area-heal.js (estusShareEnabled, preferring the mirror and falling back to the option),
 *   and are re-pushed to clients by server.js setHostSetting -> host_setting -> client.js.
 *   Enemy sync has no mirror: its own reader (isEnemySyncEnabled() in ../client/enemies.js)
 *   reads the option, so a client that takes the host's value writes it into g_options with
 *   skipNotify (the MSG.HOST_SETTING case in ../client/session.js) and every call site follows.
 *   Lifecycle: createModSettings() runs once per
 *   game-loop start (main.js Multiplayer.onLoopStart, addon order -10000) and must be done
 *   before the Options menu builds its rows, because option-types.js is what registers each
 *   option in g_options.settings and seeds g_options.values — an option has to be created
 *   before anything reads it, and the host toggles are read again by syncRevive() /
 *   syncEstusShare() right after they are declared. `local: true` marks a per-machine
 *   preference: the engine persists those to localStorage and keeps them out of the save
 *   file (OptionsManager.writeLocalStorage / onLoadSystemData), which is what the mod wants
 *   for connection details and for the host-authoritative toggles the host pushes down.
 *   Option keys (tt-*) are read all over the mod (main.js, features/*, client/session.js,
 *   debug/enemy-debug.js) — do not rename them. See option-types.js for the TEXT/BUTTON types
 *   and for createOption().
 */

import { createTextOption, createButtonOption, createOption } from "./option-types.js";
import { ENEMY_DEBUG_OPTION } from "../debug/enemy-debug.js";
import * as client from "../client/client.js";
import * as server from "../server/server.js";
import { createSkinSetting } from "../features/skins.js";

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

// Host-authoritative enemy-sync toggle (src/client/enemies.js: the identity + ownership
// bookkeeping and the split itself). Defaults ON: on its own it is harmless, and it is what
// makes the assignment known to everyone. src/client/enemies.js reads this key as a literal
// for the same cycle reason ../debug/enemy-debug.js does — do not rename it.
export const ENEMY_SYNC_OPTION = "tt-enemy-sync";

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

// The enemy-sync option's value, tested exactly the way the module that owns the feature tests
// it (../client/enemies.js isEnemySyncEnabled): a strict `=== true`, so the value this module
// pushes and the value the rest of the mod reads can never disagree about a non-boolean.
function isEnemySyncOn() {
	return terra.export.g_options?.get(ENEMY_SYNC_OPTION) === true;
}

// Host-authoritative push for enemy sync, like syncRevive()/syncEstusShare(). No runtime mirror
// to keep: the option IS what ../client/enemies.js reads, and a receiving client writes the
// host's value into the option (see the MSG.HOST_SETTING case in ../client/session.js), so every
// isEnemySyncEnabled() call site already answers with the host's setting.
export function syncEnemySync() {
	if (server.isHosting())
		server.setHostSetting(ENEMY_SYNC_OPTION, isEnemySyncOn());
}

// Same host-authoritative mirroring as syncRevive(), for the estus area heal.
export function syncEstusShare() {
	window.terraTogether ??= {};
	window.terraTogether.estusShareEnabled = isEstusShareEnabled();
	if (server.isHosting())
		server.setHostSetting(ESTUS_OPTION, isEstusShareEnabled());
}

// The game's CHECKBOX renderer never asks its option whether it may be edited (there is no
// getEnabled() anywhere in the engine), so a host-only setting would be freely togglable on a
// client that has to obey the host. Patch the renderer once instead: grey the buttons out and
// refuse the change when option.getEnabled() says no. The engine's own checkboxes don't define
// getEnabled at all, so the typeof test leaves every other checkbox alone. Idempotent — the
// flag stops createModSettings() from wrapping the methods twice if the loop restarts.
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
//
// The engine seeds g_options.values only for the options listed in its own options.json, and
// g_options.get() has no default fallback, so every option the mod injects has to be put into
// g_options.settings and have its value seeded here. createOption() / createTextOption() /
// createButtonOption() do that for us; the settings further down that are built by hand just
// write the same two lines out explicitly, either because they use a type this module has no
// factory for (RADIO_GROUP) or because they build their data block inline.
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

	// RADIO_GROUP is a type the game already registers, so the mod adds the option by hand:
	// into g_options.settings, plus a default for g_options.values. The seed matters here —
	// the radio renderer reads g_options.get() raw, so an unseeded row would draw with
	// nothing selected. Note the test is `=== undefined` (option-types.addSetting() also
	// treats null as absent): a value restored from localStorage is kept as-is, and every
	// read site of these keys coalesces a null one with its own `?? <default>`.
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
		description: { en_US: "Drinking your estus flask also heals nearby players: the heal is divided between those in range who need it, so they share one flask instead of each getting its full amount (you still keep your own heal). A downed teammate in range is revived. Only your own flask is consumed.\n\nSet by the host; other players obey." },
		type: { default: false, type: "CHECKBOX" }
	}, "CHECKBOX");
	// Editable only while we host (or are offline); otherwise we follow the host's value.
	estusShareOption.getEnabled = () => server.isHosting() || (!client.isConnected() && !client.isConnecting());

	// Mirror the stored host preference into the runtime flag at start-up.
	syncRevive();
	syncEstusShare();

	// Enemy sync (src/client/enemies.js): the split of enemy simulation between players, so it is
	// host-authoritative like the two toggles above — the host is one of the two ends of every
	// split, and two clients that disagreed about it would puppet enemies the arbiter says they
	// own. Defaults ON (carried over from the per-machine toggle it replaces): on its own it is
	// harmless, and it is what makes the assignment known to everyone. Switching it off makes
	// that module completely inert (it then reports no enemies and knows no owners).
	const enemySyncOption = createOption(ENEMY_SYNC_OPTION, {
		category: CATEGORY,
		local: true,
		label: { en_US: "Enemy Sync" },
		description: { en_US: "Let the server decide which player simulates each enemy, so the work is split between players instead of every client simulating everything.\n\nSet by the host; other players obey." },
		type: { default: true, type: "CHECKBOX" }
	}, "CHECKBOX");
	// Editable only while we host (or are offline); otherwise we follow the host's value.
	enemySyncOption.getEnabled = () => server.isHosting() || (!client.isConnected() && !client.isConnecting());

	// Push the host's value to clients (a no-op when we are not hosting).
	syncEnemySync();

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
				.then(() => { client.joinServer(undefined, { force: true }); syncRevive(); syncEstusShare(); syncEnemySync(); })
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
	// Defaults ON (the checkboxes below it default to false): g_options.get() has no fallback to
	// option.default and the engine does not seed a mod-injected row, so this one needs the seed
	// like the truthy defaults above — without it neither the reader (main.js
	// applyAlwaysFocused) nor the checkbox itself ever sees the declared default. tt-hide-party
	// below is the other case: it defaults to false and every read site coalesces the missing
	// entry with `?? false`, so an absent value already behaves exactly like false.
	let alwaysFocusedData = {
		category: CATEGORY,
		header: "Miscellaneous",
		label: { en_US: "Always Focused" },
		description: { en_US: "Disable game pause on lost focus. Recommended to leave this option ON to prevent desyncs on alt-tabbing." },
		type: {
			default: true,
			type: 'CHECKBOX'
		}
	};
	let alwaysFocused = new (terra.export.OptionTypeBuilder.builders.get('CHECKBOX'))("tt-always-focused", alwaysFocusedData);
	g_options.settings["tt-always-focused"] = alwaysFocused;
	if (g_options.values["tt-always-focused"] === undefined)
		g_options.values["tt-always-focused"] = alwaysFocusedData.type.default;

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
//
// Runs once per game-loop start at addon order 40000. The engine's MenuManager builds the
// MainMenu at onLoopStart order 0, so g_gui.hooks already holds it by the time this runs —
// that ordering is the only reason the two lookups below can skip a null check.
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

//# sourceURL=/mods/terra-together/config/settings.js
