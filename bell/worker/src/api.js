// api.js: the /api/bell routes of the town worker.
// makeHandler({sendPush, now}) -> async (request, env, ctx) => Response; now() gives milliseconds.
//   POST   /api/bell       turn a bell on   (public, same-origin page only)
//   DELETE /api/bell       turn a bell off  (public, same-origin page only)
//   POST   /api/bell/ring  ops of the build server (secret header); answers hold counts only
// Storage: D1 (env.DB), tables `bells` and `meta`. Every check of a request runs before any D1 call.
// No logging here at all: bodies, endpoints and keys never reach a log or an answer.

import { b64uToBytes, pushHostOk } from "./push.js";

const BELL_TE = new TextEncoder();
const BELL_MAX_PUBLIC_BODY = 2048; // bytes
const BELL_MAX_RING_BODY = 65536; // bytes
const BELL_MAX_TRIES = 2000; // public POST attempts for NEW bells per UTC day (refreshes and 403s are not counted)
const BELL_MAX_ROWS = 1000; // active bells
const BELL_MAX_NEW = 200; // new bells per UTC day
const BELL_PAGE = 200; // rows looked at per ring request
const BELL_MAX_LIST = 2000; // house numbers in one ring request
const BELL_MAX_LIM = 8; // pushes per ring request
const BELL_DEFAULT_LIM = 6;
const BELL_RING_KEY_MIN = 32;
const BELL_DAY = 86400; // seconds
const BELL_VERSION_GAP = 259200; // 72 h between version notes of one bell
const BELL_PRUNE_DAYS = 120;
const BELL_META_DAYS = 3;
const BELL_OK_STATUS = [200, 201, 202];
const BELL_VERSION_RE = /^rc\.(\d{1,3})$/;
const BELL_HOUSE_KEY_RE = /^[1-9][0-9]{0,3}$/;
const BELL_LEN_RE = /^[0-9]+$/;

const BELL_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS bells (" +
    "id TEXT PRIMARY KEY, e TEXT NOT NULL, p TEXT NOT NULL, a TEXT NOT NULL, h INTEGER NOT NULL, " +
    "c INTEGER NOT NULL, t INTEGER NOT NULL, hd INTEGER NOT NULL DEFAULT 0, ed INTEGER NOT NULL DEFAULT 0, " +
    "vl TEXT NOT NULL DEFAULT '', vt INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS bells_h ON bells(h)",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)",
];
const BELL_SQL_META_GET = "SELECT v FROM meta WHERE k = ?";
const BELL_SQL_META_ADD = "INSERT INTO meta (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING v";
const BELL_SQL_META_INC = "INSERT INTO meta (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1";
const BELL_SQL_OFF_SET = "INSERT INTO meta (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = 1";
const BELL_SQL_OFF_CLEAR = "DELETE FROM meta WHERE k = ?";
const BELL_SQL_ROW_AUTH = "SELECT a FROM bells WHERE id = ?";
const BELL_SQL_ROW_REFRESH = "UPDATE bells SET h = ?, t = ? WHERE id = ?";
const BELL_SQL_CAPS = "SELECT (SELECT COUNT(*) FROM bells) AS n, (SELECT v FROM meta WHERE k = ?) AS d";
const BELL_SQL_INSERT = "INSERT INTO bells (id, e, p, a, h, c, t, vl) VALUES (?, ?, ?, ?, ?, ?, ?, '')";
const BELL_SQL_DELETE_AUTH = "DELETE FROM bells WHERE id = ? AND a = ?";
const BELL_SQL_DELETE_ID = "DELETE FROM bells WHERE id = ?";
const BELL_SQL_HOUSES = "SELECT h FROM bells";
const BELL_SQL_WALK = {
  hd: "SELECT rowid AS rid, id, e, p, a, h FROM bells WHERE rowid > ? AND hd < ? ORDER BY rowid LIMIT 200",
  ed: "SELECT rowid AS rid, id, e, p, a, h FROM bells WHERE rowid > ? AND ed < ? ORDER BY rowid LIMIT 200",
  vt: "SELECT rowid AS rid, id, e, p, a, h, vl FROM bells WHERE rowid > ? AND vt < ? ORDER BY rowid LIMIT 200",
};
const BELL_SQL_MARK = {
  hd: "UPDATE bells SET hd = ? WHERE id = ?",
  ed: "UPDATE bells SET ed = ? WHERE id = ?",
};
const BELL_SQL_MARK_VERSION = "UPDATE bells SET vl = ?, vt = ? WHERE id = ?";
const BELL_SQL_PRUNE_ROWS = "DELETE FROM bells WHERE t < ?";
const BELL_SQL_PRUNE_META =
  "DELETE FROM meta WHERE (substr(k, 1, 4) = 'try:' OR substr(k, 1, 4) = 'new:') AND CAST(substr(k, 5) AS INTEGER) < ?";

// Push message, options and dedupe column of each alert kind.
const BELL_ALERT = {
  house: { col: "hd", topic: "house", urgency: "high" },
  pause: { col: "hd", topic: "house", urgency: "high" },
  empty: { col: "ed", topic: "empty", urgency: "high" },
};
const BELL_NOTE_TTL = 43200;
const BELL_HOUSE_TTL_MIN = 900;
const BELL_HOUSE_TTL_MAX = 86400;

// ---------- answers ----------

// Every answer: cache-control, nosniff, x-town-api. JSON body and content-type unless 204/404 (empty).
function bellResp(status, obj) {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-town-api": "1",
  };
  if (obj === null) return new Response(null, { status, headers });
  headers["content-type"] = "application/json";
  return new Response(JSON.stringify(obj), { status, headers });
}

function bellNotFound() {
  return bellResp(404, null);
}

function bellFail(status) {
  return bellResp(status, { ok: false });
}

function bellOk(extra) {
  return bellResp(200, Object.assign({ ok: true }, extra || {}));
}

// ---------- small checks ----------

function bellEnvOk(env) {
  return (
    !!env &&
    typeof env === "object" &&
    !!env.DB &&
    typeof env.DB.prepare === "function" &&
    typeof env.DB.batch === "function" &&
    typeof env.BELL_HOST === "string" &&
    env.BELL_HOST !== "" &&
    typeof env.VAPID_JWK === "string" &&
    env.VAPID_JWK !== ""
  );
}

function bellPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function bellParseObject(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  return bellPlainObject(v) ? v : null;
}

function bellExactKeys(obj, keys) {
  const own = Object.keys(obj);
  if (own.length !== keys.length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

function bellB64uLen(s, len, maxChars) {
  if (typeof s !== "string" || s.length > maxChars) return null;
  let b;
  try {
    b = b64uToBytes(s);
  } catch {
    return null;
  }
  return b.length === len ? b : null;
}

// e, a (and p, h for a new bell) as SPEC 5.5 / 5.6 asks. Only crypto work here, no D1.
// e must also be written exactly as the URL parser writes it (what a browser gives and what fetch sends), so
// other spellings of one push address ("/./", "%2e", "x/..", "\") can not become extra rows of one subscription.
async function bellValuesOk(body, full) {
  if (typeof body.e !== "string" || !pushHostOk(body.e)) return false;
  if (new URL(body.e).href !== body.e) return false;
  if (bellB64uLen(body.a, 16, 24) === null) return false;
  if (!full) return true;
  const p = bellB64uLen(body.p, 65, 88);
  if (p === null || p[0] !== 4) return false;
  try {
    await crypto.subtle.importKey("raw", p, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    return false;
  }
  return Number.isInteger(body.h) && body.h >= 1 && body.h <= 9999;
}

async function bellSha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", BELL_TE.encode(text)));
}

async function bellId(endpoint) {
  const d = await bellSha256(endpoint);
  let s = "";
  for (const b of d) s += (b < 16 ? "0" : "") + b.toString(16);
  return s;
}

// SHA-256 of both sides, then a constant-time compare of the two digests.
async function bellKeyMatches(given, wanted) {
  const a = await bellSha256(typeof given === "string" ? given : "");
  const b = await bellSha256(wanted);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bellClock(deps) {
  const ms = Number(deps.now());
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError("bell: bad clock");
  const sec = Math.floor(ms / 1000);
  return { sec, day: Math.floor(sec / BELL_DAY) };
}

// The push sender of makeHandler; any throw or odd answer counts as status 0.
async function bellPush(deps, env, row, msg, opt) {
  try {
    const r = await deps.sendPush(env, { e: row.e, p: row.p, a: row.a }, msg, opt, { now: deps.now });
    return r && Number.isInteger(r.status) ? r.status : 0;
  } catch {
    return 0;
  }
}

// ---------- public routes ----------

async function bellPublic(request, env, deps, on) {
  const hd = request.headers;
  if (hd.get("origin") !== "https://" + env.BELL_HOST) return bellFail(403);
  const site = hd.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return bellFail(403);
  if (hd.get("content-type") !== "application/json") return bellFail(415);
  const len = hd.get("content-length");
  if (len === null) return bellFail(411);
  if (!BELL_LEN_RE.test(len) || Number(len) > BELL_MAX_PUBLIC_BODY) return bellFail(413);
  const text = await request.text();
  if (text.length > BELL_MAX_PUBLIC_BODY || BELL_TE.encode(text).length > BELL_MAX_PUBLIC_BODY) return bellFail(413);
  const body = bellParseObject(text);
  if (body === null) return bellFail(400);
  return on ? bellOn(body, env, deps) : bellOff(body, env);
}

async function bellOn(body, env, deps) {
  if (!bellExactKeys(body, ["e", "p", "a", "h"])) return bellFail(400);
  if (!(await bellValuesOk(body, true))) return bellFail(400);
  const { day } = bellClock(deps);
  const id = await bellId(body.e);
  const db = env.DB;
  const tryKey = "try:" + day;
  try {
    const off = await db.prepare(BELL_SQL_META_GET).bind("off").first("v");
    if (off === 1) return bellFail(410);
    // A bell that is already on: a refresh (right a) or a 403. Neither reads nor writes the try counter.
    const row = await db.prepare(BELL_SQL_ROW_AUTH).bind(id).first();
    if (row) {
      if (row.a !== body.a) return bellFail(403);
      await db.prepare(BELL_SQL_ROW_REFRESH).bind(body.h, day, id).run();
      return bellOk();
    }
    // A new bell: once the day's attempts are used up, refuse and write nothing; else count this attempt.
    const used = await db.prepare(BELL_SQL_META_GET).bind(tryKey).first("v");
    if (used !== null && (!Number.isInteger(used) || used >= BELL_MAX_TRIES)) return bellFail(503);
    const tries = await db.prepare(BELL_SQL_META_ADD).bind(tryKey).first("v");
    if (!Number.isInteger(tries) || tries > BELL_MAX_TRIES) return bellFail(503);
    const caps = await db.prepare(BELL_SQL_CAPS).bind("new:" + day).first();
    if (!caps || !Number.isInteger(caps.n) || caps.n >= BELL_MAX_ROWS) return bellFail(503);
    if (caps.d !== null && (!Number.isInteger(caps.d) || caps.d >= BELL_MAX_NEW)) return bellFail(503);
  } catch {
    return bellFail(503);
  }
  const status = await bellPush(deps, env, body, { k: "test" }, { ttl: 300, urgency: "high", topic: "test" });
  if (!BELL_OK_STATUS.includes(status)) return bellFail(502);
  try {
    await db.batch([
      db.prepare(BELL_SQL_INSERT).bind(id, body.e, body.p, body.a, body.h, day, day),
      db.prepare(BELL_SQL_META_INC).bind("new:" + day),
    ]);
  } catch {
    return bellFail(503);
  }
  return bellOk();
}

async function bellOff(body, env) {
  if (!bellExactKeys(body, ["e", "a"])) return bellFail(400);
  if (!(await bellValuesOk(body, false))) return bellFail(400);
  const id = await bellId(body.e);
  try {
    await env.DB.prepare(BELL_SQL_DELETE_AUTH).bind(id, body.a).run();
  } catch {
    // always 204, also when D1 failed
  }
  return bellResp(204, null);
}

// ---------- ring route ----------

async function bellRing(request, env, deps) {
  const key = env.RING_KEY;
  if (typeof key !== "string" || key.length < BELL_RING_KEY_MIN) return bellNotFound();
  if (!(await bellKeyMatches(request.headers.get("x-bell-key"), key))) return bellNotFound();
  if (request.headers.get("content-type") !== "application/json") return bellFail(415);
  const len = request.headers.get("content-length");
  if (len !== null && (!BELL_LEN_RE.test(len) || Number(len) > BELL_MAX_RING_BODY)) return bellFail(413);
  const text = await request.text();
  if (text.length > BELL_MAX_RING_BODY || BELL_TE.encode(text).length > BELL_MAX_RING_BODY) return bellFail(413);
  const body = bellParseObject(text);
  if (body === null) return bellFail(400);
  const clock = bellClock(deps);
  switch (body.op) {
    case "init":
      return bellRingInit(env);
    case "off":
      return bellRingOff(body, env);
    case "count":
      return bellRingCount(body, env);
    case "alert":
      return bellRingAlert(body, env, deps, clock);
    case "version":
      return bellRingVersion(body, env, deps, clock);
    case "prune":
      return bellRingPrune(env, clock);
    default:
      return bellFail(400);
  }
}

async function bellRingInit(env) {
  const db = env.DB;
  try {
    await db.batch(BELL_SCHEMA.map((s) => db.prepare(s)));
  } catch {
    return bellFail(503);
  }
  return bellOk();
}

async function bellRingOff(body, env) {
  if (typeof body.on !== "boolean") return bellFail(400);
  try {
    await env.DB.prepare(body.on ? BELL_SQL_OFF_SET : BELL_SQL_OFF_CLEAR).bind("off").run();
  } catch {
    return bellFail(503);
  }
  return bellOk();
}

function bellHouseList(hs) {
  if (!Array.isArray(hs) || hs.length > BELL_MAX_LIST) return null;
  for (const x of hs) if (!Number.isInteger(x) || x < 1 || x > 9999) return null;
  return new Set(hs);
}

async function bellRingCount(body, env) {
  const set = bellHouseList(body.hs);
  if (set === null) return bellFail(400);
  let rows;
  try {
    rows = (await env.DB.prepare(BELL_SQL_HOUSES).all()).results;
  } catch {
    return bellFail(503);
  }
  let matched = 0;
  for (const r of rows) if (set.has(r.h)) matched++;
  return bellOk({ active: rows.length, matched });
}

// m = {"<house number>": [n, of]}: at most 2000 keys, keys 1..9999 written plainly,
// values two integers with 1 <= n <= of <= 99. Returns a Map(house -> [n, of]) or null.
function bellHouseMap(m) {
  if (!bellPlainObject(m)) return null;
  const keys = Object.keys(m);
  if (keys.length > BELL_MAX_LIST) return null;
  const out = new Map();
  for (const k of keys) {
    if (!BELL_HOUSE_KEY_RE.test(k)) return null;
    const v = m[k];
    if (!Array.isArray(v) || v.length !== 2) return null;
    const n = v[0];
    const of = v[1];
    if (!Number.isInteger(n) || !Number.isInteger(of) || n < 1 || n > of || of > 99) return null;
    out.set(Number(k), [n, of]);
  }
  return out;
}

// after (row cursor >= 0), lim (1..8, default 6), dry (bool): after and dry must be given.
function bellWalkArgs(body) {
  const lim = body.lim === undefined ? BELL_DEFAULT_LIM : body.lim;
  if (!Number.isSafeInteger(body.after) || body.after < 0) return null;
  if (!Number.isInteger(lim) || lim < 1 || lim > BELL_MAX_LIM) return null;
  if (typeof body.dry !== "boolean") return null;
  return { after: body.after, lim, dry: body.dry };
}

// One page of rows (at most 200) after the cursor; `isMatch(row)` picks the rows to note.
// dry: count the matches of the whole page. Otherwise stop at the lim-th match.
// Then one push per picked row (in parallel) and ONE batch with every row update.
async function bellWalk(env, deps, walk, pageSql, pageArgs, isMatch, makeNote) {
  const db = env.DB;
  let page;
  try {
    page = (await db.prepare(pageSql).bind(walk.after, ...pageArgs).all()).results;
  } catch {
    return bellFail(503);
  }
  let after = walk.after;
  let more = page.length >= BELL_PAGE;
  let matched = 0;
  const picks = [];
  for (const row of page) {
    after = row.rid;
    if (!isMatch(row)) continue;
    matched++;
    if (walk.dry) continue;
    picks.push(row);
    if (picks.length >= walk.lim) {
      more = true;
      break;
    }
  }
  const out = { sent: 0, gone: 0, denied: 0, failed: 0, matched, after, more };
  if (picks.length === 0) return bellOk(out);
  const statuses = await Promise.all(
    picks.map((row) => {
      const note = makeNote(row);
      return bellPush(deps, env, row, note.msg, note.opt);
    }),
  );
  const writes = [];
  picks.forEach((row, i) => {
    const s = statuses[i];
    if (BELL_OK_STATUS.includes(s)) {
      out.sent++;
      writes.push(makeNote(row).mark(db));
    } else if (s === 404 || s === 410) {
      out.gone++;
      writes.push(db.prepare(BELL_SQL_DELETE_ID).bind(row.id));
    } else if (s === 401 || s === 403) {
      out.denied++;
    } else {
      out.failed++;
    }
  });
  if (writes.length > 0) {
    try {
      await db.batch(writes);
    } catch {
      return bellFail(503);
    }
  }
  return bellOk(out);
}

async function bellRingAlert(body, env, deps, clock) {
  const kind = typeof body.k === "string" && Object.prototype.hasOwnProperty.call(BELL_ALERT, body.k) ? BELL_ALERT[body.k] : null;
  if (kind === null) return bellFail(400);
  if (!Number.isSafeInteger(body.day) || body.day !== clock.day) return bellFail(400);
  let ttl = BELL_NOTE_TTL;
  if (body.k === "house") {
    if (!Number.isSafeInteger(body.close)) return bellFail(400);
    ttl = body.close - clock.sec;
    if (ttl < BELL_HOUSE_TTL_MIN || ttl > BELL_HOUSE_TTL_MAX) return bellFail(400);
  }
  const m = bellHouseMap(body.m);
  if (m === null) return bellFail(400);
  const walk = bellWalkArgs(body);
  if (walk === null) return bellFail(400);
  const opt = { ttl, urgency: kind.urgency, topic: kind.topic };
  const markSql = BELL_SQL_MARK[kind.col];
  const day = clock.day;
  return bellWalk(
    env,
    deps,
    walk,
    BELL_SQL_WALK[kind.col],
    [day],
    (row) => m.has(row.h),
    (row) => {
      const nof = m.get(row.h);
      const msg = body.k === "house" ? { k: "house", close: body.close, n: nof[0], of: nof[1] } : { k: body.k };
      return { msg, opt, mark: (db) => db.prepare(markSql).bind(day, row.id) };
    },
  );
}

function bellVersionNumber(v) {
  const r = typeof v === "string" ? BELL_VERSION_RE.exec(v) : null;
  return r ? Number(r[1]) : -1;
}

async function bellRingVersion(body, env, deps, clock) {
  if (typeof body.v !== "string" || !BELL_VERSION_RE.test(body.v)) return bellFail(400);
  const walk = bellWalkArgs(body);
  if (walk === null) return bellFail(400);
  const v = body.v;
  const num = bellVersionNumber(v);
  const now = clock.sec;
  const msg = { k: "version", v };
  const opt = { ttl: BELL_NOTE_TTL, urgency: "high", topic: "version" };
  return bellWalk(
    env,
    deps,
    walk,
    BELL_SQL_WALK.vt,
    [now - BELL_VERSION_GAP],
    (row) => num > bellVersionNumber(row.vl),
    (row) => ({ msg, opt, mark: (db) => db.prepare(BELL_SQL_MARK_VERSION).bind(v, now, row.id) }),
  );
}

async function bellRingPrune(env, clock) {
  const db = env.DB;
  let res;
  try {
    res = await db.batch([
      db.prepare(BELL_SQL_PRUNE_ROWS).bind(clock.day - BELL_PRUNE_DAYS),
      db.prepare(BELL_SQL_PRUNE_META).bind(clock.day - BELL_META_DAYS),
    ]);
  } catch {
    return bellFail(503);
  }
  const changes = res && res[0] && res[0].meta ? res[0].meta.changes : 0;
  return bellOk({ removed: Number.isInteger(changes) ? changes : 0 });
}

// ---------- entry ----------

async function bellRoute(request, env, deps) {
  if (!bellEnvOk(env)) return bellFail(503);
  const url = new URL(request.url);
  if (url.hostname !== env.BELL_HOST) return bellNotFound();
  const route = request.method + " " + url.pathname;
  if (route === "POST /api/bell") return bellPublic(request, env, deps, true);
  if (route === "DELETE /api/bell") return bellPublic(request, env, deps, false);
  if (route === "POST /api/bell/ring") return bellRing(request, env, deps);
  return bellNotFound();
}

function makeHandler(opts) {
  const sendPush = opts ? opts.sendPush : undefined;
  const now = opts ? opts.now : undefined;
  if (typeof sendPush !== "function" || typeof now !== "function") {
    throw new TypeError("makeHandler: sendPush and now are needed");
  }
  const deps = { sendPush, now };
  return async function bellHandle(request, env, ctx) {
    try {
      return await bellRoute(request, env, deps);
    } catch {
      return bellFail(503);
    }
  };
}

export { makeHandler };
