// End-to-end test of the bell (owner J). Run from the bell folder: nice -n 10 node --test test/e2e.test.mjs
//
// The pieces, all together:
// - the BUNDLED worker worker/_worker.js (made by bundle.py), copied unchanged to a temp .mjs file and imported;
//   every request goes through its `export default { fetch }` (main.js routing included);
// - the fake D1 of test/fake-d1.mjs;
// - a fake push service: the global `fetch` (sendPush falls back to it). It keeps every test browser's private
//   key, checks the request and the VAPID token, decrypts the body with test/recv.mjs (receiver side of
//   RFC 8291) and hands the plain text to that browser's site/sw.js, which runs in node:vm;
// - bell-ring.py --fake on a synthetic town page; every request it prints is replayed into the worker,
//   and the worker's real answers are given back to the script (--fake-answers) so its own walk logic runs.
//
// Clock: main.js builds the handler with `() => Date.now()` and the bundle exports only `default`, so the
// test pins the global Date.now to the same second as `--now` while the suite runs (restored afterwards).
// No network. Every value is synthetic and made at run time.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { makeFakeD1 } from "./fake-d1.mjs";
import { makeReceiver, decryptPush, toB64u, fromB64u } from "./recv.mjs";

const BUNDLE = fileURLToPath(new URL("../worker/_worker.js", import.meta.url));
const RING_PY = fileURLToPath(new URL("../bell-ring.py", import.meta.url));
const SW_TEXT = readFileSync(new URL("../site/sw.js", import.meta.url), "utf8");

const HOST = "6529town.com";
const ORIGIN = "https://" + HOST;
const SCOPE = ORIGIN + "/";
const CTX = { waitUntil() {}, passThroughOnException() {} };
const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

// ---------- the synthetic day: 17:00 UTC, signing closes 19:00 UTC (7200 s ahead) ----------

const DAY = Math.floor(Date.UTC(2027, 2, 3) / 86400000);
const NOW = DAY * 86400 + 61200;
const NOW_MS = NOW * 1000;
const CLOSE = DAY * 86400 + 68400;
// The two pictures of a notification are kept inside sw.js; they must equal these two files byte for byte.
const PIC = (name) => "data:image/png;base64," + readFileSync(new URL((name === "badge.png" ? "../icons/" : "../site/") + name, import.meta.url)).toString("base64");
const ICON = PIC("icon-192.png");
const BADGE = PIC("badge.png");

// ---------- expected texts, typed from SPEC section 6 ----------

const CLOSE_TEXT = new Date(CLOSE * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const HOUSE_BODY = "Signing closes around " + CLOSE_TEXT + ". Is your validator running?";
const VERSION_BODY = "Already on it? Nothing to do. Update only from the official source.";

// Per kind of note: the plain message the worker must encrypt, the push headers, and the notification sw.js shows.
const KIND = {
  test: {
    msg: { k: "test" },
    ttl: "300",
    urgency: "high",
    topic: "test",
    note: { title: "6529 Town", body: "The bell on your house works. Unofficial, not made by 6529.", tag: "test" },
  },
  houseOne: {
    msg: { k: "house", close: CLOSE, n: 1, of: 1 },
    ttl: String(CLOSE - NOW),
    urgency: "high",
    topic: "house",
    note: { title: "Your house has not signed yet today", body: HOUSE_BODY, tag: "house" },
  },
  houseTwo: {
    msg: { k: "house", close: CLOSE, n: 1, of: 2 },
    ttl: String(CLOSE - NOW),
    urgency: "high",
    topic: "house",
    note: { title: "1 of your 2 houses have not signed yet today", body: HOUSE_BODY, tag: "house" },
  },
  pause: {
    msg: { k: "pause" },
    ttl: "43200",
    urgency: "high",
    topic: "house",
    note: {
      title: "6529 Town",
      body: "Your house has not signed for 3 days. The bell stays quiet until it signs again.",
      tag: "house",
    },
  },
  empty: {
    msg: { k: "empty" },
    ttl: "43200",
    urgency: "high",
    topic: "empty",
    note: { title: "Your house is empty today", body: "Your validator is not taking part today.", tag: "empty" },
  },
  version17: {
    msg: { k: "version", v: "rc.17" },
    ttl: "43200",
    urgency: "high",
    topic: "version",
    note: { title: "New validator version: rc.17", body: VERSION_BODY, tag: "version" },
  },
};
const pushOf = (kind) => ({ msg: KIND[kind].msg, ttl: KIND[kind].ttl, urgency: KIND[kind].urgency, topic: KIND[kind].topic });
const noteOf = (kind) => ({ ...KIND[kind].note, icon: ICON, badge: BADGE });

// ---------- the town page (synthetic) ----------
// 40 houses, 6 days: indexes 0..4 are final, 5 is today. Bit 8 (0x80) set = signed, other non-zero byte = on
// the roster but not signed, 0x00 = not on the roster (empty); the low 7 bits vary per house and day.
// Houses 7 and 8 are ONE wallet group; every other house is alone.
//   house 3   unsigned today                          -> house note [1,1]
//   house 7   unsigned today, group with house 8      -> house note [1,2] for 7 AND 8
//   house 12  signed                                  -> nothing
//   house 15  empty today, on the roster on F[-1]     -> empty note
//   house 20  unsigned on the last 3 final days       -> pause note
//   house 25  unsigned on the last 4 final days       -> silent
//   house 30  empty today and on F[-1]                -> nothing (not a new "empty")
//   house 40  first day is today, unsigned            -> nothing (new house)
// Today: 38 taking, 33 signed (0.87); last final day: 38 taking, 36 signed (0.95 - 0.10 <= 0.87).

const N_HOUSES = 40;
const SIGNED = 0x81;
const UNSIGNED = 0x01;
const OUT = 0x00;
const TODAY_IDX = 5;

function stamp(sec) {
  const s = new Date(sec * 1000).toISOString();
  return s.slice(0, 4) + s.slice(5, 7) + s.slice(8, 10) + "T" + s.slice(11, 13) + s.slice(14, 16) + "Z";
}
function dateOf(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function townData(release) {
  const rows = Array.from({ length: TODAY_IDX + 1 }, () => new Uint8Array(N_HOUSES).fill(SIGNED));
  const put = (house, days, v) => {
    for (const j of days) rows[j][house - 1] = v;
  };
  put(3, [5], UNSIGNED);
  put(7, [5], UNSIGNED);
  put(15, [5], OUT);
  put(20, [2, 3, 4, 5], UNSIGNED);
  put(25, [1, 2, 3, 4, 5], UNSIGNED);
  put(30, [4, 5], OUT);
  put(40, [0, 1, 2, 3, 4], OUT);
  put(40, [5], UNSIGNED);
  // SPEC 7.1 only fixes 0 (empty) and bit 8 (signed); the other 7 bits may hold anything. Vary them per house
  // and day (same facts), so a test of the whole byte (== 0x81, == 0x01) instead of bit 8 can not pass.
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) if (row[i] !== OUT) row[i] = (row[i] & 0x80) | (1 + ((i * 5 + j * 3) % 127));
  });
  const list = [];
  for (let h = 1; h <= N_HOUSES; h++) list.push([h === 40 ? TODAY_IDX : 0, 0, h === 7 || h === 8 ? 5 : 100 + h]);
  const days = rows.map((_, j) => {
    const cd = DAY - TODAY_IDX + j;
    const final = j < TODAY_IDX;
    return { cycle_day: cd, final, captured: final ? stamp(cd * 86400 + 85800) : stamp(NOW - 1200) };
  });
  return {
    days,
    homes: { days: rows.map((r) => Buffer.from(r).toString("base64")), list },
    releases: [release, ["rc.16", dateOf(DAY - 9)]],
  };
}

function pageHtml(data) {
  return (
    "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>town</title></head><body>\n<script>\n" +
    "var DATA = " +
    JSON.stringify(data) +
    ";\n</script>\n</body></html>\n"
  );
}

// ---------- secrets that must never show up in a worker answer ----------

const SECRETS = new Set();
const secret = (s) => (SECRETS.add(s), s);
const rnd = (n) => toB64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const RING_KEY = secret(rnd(36));
let VAPID_JWK = "";
let VAPID_PUB = "";

const ANSWER_KEYS = new Set(["ok", "active", "matched", "sent", "gone", "denied", "failed", "after", "more", "removed"]);

// Every worker answer: fixed headers, no CORS, empty 204/404, otherwise JSON with count keys only, and
// never an endpoint, key, id or address-like text.
async function look(res) {
  assert.ok(res instanceof Response, "worker gives a Response");
  const h = res.headers;
  assert.equal(h.get("cache-control"), "no-store");
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("x-town-api"), "1");
  for (const [k] of h) assert.ok(!k.startsWith("access-control-"), "no CORS header");
  const text = await res.text();
  if (res.status === 204 || res.status === 404) {
    assert.equal(text, "");
    assert.equal(h.get("content-type"), null);
  } else {
    assert.equal(h.get("content-type"), "application/json");
  }
  for (const s of SECRETS) assert.ok(!text.includes(s), "answer holds a secret value");
  assert.doesNotMatch(text, /https?:/i);
  assert.doesNotMatch(text, /[0-9a-f]{64}/i);
  assert.doesNotMatch(text, /[A-Za-z0-9_-]{22,}/);
  let body = null;
  if (text !== "") {
    body = JSON.parse(text);
    assert.ok(body && typeof body === "object" && !Array.isArray(body));
    for (const [k, v] of Object.entries(body)) {
      assert.ok(ANSWER_KEYS.has(k), "unknown answer key " + k);
      assert.ok(typeof v === "boolean" || Number.isInteger(v), "answer value is a count or bool");
    }
  }
  return { status: res.status, body };
}

// ---------- test browsers: push subscription keys + their own sw.js in node:vm ----------

function loadSw() {
  const rec = { listeners: new Map(), notes: [], opened: [], focused: [], windows: [], skip: 0, claim: 0 };
  class FixedDate extends Date {
    static now() {
      return NOW_MS;
    }
  }
  const g = {};
  vm.createContext(g);
  Object.assign(g, {
    self: g,
    Date: FixedDate,
    addEventListener(type, fn) {
      if (!rec.listeners.has(type)) rec.listeners.set(type, []);
      rec.listeners.get(type).push(fn);
    },
    skipWaiting() {
      rec.skip++;
      return Promise.resolve();
    },
    registration: {
      scope: SCOPE,
      showNotification(title, opts) {
        // copy out of the vm realm
        rec.notes.push(JSON.parse(JSON.stringify({ title, ...opts })));
        return Promise.resolve();
      },
    },
    clients: {
      claim() {
        rec.claim++;
        return Promise.resolve();
      },
      matchAll() {
        return Promise.resolve(rec.windows.slice());
      },
      openWindow(url) {
        rec.opened.push(url);
        return Promise.resolve(null);
      },
    },
  });
  vm.runInContext(SW_TEXT, g, { filename: "sw.js" });
  const fire = async (type, event) => {
    const waits = [];
    const ev = { ...event, waitUntil: (p) => waits.push(p) };
    for (const fn of rec.listeners.get(type) || []) fn(ev);
    await Promise.all(waits);
    return waits.length;
  };
  return { rec, fire };
}

const browsers = new Map(); // endpoint -> browser
const problems = []; // anything wrong the fake push service saw (a throw inside fetch would only become status 0)
const unexpected = [];

async function makeBrowser(label, h, host, path) {
  const receiver = await makeReceiver();
  const e = secret("https://" + host + path + rnd(24));
  const sw = loadSw();
  await sw.fire("install", {});
  await sw.fire("activate", {});
  const b = {
    label,
    h,
    e,
    p: secret(receiver.p),
    a: secret(receiver.a),
    id: secret(sha256hex(e)),
    receiver,
    sw,
    pushes: [],
    status: 201,
  };
  browsers.set(e, b);
  return b;
}

// What a browser does with one delivered push: hand the decrypted text to its service worker.
async function deliver(b, text) {
  const n = await b.sw.fire("push", { data: { text: () => text, json: () => JSON.parse(text) } });
  if (n !== 1) problems.push(b.label + ": sw.js called waitUntil " + n + " times");
}

// ---------- fake push service (the global fetch) ----------

async function checkVapid(url, auth) {
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(auth || "");
  assert.ok(m, "Authorization is 'vapid t=<jwt>, k=<key>'");
  assert.equal(m[4], VAPID_PUB, "k= is the worker's VAPID public key");
  assert.deepEqual(JSON.parse(td.decode(fromB64u(m[1]))), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(td.decode(fromB64u(m[2])));
  assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "sub"]);
  assert.equal(claims.aud, new URL(url).origin);
  assert.equal(claims.sub, "https://6529town.com");
  assert.ok(Number.isInteger(claims.exp) && claims.exp - NOW > 3600 && claims.exp - NOW <= 43200, "exp on the test clock");
  const key = await crypto.subtle.importKey("raw", fromB64u(m[4]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const sig = fromB64u(m[3]);
  assert.equal(sig.length, 64, "raw r|s signature");
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, te.encode(m[1] + "." + m[2]));
  assert.ok(ok, "JWT signature verifies with k=");
}

async function fakePushService(input, init) {
  const url = typeof input === "string" ? input : String(input && input.url);
  const b = browsers.get(url);
  if (!b) {
    unexpected.push(url.length);
    return new Response(null, { status: 404 });
  }
  let text;
  try {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal, "request has a timeout signal");
    const h = new Headers(init.headers);
    assert.equal(h.get("content-encoding"), "aes128gcm");
    assert.equal(h.get("content-type"), "application/octet-stream");
    await checkVapid(url, h.get("authorization"));
    assert.ok(init.body instanceof Uint8Array, "body is bytes");
    text = td.decode(await decryptPush(init.body, b.receiver));
    b.pushes.push({ msg: JSON.parse(text), ttl: h.get("ttl"), urgency: h.get("urgency"), topic: h.get("topic") });
  } catch (err) {
    problems.push(b.label + ": " + (err && err.message ? err.message : String(err)));
    return new Response(null, { status: 500 });
  }
  if (b.status >= 200 && b.status <= 202) await deliver(b, text);
  return new Response(null, { status: b.status });
}

function noProblems() {
  assert.deepEqual(problems, [], "fake push service problems");
  assert.deepEqual(unexpected, [], "push to an unknown address");
}

// ---------- requests as the page and bell-ring.py send them ----------

function pubReq(method, obj) {
  const text = JSON.stringify(obj);
  return new Request(ORIGIN + "/api/bell", {
    method,
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "content-length": String(te.encode(text).length),
    },
    body: text,
  });
}

function ringReq(obj) {
  const text = JSON.stringify(obj);
  return new Request(ORIGIN + "/api/bell/ring", {
    method: "POST",
    headers: {
      "x-bell-key": RING_KEY,
      "user-agent": "6529town-bell/1 (+https://6529town.com)",
      "content-type": "application/json",
      "content-length": String(te.encode(text).length),
    },
    body: text,
  });
}

// ---------- shared rig ----------

const realFetch = globalThis.fetch;
const realNow = Date.now;
let dir = "";
let worker = null;
let mod = null;
let db = null;
let env = null;
const F = {};

async function send(req) {
  return look(await worker.fetch(req, env, CTX));
}

function runRing(extra = [], conf = F.conf) {
  const args = ["-I", RING_PY, "--page", F.page, "--state", F.state, "--conf", conf, "--stop", F.stop];
  args.push("--now", String(NOW), "--fake", ...extra);
  const out = execFileSync("python3", args, {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  const lines = out.split("\n").filter((l) => l !== "");
  const summary = lines.pop();
  assert.match(summary, /^bell: /);
  const reqs = lines.map((l) => {
    const o = JSON.parse(l);
    assert.deepEqual(Object.keys(o), ["req"], "every other line is one {\"req\": ...}");
    return o.req;
  });
  return { reqs, summary };
}

// Closed loop: run the script from the same seed state with the worker's real answers so far; replay the
// first request it has no answer for; repeat until a run prints no new request. The last run's state file
// is what a real run would have saved.
async function ringLoop(seedState, conf = F.conf) {
  const answers = [];
  const statuses = [];
  let prev = [];
  for (let i = 0; i < 40; i++) {
    writeFileSync(F.state, JSON.stringify(seedState));
    writeFileSync(F.answers, JSON.stringify(answers));
    const run = runRing(["--fake-answers", F.answers], conf);
    assert.deepEqual(run.reqs.slice(0, answers.length), prev.slice(0, answers.length), "the script is deterministic");
    if (run.reqs.length === answers.length) return { reqs: run.reqs, answers, statuses, summary: run.summary };
    const res = await send(ringReq(run.reqs[answers.length]));
    statuses.push(res.status);
    answers.push(res.body);
    prev = run.reqs;
  }
  throw new Error("the ring loop did not settle");
}

function bellRows() {
  return db.sql.prepare("SELECT rowid AS rid, id, e, p, a, h, c, t, hd, ed, vl, vt FROM bells ORDER BY rowid").all();
}

const PLAN = [
  { label: "house 3, first browser", h: 3, host: "fcm.googleapis.com", path: "/fcm/send/", ring: ["houseOne"] },
  { label: "house 3, second browser", h: 3, host: "updates.push.services.mozilla.com", path: "/wpush/v2/", ring: ["houseOne"] },
  { label: "house 7 (group, unsigned)", h: 7, host: "fcm.googleapis.com", path: "/fcm/send/", ring: ["houseTwo"] },
  { label: "house 8 (group, signed)", h: 8, host: "web.push.apple.com", path: "/", ring: ["houseTwo"] },
  { label: "house 12 (signed)", h: 12, host: "wns2-db5p.notify.windows.com", path: "/w/", ring: [] },
  { label: "house 15 (empty today)", h: 15, host: "fcm.googleapis.com", path: "/fcm/send/", ring: ["empty"] },
  { label: "house 20 (3 days unsigned)", h: 20, host: "updates.push.services.mozilla.com", path: "/wpush/v2/", ring: ["pause"] },
  { label: "house 25 (4 days unsigned)", h: 25, host: "fcm.googleapis.com", path: "/fcm/send/", ring: [] },
];
const B = [];
const SEED = { version_sent: "rc.16", version_seen: { v: "rc.17", first: NOW - 7201 } };
let ring1 = null;
let finalState = null;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bell-e2e-"));
  F.worker = join(dir, "worker.mjs");
  F.page = join(dir, "index.html");
  F.state = join(dir, "state.json");
  F.conf = join(dir, "bell.json");
  F.stop = join(dir, "bell.STOP"); // never created
  F.noConf = join(dir, "missing-bell.json"); // never created: every part is "dry"
  F.answers = join(dir, "answers.json");
  copyFileSync(BUNDLE, F.worker);
  writeFileSync(F.page, pageHtml(townData(["rc.17", dateOf(DAY)])));
  writeFileSync(F.conf, JSON.stringify({ house: "live", version: "live", empty: "live" }));

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const j = await crypto.subtle.exportKey("jwk", pair.privateKey);
  secret(j.d);
  VAPID_JWK = secret(JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d }));
  VAPID_PUB = toB64u(new Uint8Array([4, ...fromB64u(j.x), ...fromB64u(j.y)]));

  Date.now = () => NOW_MS;
  globalThis.fetch = fakePushService;
  mod = await import(pathToFileURL(F.worker).href);
  worker = mod.default;
  db = makeFakeD1();
  env = {
    DB: db,
    ASSETS: { fetch: async () => new Response("static page", { status: 200 }) },
    BELL_HOST: HOST,
    VAPID_JWK,
    RING_KEY,
  };
});

after(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  if (db) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// =================================================================================================

describe("e2e: bundled worker + fake D1 + fake push service + sw.js + bell-ring.py --fake", () => {
  test("the bundle loads as a module, exports only default.fetch, and routes like main.js", async () => {
    assert.deepEqual(Object.keys(mod), ["default"]);
    assert.equal(typeof worker.fetch, "function");
    const page = await worker.fetch(new Request(ORIGIN + "/"), env, CTX);
    assert.equal(await page.text(), "static page");
    const other = await worker.fetch(new Request(ORIGIN + "/api/bellx"), env, CTX);
    assert.equal(await other.text(), "static page");
    const get = await send(new Request(ORIGIN + "/api/bell"));
    assert.equal(get.status, 404);
    noProblems();
  });

  test("init -> page-style POST -> one push that decrypts to {\"k\":\"test\"} -> sw.js shows the test note", async () => {
    const init = await send(ringReq({ op: "init" }));
    assert.deepEqual(init, { status: 200, body: { ok: true } });
    const tables = db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(tables.map((r) => r.name), ["bells", "meta"]);

    const p = PLAN[0];
    const b = await makeBrowser(p.label, p.h, p.host, p.path);
    B.push(b);
    const on = await send(pubReq("POST", { e: b.e, p: b.p, a: b.a, h: b.h }));
    assert.deepEqual(on, { status: 200, body: { ok: true } });
    noProblems();
    assert.deepEqual(b.pushes, [pushOf("test")]);
    assert.deepEqual(b.sw.rec.notes, [noteOf("test")]);

    const rows = bellRows();
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { id: rows[0].id, e: rows[0].e, p: rows[0].p, a: rows[0].a, h: rows[0].h, c: rows[0].c, t: rows[0].t },
      { id: b.id, e: b.e, p: b.p, a: b.a, h: 3, c: DAY, t: DAY },
    );
    assert.deepEqual([rows[0].hd, rows[0].ed, rows[0].vl, rows[0].vt], [0, 0, "", 0]);

    // a tap on the note opens the town page (scope), never anything from the payload
    let closed = 0;
    const n = await b.sw.fire("notificationclick", { notification: { close: () => closed++ } });
    assert.equal(n, 1);
    assert.equal(closed, 1);
    assert.deepEqual(b.sw.rec.opened, [SCOPE]);
  });

  test("the same browser sends its bell again (same keys): row refreshed, no second push", async () => {
    const b = B[0];
    const again = await send(pubReq("POST", { e: b.e, p: b.p, a: b.a, h: b.h }));
    assert.deepEqual(again, { status: 200, body: { ok: true } });
    assert.equal(b.pushes.length, 1);
    assert.equal(bellRows().length, 1);
    noProblems();
  });

  test("seven more browsers turn their bell on: each gets exactly one test note", async () => {
    for (const p of PLAN.slice(1)) {
      const b = await makeBrowser(p.label, p.h, p.host, p.path);
      B.push(b);
      const on = await send(pubReq("POST", { e: b.e, p: b.p, a: b.a, h: b.h }));
      assert.deepEqual(on, { status: 200, body: { ok: true } }, p.label);
      assert.deepEqual(b.pushes, [pushOf("test")], p.label);
      assert.deepEqual(b.sw.rec.notes, [noteOf("test")], p.label);
    }
    noProblems();
    const rows = bellRows();
    assert.deepEqual(rows.map((r) => r.h), PLAN.map((p) => p.h));
    assert.deepEqual(rows.map((r) => r.id), B.map((b) => b.id));
    const count = await send(ringReq({ op: "count", hs: [3] }));
    assert.deepEqual(count.body, { ok: true, active: 8, matched: 2 });
  });

  test("conf file missing = dry: the same day replayed into the worker gives counts only, no push, no mark", async () => {
    const before = B.map((b) => b.pushes.length);
    const r = await ringLoop(SEED, F.noConf);
    noProblems();
    assert.deepEqual(B.map((b) => b.pushes.length), before, "no push in dry");
    const walk = { after: 0, lim: 6, dry: true };
    assert.deepEqual(r.reqs, [
      { op: "count", hs: [3, 7, 8] },
      { op: "alert", k: "house", day: DAY, close: CLOSE, m: { 3: [1, 1], 7: [1, 2], 8: [1, 2] }, ...walk },
      { op: "count", hs: [20] },
      { op: "alert", k: "pause", day: DAY, m: { 20: [1, 1] }, ...walk },
      { op: "count", hs: [15] },
      { op: "alert", k: "empty", day: DAY, m: { 15: [1, 1] }, ...walk },
      { op: "version", v: "rc.17", ...walk },
      { op: "prune" },
    ]);
    const last = bellRows().at(-1).rid;
    const dry = (matched) => ({ ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched, after: last, more: false });
    assert.deepEqual(r.answers, [
      { ok: true, active: 8, matched: 4 },
      dry(4),
      { ok: true, active: 8, matched: 1 },
      dry(1),
      { ok: true, active: 8, matched: 1 },
      dry(1),
      dry(8),
      { ok: true, removed: 0 },
    ]);
    assert.match(r.summary, /^bell: house dry unsigned=4 alert=2 pause=1 silent=1 groups=2 matched=4 active=8 hit=5 \| /);
    assert.match(r.summary, /\| version dry hit=8 \| empty dry houses=1 matched=1 active=8 hit=1 \| prune removed=0$/);
    assert.ok(bellRows().every((row) => row.hd === 0 && row.ed === 0 && row.vl === "" && row.vt === 0), "no row marked");
  });

  test("bell-ring.py --fake on the synthetic day, replayed into the worker: the exact requests and answers", async () => {
    for (const b of B) b.mark = { pushes: b.pushes.length, notes: b.sw.rec.notes.length };
    ring1 = await ringLoop(SEED);
    finalState = JSON.parse(readFileSync(F.state, "utf8"));
    noProblems();
    const rid = bellRows().map((r) => r.rid);
    const walk = { after: 0, lim: 6, dry: false };
    assert.deepEqual(ring1.reqs, [
      { op: "count", hs: [3, 7, 8] },
      { op: "alert", k: "house", day: DAY, close: CLOSE, m: { 3: [1, 1], 7: [1, 2], 8: [1, 2] }, ...walk },
      { op: "count", hs: [20] },
      { op: "alert", k: "pause", day: DAY, m: { 20: [1, 1] }, ...walk },
      { op: "count", hs: [15] },
      { op: "alert", k: "empty", day: DAY, m: { 15: [1, 1] }, ...walk },
      { op: "version", v: "rc.17", ...walk },
      { op: "version", v: "rc.17", ...walk, after: rid[5] },
      { op: "prune" },
    ]);
    assert.deepEqual(ring1.statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200]);
    const tally = (sent, matched, after, more) => ({ ok: true, sent, gone: 0, denied: 0, failed: 0, matched, after, more });
    assert.deepEqual(ring1.answers, [
      { ok: true, active: 8, matched: 4 },
      tally(4, 4, rid[7], false),
      { ok: true, active: 8, matched: 1 },
      tally(1, 1, rid[7], false),
      { ok: true, active: 8, matched: 1 },
      tally(1, 1, rid[7], false),
      tally(6, 6, rid[5], true),
      tally(2, 2, rid[7], false),
      { ok: true, removed: 0 },
    ]);
    const parts = ring1.summary.slice("bell: ".length).split(" | ");
    assert.equal(parts.length, 4, ring1.summary);
    assert.match(parts[0], /^house live unsigned=4 alert=2 pause=1 silent=1 groups=2 matched=4 active=8 /);
    assert.match(parts[0], / hit=5 sent=5 gone=0 denied=0 failed=0$/);
    assert.match(parts[1], /^version live hit=8 sent=8 gone=0 denied=0 failed=0$/);
    assert.match(parts[2], /^empty live houses=1 matched=1 active=8 hit=1 sent=1 gone=0 denied=0 failed=0$/);
    assert.equal(parts[3], "prune removed=0");
    assert.deepEqual(
      { house_day: finalState.house_day, empty_day: finalState.empty_day, pruned_day: finalState.pruned_day },
      { house_day: DAY, empty_day: DAY, pruned_day: DAY },
    );
    assert.equal(finalState.version_sent, "rc.17");
  });

  test("the right bells got the right text, the others nothing (besides the version note for every bell)", () => {
    assert.ok(ring1, "ring replay ran");
    PLAN.forEach((p, i) => {
      const b = B[i];
      const kinds = [...p.ring, "version17"];
      assert.deepEqual(b.pushes.slice(b.mark.pushes), kinds.map(pushOf), p.label + ": pushes");
      assert.deepEqual(b.sw.rec.notes.slice(b.mark.notes), kinds.map(noteOf), p.label + ": notes");
    });
    noProblems();
  });

  test("D1 rows after the ring: day marks only on the bells that got a note, version marks on all", () => {
    const rows = bellRows();
    assert.equal(rows.length, PLAN.length);
    PLAN.forEach((p, i) => {
      const r = rows[i];
      const houseNote = p.ring.some((k) => k === "houseOne" || k === "houseTwo" || k === "pause");
      assert.deepEqual(
        { h: r.h, c: r.c, t: r.t, hd: r.hd, ed: r.ed, vl: r.vl, vt: r.vt },
        { h: p.h, c: DAY, t: DAY, hd: houseNote ? DAY : 0, ed: p.ring.includes("empty") ? DAY : 0, vl: "rc.17", vt: NOW },
        p.label,
      );
    });
  });

  test("second replay of the same requests sends nothing", async () => {
    const before = B.map((b) => b.pushes.length);
    const answers = [];
    for (const req of ring1.reqs) {
      const res = await send(ringReq(req));
      assert.equal(res.status, 200);
      answers.push(res.body);
    }
    assert.deepEqual(B.map((b) => b.pushes.length), before, "no push at all");
    noProblems();
    for (let i = 0; i < answers.length; i++) {
      const op = ring1.reqs[i].op;
      if (op === "count") assert.deepEqual(answers[i], ring1.answers[i], "count answers are the same");
      if (op === "alert" || op === "version") {
        assert.equal(answers[i].sent, 0);
        assert.equal(answers[i].matched, 0);
        assert.equal(answers[i].more, false);
      }
      if (op === "prune") assert.deepEqual(answers[i], { ok: true, removed: 0 });
    }
  });

  test("a second script run on the saved state (same day) prints no request at all", () => {
    writeFileSync(F.state, JSON.stringify(finalState));
    const run = runRing();
    assert.deepEqual(run.reqs, []);
    assert.equal(run.summary, "bell: house live done | version none | empty live done | prune done");
  });

  test("version path: a newer version within 72 h of the last version note -> the worker sends nothing", async () => {
    writeFileSync(F.page, pageHtml(townData(["rc.18", dateOf(DAY)])));
    const seed = { ...finalState, version_seen: { v: "rc.18", first: NOW - 7201 } };
    const before = B.map((b) => b.pushes.length);
    const r = await ringLoop(seed);
    assert.deepEqual(r.reqs, [{ op: "version", v: "rc.18", after: 0, lim: 6, dry: false }]);
    assert.deepEqual(r.answers, [
      { ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched: 0, after: 0, more: false },
    ]);
    assert.deepEqual(B.map((b) => b.pushes.length), before, "no push");
    assert.match(r.summary, /\| version live hit=0 sent=0 gone=0 denied=0 failed=0 \|/);
    // SPEC 7.5: the loop ended with more=false, so the script counts rc.18 as sent (see notes/J.md, open).
    assert.equal(JSON.parse(readFileSync(F.state, "utf8")).version_sent, "rc.18");
    assert.ok(bellRows().every((row) => row.vl === "rc.17" && row.vt === NOW));
    noProblems();
  });

  test("DELETE with a wrong auth keeps the row; DELETE with the right one removes it", async () => {
    const b = B[1];
    const other = B[0];
    const pushesBefore = b.pushes.length;
    const wrong = await send(pubReq("DELETE", { e: b.e, a: other.a }));
    assert.deepEqual(wrong, { status: 204, body: null });
    assert.equal(bellRows().length, PLAN.length);
    const off = await send(pubReq("DELETE", { e: b.e, a: b.a }));
    assert.deepEqual(off, { status: 204, body: null });
    const rows = bellRows();
    assert.equal(rows.length, PLAN.length - 1);
    assert.ok(!rows.some((r) => r.id === b.id), "row gone");
    assert.ok(rows.some((r) => r.id === other.id), "the other bell on the same house stays");
    const count = await send(ringReq({ op: "count", hs: [3] }));
    assert.deepEqual(count.body, { ok: true, active: 7, matched: 1 });
    assert.equal(b.pushes.length, pushesBefore, "turning off sends no push");
    noProblems();
  });
});
