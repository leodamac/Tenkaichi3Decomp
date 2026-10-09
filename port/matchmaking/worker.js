// Matchmaking for Tenkaichi3Decomp's online play: room codes.
//
// What it does: lets two players find each other without typing addresses. The host makes a room and gets a short
// code; the other player joins with the code; each learns the addresses the other can be reached at, and the two
// games then connect to each other directly. No game data passes through here.
//
// What it stores (a D1 database bound as DB, table `rooms`, see schema.sql), for at most ten minutes per room: the
// code, the two player names, the addresses each game reported, and the host's address as Cloudflare saw it.
//
// Requests are JSON over POST:
//   /v1/host   {v, name, addrs}        -> {code, key, you, turn?}
//   /v1/addrs  {code, key, addrs}      -> {}       (the host, once it has more addresses: its relay address)
//   /v1/join   {v, code, name, addrs}  -> {key, you, peer: {name, addrs}}
//   /v1/poll   {code, key}             -> {peer: {name, addrs} | null}     (the host asks until someone has joined)
//   /v1/leave  {code, key}             -> {}
// `turn` (only if the Worker has a TURN key: the secrets TURN_KEY_ID and TURN_KEY_TOKEN) is what the host needs to
// get a relay address from Cloudflare's TURN service: {server, username, credential}, good for three hours. The
// host publishes that address as "relay=ip:port" among its addresses; the other player's addresses carry
// "seen=ip", the address this Worker saw them under (the relay must be told whom to let through).
// `v` is the game's netcode version, `addrs` a list of "ip:port" strings (what the game found out about itself),
// `you` the caller's address as seen here (the game uses it when it could not find out its own). Errors come back
// as {error: "..."} with a 4xx status: "version" (the two games differ), "no room", "full", "busy", "bad request".

const ROOM_SECONDS = 600;       // a room nobody joined disappears after ten minutes
const ROOMS_PER_ADDRESS = 4;    // rooms one address may have open at a time
const HOSTS_PER_HOUR = 20;      // rooms one address may make in an hour
const RELAY_PER_DAY_ADDRESS = 30; // relay logins one address may be given in a day
const RELAY_PER_DAY = 2000;     // relay logins given in a day, all told (the variable TURN_DAILY_MAX overrides it): the
                                // ceiling on what the relay can be made to cost, whatever anyone sends
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1: they are misread

function reply(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function randomText(length, alphabet) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = "";
    for (const b of bytes) {
        out += alphabet[b % alphabet.length];
    }
    return out;
}

// A name as the game sends it: printable ASCII, at most 16 characters.
function cleanName(name) {
    return String(name ?? "Player").replace(/[^\x20-\x7e]/g, "").slice(0, 16) || "Player";
}

// The addresses a game reports: up to four "ip:port" strings.
function cleanAddrs(addrs) {
    if (!Array.isArray(addrs)) {
        return null;
    }
    const out = [];
    for (const a of addrs.slice(0, 5)) {
        if (typeof a === "string" && /^(relay=)?[0-9a-fA-F:.\[\]]{3,64}:\d{1,5}$/.test(a)) {
            out.push(a);
        }
    }
    return out.length > 0 ? out : null;
}

// Counts one more use of `what` in the time slot that starts at `slot` (seconds) and says how many that makes; 0 if
// the count could not be kept (the table "used" is missing: see schema.sql).
async function countUse(env, what, slot) {
    try {
        const row = await env.DB.prepare("INSERT INTO used (what, slot, n) VALUES (?, ?, 1) ON CONFLICT(what, slot) DO UPDATE SET n = n + 1 RETURNING n")
            .bind(what, slot).first();
        return row ? row.n : 0;
    } catch (e) {
        return 0;
    }
}

// Whether this address may be given a relay login now (and counts it), or why not.
async function relayAllowed(env, ip, now) {
    const day = now - (now % 86400);
    const all = await countUse(env, "relay", day);
    if (all === 0) {
        return "the Worker cannot count relay logins (the table 'used' is missing): none are given";
    }
    if (all > (Number(env.TURN_DAILY_MAX) || RELAY_PER_DAY)) {
        return "the day's relay logins are used up";
    }
    if ((await countUse(env, "relay:" + ip, day)) > RELAY_PER_DAY_ADDRESS) {
        return "too many relay logins for this address today";
    }
    return null;
}

// Short-lived access to Cloudflare's TURN service for one host: {server, username, credential}, or {why} saying what
// stood in the way (never anything secret: for whoever sets the Worker up).
async function turnAccess(env) {
    if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) {
        return { why: `no key: the secret ${!env.TURN_KEY_ID ? "TURN_KEY_ID" : "TURN_KEY_TOKEN"} is not set` };
    }
    try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
            method: "POST",
            headers: { authorization: `Bearer ${env.TURN_KEY_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ ttl: 10800 }),
        });
        if (!r.ok) {
            return { why: `the TURN service answered ${r.status} (401 or 403: the key ID or the token is not right)` };
        }
        const j = await r.json();
        // iceServers is a list of entries, or (older answers) one entry
        const list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
        for (const s of list) {
            const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
            const udp = urls.find((u) => typeof u === "string" && u.startsWith("turn:") && u.includes("transport=udp"));
            if (udp && s.username && s.credential) {
                return { server: udp.slice(5).split("?")[0], username: s.username, credential: s.credential };
            }
        }
        return { why: "the TURN service's answer had no UDP relay in it" };
    } catch (e) {
        return { why: "the TURN service could not be asked" };
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/") {
            return new Response("Tenkaichi3Decomp matchmaking: room codes. See the game's repository, port/matchmaking.\n");
        }
        if (request.method !== "POST" || !url.pathname.startsWith("/v1/")) {
            return reply({ error: "bad request" }, 404);
        }
        let body;
        try {
            body = await request.json();
        } catch (e) {
            return reply({ error: "bad request" }, 400);
        }
        const ip = request.headers.get("cf-connecting-ip") ?? "";
        const now = Math.floor(Date.now() / 1000);
        const what = url.pathname.slice(4);

        if (what === "host") {
            const addrs = cleanAddrs(body.addrs);
            if (!Number.isInteger(body.v) || addrs === null) {
                return reply({ error: "bad request" }, 400);
            }
            await env.DB.prepare("DELETE FROM rooms WHERE made < ?").bind(now - ROOM_SECONDS).run();
            const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM rooms WHERE ip = ?").bind(ip).first();
            if (open && open.n >= ROOMS_PER_ADDRESS) {
                return reply({ error: "busy" }, 429);
            }
            if ((await countUse(env, "host:" + ip, now - (now % 3600))) > HOSTS_PER_HOUR) {
                return reply({ error: "busy" }, 429);
            }
            if (now % 50 === 0) { // now and then: counts of past days are thrown away
                await env.DB.prepare("DELETE FROM used WHERE slot < ?").bind(now - 2 * 86400).run().catch(() => {});
            }
            const key = randomText(24, ALPHABET);
            for (let attempt = 0; attempt < 5; attempt++) {
                const code = randomText(6, ALPHABET);
                try {
                    await env.DB.prepare("INSERT INTO rooms (code, made, version, ip, host_key, host_name, host_addrs) VALUES (?, ?, ?, ?, ?, ?, ?)")
                        .bind(code, now, body.v, ip, key, cleanName(body.name), JSON.stringify(addrs)).run();
                    const refused = await relayAllowed(env, ip, now);
                    const turn = refused ? { why: refused } : await turnAccess(env);
                    return reply(turn.server ? { code, key, you: ip, turn } : { code, key, you: ip, noRelay: turn.why });
                } catch (e) {
                    // the code is taken: another one
                }
            }
            return reply({ error: "busy" }, 503);
        }

        const code = String(body.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (code.length !== 6) {
            return reply({ error: "no room" }, 404);
        }
        const room = await env.DB.prepare("SELECT * FROM rooms WHERE code = ? AND made >= ?").bind(code, now - ROOM_SECONDS).first();
        if (!room) {
            return reply({ error: "no room" }, 404);
        }

        if (what === "join") {
            const addrs = cleanAddrs(body.addrs);
            if (!Number.isInteger(body.v) || addrs === null) {
                return reply({ error: "bad request" }, 400);
            }
            if (body.v !== room.version) {
                return reply({ error: "version" }, 409);
            }
            const key = randomText(24, ALPHABET);
            // only if nobody has joined yet (the update tells whether it was this request that got the place)
            if (/^[0-9.]{7,15}$/.test(ip)) {
                addrs.push("seen=" + ip); // for the host's relay: whom to let through
            }
            const done = await env.DB.prepare("UPDATE rooms SET join_key = ?, join_name = ?, join_addrs = ? WHERE code = ? AND join_key IS NULL")
                .bind(key, cleanName(body.name), JSON.stringify(addrs), code).run();
            if (!done.meta || done.meta.changes !== 1) {
                return reply({ error: "full" }, 409);
            }
            return reply({ key, you: ip, peer: { name: room.host_name, addrs: JSON.parse(room.host_addrs) } });
        }

        const isHost = body.key === room.host_key, isJoin = room.join_key !== null && body.key === room.join_key;
        if (!isHost && !isJoin) {
            return reply({ error: "no room" }, 404);
        }
        if (what === "poll") {
            if (isHost) {
                return reply({ peer: room.join_key !== null ? { name: room.join_name, addrs: JSON.parse(room.join_addrs) } : null });
            }
            return reply({ peer: { name: room.host_name, addrs: JSON.parse(room.host_addrs) } });
        }
        if (what === "addrs") { // the host has found out more about how it can be reached
            const addrs = cleanAddrs(body.addrs);
            if (!isHost || addrs === null) {
                return reply({ error: "bad request" }, 400);
            }
            await env.DB.prepare("UPDATE rooms SET host_addrs = ? WHERE code = ?").bind(JSON.stringify(addrs), code).run();
            return reply({});
        }
        if (what === "leave") {
            await env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(code).run();
            return reply({});
        }
        return reply({ error: "bad request" }, 404);
    },
};
