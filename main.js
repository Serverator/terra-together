window.terraTogether ??= {};

import * as server from './server.js';
import * as client from './client.js';

server.startServer();
client.joinServer();

//# sourceURL=mods/multiplayer/main.js
