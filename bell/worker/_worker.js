// _worker.js: made by bundle.py from src/push.js, src/api.js, src/main.js. Do not edit by hand.

// ---------- src/push.js ----------
// push.js: web push for the bell.
// base64url helpers, push-host allowlist, RFC 8291 payload encryption ("aes128gcm", RFC 8188),
// RFC 8292 VAPID header, sendPush.
// Uses only Workers runtime globals (crypto.subtle, fetch, URL, TextEncoder, AbortSignal, atob/btoa),
// so the same file also runs unchanged under Node 22 for the tests.
// No logging here at all: endpoints, keys and payloads never reach a log.

const PUSH_TE = new TextEncoder();
const PUSH_VAPID_SUB = "https://6529town.com";
const PUSH_VAPID_HEADER = '{"typ":"JWT","alg":"ES256"}';
const PUSH_VAPID_LIFE = 43200; // seconds a new token is valid (12 h)
const PUSH_VAPID_MARGIN = 3600; // a cached token is reused while more than this is left (1 h)
const PUSH_VAPID_CACHE = new Map(); // audience -> {jwk, exp, value}
const PUSH_VAPID_CACHE_MAX = 64;
const PUSH_RS = 4096; // record size in the aes128gcm header
const PUSH_MAX_PLAIN = 3993; // RFC 8291 section 4: 4096 - 86 header - 1 delimiter - 16 tag
const PUSH_MSG_MAX = 256; // bytes of JSON per message
const PUSH_TTL_MAX = 2419200; // 4 weeks
const PUSH_TIMEOUT_MS = 8000;
const PUSH_EXACT_HOSTS = ["fcm.googleapis.com", "jmt17.google.com", "updates.push.services.mozilla.com"];
const PUSH_SUFFIX_HOSTS = [".push.apple.com", ".notify.windows.com"];
const PUSH_URGENCY = ["very-low", "low", "normal", "high"];

// ---------- bytes and base64url ----------

// Uint8Array as is; any other typed array or DataView as a byte view; a raw byte store (what
// crypto.subtle returns) wrapped. (The word for that type is avoided: bundle.py refuses any text
// that contains the Node byte type name.)
function pushBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x && typeof x === "object" && typeof x.byteLength === "number") {
    if (typeof x.byteOffset === "number" && x.buffer) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    return new Uint8Array(x);
  }
  throw new TypeError("push: bytes expected");
}

function pushConcat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesToB64u(u8) {
  const b = pushBytes(u8);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Only A-Z a-z 0-9 _ -, no padding, no impossible length (SPEC 5.2); anything else throws.
function b64uToBytes(str) {
  if (typeof str !== "string") throw new TypeError("b64u: not a string");
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new TypeError("b64u: bad character");
  const rem = str.length % 4;
  if (rem === 1) throw new TypeError("b64u: bad length");
  const pad = rem === 2 ? "==" : rem === 3 ? "=" : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- push-host allowlist ----------

function pushHostNameOk(host) {
  if (host.startsWith("[") || host.includes(":")) return false; // IPv6 literal
  const labels = host.split(".");
  // IPv4 literal in any form the URL parser accepts (last label numeric or hex)
  if (/^(?:0x[0-9a-f]*|[0-9]+)$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

function pushHostOk(urlString) {
  try {
    if (typeof urlString !== "string" || urlString.length > 1024) return false;
    if (!/^[\x21-\x7e]+$/.test(urlString)) return false; // printable ASCII, no space or control
    if (urlString.includes("#")) return false; // also an empty fragment
    if (!urlString.startsWith("https://")) return false;
    const u = new URL(urlString);
    if (u.protocol !== "https:") return false;
    if (u.username !== "" || u.password !== "" || u.port !== "" || u.hash !== "") return false;
    const host = u.hostname;
    // The URL parser lower-cases the host and drops a default port, so the raw text must hold
    // exactly the parsed host right after "https://" (no userinfo, no port, no upper case).
    const rest = urlString.slice(8);
    if (!rest.startsWith(host)) return false;
    const next = rest.charAt(host.length);
    if (next !== "" && next !== "/" && next !== "?") return false;
    if (!pushHostNameOk(host)) return false;
    if (PUSH_EXACT_HOSTS.includes(host)) return true;
    return PUSH_SUFFIX_HOSTS.some((s) => host.length > s.length && host.endsWith(s));
  } catch {
    return false;
  }
}

// ---------- RFC 8291 encryption ----------

async function pushHkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8);
  return new Uint8Array(bits);
}

// One aes128gcm record, rs 4096:
// body = salt(16) | rs(4) | idlen(1)=65 | sender public key(65) | ciphertext.
// `inject` ({salt, asPrivateJwk}) is only for the RFC 8291 section 5 test vector.
async function encryptPayload(plainU8, p256dhU8, authU8, inject) {
  const plain = pushBytes(plainU8);
  const uaPub = pushBytes(p256dhU8);
  const auth = pushBytes(authU8);
  if (plain.length > PUSH_MAX_PLAIN) throw new RangeError("push: plaintext too long");
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new TypeError("push: bad p256dh");
  if (auth.length !== 16) throw new TypeError("push: bad auth");
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const uaKey = await crypto.subtle.importKey("raw", uaPub, curve, false, []);

  let salt;
  let asPriv;
  let asPub;
  if (inject) {
    salt = pushBytes(inject.salt);
    const j = inject.asPrivateJwk;
    asPriv = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d },
      curve,
      false,
      ["deriveBits"],
    );
    asPub = pushConcat([[4], b64uToBytes(j.x), b64uToBytes(j.y)]);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    const pair = await crypto.subtle.generateKey(curve, true, ["deriveBits"]);
    asPriv = pair.privateKey;
    asPub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  if (salt.length !== 16 || asPub.length !== 65 || asPub[0] !== 4) throw new TypeError("push: bad sender key");

  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const keyInfo = pushConcat([PUSH_TE.encode("WebPush: info"), [0], uaPub, asPub]);
  const ikm = await pushHkdf(auth, ecdh, keyInfo, 32);
  const cek = await pushHkdf(salt, ikm, pushConcat([PUSH_TE.encode("Content-Encoding: aes128gcm"), [0]]), 16);
  const nonce = await pushHkdf(salt, ikm, pushConcat([PUSH_TE.encode("Content-Encoding: nonce"), [0]]), 12);

  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const record = pushConcat([plain, [2]]); // padding delimiter of the last (only) record, no extra padding
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, record));

  const header = new Uint8Array(86);
  header.set(salt, 0);
  header[16] = (PUSH_RS >>> 24) & 0xff;
  header[17] = (PUSH_RS >>> 16) & 0xff;
  header[18] = (PUSH_RS >>> 8) & 0xff;
  header[19] = PUSH_RS & 0xff;
  header[20] = 65;
  header.set(asPub, 21);
  return pushConcat([header, ct]);
}

// ---------- RFC 8292 VAPID ----------

// Header value "vapid t=<jwt>, k=<public key>". One token per audience, kept in a module-level Map
// and reused while exp - nowSec > 3600. A cached token made with another key, or one that looks
// newer than now (clock went back), is not reused.
async function vapidAuth(env, audience, nowSec) {
  const raw = env ? env.VAPID_JWK : undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) throw new TypeError("vapid: no key");
  if (typeof audience !== "string" || !audience.startsWith("https://") || new URL(audience).origin !== audience) {
    throw new TypeError("vapid: bad audience");
  }
  const now = Math.floor(Number(nowSec));
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("vapid: bad time");

  const hit = PUSH_VAPID_CACHE.get(audience);
  if (hit && hit.jwk === raw && hit.exp - now > PUSH_VAPID_MARGIN && hit.exp - now <= PUSH_VAPID_LIFE) {
    return hit.value;
  }

  const j = JSON.parse(raw);
  if (!j || j.kty !== "EC" || j.crv !== "P-256") throw new TypeError("vapid: bad key");
  const x = b64uToBytes(j.x);
  const y = b64uToBytes(j.y);
  if (x.length !== 32 || y.length !== 32 || b64uToBytes(j.d).length !== 32) throw new TypeError("vapid: bad key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: j.x, y: j.y, d: j.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const exp = now + PUSH_VAPID_LIFE;
  const claims = JSON.stringify({ aud: audience, exp, sub: PUSH_VAPID_SUB });
  const unsigned = bytesToB64u(PUSH_TE.encode(PUSH_VAPID_HEADER)) + "." + bytesToB64u(PUSH_TE.encode(claims));
  // WebCrypto ECDSA gives the raw r|s form (64 bytes) that JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, PUSH_TE.encode(unsigned));
  const value = "vapid t=" + unsigned + "." + bytesToB64u(sig) + ", k=" + bytesToB64u(pushConcat([[4], x, y]));

  PUSH_VAPID_CACHE.delete(audience);
  if (PUSH_VAPID_CACHE.size >= PUSH_VAPID_CACHE_MAX) PUSH_VAPID_CACHE.delete(PUSH_VAPID_CACHE.keys().next().value);
  PUSH_VAPID_CACHE.set(audience, { jwk: raw, exp, value });
  return value;
}

// ---------- sendPush ----------

// {status}: the push service's HTTP status; -1 = refused before any network call (bad host or
// bad input); 0 = network error or timeout. Never throws.
// deps.now() returns milliseconds like Date.now(); a value below 1e11 is taken as seconds.
async function sendPush(env, sub, msg, opt, deps) {
  let doFetch;
  let url;
  let init;
  try {
    if (!sub || typeof sub !== "object" || !pushHostOk(sub.e)) return { status: -1 };
    const d = deps || {};
    doFetch = d.fetch !== undefined ? d.fetch : (u, i) => fetch(u, i);
    const nowFn = d.now !== undefined ? d.now : () => Date.now();
    if (typeof doFetch !== "function" || typeof nowFn !== "function") return { status: -1 };

    const o = opt || {};
    if (!Number.isSafeInteger(o.ttl) || o.ttl < 0 || o.ttl > PUSH_TTL_MAX) return { status: -1 };
    const urgency = o.urgency === undefined ? "normal" : o.urgency;
    if (!PUSH_URGENCY.includes(urgency)) return { status: -1 };
    if (o.topic !== undefined && (typeof o.topic !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(o.topic))) {
      return { status: -1 };
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { status: -1 };
    const proto = Object.getPrototypeOf(msg);
    if (proto !== Object.prototype && proto !== null) return { status: -1 };
    const plain = PUSH_TE.encode(JSON.stringify(msg));
    if (plain.length > PUSH_MSG_MAX) return { status: -1 };

    const t = Number(nowFn());
    if (!Number.isFinite(t) || t <= 0) return { status: -1 };
    const nowSec = Math.floor(t >= 1e11 ? t / 1000 : t);

    url = sub.e;
    const body = await encryptPayload(plain, b64uToBytes(sub.p), b64uToBytes(sub.a));
    const authorization = await vapidAuth(env, new URL(url).origin, nowSec);
    const headers = {
      TTL: String(o.ttl),
      Urgency: urgency,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: authorization,
    };
    if (o.topic !== undefined) headers.Topic = o.topic;
    init = { method: "POST", headers, body, redirect: "manual" };
  } catch {
    return { status: -1 };
  }

  let res;
  try {
    init.signal = AbortSignal.timeout(PUSH_TIMEOUT_MS);
    res = await doFetch(url, init);
  } catch {
    return { status: 0 };
  }
  let status = 0;
  try {
    const s = res ? res.status : undefined;
    if (Number.isInteger(s) && s >= 0 && s <= 999) status = s;
  } catch {
    status = 0;
  }
  try {
    if (res && res.body && typeof res.body.cancel === "function") res.body.cancel().catch(() => {});
  } catch {
    // body already used or locked; nothing to free
  }
  return { status };
}

// ---------- src/api.js ----------
// api.js: the /api/bell routes of the town worker.
// makeHandler({sendPush, now}) -> async (request, env, ctx) => Response; now() gives milliseconds.
//   POST   /api/bell       turn a bell on   (public, same-origin page only)
//   DELETE /api/bell       turn a bell off  (public, same-origin page only)
//   POST   /api/bell/ring  ops of the build server (secret header); answers hold counts only
// Storage: D1 (env.DB), tables `bells` and `meta`. Every check of a request runs before any D1 call.
// No logging here at all: bodies, endpoints and keys never reach a log or an answer.


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

// ---------- src/main.js ----------
// main.js: entry of the town worker. /api/bell and /api/bell/* go to the bell handler, the rest to the static
// files (env.ASSETS). No top-level `fetch` name: the bundle is one scope and push.js uses the global fetch.
const bellMainHandler = makeHandler({ sendPush, now: () => Date.now() });
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/api/bell" || path.startsWith("/api/bell/")) return bellMainHandler(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
