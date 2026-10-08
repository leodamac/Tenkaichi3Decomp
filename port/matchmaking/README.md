# Matchmaking Worker (room codes)

A small Cloudflare Worker that lets two players of the port find each other with a short code, without typing
addresses or forwarding a port. It only introduces the two games to each other: no game data passes through it.

Files: `worker.js` (the Worker), `schema.sql` (its one table, as ONE line without comments: the dashboard's console
joins what is pasted into one line, and a `--` comment then takes the rest of the statement with it).

The table `rooms`, one row per room (rows older than ten minutes are removed whenever a room is made):

| Column | |
|---|---|
| `code` | what the host tells the other player: 6 characters |
| `made` | seconds since 1970 |
| `version` | the game's netcode version: both players need the same |
| `ip` | the host's address as Cloudflare saw it (for the limit of rooms per address) |
| `host_key`, `join_key` | secrets handed to each player, so nobody else can read or end the room |
| `host_name`, `join_name` | the players' names |
| `host_addrs`, `join_addrs` | JSON: the addresses each game can be reached at ("ip:port"), best first |

## What it keeps

For at most ten minutes per room: the room code, the two player names, the addresses each game reported about
itself, and the host's address as Cloudflare saw it (to limit how many rooms one address can open). Nothing else,
and nothing after the room has expired.

## Setting it up (the Cloudflare dashboard, no tools needed)

1. **Database.** Storage & Databases -> D1 -> Create. Name it `bt3-rooms`. Open its Console, paste the
   contents of `schema.sql`, run it.
2. **Worker.** Workers & Pages -> Create -> Worker ("Hello World"). Give it a name that says nothing about you
   (the name and your account's workers.dev subdomain are part of the public address). Deploy, then Edit code,
   replace everything with the contents of `worker.js`, Deploy.
3. **Binding.** The Worker -> Settings -> Bindings -> Add -> D1 database. Variable name `DB`, database
   `bt3-rooms`. Deploy.
4. Open the Worker's address in a browser: it answers with one line of text.

## Trying it by hand

    W=https://<worker>.<subdomain>.workers.dev
    curl -s -X POST $W/v1/host -d '{"v":3,"name":"A","addrs":["203.0.113.5:7000"]}'
    # -> {"code":"ABC234","key":"...","you":"<your address>"}
    curl -s -X POST $W/v1/join -d '{"v":3,"code":"ABC234","name":"B","addrs":["198.51.100.9:7000"]}'
    # -> {"key":"...","you":"...","peer":{"name":"A","addrs":["203.0.113.5:7000"]}}
    curl -s -X POST $W/v1/poll -d '{"code":"ABC234","key":"<the host key>"}'
    # -> {"peer":{"name":"B","addrs":["198.51.100.9:7000"]}}

## Limits

The free plan allows 100,000 requests a day. A host asks every two seconds while waiting, so ten minutes of
waiting are 300 requests. A room code is good for ten minutes. One address can have four rooms open.
