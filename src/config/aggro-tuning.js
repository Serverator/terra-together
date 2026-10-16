/**
 * src/config/aggro-tuning.js
 * The ONE place the enemy-aggro rebuild's numbers live: one frozen object, every knob the
 * server half and the client half share, each with its units and what changing it does.
 * Responsibilities:
 *   - Declare every tunable of the ownership/aggro rebuild (cadence, holds, margins, radii,
 *     claim rules) as data.
 * Public surface: AGGRO_TUNING
 * Engine touchpoints: none (a plain frozen data object; no terra.* usage, no imports at all)
 * Notes:
 *   - Deliberately dependency-free and logic-free. BOTH halves of the mod import it (the
 *     arbiter in src/server/enemy-ownership.js, the server cadence in src/server/server.js, and
 *     the client's engagement/group-wake rules), so it must load in either context and must
 *     never grow a side effect. Edit a value here and reload the mod -- that is the whole point
 *     of the file, so keep it obvious and keep it the only source of truth: do not re-declare
 *     these numbers anywhere else.
 *   - Consumers read them at MODULE LOAD into `const` aliases (e.g. `const OWNER_MIN_HOLD_MS =
 *     AGGRO_TUNING.ownerMinHoldMs`), so this is an edit-and-reload surface, not a runtime knob.
 *   - Units: distances are WORLD UNITS (the engine's own space, where the enemy "loose" rule
 *     uses 20 and group aggro uses 8); times are MILLISECONDS.
 *   - Both halves must agree on the MEANING of each key; the names are the contract between
 *     them. Renaming a key is a two-sided change.
 */

export { AGGRO_TUNING };

const AGGRO_TUNING = Object.freeze({
	// ─── cadence ────────────────────────────────────────────────────────────────────
	// How often the server re-evaluates enemy ownership against positions/busy/claims (ms).
	// Lower = more responsive switch, higher = fewer handoffs. 1000 with ownerMinHoldMs 1500
	// gives the worst-case distance reaction of roughly 2.5s; halving it buys ~0.5s at the
	// cost of twice the arbitration work.
	ownershipTickMs: 1000,

	// ─── distance-driven switches ───────────────────────────────────────────────────
	// Min time an assignment is committed before DISTANCE may move it again (ms). Stops a
	// player loitering near the margin from flipping an enemy back and forth; does NOT gate
	// the moves that are not about distance (owner left the candidate set, owner downed), and
	// does NOT gate an attack claim while attackClaimHoldBypass is on.
	ownerMinHoldMs: 1500,
	// A rival candidate must be at least this much NEARER (world units) than the current owner
	// before a distance-driven switch happens. A dead band, so jitter around a boundary moves
	// nothing; raise it for more peace, lower it to let nearer players take over sooner.
	ownerSwitchMargin: 5.0,
	// Candidates within this many world units of the nearest count as EQUIDISTANT, and the
	// balanced deal (the room split) decides between them. This is the tie-breaker, so balance
	// survives float noise; leave it small.
	proximityTieBand: 1.0,

	// ─── engagement (near-player ownership) ────────────────────────────────────────
	// A player within this many world units of an IN-COMBAT enemy counts as engaged with it.
	// When a fought enemy has any engaged candidate, a distance-driven switch may only hand it
	// to one of them -- so a fighting enemy is never moved to a player standing outside the
	// fight (who the engine would de-aggro anyway at 20u). Raise it to make ownership stick to
	// whoever is in the brawl; the hold and margin still prevent it firing continually.
	aggroShareRadius: 15.0,

	// ─── attack claims ─────────────────────────────────────────────────────────────
	// An attack claim is the server seeing a forwarded hit (MSG.ENEMY_HIT) on an enemy: the
	// client that landed it asks, in effect, for that enemy to come and fight it. The claim is
	// REGISTERED the instant the hit is relayed and APPLIED at the next proximity tick, to a
	// claimant that is an eligible candidate and an enemy that is not busy.
	// When true, a claim does not wait out ownerMinHoldMs (a freshly assigned enemy can still be
	// claimed); when false, the claim must also outlast the generic hold.
	attackClaimHoldBypass: true,
	// Min time between two CLAIM-driven ownership moves of the same enemy (ms). This is the
	// anti-ping-pong guard for two players pummelling the same enemy -- each keeps forwarding
	// hits, and without this the enemy would change hands every tick. Raise it for a calmer,
	// slower claim; 0 disables the guard (thrash risk).
	claimMinHoldMs: 1500,
	// How long a claim stays live after the last hit that made it (ms). Claims are refreshed by
	// every hit, so this is "was this player recently attacking it": past the window a stale
	// claim stops pulling the enemy, which is what keeps yesterday's fight from re-homing it.
	claimTtlMs: 3000,
});

//# sourceURL=/mods/terra-together/config/aggro-tuning.js
