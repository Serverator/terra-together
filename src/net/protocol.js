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
 *   MSG.UPDATE          "update"           client -> server -> other clients. Emitted by
 *                                         snapshot.js sendPlayerData() on every tick; the
 *                                         server caches it (server.js:119), relays it
 *                                         (server.js:120) and replays the cache to a newcomer
 *                                         on JOIN_MAP (server.js:166). Client case: MSG.UPDATE.
 *   MSG.SCENE_CHANGED   "scene_changed"    client -> server -> other clients. Emitted by
 *                                         client.js on scene/focus changes; relayed at
 *                                         server.js:131. Client case: MSG.SCENE_CHANGED --
 *                                         LOADING/TITLE hide the peer, MENU/PAUSED freeze it.
 *   MSG.PROFILE         "profile"          client -> server only, once per connection, right
 *                                         after WELCOME. Server case: MSG.PROFILE
 *                                         (server.js:134); never relayed -- it is answered
 *                                         with MSG.PLAYER_PROFILE instead.
 *   MSG.JOIN_MAP        "join_map"         client -> server -> other clients, and the trigger
 *                                         for the server's cached-state replay
 *                                         (server.js:166). Client case: MSG.JOIN_MAP (log).
 *   MSG.REVIVE          "revive"           client -> server -> other clients, relayed
 *                                         verbatim (server.js:170). Emitted by the Reviver;
 *                                         the client case routes to Reviver.onMessage().
 *   MSG.REVIVE_PROGRESS "revive_progress"  as MSG.REVIVE (server.js:171): the progress
 *                                         updates sent while a revive is being held.
 *   MSG.AREA_HEAL       "area_heal"        as MSG.REVIVE (server.js:172). Emitted by the
 *                                         AreaHealer; the client case routes to
 *                                         AreaHealer.onMessage().
 *   MSG.WELCOME         "welcome"          server -> client only (server.js:96). Client case:
 *                                         MSG.WELCOME -- stores the id and sends MSG.PROFILE.
 *   MSG.HOST_SETTING    "host_setting"     server -> client only: pushed on change
 *                                         (server.js:54) and replayed per connection
 *                                         (server.js:100). Client case copies the host's value
 *                                         into its runtime mirror without re-emitting the
 *                                         option change.
 *   MSG.PLAYER_PROFILE  "player_profile"   server -> client only: the relay of another
 *                                         player's profile (server.js:142) plus the newcomer
 *                                         backfill (server.js:149). Client case:
 *                                         MSG.PLAYER_PROFILE.
 *   MSG.PLAYER_JOINED   "player_joined"    server -> client only (server.js:104). Client case
 *                                         adds a peer that has no state yet.
 *   MSG.PLAYER_LEFT     "player_left"      server -> client only, on disconnect or error
 *                                         (server.js:200/212). Client case drops the peer:
 *                                         action, name and all its per-peer state.
 *
 * The server's inbound switch (server.js:111) has 7 cases -- exactly the relayed set above:
 * UPDATE, SCENE_CHANGED, PROFILE, JOIN_MAP, REVIVE, REVIVE_PROGRESS, AREA_HEAL. The client's
 * dispatch has 11: everything except PROFILE. The five server-only types (WELCOME,
 * HOST_SETTING, PLAYER_PROFILE, PLAYER_JOINED, PLAYER_LEFT) are never accepted from a
 * client -- a client that sends one hits the server's default branch and is dropped,
 * because they describe state only the server can vouch for (ids it minted, settings it
 * owns, membership it tracks).
 */

export const MSG = { UPDATE:"update", SCENE_CHANGED:"scene_changed", PROFILE:"profile", JOIN_MAP:"join_map", REVIVE:"revive", REVIVE_PROGRESS:"revive_progress", AREA_HEAL:"area_heal", WELCOME:"welcome", HOST_SETTING:"host_setting", PLAYER_PROFILE:"player_profile", PLAYER_JOINED:"player_joined", PLAYER_LEFT:"player_left" };

//# sourceURL=/mods/terra-together/net/protocol.js
