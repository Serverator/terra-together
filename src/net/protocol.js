/**
 * src/net/protocol.js
 * Single source of truth for the Terra Together wire message types.
 * Responsibilities:
 *   - Declare every `msg.type` string that client and server exchange over the websocket.
 * Public surface: MSG
 * Engine touchpoints: none (pure data; no terra.* usage, no globals, no addon hooks)
 * Notes:
 *   - The string VALUES are the wire contract and are case-sensitive: both dispatch sites
 *     (src/server/server.js and src/client/session.js) switch on them, so a typo here
 *     silently turns a message into a no-op (server) or an unhandled message (client).
 *   - No validator is exported: each dispatch owns its own fallback (the server's default
 *     branch warns and drops, the client's switch silently drops). Adding a shared check
 *     would not change which messages are relayed, so the table is the whole surface.
 *
 * Message directions: one entry per type. "Relayed" means the server forwards the message
 * to every other client verbatim (broadcast minus the sender) without rewriting it. Line
 * refs point into src/server/server.js; other modules are named by their case/function so
 * the reference cannot go stale.
 *
 *   MSG.UPDATE            "update"           client -> server -> other clients. Emitted by
 *                                            snapshot.js sendPlayerData() on every tick; the
 *                                            server caches it (server.js:119), relays it
 *                                            (server.js:120) and replays the cache to a newcomer
 *                                            on JOIN_MAP (server.js:166). Client case: MSG.UPDATE.
 *   MSG.SCENE_CHANGED     "scene_changed"    client -> server -> other clients. Emitted by
 *                                            client.js on scene/focus changes; relayed at
 *                                            server.js:131. Client case: MSG.SCENE_CHANGED --
 *                                            LOADING/TITLE hide the peer, MENU/PAUSED freeze it.
 *   MSG.PROFILE           "profile"          client -> server only, once per connection, right
 *                                            after WELCOME. Server case: MSG.PROFILE
 *                                            (server.js:134); never relayed -- it is answered
 *                                            with MSG.PLAYER_PROFILE instead.
 *   MSG.JOIN_MAP          "join_map"         client -> server -> other clients, and the trigger
 *                                            for the server's cached-state replay
 *                                            (server.js:166). Client case: MSG.JOIN_MAP (log).
 *   MSG.REVIVE            "revive"           client -> server -> other clients, relayed
 *                                            verbatim (server.js:170). Emitted by the Reviver;
 *                                            the client case routes to Reviver.onMessage().
 *   MSG.REVIVE_PROGRESS   "revive_progress"  as MSG.REVIVE (server.js:171): the progress
 *                                            updates sent while a revive is being held.
 *   MSG.AREA_HEAL         "area_heal"        as MSG.REVIVE (server.js:172). Emitted by the
 *                                            AreaHealer; the client case routes to
 *                                            AreaHealer.onMessage().
 *   MSG.WELCOME           "welcome"          server -> client only (server.js:96). Client case:
 *                                            MSG.WELCOME -- stores the id and sends MSG.PROFILE.
 *   MSG.HOST_SETTING      "host_setting"     server -> client only: pushed on change
 *                                            (server.js:54) and replayed per connection
 *                                            (server.js:100). Client case copies the host's value
 *                                            into its runtime mirror without re-emitting the
 *                                            option change.
 *   MSG.PLAYER_PROFILE    "player_profile"   server -> client only: the relay of another
 *                                            player's profile (server.js:142) plus the newcomer
 *                                            backfill (server.js:149). Client case:
 *                                            MSG.PLAYER_PROFILE.
 *   MSG.PLAYER_JOINED     "player_joined"    server -> client only (server.js:104). Client case
 *                                            adds a peer that has no state yet.
 *   MSG.PLAYER_LEFT       "player_left"      server -> client only, on disconnect or error
 *                                            (server.js:200/212). Client case drops the peer:
 *                                            action, name and all its per-peer state.
 *   MSG.ENEMY_REGISTER    "enemy_register"   client -> server only, when this client learns of a
 *                                            map-placed enemy: both clients hold the same ones,
 *                                            so both register each id; the server de-dupes
 *                                            (keeping the first assignment, though a second
 *                                            client's announcement widens which clients may own
 *                                            the enemy and can re-split its room). Server case:
 *                                            MSG.ENEMY_REGISTER (server.js:275); never relayed,
 *                                            it is answered with MSG.ENEMY_OWNER. Payload:
 *                                            { id, map, variant }.
 *   MSG.ENEMY_UNREGISTER  "enemy_unregister" client -> server only, when an enemy stops existing
 *                                            for this client (its death resolved, or the map
 *                                            unloaded). Server case: MSG.ENEMY_UNREGISTER
 *                                            (server.js:292); never relayed, never answered.
 *                                            Payload: { ids[] }.
 *   MSG.ENEMY_OWNER       "enemy_owner"      server -> all clients, from the ownership arbiter
 *                                            (src/server/enemy-ownership.js): the authoritative
 *                                            answer to a register, and the republish whenever a
 *                                            room's membership changes. `owner` null means the
 *                                            enemy is unowned, i.e. nobody simulates it. Client
 *                                            case: MSG.ENEMY_OWNER.
 *   MSG.ENEMY_STATE       "enemy_state"      client -> server -> other clients, per frame, and only
 *                                            from an enemy's CURRENT owner: the movement, animation
 *                                            and HP of the enemies that client simulates, which the
 *                                            other clients apply to their puppets. The one relayed
 *                                            type the server does NOT forward verbatim -- it rechecks
 *                                            every entry against the arbiter
 *                                            (enemy-ownership.js validate()) and DROPS any the sender
 *                                            does not own, then relays the surviving frame with
 *                                            `owner` stamped to the sender (server.js, the
 *                                            MSG.ENEMY_STATE case). Payload: { owner, map, variant,
 *                                            list: [ { id, x, y, z, vx, vy, vz, fx, fy, anim,
 *                                            animTime, hp, state, action } ] }. Client case:
 *                                            MSG.ENEMY_STATE.
 *   MSG.ENEMY_HANDOFF     "enemy_handoff"    client -> server -> other clients, ONE-SHOT, from the
 *                                            client that has just LOST an enemy (it reads that from
 *                                            the same enemy_owner broadcast the new owner reads):
 *                                            the enemy's final state, so the client that takes it
 *                                            over continues from where it was instead of from its
 *                                            own copy -- which, on a map that client has just
 *                                            rebuilt, is the spawn point. Stamp-then-relay like
 *                                            ENEMY_STATE (the server rewrites `owner` to the
 *                                            sender's id), but deliberately NOT entry-validated
 *                                            against the arbiter: the sender no longer owns these
 *                                            enemies by definition, so validate() would drop the
 *                                            whole message. It is coop traffic, like REVIVE. Payload:
 *                                            { owner, list: [ <same state shape as ENEMY_STATE> ] }.
 *                                            Client case: MSG.ENEMY_HANDOFF.
 *   MSG.ENEMY_DESPAWN     "enemy_despawn"    client -> server -> other clients, ONE-SHOT, from an
 *                                            enemy's CURRENT owner at the instant that enemy is
 *                                            definitively killed: the ids it has just beaten, so
 *                                            every other client can mark each of them dead in its
 *                                            own (per-client) dead-set and take the enemy out of
 *                                            its world, instead of keeping a ghost the engine still
 *                                            believes is alive -- and, with the enemy gone locally
 *                                            but alive on the peer, handing the residue to whoever
 *                                            the arbiter assigns next. Stamp-then-relay like
 *                                            ENEMY_HANDOFF (the server rewrites `owner` to the
 *                                            sender's id), and like it deliberately NOT entry-
 *                                            validated against the arbiter: the arbiter's record
 *                                            for a just-killed enemy can already be gone (the
 *                                            sender's own enemy_unregister for it is written in the
 *                                            same frame) or moved by a rebalance, so validate()
 *                                            would drop exactly the message that has to arrive. The
 *                                            recipient is what makes it safe: it applies a despawn
 *                                            only to an enemy it holds itself, and idempotently.
 *                                            Payload: { owner, list: [ { id } ] }. Client case:
 *                                            MSG.ENEMY_DESPAWN.
 *   MSG.ENEMY_RESPAWN     "enemy_respawn"    client -> server -> all but sender, ONE-SHOT, from the
 *                                            client that has just RESTED: "the enemy population of
 *                                            this map has reset". Resting is the one world event
 *                                            that puts a map's enemies back, and the engine does it
 *                                            by clearing a PER-CLIENT session dead-set
 *                                            (combat.js onRestReset -> g_vars.clearMapSessionVars),
 *                                            so it only respawns the rester's own enemies -- the
 *                                            other client's spots stay defeated and it is left
 *                                            simulating a map whose enemies are gone. The recipient
 *                                            therefore runs the engine's own reset locally (clear
 *                                            the same session vars, respawn its defeated spots) and
 *                                            the restored enemies are re-registered by the normal
 *                                            per-frame diff, which re-splits their room. Stamp-then-
 *                                            relay like ENEMY_HANDOFF/ENEMY_DESPAWN (the server
 *                                            rewrites `from` to the sender's socket id), and like
 *                                            them NOT entry-validated -- it describes a world event,
 *                                            not an enemy's ownership. Unlike the other relays it is
 *                                            not room-scoped either: every recipient ignores it
 *                                            when its active map is not the one named. Payload:
 *                                            { from, map, variant }. Client case:
 *                                            MSG.ENEMY_RESPAWN.
 *
 * The server's inbound switch has 13 cases: the 9 relayed types (UPDATE, SCENE_CHANGED, JOIN_MAP,
 * REVIVE, REVIVE_PROGRESS, AREA_HEAL forwarded verbatim; ENEMY_STATE forwarded entry-validated;
 * ENEMY_HANDOFF and ENEMY_DESPAWN forwarded with `owner` stamped to the sender; ENEMY_RESPAWN
 * forwarded with `from` stamped to the sender), PROFILE --
 * answered, not relayed -- and ENEMY_REGISTER / ENEMY_UNREGISTER, which are not relayed but
 * answered with ENEMY_OWNER. The
 * client's dispatch has 16: every type except PROFILE,
 * ENEMY_REGISTER and ENEMY_UNREGISTER. The six server-only types (WELCOME, HOST_SETTING,
 * PLAYER_PROFILE, PLAYER_JOINED, PLAYER_LEFT, ENEMY_OWNER) are never accepted from a client -- a
 * client that sends one hits the server's default branch and is dropped, because they describe state
 * only the server can vouch for (ids it minted, settings it owns, membership it tracks, and the
 * enemy ownership it arbitrates).
 */

export const MSG = { UPDATE:"update", SCENE_CHANGED:"scene_changed", PROFILE:"profile", JOIN_MAP:"join_map", REVIVE:"revive", REVIVE_PROGRESS:"revive_progress", AREA_HEAL:"area_heal", WELCOME:"welcome", HOST_SETTING:"host_setting", PLAYER_PROFILE:"player_profile", PLAYER_JOINED:"player_joined", PLAYER_LEFT:"player_left", ENEMY_REGISTER:"enemy_register", ENEMY_UNREGISTER:"enemy_unregister", ENEMY_OWNER:"enemy_owner", ENEMY_STATE:"enemy_state", ENEMY_HANDOFF:"enemy_handoff", ENEMY_DESPAWN:"enemy_despawn", ENEMY_RESPAWN:"enemy_respawn" };

//# sourceURL=/mods/terra-together/net/protocol.js
