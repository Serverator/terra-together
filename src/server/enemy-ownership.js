/**
 * src/server/enemy-ownership.js
 * The enemy-sync ownership arbiter: decides which client simulates each map-placed enemy.
 * Responsibilities:
 *   - Record which enemies exist, which room each one belongs to, and who simulates it.
 *   - Assign an owner on registration, and rebalance a room's split whenever its membership
 *     changes: a member arrives, leaves, changes room or disconnects, or a client announces an
 *     enemy that only some of the room has (that widens the enemy's candidate set -- see below).
 *   - Stamp every assignment with a monotonic epoch so a stale owner message is rejectable.
 *   - Re-home an enemy onto the NEAREST player who can simulate it (onProximityTick), so the
 *     engine's owner-locked targeting aims at the player who is actually in the fight.
 * Public surface: EnemyOwnership (register, unregister, onRosterChange, onProximityTick, rooms,
 *   ownerOf, epochOf, ownedRooms, validate)
 * Engine touchpoints: none (pure bookkeeping: no sockets, no I/O, no terra.* usage)
 * Notes:
 *   - Split ownership is what makes this safe: each client simulates the enemies it owns and
 *     renders the rest as puppets, and this module is the single answer to "who owns what".
 *     The server hosting the arbiter is one process, so its assignment *is* the consensus --
 *     there is no second coordinator to disagree with, which is exactly what the old
 *     enemy-sync branch got wrong (each client worked out an owner locally; two clients could
 *     both claim the same enemy). The arbiter never simulates anything itself.
 *   - Determinism is the crux. Two clients that disagree about an owner freeze the enemy (both
 *     puppet it) or simulate it twice. So the room's split is a pure function of the server's
 *     own state, never of a client-local value such as core.uid, which differs per client. The
 *     split is produced by onRosterChange(), which deals the room's sorted enemies to their
 *     sorted candidate sets in turn; register() only places a NEW enemy, on the least-loaded of
 *     its candidates, ties going to the lexicographically smallest playerId. register() also
 *     re-runs that deal whenever a registrant is added (a candidate set changed), so the split a
 *     client is told is the same one any other client would compute, however the announcements
 *     arrived -- that is what lets a client trust an assignment it did not compute itself.
 *   - Reassignment is a FULL rebalance of the room, not orphan repair, and that difference is
 *     the whole point of it. At map start the first client's registrations can arrive before
 *     the second client's room is known, so every enemy is assigned against a one-member
 *     roster; when the second client's room then becomes known, both clients are present, no
 *     assignment is an orphan, and orphan repair would leave one client owning the entire map
 *     -- exactly the bug the split exists to prevent. Recomputing the split whenever the room or
 *     a candidate set changes is what converges on the balanced one, and the rebalance is
 *     idempotent, so a change that moves nothing publishes nothing.
 *   - An enemy is held by more than one client (every client that can see it announces it), so
 *     a record carries the set of clients that have announced it. A withdrawal removes only the
 *     withdrawing client; the record (and its epoch) survives while any other client still
 *     holds the enemy. That is what keeps an assignment's epoch comparable across a
 *     withdrawal, and it is why unregister() takes the sender.
 *   - An enemy may only be assigned to a client that HAS it, so the owner is always a client
 *     that can actually drive it. The candidate set for an enemy is `registrants(enemy) ∩
 *     roomMembers`, falling back to `roomMembers` when that is empty (nobody the room knows
 *     about has announced it). In the normal, symmetric case -- every client has announced
 *     every enemy -- that intersection IS the room's members, so both rules below reduce
 *     BYTE-IDENTICALLY to the pre-candidate behaviour: pickOwner's pool is the full roster, and
 *     onRosterChange's per-enemy least-loaded/tie-break deal reproduces the round-robin
 *     `members[i % members.length]` it replaced (it deals the sorted enemies to the sorted
 *     members in turn). A fresh enemy is therefore placed on its first registrant, and the room
 *     is re-split onto a real balance only once the other clients have announced it too, which
 *     register() triggers when a registrant is added.
 *   - Room keys are `<map>#<variant>` (variant null outside rogue). server.js builds the same
 *     key from the messages a client sends; this module only compares keys, it never parses
 *     one.
 *     The ENEMY id, by contrast, is not variant-scoped, so the same map path in two rogue
 *     variants de-dupes onto one owner here -- a known gap deferred to Phase 2, recorded at
 *     the id's origin in src/client/enemies.js (the id format must not change in Phase 1).
 *   - The BALANCED SPLIT above decides only WHO may simulate an enemy, never WHICH of the
 *     eligible clients it is best for. That is what Phase 7's proximity pass adds: the engine's
 *     enemy targeting is hard-wired to the OWNER's local player (enemy-cmp.js:654), and it
 *     drops a target that stays >20u away for 5s (:584-588), so an enemy dealt to a player 30u
 *     away fights nobody while its neighbour, dealt to the player standing in the fight, fights
 *     normally -- the "one enemy is aggroed and the one next to it is not" report. Assigning to
 *     the nearest eligible player makes the target the player who is actually there. The pass
 *     is a refinement, not a replacement: it keeps the roster deal's answer whenever the
 *     candidates are equidistant (see PROXIMITY_TIE_BAND), it never assigns outside the
 *     candidate set, and its hysteresis makes a move the exception rather than the rule.
 *   - onProximityTick is pure (positions, liveness and a clock go in; changed assignments come
 *     out), so the SERVER owns the cadence and the publishing. It is idempotent like the
 *     rebalance, which is what lets a tick that finds nothing to move stay silent -- positions
 *     change every frame, so a pass that reacted to them would churn the handoff machinery
 *     mid-fight.
 * Wire: MSG.ENEMY_OWNER (server -> all clients) publishes the { id, owner, epoch } assignment
 *   this module returns. MSG.ENEMY_REGISTER / MSG.ENEMY_UNREGISTER (client -> server) drive
 *   register()/unregister(); all three live in src/net/protocol.js. validate() is also the gate
 *   for the relayed MSG.ENEMY_STATE, so only an enemy's owner may drive it.
 */

export { EnemyOwnership };

// A player id is only usable as a candidate when it is a non-empty string. Anything else
// (undefined from a half-populated roster, a number from a malformed payload) is DROPPED
// rather than coerced: a coerced id could win a lexical tie-break and hand an enemy to a
// player that does not exist.
function normalizeIds(ids) {
	if (!Array.isArray(ids))
		return [];
	const out = [];
	for (const id of ids) {
		if (typeof id === "string" && id.length > 0)
			out.push(id);
	}
	return out;
}

// The clients that may be given `entry`: the room's members that have actually ANNOUNCED this
// enemy, so an enemy that exists on only one client's screen is never handed to the other -- a
// client that does not have the enemy cannot drive it. Falls back to the whole room when nobody
// in it has announced the enemy (every registrant has left the room, or it was registered from no
// room), which keeps the degenerate case on the behaviour it had before the candidate rule.
// `members` is expected already normalised; the order is preserved, so a sorted input gives a
// sorted pool.
function candidatePool(entry, members) {
	const pool = members.filter((id) => entry.registrants.has(id));
	return pool.length > 0 ? pool : members;
}

// ─── proximity arbitration (Phase 7) ───────────────────────────────────────────────
// Ownership has to be proximity-aware because the engine's enemy targeting is hard-wired to the
// OWNER's local player (enemy-cmp.js:654-656 updateTarget) and drops a target that stays >20u
// away for 5s (:584-588): an enemy dealt to a player across the map aggros onto nobody who is
// there, while the enemy next to it -- dealt to the player in the fight -- fights normally. The
// same fight, opposite behaviour, entirely explained by ownership. Assigning each enemy to the
// NEAREST eligible player makes the owner's local player, by construction, the player who is
// there to be targeted.
//
// Every ownership move costs a handoff (the old owner's final state, the new owner's adoption)
// and is visible mid-fight, so the pass is deliberately reluctant to move anything. Three
// constants govern that, and all three are in world units / milliseconds of the server's clock:
//   - OWNER_SWITCH_MARGIN: a different candidate must be nearer by at least this much before a
//     distance-driven move happens. A dead band, so jitter around a boundary moves nothing.
//   - OWNER_MIN_HOLD_MS: how long an enemy's assignment is committed before DISTANCE may move it
//     again, so a player hovering near the margin cannot flip it back and forth. It deliberately
//     does NOT gate the moves that are not about distance -- owner gone from the candidate set,
//     or owner downed -- because waiting there would just leave the enemy undriven.
//   - PROXIMITY_TIE_BAND: candidates within this many world units of the nearest count as
//     equidistant, and the balanced deal decides between them. This is how "split wins ties" is
//     achieved: where nothing can tell two players apart (both the same distance from the enemy,
//     as when they are effectively standing on top of each other, or no measurable position at
//     all) the pass reproduces the deal onRosterChange already made -- balanced, and identical,
//     i.e. silent. Proximity never asks the deal for a NEW split: it only re-homes an enemy whose
//     incumbent is measurably (margin) worse than a candidate near that enemy.
// The margin and the band do different jobs and both are needed: the band keeps the BALANCE (an
// exact tie is settled by load, not by float noise), while the margin keeps the PEACE (two players
// fighting side by side are, to within the margin, equally good owners, so the assignment the deal
// produced stands and neither pays a handoff for the other's jockeying).
const OWNER_SWITCH_MARGIN = 5.0;
const OWNER_MIN_HOLD_MS = 5000;
const PROXIMITY_TIE_BAND = 1.0;

// A caller's clock value when it is a usable one, else null. The entry's `ownerSince` is only
// ever compared against another value from the same source (the server's Date.now()), so a
// caller that supplies nothing records "no hold claimed" rather than a bogus timestamp.
function stamp(now) {
	return typeof now === "number" && Number.isFinite(now) ? now : null;
}

// Distance from `playerId`'s last known position to `enemyId`'s, or Infinity when either end is
// unknown (no snapshot from that player yet this session, or nobody has published the enemy).
// Infinity means UNMEASURABLE, not "far": callers must not read it as evidence that the far end
// is remote -- see onProximityTick, which only moves an enemy between two measurable positions.
function enemyDistance(positions, enemyId, playerId) {
	const a = positions?.get(enemyId);
	const b = positions?.get(playerId);
	if (!a || !b)
		return Infinity;
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	const dz = a.z - b.z;
	const d2 = dx * dx + dy * dy + dz * dz;
	return Number.isFinite(d2) ? Math.sqrt(d2) : Infinity;
}

// The owner for `enemyId` out of `candidates` (already liveness-filtered, order irrelevant) and
// the distance to it. The rule: of the candidates within PROXIMITY_TIE_BAND of the nearest, the
// least-loaded wins, ties going to the lexicographically smallest playerId -- the balanced deal
// (onRosterChange) run over the equidistant set, so it is the tie-breaker that proximity cannot
// override. With every distance equal -- two players together, or nothing measurable at all --
// this reduces to that deal over the whole candidate set, which is what makes the pass report
// nothing for a split the roster path already produced. `load` is the running per-candidate count
// for this pass (the same accounting onRosterChange does), keyed by player id.
function nearestCandidate(enemyId, candidates, positions, load) {
	const dist = new Map();
	let nearest = Infinity;
	for (const id of candidates) {
		const d = enemyDistance(positions, enemyId, id);
		dist.set(id, d);
		if (d < nearest)
			nearest = d;
	}

	let best = null;
	let bestLoad = Infinity;
	for (const id of candidates) {
		// Unmeasurable candidates are kept rather than filtered: when nothing can be measured
		// every candidate is equally far (Infinity <= Infinity + band), i.e. the case the plain
		// deal is for.
		if (dist.get(id) > nearest + PROXIMITY_TIE_BAND)
			continue;
		const n = load.get(id) ?? 0;
		if (n < bestLoad || (n === bestLoad && (best === null || id < best))) {
			best = id;
			bestLoad = n;
		}
	}
	return { owner: best, distance: best === null ? Infinity : dist.get(best) };
}

class EnemyOwnership {
	// Records are keyed by enemy id. `room` is the room the enemy was registered from,
	// `registrant` the client that registered it first (the last-resort owner when the room
	// has no member left to take it), `registrants` every client that has announced the enemy
	// and not withdrawn it yet, `owner` the current simulator (null while unassigned) and
	// `epoch` the assignment's version -- see register() for why it starts at 1.
	constructor() {
		this.enemies = new Map();
	}

	// Record `enemyId` in `room` and give it an owner if it does not have one yet.
	// `memberIds` is the room's candidate roster (every client currently in that room); it is
	// what splits the load across the room instead of parking every enemy on its registrant.
	// Returns the { id, owner, epoch } assignment for this enemy -- newly made, or the EXISTING
	// one when the id is already known -- plus `changed`: every OTHER assignment this call moved.
	// That duplicate case is the normal one, not an error: both clients hold every map-placed
	// enemy, so both register it, and the second registrant needs the first assignment reported
	// back to learn who owns it.
	//
	// The duplicate case is also where the room converges. Adding a registrant WIDENS this
	// enemy's candidate set, and the room's split is a function of those sets, so the split is
	// recomputed here -- the same rule as a roster change (onRosterChange). It is idempotent, so
	// a repeat announcement from a client already recorded moves nothing and reports nothing;
	// it is the second client's announcement of an enemy that re-splits the room onto a real
	// balance (the first client's registrations can all land before the room is even known, and
	// would otherwise leave one client owning the whole map).
	register(enemyId, room, registrantId, memberIds = [], now = null) {
		if (typeof enemyId !== "string" || enemyId.length === 0)
			return null;

		const registrant = typeof registrantId === "string" && registrantId.length > 0 ? registrantId : null;

		const existing = this.enemies.get(enemyId);
		if (existing) {
			// A second client announcing an enemy the room already knows: it holds the enemy too.
			// Recording it is what lets the record outlive either client's withdrawal, and what
			// keeps the assignment epoch comparable across one (see unregister()).
			if (registrant !== null)
				existing.registrants.add(registrant);
			// Re-split the room over the widened candidate sets. Guarded on a non-empty roster: a
			// caller that names no room member has no business unowning the room, so it leaves the
			// assignment (the registrant holds it -- see pickOwner's fallback) alone.
			const members = normalizeIds(memberIds);
			const moved = members.length > 0 ? this.onRosterChange(existing.room, members, now) : [];
			// This enemy rides in the returned assignment below, with its post-split owner/epoch,
			// so it is not repeated among the changed ones the caller has to publish.
			const changed = [];
			for (const assignment of moved) {
				if (assignment.id !== enemyId)
					changed.push(assignment);
			}
			return { id: enemyId, owner: existing.owner, epoch: existing.epoch, changed };
		}

		const entry = {
			room: room ?? null,
			registrant,
			registrants: new Set(registrant === null ? [] : [registrant]),
			owner: null,
			// The first assignment is itself a change, so the counter starts at 1 (an epoch of
			// 0 is never a real one, which lets epochOf() report 0 for "no such enemy"). It is
			// set here rather than after pickOwner() below so that even an enemy left unowned
			// (no candidate at all) has published exactly one version.
			epoch: 1,
			// When the current owner was assigned, on the caller's clock (register /
			// onRosterChange / onProximityTick all stamp it). Null means "not stamped by a
			// clocked caller", which the proximity pass reads as "no hold claimed" -- the
			// alternative, treating it as an infinite hold, would freeze such an enemy for good.
			ownerSince: null,
		};
		this.enemies.set(enemyId, entry);
		entry.owner = this.pickOwner(entry, memberIds);
		entry.ownerSince = stamp(now);
		return { id: enemyId, owner: entry.owner, epoch: entry.epoch, changed: [] };
	}

	// Forget enemies that `registrantId` no longer holds (it resolved a death, or its map
	// unloaded). The enemy is still held by every other client that announced it, so the record
	// only goes when the LAST registrant withdraws: dropping it while another client still has
	// the live enemy would both strand that client (nobody would be assigned to simulate it) and
	// restart the record's epoch at 1, which a client still holding the superseded epoch would
	// reject as stale -- exactly the transient disagreement where two clients each believe the
	// other owns the enemy, or each believe they do. An omitted sender keeps the old
	// unconditional removal for callers that are not speaking for a client.
	// Removal never triggers a reassignment: a room with fewer enemies is never a reason to
	// move one, and an owner that just died is exactly the case where the entry should go away
	// rather than migrate. Returns how many records were actually dropped.
	unregister(enemyIds, registrantId = null) {
		let removed = 0;
		if (!Array.isArray(enemyIds))
			return removed;
		const registrant = typeof registrantId === "string" && registrantId.length > 0 ? registrantId : null;
		for (const enemyId of enemyIds) {
			const entry = this.enemies.get(enemyId);
			if (!entry)
				continue;
			if (registrant !== null)
				entry.registrants.delete(registrant);
			if (registrant === null || entry.registrants.size === 0) {
				this.enemies.delete(enemyId);
				removed++;
			}
		}
		return removed;
	}

	// `room`'s members or one of its enemies' candidate sets just changed (someone joined, left the
	// world, disconnected, or announced an enemy the room had from someone else): recompute the
	// room's split from scratch and return every assignment that moved. Callers publish exactly
	// what comes back, so an assignment that did not move stays byte-identical and silent -- a
	// client compares epochs and sees nothing to do.
	//
	// This is a FULL rebalance, deliberately, and it is the fix for the map-start convergence
	// case rather than a refinement of it. Orphan repair alone is not enough: the first client's
	// registrations can land before the second client's room is known, so all the enemies are
	// assigned to that first client against a one-member roster, and when the second client's
	// room becomes known both clients are present -- nothing is an orphan, nothing moves, and
	// one client keeps the whole map. Recomputing the split whenever the roster or a candidate set
	// changes is what repairs it.
	//
	// The rule, which is a pure function of the room's sorted members, its sorted enemy ids and
	// each enemy's candidate set (the spec's `rebalance`): deal the enemies to the candidates in
	// turn, least-loaded first, ties to the lexicographically smallest playerId. Properties this
	// buys, all of them load-bearing:
	//   - IDEMPOTENT: the deal is a function of the inputs alone -- it seeds every candidate's
	//     load at zero and never reads the current owner -- so the second run of an unchanged
	//     room finds every owner already equal, returns nothing, bumps nothing, publishes nothing.
	//   - DETERMINISTIC: sorting makes the result independent of Map iteration order and of the
	//     order the caller collected the roster in. Two servers in the same state agree, so
	//     no client can be told a different owner than another.
	//   - CANDIDATE-RESPECTING: an enemy is only ever given to a member that has announced it
	//     (candidatePool), so a client that does not hold the enemy is never made its owner.
	//   - EPOCH-ON-CHANGE-ONLY: only a moved assignment bumps its epoch, which is what makes a
	//     stale owner message rejectable without a repeat looking like a new assignment.
	// When every candidate is present (the symmetric case) the pool is the whole roster for every
	// enemy, and this deal is exactly the round-robin it replaced: after i enemies the loads are
	// balanced to within one and the least-loaded, lexicographically smallest member is precisely
	// `members[i % members.length]`.
	// An empty roster means nobody can simulate the room's enemies, so they are left unowned
	// (null) rather than parked on the last registrant.
	//
	// Returns the changed assignments, in enemy-id order.
	onRosterChange(room, memberIds, now = null) {
		// Deduplicated: the deal counts each member once, so a repeated id would skew it. Sorted
		// ascending (default string order) for determinism.
		const members = [...new Set(normalizeIds(memberIds))].sort();

		const enemyIds = [];
		for (const [enemyId, entry] of this.enemies) {
			if (entry.room === room)
				enemyIds.push(enemyId);
		}
		enemyIds.sort();

		// Running load per member, built as the deal proceeds (from zero, never from the current
		// owners -- see IDEMPOTENT above).
		const load = new Map();
		for (const id of members)
			load.set(id, 0);

		const changed = [];
		for (const enemyId of enemyIds) {
			const entry = this.enemies.get(enemyId);
			const pool = candidatePool(entry, members);

			let owner = null;
			let bestLoad = Infinity;
			for (const id of pool) {
				const n = load.get(id);
				if (n < bestLoad || (n === bestLoad && id < owner)) {
					owner = id;
					bestLoad = n;
				}
			}
			if (owner !== null)
				load.set(owner, load.get(owner) + 1);

			// Unchanged assignment: leave owner and epoch untouched so the caller publishes
			// nothing for it.
			if (owner === entry.owner)
				continue;
			// `previous` rides along for the opt-in server diagnostic (server.js), which has to
			// report old -> new; the publish loop itself only reads id/owner/epoch.
			changed.push({ id: enemyId, owner, previous: entry.owner, epoch: entry.epoch + 1 });
			entry.owner = owner;
			entry.ownerSince = stamp(now);
			entry.epoch++;
		}
		return changed;
	}

	// The rooms that currently hold at least one recorded enemy, sorted. Rooms an enemy cannot
	// name (registered with no room key) are not reported: nothing can roster them, so the
	// proximity pass must leave their enemies where they are. The server walks this to build the
	// per-room roster the pass needs, which is why it lives here rather than being derived from
	// the clients' own rooms -- an enemy may outlive the client room report it came from.
	rooms() {
		const out = new Set();
		for (const entry of this.enemies.values()) {
			if (entry.room !== null)
				out.add(entry.room);
		}
		return [...out].sort();
	}

	// The proximity pass (Phase 7): re-home every enemy onto the nearest eligible player who can
	// simulate it. Pure by construction -- positions, liveness and the clock go IN, the changed
	// assignments come OUT, and nothing here touches a socket, a timer or the engine -- so the
	// server owns the cadence and the broadcasting and this can be exercised directly.
	//
	// `rosterByRoom` maps a room key to that room's member ids (the same roster onRosterChange
	// takes), `positions` maps an ENEMY id and a PLAYER id to { x, y, z } (the server caches both
	// from traffic it already relays), `downed` is the set of player ids that are down, and `now`
	// is the caller's millisecond clock. Returns the changed assignments in enemy-id order, the
	// same contract as onRosterChange, so the caller publishes exactly what moved.
	//
	// Per enemy, walking rooms then enemy ids in sorted order:
	//   1. The candidate set is UNCHANGED from the roster deal's: registrants(enemy) ∩ roomMembers,
	//      falling back to the room. A client that does not hold the enemy can never simulate it,
	//      so proximity never widens the set -- it only chooses within it.
	//   2. Downed candidates are dropped when any live one remains (a downed player cannot fight,
	//      and an enemy's target follows its owner, so an enemy left on a downed owner simply
	//      stops -- the "revived, but it never retargets" report). They are kept when they are all
	//      there is: an enemy nobody simulates is worse than one on a downed player's client, and
	//      the answer stays deterministic either way.
	//   3. The target is the nearest remaining candidate (nearestCandidate, which settles a tie
	//      inside PROXIMITY_TIE_BAND by the balanced deal, so two players the same distance from
	//      an enemy keep a 50/50 split rather than piling onto one of them). An incumbent that IS
	//      the target keeps the enemy; so does an incumbent that is nearer than the target by less
	//      than OWNER_SWITCH_MARGIN -- which is the normal case while two players fight side by
	//      side, and the reason the split the roster deal made survives inside a fight.
	//   4. A distance-driven move additionally needs both distances to be measurable and the
	//      per-enemy hold (OWNER_MIN_HOLD_MS) to have elapsed. A move for any other reason -- the
	//      owner has left the candidate set, or is down -- is applied at once: those are not
	//      distance questions, and waiting would leave the enemy undriven.
	//
	// Idempotent and deterministic, which is what makes a 1s cadence safe: the load counter is
	// seeded from zero and the choice never reads the current owner, so re-running with unchanged
	// inputs finds every owner already equal to its target -- no bump, no message. Sorted rooms,
	// ids and members make the result independent of Map iteration order and of the order the
	// caller collected the roster in, so two runs of the same state agree.
	onProximityTick(rosterByRoom, positions, downed, now) {
		const downedIds = downed instanceof Set ? downed : new Set();
		const at = stamp(now);
		const changed = [];

		for (const room of this.rooms()) {
			const members = [...new Set(normalizeIds(rosterByRoom?.get(room)))].sort();
			// A room the caller says nothing about is left ALONE rather than emptied: silence is
			// not evidence that a room's players have gone, and unowning an enemy freezes it on
			// every other screen (the roster path is what handles a room truly emptying).
			if (members.length === 0)
				continue;

			const enemyIds = [];
			for (const [enemyId, entry] of this.enemies) {
				if (entry.room === room)
					enemyIds.push(enemyId);
			}
			enemyIds.sort();

			// Load per candidate, from zero and grown as this pass assigns -- the same accounting
			// onRosterChange uses, and the reason a pass that agrees with the room's split returns
			// nothing.
			const load = new Map();
			for (const id of members)
				load.set(id, 0);

			for (const enemyId of enemyIds) {
				const entry = this.enemies.get(enemyId);
				const pool = candidatePool(entry, members);
				if (pool.length === 0)
					continue;
				const live = pool.filter((id) => !downedIds.has(id));
				const candidates = live.length > 0 ? live : pool;
				const target = nearestCandidate(enemyId, candidates, positions, load);

				const ownerGone = entry.owner === null || !pool.includes(entry.owner);
				const ownerDown = entry.owner !== null && downedIds.has(entry.owner) && live.length > 0;

				let next = entry.owner;
				if (ownerGone || ownerDown) {
					next = target.owner;
				} else if (target.owner !== null && target.owner !== entry.owner) {
					const ownerDistance = enemyDistance(positions, enemyId, entry.owner);
					const holdElapsed = entry.ownerSince === null || at === null || (at - entry.ownerSince) >= OWNER_MIN_HOLD_MS;
					// Both distances have to be real numbers: an unmeasured position is not evidence
					// that the incumbent is remote, and must not be spent as if it were.
					if (holdElapsed && Number.isFinite(ownerDistance) && Number.isFinite(target.distance)
						&& ownerDistance - target.distance >= OWNER_SWITCH_MARGIN)
						next = target.owner;
				}

				// The choice counts against the running load either way: a kept incumbent occupies
				// its player just as a fresh assignment does, which is what keeps a room balanced
				// across a mix of moved and unmoved enemies.
				if (next !== null)
					load.set(next, (load.get(next) ?? 0) + 1);

				if (next === entry.owner)
					continue;
				changed.push({ id: enemyId, owner: next, previous: entry.owner, epoch: entry.epoch + 1 });
				entry.owner = next;
				entry.ownerSince = at;
				entry.epoch++;
			}
		}
		return changed;
	}

	// The assignment rule, kept pure and separate so it can be exercised directly:
	// the least-loaded CANDIDATE wins, ties go to the lexicographically smallest playerId.
	// Candidates are the room's members that have announced the enemy (see candidatePool), so a
	// newly announced enemy -- held by exactly one client at that instant -- is placed on that
	// client, and the placement widens into the room's balance only once the others have announced
	// it too (register() re-splits the room then). An empty room falls back to the enemy's
	// registrant (someone has to hold it even when the room is unknown or has emptied), and with
	// no registrant either the enemy is left unowned (null) rather than guessed at.
	pickOwner(entry, memberIds) {
		let pool = candidatePool(entry, normalizeIds(memberIds));
		if (pool.length === 0)
			pool = entry.registrant === null ? [] : [entry.registrant];
		if (pool.length === 0)
			return null;

		// Load = how many enemies in this enemy's OWN room each candidate already simulates.
		// The enemy being placed is skipped: counting it against its previous owner would skew
		// a reassignment, where the incumbent is precisely the one we are moving away from.
		const load = new Map();
		for (const id of pool)
			load.set(id, 0);
		for (const other of this.enemies.values()) {
			if (other === entry || other.room !== entry.room || other.owner === null)
				continue;
			if (load.has(other.owner))
				load.set(other.owner, load.get(other.owner) + 1);
		}

		let best = null;
		let bestLoad = Infinity;
		for (const id of pool) {
			const n = load.get(id);
			if (n < bestLoad || (n === bestLoad && id < best)) {
				best = id;
				bestLoad = n;
			}
		}
		return best;
	}

	// Current owner, or null when the enemy is unknown or has no owner.
	ownerOf(enemyId) {
		return this.enemies.get(enemyId)?.owner ?? null;
	}

	// Current epoch, or 0 when the enemy is unknown. Epochs start at 1, so 0 is never a real
	// one: a caller can use it as "no such enemy" without a second lookup.
	epochOf(enemyId) {
		return this.enemies.get(enemyId)?.epoch ?? 0;
	}

	// Distinct rooms in which `playerId` currently owns at least one enemy, in registration
	// order. The server uses this to find the rooms a client is about to abandon -- a map
	// change, a move to MENU, a disconnect -- because the client's own last stored state cannot
	// be trusted to still name them: an UPDATE for the new map may already have overwritten it
	// by the time the join_map arrives, and an enemy left owned by a client that has walked away
	// would sit frozen on every other screen. Enemies registered without a room key are
	// unnameable, so they are not reported.
	ownedRooms(playerId) {
		if (typeof playerId !== "string" || playerId.length === 0)
			return [];
		const rooms = new Set();
		for (const entry of this.enemies.values()) {
			if (entry.owner === playerId && entry.room !== null)
				rooms.add(entry.room);
		}
		return [...rooms];
	}

	// Is `senderId` allowed to speak for this enemy? False for an unknown enemy, false for an
	// enemy nobody owns, false for anyone but the recorded owner. Later phases use this to drop
	// state/hit messages from a client that is not the assigned simulator -- the server is the
	// only party that can vouch for that, since it minted the ids and made the assignment.
	validate(enemyId, senderId) {
		const entry = this.enemies.get(enemyId);
		return !!entry && entry.owner !== null && entry.owner === senderId;
	}
}

//# sourceURL=/mods/terra-together/server/enemy-ownership.js
