/**
 * src/config/option-types.js
 * Defines two custom option types (TEXT: editable string, BUTTON: clickable mod callback)
 * for the game's Options menu, plus the small helpers that create options of any type.
 * Responsibilities:
 *   - Data models (OptionText / OptionButton, both extending terra.export.Option).
 *   - Menu renderers (OptionTextGui / OptionButtonGui) and their keyboard/mouse handling.
 *   - registerOptionTypes(): register both halves, idempotently, before any menu is built.
 *   - Factories: createTextOption, createButtonOption, createOption, setButtonHandler.
 * Public surface: registerOptionTypes, createTextOption, createButtonOption, createOption,
 *   setButtonHandler, OptionText, OptionButton, OptionTextGui, OptionButtonGui
 * Engine touchpoints: terra.export (aliased `g` below) — Option, OptionTypeBuilder,
 *   OptionTypeGui, OptionGuiTypeBuilder, g_options, ColorDecorator, ColorGui, TextGui,
 *   TextButton, LangEntry, g_tick, g_input, g_menuSFX, GUI_ALIGN_X/Y, FONT_SIZE,
 *   BUTTON_TYPES, NP_CUT_DIR; window keydown/mousedown capture listeners while a TEXT field
 *   is being edited. g.ColorDecorator.WHITE is installed at module load.
 * Notes: createOption was merged in from the deleted src/helper.js — it is the generic
 *   factory the settings modules use for option types the game already registers (e.g.
 *   CHECKBOX). registerOptionTypes() is a no-op after the first call, so every factory may
 *   call it unconditionally. All helpers must run once the Options menu is being built
 *   (main.js onLoopStart), after terra.export exists.
 */

export {
	registerOptionTypes,
	createTextOption,
	createButtonOption,
	createOption,
	setButtonHandler,
	OptionText,
	OptionButton,
	OptionTextGui,
	OptionButtonGui,
}

const g = terra.export;

const ALIGN_X = g.GUI_ALIGN_X;
const ALIGN_Y = g.GUI_ALIGN_Y;

// BUTTON callbacks by option key; set at creation or via setButtonHandler().
const buttonHandlers = new Map();

let registered = false;

g.ColorDecorator.WHITE = new g.ColorDecorator(g.FONT_COLOR.WHITE);

// ───────────────────────────── data model ─────────────────────────────

class OptionText extends g.Option {
	constructor(key, data) {
		super(key, data);
		this.maxLength = this.config.maxLength || 0;
		this.placeholder = g.LangEntry.getText(this.config.placeholder, true) || "";
		// Optional predicate () => boolean; when false the field cannot be edited.
		this.isEnabled = null;
	}
	getEnabled() {
		return typeof this.isEnabled === "function" ? !!this.isEnabled() : true;
	}
	get default() {
		const value = this.config.default;
		return value === undefined || value === null ? "" : value;
	}
	getDefaultText() {
		// Shown as "Default value" in the info panel.
		return g.LangEntry.getText(this.config.default, true) || "";
	}
	isValid(value) {
		if (typeof value !== "string")
			return false;
		if (this.maxLength > 0 && value.length > this.maxLength)
			return false;
		return true;
	}
}
OptionText.type = "TEXT";

class OptionButton extends g.Option {
	constructor(key, data) {
		super(key, data);
		this.buttonWidth = this.config.width || 0;
		this.onPress = null;
		// Optional predicate () => boolean; when false the button is disabled.
		this.isEnabled = null;
	}
	getDefaultText() {
		// Buttons have no meaningful default value to show in the info panel.
		return null;
	}
	getButtonText() {
		if (!this.getEnabled() && this.config.disabledText)
			return g.LangEntry.getText(this.config.disabledText, true) || this.config.text || "OK";
		return g.LangEntry.getText(this.config.text, true) || "OK";
	}
	getEnabled() {
		return typeof this.isEnabled === "function" ? !!this.isEnabled() : true;
	}
}
OptionButton.type = "BUTTON";

// ───────────────────────────── menu renderer ─────────────────────────────

class OptionTextGui extends g.OptionTypeGui {
	constructor(row, option) {
		super(row, option);
		this.editing = false;
		this.editText = "";
		this.caret = 0;
		this.caretOn = true;
		this.caretTimer = 0;
		this.focused = false;
		this.lastEnabled = null;

		this.onKeyDown = this.onKeyDown.bind(this);
		this.onWindowMouseDown = this.onWindowMouseDown.bind(this);

		this.background = new g.ColorGui(new g.Color("#00000000"));
		this.background.setAlign(ALIGN_X.CENTER, ALIGN_Y.CENTER);
		this.addChild(this.background);

		this.text = new g.TextGui("", { size: g.FONT_SIZE.LARGE });
		this.text.setAlign(ALIGN_X.CENTER, ALIGN_Y.CENTER);
		this.text.setPos(0, -1);
		this.addChild(this.text);

		this.refresh();
	}

	setSize(x, y) {
		super.setSize(x, y);
		this.background.setSize(Math.max(0, x - 8), Math.max(0, y - 8));
		this.text.setMaxWidth(Math.max(0, x - 16));
		this.refresh();
	}

	update() {
		if (this.editing) {
			// Blink the caret roughly twice a second.
			this.caretTimer += g.g_tick.gui;
			if (this.caretTimer >= 0.5) {
				this.caretTimer = 0;
				this.caretOn = !this.caretOn;
				this.refresh();
			}
			return;
		}
		// Reflect enable/disable changes (e.g. while connected) live.
		this.refreshEnabled();
	}

	getEnabled() {
		return typeof this.option.getEnabled === "function" ? this.option.getEnabled() : true;
	}

	refreshEnabled() {
		const enabled = this.getEnabled();
		if (enabled !== this.lastEnabled) {
			this.lastEnabled = enabled;
			this.refresh();
		}
	}

	refresh() {
		if (this.editing) {
			const caret = this.caretOn ? "|" : " ";
			this.text.setText(this.editText.slice(0, this.caret) + caret + this.editText.slice(this.caret));
			this.text.setDecorator(this.focused ? g.ColorDecorator.YELLOW : g.ColorDecorator.WHITE);
			return;
		}
		const enabled = this.getEnabled();
		const value = g.g_options.get(this.key);
		if (value === undefined || value === null || value === "") {
			this.text.setText(this.option.placeholder || "<empty>");
			this.text.setDecorator(g.ColorDecorator.GREY);
		}
		else {
			this.text.setText(String(value));
			this.text.setDecorator(enabled ? g.ColorDecorator.WHITE : g.ColorDecorator.GREY);
		}
	}

	startEditing() {
		if (this.editing)
			return;
		if (!this.getEnabled()) {
			g.g_menuSFX.blocked();
			return;
		}
		const value = g.g_options.get(this.key);
		this.editText = (value === undefined || value === null) ? "" : String(value);
		this.caret = this.editText.length;
		this.editing = true;
		this.caretOn = true;
		this.caretTimer = 0;
		// Capture keystrokes (bubble phase) before the game's menu handler does.
		g.g_input.ignoreKeyboard = true;
		// Drop held actions (e.g. the confirm press) so they don't repeat while typing.
		g.g_input.clearActions();
		window.addEventListener("keydown", this.onKeyDown, true);
		window.addEventListener("mousedown", this.onWindowMouseDown, true);
		g.g_menuSFX.confirmMedium();
		this.refresh();
	}

	stopEditing(commit) {
		if (!this.editing)
			return;
		this.editing = false;
		window.removeEventListener("keydown", this.onKeyDown, true);
		window.removeEventListener("mousedown", this.onWindowMouseDown, true);
		g.g_input.ignoreKeyboard = false;
		if (commit && g.g_options.get(this.key) !== this.editText)
			g.g_options.set(this.key, this.editText);
		this.refresh();
	}

	resetCaretBlink() {
		this.caretOn = true;
		this.caretTimer = 0;
		this.refresh();
	}

	onKeyDown(event) {
		if (!this.editing)
			return;
		event.stopPropagation();
		event.preventDefault();
		const key = event.key;

		switch (key) {
			case "Escape":
				this.stopEditing(false);
				g.g_menuSFX.pageBackward();
				return;
			case "Enter":
				this.stopEditing(true);
				g.g_menuSFX.confirmMedium();
				return;
			case "Backspace":
				if (this.caret > 0) {
					this.editText = this.editText.slice(0, this.caret - 1) + this.editText.slice(this.caret);
					this.caret--;
				}
				return this.resetCaretBlink();
			case "Delete":
				this.editText = this.editText.slice(0, this.caret) + this.editText.slice(this.caret + 1);
				return this.resetCaretBlink();
			case "ArrowLeft":
				this.caret = Math.max(0, this.caret - 1);
				return this.resetCaretBlink();
			case "ArrowRight":
				this.caret = Math.min(this.editText.length, this.caret + 1);
				return this.resetCaretBlink();
			case "Home":
				this.caret = 0;
				return this.resetCaretBlink();
			case "End":
				this.caret = this.editText.length;
				return this.resetCaretBlink();
		}

		if (event.ctrlKey || event.metaKey || event.altKey)
			return;
		if (key.length !== 1)
			return;
		if (this.option.maxLength > 0 && this.editText.length >= this.option.maxLength)
			return;
		this.editText = this.editText.slice(0, this.caret) + key + this.editText.slice(this.caret);
		this.caret++;
		this.resetCaretBlink();
	}

	onWindowMouseDown() {
		// Clicking anywhere ends editing (the click itself still goes through).
		this.stopEditing(true);
	}

	onValidate() {
		this.lastEnabled = this.getEnabled();
		if (!this.editing)
			this.refresh();
	}

	onAttach() {
		this.refresh();
	}

	onRowFocusGain() {
		this.focused = true;
		this.refresh();
	}

	onRowFocusLost() {
		this.focused = false;
		this.stopEditing(true);
	}

	onConfirmPressed() {
		this.startEditing();
	}

	onMouseInteract(mouseOver, clicked) {
		if (clicked && !this.editing)
			this.startEditing();
	}

	onLeftRightInput(direction) { }

	hasFocus() {
		return this.editing;
	}

	canLeaveFocus() {
		return !this.editing;
	}

	getMouseFocusButtons() {
		return null;
	}
}
OptionTextGui.type = "TEXT";

class OptionButtonGui extends g.OptionTypeGui {
	constructor(row, option) {
		super(row, option);
		this.button = new g.TextButton(option.getButtonText(), {
			type: g.BUTTON_TYPES.GROUP_SINGLE,
			cutDirHorz: g.NP_CUT_DIR.NONE,
			width: option.buttonWidth || 120,
			minWidth: 60,
		});
		this.button.setAlign(ALIGN_X.CENTER, ALIGN_Y.CENTER);
		this.button.onButtonPress = () => this.press();
		this.addChild(this.button);
		this.lastEnabled = null;
		this.lastText = null;
		this.refreshEnabled();
	}

	// Called every frame while the menu is open so the button reflects live state.
	update() {
		this.refreshEnabled();
	}

	// Apply the enabled predicate visually and behaviourally (plays "blocked" when off).
	// Cached so setActive()/setText() (which rebuild the text) only run on change.
	refreshEnabled() {
		const enabled = this.option.getEnabled();
		if (enabled !== this.lastEnabled) {
			this.lastEnabled = enabled;
			this.button.setActive(enabled);
			if (!enabled)
				this.button.setPressed(false);
		}
		const text = this.option.getButtonText();
		if (text !== this.lastText) {
			this.lastText = text;
			this.button.setText(text, true);
		}
	}

	press() {
		if (!this.option.getEnabled()) {
			g.g_menuSFX.blocked();
			return;
		}
		g.g_menuSFX.confirmMedium();
		const handler = this.option.onPress || buttonHandlers.get(this.key);
		if (typeof handler === "function") {
			try {
				handler(this.option, this.key);
			}
			catch (err) {
				console.error(`[TerraTogether] BUTTON option '${this.key}' handler failed:`, err);
			}
		}
		// The handler may have changed the enabled state (e.g. hosting started).
		this.refreshEnabled();
	}

	onValidate() {
		this.refreshEnabled();
	}

	onConfirmPressed() {
		// Mouse clicks are delivered straight to the button via onButtonPress.
		if (g.g_input.mouseGuiActive)
			return;
		this.press();
	}

	onRowFocusGain() {
		if (g.g_input.mouseGuiActive)
			return;
		this.button.focusGained();
	}

	onRowFocusLost() {
		this.button.focusLost();
	}

	getMouseFocusButtons() {
		return [{ index: 1, gui: this.button }];
	}

	hasFocus() {
		return this.button.focus;
	}
}
OptionButtonGui.type = "BUTTON";

// ───────────────────────────── helpers ─────────────────────────────

// Registers both halves of the new option types. Safe to call repeatedly.
function registerOptionTypes() {
	if (registered)
		return;
	registered = true;
	g.OptionTypeBuilder.register(OptionText);
	g.OptionTypeBuilder.register(OptionButton);
	g.OptionGuiTypeBuilder.register(OptionTextGui);
	g.OptionGuiTypeBuilder.register(OptionButtonGui);
	// Mirror the game, which seeds g_options.types from its OPTION_TYPE enum.
	for (const type of ["TEXT", "BUTTON"])
		if (!g.g_options.types[type])
			g.g_options.addType(type);
}

// Registers a button handler by option key (for callbacks defined later).
function setButtonHandler(key, handler) {
	buttonHandlers.set(key, handler);
}

function addSetting(key, option) {
	const options = g.g_options;
	options.settings[key] = option;
	// Preserve a value restored from localStorage / a save, otherwise use default.
	if (options.values[key] === undefined || options.values[key] === null)
		options.values[key] = option.default;
	return option;
}

// Creates a TEXT setting. `data.type` may carry `default`, `maxLength`, `placeholder`.
function createTextOption(key, data) {
	registerOptionTypes();
	data.type = { ...(data.type || {}), type: "TEXT" };
	return addSetting(key, g.OptionTypeBuilder.build("TEXT", key, data));
}

// Creates a BUTTON setting. `onPress(option, key)` runs on press.
function createButtonOption(key, data, onPress) {
	registerOptionTypes();
	data.type = { ...(data.type || {}), type: "BUTTON" };
	const option = g.OptionTypeBuilder.build("BUTTON", key, data);
	if (typeof onPress === "function")
		option.onPress = onPress;
	return addSetting(key, option);
}

// Creates a new option in the game menu, for any option type the game already knows
// (used for the CHECKBOX settings). Should run in `onLoopStart`. Merged verbatim from
// the deleted src/helper.js, minus its option-types.js import.
function createOption(id, data, type) {
	registerOptionTypes();

	let builder = terra.export.OptionTypeBuilder.builders.get(type);
	if (!builder)
		throw new Error("[TerraTogether] Unknown option type: " + type);

	let option = new builder(id, data);

	let options = terra.export.g_options;
	options.settings[id] = option;
	// Keep a value restored from localStorage/save, otherwise use the default.
	if (options.values[id] === undefined || options.values[id] === null)
		options.values[id] = option.default;

	return option;
}

//# sourceURL=/mods/terra-together/config/option-types.js
