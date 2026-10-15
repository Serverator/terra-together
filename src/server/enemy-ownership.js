/**
 * src/server/enemy-ownership.js
 * The enemy-sync ownership arbiter: decides which client simulates each map-placed enemy.
 * Responsibilities:
 *   - Record which enemies exist, which room each one belongs to, and who simulates it.
 *   - Assign an owner on registration, and rebalance a room's split whenever its membership
 *     changes: a member arrives, leaves, changes room or disconnects, or a client announces an
 *     enemy that only some of the room has (that widens the enemy's candidate set -- see below).
 *   - Stamp every assignment with a monotonic epoch so a stale owner message is rejectable.
 * Public surface: EnemyOwnership (register, unregister, onRosterChange, ownerOf, epochOf,
 *   ownedRooms, validate)
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
	register(enemyId, room, registrantId, memberIds = []) {
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
			const moved = members.length > 0 ? this.onRosterChange(existing.room, members) : [];
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
		};
		this.enemies.set(enemyId, entry);
		entry.owner = this.pickOwner(entry, memberIds);
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
	onRosterChange(room, memberIds) {
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
			entry.epoch++;
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
