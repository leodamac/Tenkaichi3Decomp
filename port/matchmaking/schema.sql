-- The rooms of the matchmaking Worker (worker.js). One row per room; rows older than ten minutes are removed
-- whenever a room is made.
CREATE TABLE IF NOT EXISTS rooms (
    code       TEXT PRIMARY KEY,   -- what the host tells the other player: 6 characters
    made       INTEGER NOT NULL,   -- seconds since 1970
    version    INTEGER NOT NULL,   -- the game's netcode version: both players need the same
    ip         TEXT NOT NULL,      -- the host's address as Cloudflare saw it (for the limit of rooms per address)
    host_key   TEXT NOT NULL,      -- secrets handed to each player, so nobody else can read or end the room
    join_key   TEXT,
    host_name  TEXT NOT NULL,
    join_name  TEXT,
    host_addrs TEXT NOT NULL,      -- JSON: the addresses the host can be reached at ("ip:port"), best first
    join_addrs TEXT
);
