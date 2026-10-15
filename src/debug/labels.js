/**
 * src/debug/labels.js
 * Shared world-space label helper: builds and positions the GUI text drawn above actors.
 * Responsibilities:
 *  - build a world label TextGui (small outlined font, no auto pivot) at a given scale
 *  - resolve an actor's head anchor as a world position, from its stable collision box
 *  - project that world position to screen space and centre the label above it
 *  - park a label off-screen without tearing its TextGui down
 * Public surface: createLabel, headLabelPos, anchorLabel, placeLabelAbove, hideLabel,
 *  LABEL_HEAD_OFFSET, LABEL_HIDDEN_X
 * Engine touchpoints: terra.export.TextGui (features/gui/text/text.js:22),
 *  GuiHook.transformToMapPos (features/gui/gui-hook.js:221), EntityTools.getAlignedPos
 *  (engine/entity/entity.js:416), terra.export.ENT_ALIGN, GUI_ALIGN_X/GUI_ALIGN_Y
 *  (features/gui/gui-types.js:17-25), FONT_SIZE/FONT_OUTLINE
 *  (features/font/font-system-types.js:5-14), FONT_ALIGN (engine/font/font-types.js:6-11)
 * Notes: callers own their scale — the player nameplates follow the "Nameplate Scale"
 *  option, the enemy overlay is fixed at 0.5 — and anything they stack under a label
 *  (the nameplate HP bar). headLabelPos() returns a shared scratch vector: consume it
 *  before calling headLabelPos() again.
 */

const Vec3 = terra.export.Vec3;

// Font config shared by every world label. FONT_SIZE.SMALL === 0, FONT_OUTLINE.ON === 2,
// FONT_ALIGN.CENTER === 2 — centred so multi-line labels (the enemy overlay) line up.
const LABEL_FONT_SIZE = terra.export.FONT_SIZE.SMALL;
const LABEL_FONT_OUTLINE = terra.export.FONT_OUTLINE.ON;
const LABEL_FONT_ALIGN = terra.export.FONT_ALIGN.CENTER;

// World-space height added above the top of the collision box so the text clears the
// head. Callers pass their own extra clearance on top via headLabelPos()'s `extraZ`.
export const LABEL_HEAD_OFFSET = 0.4;

// Off-screen x used to hide a label. The TextGui stays in the GUI tree (its glyph
// layout survives), so re-showing it costs nothing; it is simply drawn off-screen.
export const LABEL_HIDDEN_X = -100000;

// Scratch world-space output for EntityTools.getAlignedPos(). Only ever read within the
// frame that filled it, so one shared vector is safe.
const labelWorld = new Vec3();

// A TextGui for a world label, drawn at `scale` and positioned from its own top-left
// corner. The caller keeps it in its GUI tree and hides it with hideLabel().
export function createLabel(scale) {
	const text = new terra.export.TextGui("", {
		size: LABEL_FONT_SIZE,
		outline: LABEL_FONT_OUTLINE,
		align: LABEL_FONT_ALIGN,
		dynamic: true,
		// Without this, TextGui.setSizeToTextBlock() re-pivots the text to its centre
		// whenever it is re-measured (features/gui/text/text.js:210); we own the pivot.
		skipAutoPivot: true
	});
	text.setAlign(terra.export.GUI_ALIGN_X.LEFT, terra.export.GUI_ALIGN_Y.TOP);
	text.setPivot(0, 0);
	text.hook.scale = scale;
	return text;
}

// World-space anchor just above the head of `entity`, taken from the stable collision box
// (not the bobbing head bone). `extraZ` is per-caller clearance in world units; pass 0
// for the plain head offset. Returns the shared scratch vector, or null for an entity
// with no core.
export function headLabelPos(entity, extraZ = 0) {
	const core = entity?.core;
	if (!core)
		return null;

	const sizeZ = core.colls?.[0]?.size?.z ?? 2;

	const tools = terra.export.EntityTools;
	const align = terra.export.ENT_ALIGN;
	if (tools?.getAlignedPos && align) {
		const pos = tools.getAlignedPos(labelWorld, entity, align.CENTER);
		if (pos) {
			pos.z += sizeZ * 0.5 + LABEL_HEAD_OFFSET + extraZ;
			return pos;
		}
	}

	// getAlignedPos unavailable: stand on the core position plus the full box height.
	return labelWorld.setC(core.pos.x, core.pos.y, core.pos.z + sizeZ + LABEL_HEAD_OFFSET + extraZ);
}

// Project `text` to map (screen) space at the world position `pos`, applying `scale`.
// ignoreScale=true: transformToMapPos must not overwrite hook.scale, we own it
// (features/gui/gui-hook.js:221-229).
export function anchorLabel(text, scale, pos) {
	text.hook.scale = scale;
	text.hook.transformToMapPos(pos, true);
}

// Centre `text` horizontally on the screen-space anchor `anchorX` and sit it fully above
// `baselineY`, both read from text.hook.pos after anchorLabel(). A label with nothing
// stacked beneath it passes its own anchor for `baselineY`; a nameplate lowered by its
// HP bar passes the raised baseline instead.
export function placeLabelAbove(text, anchorX, baselineY, scale) {
	let w = text.hook.size.x * scale;
	let h = text.hook.size.y * scale;
	// An unmeasured text can report a non-finite size. Clamp per axis: each axis then
	// contributes 0 instead of pushing the label position to NaN.
	if (!Number.isFinite(w)) w = 0;
	if (!Number.isFinite(h)) h = 0;
	text.hook.pos.x = anchorX - w * 0.5;
	text.hook.pos.y = baselineY - h;
}

// Park the label off-screen (see LABEL_HIDDEN_X).
export function hideLabel(text) {
	text.hook.pos.setC(LABEL_HIDDEN_X, 0);
}

//# sourceURL=/mods/terra-together/debug/labels.js
