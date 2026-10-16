/**
 * src/debug/enemy-debug.js
 * Enemy debug overlay: a small label above every live enemy showing the player who owns
 * (will simulate) it, its stable enemy id (the string the sync keys on, so the same enemy
 * can be matched across clients' screens), the enemy's current logic state and the action
 * its actor is running.
 * Responsibilities:
 *  - on/off from window.ttEnemyDebug (live) OR the tt-enemy-debug option
 *  - the ownership label: the SERVER-assigned owner when one is known (src/client/enemies.js,
 *    which owns enemy identity too), else the local rendezvous hash (SWAP-POINT)
 *  - one TextGui per live enemy, drawn at a fixed 0.5 scale via ./labels.js
 * Public surface: ENEMY_DEBUG_OPTION, ENEMY_DEBUG_SCALE, enemyStableId (re-exported from
 *  ../client/enemies.js, which now owns it), enemyOwnerLabel, EnemyDebug, EnemyDebugGui
 * Engine touchpoints: terra.addAddon (src/main.js registers EnemyDebug at onLoopStart 50001),
 *  terra.export GuiElement / g_gui / g_system.size / g_scene / g_gState.entities /
 *  g_options / EnemyCmp; window.terraTogether.playerId / peers / playerNames (published by
 *  src/client/session.js). TextGui itself is reached through ./labels.js; the enemy ids and
 *  the assigned owners come from ../client/enemies.js.
 * Notes: label building/anchoring is shared with src/features/nameplates.js via ./labels.js;
 *  ENT_ALIGN.CENTER head-node ref: engine/entity/entity.js:416. Off by default. Ownership is
 *  read from the server assignment when there is one and falls back to a local policy
 *  otherwise: the entire fallback is the SWAP-POINT section below.
 *
 * ─────────────────────────────── HOW TO TOGGLE ───────────────────────────────
 *   1) Live / per-session — NW.js devtools console (F12, or Ctrl+Shift+I):
 *        window.ttEnemyDebug = true;    // on
 *        window.ttEnemyDebug = false;   // off
 *      The flag is re-read every frame, so toggling is immediate and needs no reload.
 *      Delete the property (delete window.ttEnemyDebug) to fall back to the option.
 *   2) Persistent across restarts — Options > Multiplayer > Debug >
 *      "Enemy Debug Overlay" (the tt-enemy-debug checkbox, declared in src/config/settings.js).
 *
 *   Enabled = window flag OR option.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createLabel, headLabelPos, anchorLabel, placeLabelAbove, hideLabel } from "./labels.js";
// Enemy identity (enemyStableId, re-exported at the bottom so this module's surface is
// unchanged) and the server-assigned owner. Identity lives in one place: ../client/enemies.js
// builds the ids this overlay labels and the registry that turns them into owners.
import { enemyStableId, getEnemyOwnerId, getEnemyOwnerName } from "../client/enemies.js";

// Option key (declared in src/config/settings.js, read here) and the console flag name.
export const ENEMY_DEBUG_OPTION = "tt-enemy-debug";
const ENEMY_DEBUG_WINDOW_FLAG = "ttEnemyDebug";

// The overlay always draws at 0.5x, unlike the nameplates (which follow the "Nameplate
// Scale" option). Half of the nameplate default is deliberately small: the label is a
// four-line debug readout over the head, so it is kept quieter than the name it sits next
// to, and it is a constant rather than an option because the overlay is a debug view.
// Load-bearing value — keep it exact: ./labels.js multiplies the measured text size and the
// stacking baseline by it.
export const ENEMY_DEBUG_SCALE = 0.5;

// Extra world-space z on top of the shared head offset, so the label clears the head node.
// Passed to labels.js headLabelPos() as its `extraZ`.
const LABEL_GAP = 0.15;

// The username option, same source src/features/nameplates.js and src/main.js use for the
// local player.
const USERNAME_OPTION = "tt-username";

// True when the overlay should draw this frame, i.e. window flag OR option. Both tests are
// strict `=== true`, so only a real boolean switches the overlay on — a truthy leftover in
// either place does not. The window flag is checked first, so a live console toggle overrides
// the stored setting without touching it; deleting the property falls back to the option.
// Both reads are plain property lookups, which is what makes the flag take effect on the next
// frame with no reload.
function isEnemyDebugEnabled() {
	if (typeof window !== "undefined" && window[ENEMY_DEBUG_WINDOW_FLAG] === true)
		return true;
	return terra.export.g_options?.get(ENEMY_DEBUG_OPTION) === true;
}

// Whitespace/command sanitising for network-supplied text. `{...}` are text commands in
// this engine's text blocks, so a crafted username must not reach the label verbatim.
function cleanText(value) {
	if (value == null)
		return null;
	const text = String(value).replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
	return text === "" ? null : text;
}

// ─────────────────────────── enemy owner (SWAP-POINT) ───────────────────────────
//
// Enemy simulation ownership is server-arbitrated now (../client/enemies.js, fed by the
// server's enemy_owner), so what follows is the FALLBACK policy: the display used ONLY for an
// enemy this client cannot name an assigned owner for (no connection, no assignment yet, or an
// owner whose username never reached us -- see getEnemyOwnerName() in ../client/enemies.js,
// which the label reads first, and ownerLine() below, which marks this fallback so it is never
// read as the assignment). ALL of that fallback lives in enemyOwnerLabel() and the helpers
// between it and the identity helper that used to sit here (now enemyStableId() in
// ../client/enemies.js). The point of that shape is that it is a pure function of state every
// client already has: no client tells another who owns what, they agree because they run the
// same arithmetic over the same inputs -- which is exactly why it can disagree with the
// server's split and must not be mistaken for it.
//
// Contract, in the order the invariants build on each other:
//   1. enemyStableId() (../client/enemies.js) gives the same enemy the same id on every client.
//   2. ownerRoster() gives every client the same roster, in the same order, for the same set
//      of connected players.
//   3. enemyOwnerLabel() turns those two into a total, deterministic choice, so two clients
//      can never disagree about an enemy's owner.
// With no peers the local player owns everything (a one-member roster always wins its own
// comparison). Only the displayed NAME can differ between clients for a moment — the local
// player reads their own tt-username while peers render the name the server relayed — but the
// choice itself is made on roster keys, never on names.

// Key used for the local player when the server has not assigned an id yet
// (offline / single-player): there are no peers then, so this only ever competes
// with itself and the local player wins.
const LOCAL_ROSTER_KEY = "local";
const LOCAL_FALLBACK_NAME = "Player";

// 32-bit FNV-1a, written out by hand on purpose: the owner choice is only stable if both
// clients hash the identical string to the identical 32-bit value, so this must not lean on
// anything locale, platform or (crypto) API dependent. charCodeAt works on UTF-16 code units
// and Math.imul keeps the multiply in 32 bits; the only allocation is the input string.
function stableHash(text) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

// Local player's display name: their configured username, else a readable fallback.
function selfDisplayName() {
	return cleanText(terra.export.g_options?.get(USERNAME_OPTION)) ?? LOCAL_FALLBACK_NAME;
}

// A peer's display name, falling back to a short stable tag when they never sent one.
function peerDisplayName(peerId, key) {
	const name = cleanText(window.terraTogether?.playerNames?.get(peerId));
	return name ?? ("Player " + String(key).slice(0, 4));
}

// The known roster: the local player plus every connected peer, sorted by id so the result
// never depends on Set/Map insertion order (which differs per client). Keys are
// String(playerId) — the server's numeric ids, stringified the same way on both sides. The
// sort is lexicographic, not numeric, which is fine: all it has to be is the same order on
// every client. The local player is inserted unconditionally, so the roster is never empty.
function ownerRoster() {
	const tt = (typeof window !== "undefined" ? window.terraTogether : null) ?? {};
	const selfKey = tt.playerId != null ? String(tt.playerId) : LOCAL_ROSTER_KEY;

	const roster = new Map();
	roster.set(selfKey, selfDisplayName());
	for (const peerId of tt.peers ?? []) {
		const key = String(peerId);
		if (roster.has(key))
			continue;
		roster.set(key, peerDisplayName(peerId, key));
	}

	return [...roster].map(([key, name]) => ({ key, name }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// The enemy's stable identity moved to ../client/enemies.js (exported there, imported at the
// top of this file and re-exported below): this overlay labels the ids that module builds, so
// the two cannot drift apart. See the identity note there for what the ids mean and why
// anything without a map id only has a client-local one.

// SWAP-POINT: which player owns this enemy. Rendezvous ("highest random weight") hashing:
// every roster member scores hash(enemyId|key) and the highest score wins. Each client has
// both inputs already (invariants 1 and 2 above), so each reaches the same answer alone — no
// coordination, no tie-breaking messages, nothing to keep in sync. Rendezvous is used instead
// of, say, hash % rosterSize because a roster change then only moves the enemies that the
// changed member was winning; with a modulo, one player joining would re-own almost
// everything.
//
// Ties (a hash collision on two members' scores) resolve to the first member in roster order,
// i.e. the lowest key, because the roster is sorted and the comparison is strictly `>`.
// bestScore starts at -1, below every unsigned FNV result, so the first member always beats
// the initial state and `best` is never left unassigned. roster[0] therefore is not optional:
// ownerRoster() always contains the local player, and the empty-roster branch below is only a
// guard in case that ever stops being true.
export function enemyOwnerLabel(enemyId) {
	const roster = ownerRoster();
	if (roster.length === 0)
		return LOCAL_FALLBACK_NAME;
	let best = roster[0];
	let bestScore = -1;
	for (const member of roster) {
		const score = stableHash(enemyId + "|" + member.key);
		if (score > bestScore) {
			bestScore = score;
			best = member;
		}
	}
	return best.name;
}

// ──────────────────────────────── entity plumbing ────────────────────────────────

function isWorldSceneActive() {
	return !!terra.export.g_scene?.isRunning?.() && !terra.export.g_scene?.isCutscene?.();
}

// A live enemy = an entity carrying an EnemyCmp whose combatant is alive. Enemies that
// have not finished initialising (no combatant yet) and already-killed entities are skipped.
function getLiveEnemy(core) {
	if (!core || !core.ent || core.isKilled?.())
		return null;
	const enemy = terra.export.EnemyCmp?.get?.(core.ent);
	if (!enemy || !enemy.combatant)
		return null;
	if (typeof enemy.isAlive === "function" && !enemy.isAlive())
		return null;
	return enemy;
}

// The label's FIXED line set, in order: owner, enemy id, logic state, running action. All
// four lines are emitted on every frame.
//
// Order: owner first (who simulates this enemy) and the id second, directly under it, because
// the id is the cross-client key the owner is derived from -- reading the two together is what
// makes "same enemy, two screens" checks quick. State then action, as before.
//
// Every line is emitted unconditionally, with the same `-` placeholder a missing state already
// used, because a dropped line is not a cosmetic loss here: ./labels.js placeLabelAbove()
// anchors the block by its BOTTOM edge (it subtracts the measured block height from the head
// baseline), so a shorter block re-flows the remaining lines DOWNWARDS from the fixed head
// anchor. The running action is usually empty, so emitting it only when present would make the
// whole readout jump every time one starts or ends. A constant line count keeps the block
// height constant and the lines still, frame to frame.
//
// Both enemy fields can legitimately be null. The owner and the id never are: the owner is the
// server's assignment whenever this client can NAME it, and only when it cannot does the local
// rendezvous estimate below stand in -- marked, because the two are not the same claim (see
// ownerLine), and enemyStableId() always returns a string.
function buildLabel(core, enemy) {
	const id = enemyStableId(core);
	const owner = ownerLine(id);
	const state = cleanText(enemy.currentState?.name) ?? "-";
	const action = cleanText(core.ent?.actor?.actionState?.sequence?.name) ?? "-";
	// The id goes in VERBATIM, never through cleanText(): the whole point of the line is that
	// it is byte-for-byte the string the sync exchanges, so the two clients' labels match.
	return `${owner}\n${id}\n${state}\n${action}`;
}

// The owner line, and the whole point of the marker on it. This runs on the observer's side of a
// two-screen check, so the line must never look like an agreement it did not get:
//   * getEnemyOwnerId() is the server's assignment as THIS client knows it, i.e. which player is
//     simulating the enemy (and the same answer ../client/enemies.js acts on: an enemy this client
//     is shown, rather than running, is one it accepted a peer's state for, which only the
//     assignment's owner can send -- enemies.js currentOwner/onEnemyState). That is the authority.
//   * The NAME for that id can still be missing: a peer that never set a tt-username sends a null
//     profile, the server relays it verbatim (server.js MSG.PROFILE) and cleanText() drops it, so
//     getEnemyOwnerName() answers null for an owner whose identity is perfectly well known. Naming
//     it by its id tag is then the honest line, and the one that matches the other screen.
//   * Only when the client has NO assignment at all does the local rendezvous estimate stand in,
//     and it is marked: it is a different policy (this file's own arithmetic), free to disagree
//     with the server's split -- in a two-player room it names the local player about half the
//     time -- so an unmarked fallback reads as "this client owns the enemy" when the client may be
//     simulating nothing of the sort. "(est)" says the line is a guess made here; the id line
//     below it is what to compare across screens.
function ownerLine(enemyId) {
	const ownerId = getEnemyOwnerId(enemyId);
	if (ownerId === null)
		return enemyOwnerLabel(enemyId) + " (est)";
	return getEnemyOwnerName(enemyId) ?? peerDisplayName(Number(ownerId), ownerId);
}

// One TextGui per live enemy, positioned over its head each frame.
class EnemyDebugGui extends terra.export.GuiElement {
	constructor() {
		super();
		this.entries = new Map();
		this.hook.zIndex = 6;            // same layer as the player nameplates
		this.hook.updateOnPause = true;
		this.setSize(terra.export.g_system.size.x, terra.export.g_system.size.y);
	}

	createEntry(key) {
		const text = createLabel(ENEMY_DEBUG_SCALE);
		const entry = { text, label: null };
		this.entries.set(key, entry);
		this.addChild(text);
		return entry;
	}

	updateEntry(key, core, label) {
		const entry = this.entries.get(key) ?? this.createEntry(key);

		// setText() re-measures the text block (features/gui/text/text.js:173-178), so only
		// push the string when it actually changed.
		if (entry.label !== label) {
			entry.label = label;
			entry.text.setText(label);
		}

		const pos = core.isVisible?.() ? headLabelPos(core.ent, LABEL_GAP) : null;
		if (!pos) {
			hideLabel(entry.text);
			return;
		}

		const text = entry.text;
		// Screen-space anchor at the head; centre horizontally and sit fully above it.
		anchorLabel(text, ENEMY_DEBUG_SCALE, pos);
		placeLabelAbove(text, text.hook.pos.x, text.hook.pos.y, ENEMY_DEBUG_SCALE);
	}

	update() {
		const active = new Set();

		if (isEnemyDebugEnabled() && isWorldSceneActive()) {
			for (const core of terra.export.g_gState?.entities ?? []) {
				const enemy = getLiveEnemy(core);
				if (!enemy)
					continue;
				// Entries are keyed by core.uid, which is unique within this client (a
				// per-process counter) — all the map needs. The owner shown in the label comes
				// from enemyStableId() instead, because that one has to match the other clients.
				const key = String(core.uid);
				active.add(key);
				this.updateEntry(key, core, buildLabel(core, enemy));
			}
		}

		// Drop entries whose enemy is gone (or whose overlay was just switched off).
		for (const [key, entry] of [...this.entries]) {
			if (active.has(key))
				continue;
			this.removeChild(entry.text);
			this.entries.delete(key);
		}
	}
}
// GuiHook reads `element.constructor.states` when the element attaches
// (features/gui/gui-hook.js:95); both states are instant (duration 0), so showing or hiding an
// entry never fades. Overrides GuiElement's base table (DEFAULT only, spline EASE, 0.2s).
EnemyDebugGui.states = {
	DEFAULT: { transform: { alpha: 1 }, duration: 0 },
	HIDDEN: { transform: { alpha: 0 }, duration: 0 }
};

class EnemyDebug {
	onLoopStart() {
		const g_gui = terra.export.g_gui;
		if (!g_gui?.addElement)
			return;
		// forceVisible: an element added straight to the GUI manager is only shown when the
		// root hook is told to be visible (features/gui/gui-hook.js:252).
		g_gui.addElement(new EnemyDebugGui(), true);
	}
}

export { EnemyDebug, EnemyDebugGui, enemyStableId };

//# sourceURL=/mods/terra-together/debug/enemy-debug.js
