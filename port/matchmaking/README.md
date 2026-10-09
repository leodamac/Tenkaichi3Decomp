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

## The relay (optional)

Some pairs of players cannot reach each other directly (strict routers, mobile connections). With a TURN key the
host of a room also gets an address at Cloudflare's TURN service that passes the match's packets on.

1. Realtime -> TURN Server -> Create. Note the Turn Token ID and the API token (shown once).
2. The Worker -> Settings -> Variables and Secrets: add two **secrets**, `TURN_KEY_ID` and `TURN_KEY_TOKEN`. Deploy.

Without the two secrets the Worker works as before, without a relay. The key never leaves the Worker: each host is
handed a name and password that are good for three hours. Cloudflare's TURN is free for the first 1,000 GB a month
(a match is about 50 MB an hour, and only matches that cannot connect directly use it).

## What a player is told about the other

The name, the public address and port, and for the one who joins the host's relay address. An address of a
private network (192.168.x.x and the like) is handed over only when the two are on one network: seen by the
Worker under the same address (the same network part, for IPv6), or with the same public IPv4 address in what the
games found out themselves.

## Limits against abuse

Anyone can send requests to a Worker, so it counts (table `used`):

- an address may make 20 rooms an hour and have 4 open at a time;
- an address may enter 30 codes an hour that name no room (codes are not to be found by trying);
- an address is given at most 30 relay logins a day, and all addresses together 2,000 a day (the variable
  `TURN_DAILY_MAX` sets another number). Past that, rooms still work, without a relay. This is the ceiling on what
  the relay can be made to cost: a login lets its holder send through the relay for three hours.

Without the table `used` no relay logins are given at all (rooms work). What the counts do not prevent: many
addresses using up the Worker's own daily requests (100,000 on the free plan; matchmaking then stops until the
next day, at no cost). If a relay key is abused, deleting it (Realtime -> TURN Server) ends every login made from
it at once. A billing notification in the dashboard is worth setting.

## Testing a change

`node port/matchmaking/test.mjs` runs the Worker's code against a small stand-in for its database: who is told
which addresses, and the limits. Nothing is sent anywhere.

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
