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

export { b64uToBytes, bytesToB64u, pushHostOk, encryptPayload, vapidAuth, sendPush };
