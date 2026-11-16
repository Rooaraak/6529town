// Tests for worker/src/api.js, worker/src/main.js, the bundle worker/_worker.js and test/fake-d1.mjs
// (owner W2). Run: nice -n 10 node --test test/api.test.mjs
// No network: the push sender is a fake passed into makeHandler; the bundle test puts a fake
// global fetch in place for its few requests. Every value below is synthetic and made at run time.
//
// EVERY handler answer goes through look(): fixed headers, empty 204/404, JSON otherwise, the body
// holds only known count keys with boolean/integer values, and no endpoint, key or id appears in it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { makeHandler } from "../worker/src/api.js";
import { bytesToB64u } from "../worker/src/push.js";
import { makeFakeD1 } from "./fake-d1.mjs";

const HOST = "6529town.com";
const ORIGIN = "https://" + HOST;
const URL_BELL = ORIGIN + "/api/bell";
const URL_RING = ORIGIN + "/api/bell/ring";
const T0 = Date.UTC(2026, 10, 13, 15, 0, 0); // ms, 15:00 UTC
const DAY = Math.floor(T0 / 86400000);
const CLOSE = DAY * 86400 + 68400; // 19:00 UTC of DAY
const CTX = { waitUntil() {}, passThroughOnException() {} };
const te = new TextEncoder();

// ---------- secrets that must never be in an answer ----------

const SECRETS = new Set();
function secret(s) {
  SECRETS.add(s);
  return s;
}
function rnd(n) {
  return bytesToB64u(crypto.getRandomValues(new Uint8Array(n)));
}
function sha256hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const RING_KEY = secret(rnd(36)); // 48 chars
const VAPID_JWK = await (async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const j = await crypto.subtle.exportKey("jwk", pair.privateKey);
  secret(j.d);
  return JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d });
})();
SECRETS.add(VAPID_JWK);

const ANSWER_KEYS = new Set(["ok", "active", "matched", "sent", "gone", "denied", "failed", "after", "more", "removed"]);

async function look(res) {
  assert.ok(res instanceof Response, "handler gives a Response");
  const h = res.headers;
  assert.equal(h.get("cache-control"), "no-store");
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("x-town-api"), "1");
  for (const [k] of h) assert.ok(!k.startsWith("access-control-"), "no CORS header: " + k);
  const text = await res.text();
  if (res.status === 204 || res.status === 404) {
    assert.equal(text, "", "empty " + res.status);
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
      assert.ok(typeof v === "boolean" || Number.isInteger(v), "answer value of " + k + " is a count or bool");
    }
    assert.equal(body.ok, res.status === 200, "ok true only on 200");
  }
  return { status: res.status, body, text, headers: [...h].sort((x, y) => (x[0] < y[0] ? -1 : 1)) };
}

// ---------- rig: fake D1 + fake push sender + clock ----------

function makeRig() {
  const db = makeFakeD1();
  const env = { DB: db, BELL_HOST: HOST, VAPID_JWK, RING_KEY };
  const pushes = [];
  const push = { status: 201, byEndpoint: new Map(), throwFor: new Set() };
  let clock = T0;
  const sendPush = async (envArg, sub, msg, opt, deps) => {
    pushes.push({ env: envArg, sub: { ...sub }, msg: JSON.parse(JSON.stringify(msg)), opt: { ...opt }, deps });
    if (push.throwFor.has(sub.e)) throw new Error("fake push blew up");
    const s = push.byEndpoint.has(sub.e) ? push.byEndpoint.get(sub.e) : push.status;
    return s === "undefined" ? undefined : { status: s };
  };
  const handler = makeHandler({ sendPush, now: () => clock });
  const rig = {
    db,
    env,
    pushes,
    push,
    handler,
    stats: { maxStatements: 0, maxPushes: 0, requests: 0 },
    get now() {
      return clock;
    },
    set now(v) {
      clock = v;
    },
    get day() {
      return Math.floor(clock / 86400000);
    },
    async send(req, envArg) {
      db.resetCount();
      const before = pushes.length;
      const res = await handler(req, envArg === undefined ? env : envArg, CTX);
      const out = await look(res);
      out.statements = db.statements;
      out.batches = db.batches;
      out.pushes = pushes.length - before;
      // free-plan budget per request (SPEC 5.7)
      assert.ok(out.statements <= 12, "at most 12 D1 statements, got " + out.statements);
      assert.ok(out.pushes <= 8, "at most 8 pushes, got " + out.pushes);
      rig.stats.maxStatements = Math.max(rig.stats.maxStatements, out.statements);
      rig.stats.maxPushes = Math.max(rig.stats.maxPushes, out.pushes);
      rig.stats.requests++;
      return out;
    },
    ring(body, o) {
      return rig.send(ringReq(body, o));
    },
    post(body, o) {
      return rig.send(pubReq("POST", body, o));
    },
    del(body, o) {
      return rig.send(pubReq("DELETE", body, o));
    },
    async init() {
      const r = await rig.ring({ op: "init" });
      assert.equal(r.status, 200);
      return r;
    },
    rows() {
      return db.sql.prepare("SELECT rowid AS rid, * FROM bells ORDER BY rowid").all().map((r) => ({ ...r }));
    },
    row(id) {
      const r = db.sql.prepare("SELECT rowid AS rid, * FROM bells WHERE id = ?").get(id);
      return r ? { ...r } : null;
    },
    meta(k) {
      const r = db.sql.prepare("SELECT v FROM meta WHERE k = ?").get(k);
      return r ? r.v : null;
    },
    setMeta(k, v) {
      db.sql.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    },
    // A row put straight into the table (no API, no push); returns it with its rowid.
    seed(fields = {}) {
      const e = secret("https://fcm.googleapis.com/fcm/send/" + rnd(18));
      const row = {
        id: secret(sha256hex(e)),
        e,
        p: secret(rnd(65)),
        a: secret(rnd(16)),
        h: 1,
        c: rig.day,
        t: rig.day,
        hd: 0,
        ed: 0,
        vl: "",
        vt: 0,
        ...fields,
      };
      const info = db.sql
        .prepare("INSERT INTO bells (id, e, p, a, h, c, t, hd, ed, vl, vt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(row.id, row.e, row.p, row.a, row.h, row.c, row.t, row.hd, row.ed, row.vl, row.vt);
      row.rid = Number(info.lastInsertRowid);
      return row;
    },
  };
  return rig;
}

function setHeaders(base, over) {
  const h = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined) delete h[k];
    else h[k] = v;
  }
  return h;
}

// A request like the page sends it. `body` is an object (JSON) or raw text.
function pubReq(method, body, o = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = setHeaders(
    {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "content-length": String(te.encode(text).length),
    },
    o.headers,
  );
  return new Request(o.url || URL_BELL, { method: o.method || method, headers, body: text });
}

// A request like bell-ring.py sends it.
function ringReq(body, o = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = setHeaders(
    {
      "x-bell-key": RING_KEY,
      "content-type": "application/json",
      "content-length": String(te.encode(text).length),
    },
    o.headers,
  );
  return new Request(o.url || URL_RING, { method: o.method || "POST", headers, body: text });
}

function bare(method, url, headers) {
  return new Request(url, { method, headers: headers || {} });
}

// A subscription like a browser makes it: real P-256 public key, random auth, endpoint on an allowed host.
async function newSub(host = "fcm.googleapis.com", h = 12) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const p = secret(bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))));
  const a = secret(rnd(16));
  const e = secret("https://" + host + "/send/" + rnd(18));
  const id = secret(sha256hex(e));
  return { e, p, a, h, id };
}
function onBody(s, h) {
  return { e: s.e, p: s.p, a: s.a, h: h === undefined ? s.h : h };
}
function offBody(s, a) {
  return { e: s.e, a: a === undefined ? s.a : a };
}

function alertBody(over = {}) {
  return { op: "alert", k: "house", day: DAY, close: CLOSE, m: {}, after: 0, lim: 6, dry: false, ...over };
}

// =================================================================================================

describe("fake D1 (shapes close to the D1 client API)", () => {
  test("prepare/bind/first/all/run/raw, RETURNING, meta.changes, last_row_id", async () => {
    const d = makeFakeD1();
    await d.batch([d.prepare("CREATE TABLE m (k TEXT PRIMARY KEY, v INTEGER NOT NULL)")]);
    const add = d.prepare("INSERT INTO m (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING v");
    assert.equal(await add.bind("x").first("v"), 1);
    assert.equal(await add.bind("x").first("v"), 2);
    const r = await add.bind("y").run();
    assert.equal(r.success, true);
    assert.deepEqual(r.results, [{ v: 1 }]);
    assert.equal(r.meta.changes, 1);
    const all = await d.prepare("SELECT k, v FROM m ORDER BY k").all();
    assert.deepEqual(all.results, [
      { k: "x", v: 2 },
      { k: "y", v: 1 },
    ]);
    assert.equal(Object.getPrototypeOf(all.results[0]), Object.prototype);
    assert.equal(all.meta.changes, 0);
    assert.deepEqual(await d.prepare("SELECT k, v FROM m ORDER BY k").raw(), [
      ["x", 2],
      ["y", 1],
    ]);
    assert.equal(await d.prepare("SELECT v FROM m WHERE k = ?").bind("none").first(), null);
    assert.equal(await d.prepare("SELECT v FROM m WHERE k = ?").bind("none").first("v"), null);
    await assert.rejects(d.prepare("SELECT v FROM m").first("nope"), /D1_COLUMN_NOTFOUND/);
    const del = await d.prepare("DELETE FROM m WHERE k = ?").bind("x").run();
    assert.equal(del.meta.changes, 1);
    const ins = await d.prepare("INSERT INTO m (k, v) VALUES ('z', 5)").run();
    assert.equal(typeof ins.meta.last_row_id, "number");
    assert.equal(d.statements, 11);
    assert.equal(d.batches, 1);
    d.close();
  });

  test("bind types, placeholder count, batch is all or nothing, failNext, failWhen, empty batch", async () => {
    const d = makeFakeD1();
    await d.exec("CREATE TABLE m (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    const st = d.prepare("INSERT INTO m (k, v) VALUES (?, ?)");
    assert.throws(() => st.bind("a", undefined), /D1_TYPE_ERROR/);
    assert.throws(() => st.bind("a", {}), /D1_TYPE_ERROR/);
    await assert.rejects(st.bind("a").run(), /parameter bindings/);
    await st.bind("t", true).run();
    assert.equal(await d.prepare("SELECT v FROM m WHERE k = 't'").first("v"), 1);
    await assert.rejects(d.batch([st.bind("b", 1), st.bind("b", 2)]), /D1_ERROR/);
    assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM m").first("n"), 1, "rolled back");
    await assert.rejects(d.batch([]), /D1_ERROR/);
    d.failNext();
    await assert.rejects(d.prepare("SELECT 1 AS one").first(), /D1_ERROR/);
    assert.equal(await d.prepare("SELECT 1 AS one").first("one"), 1, "only the next call fails");
    d.failNext();
    await assert.rejects(d.batch([st.bind("c", 1)]), /D1_ERROR/);
    assert.equal(await d.prepare("SELECT COUNT(*) AS n FROM m WHERE k = 'c'").first("n"), 0);
    d.failWhen(/^DELETE/);
    await assert.rejects(d.prepare("DELETE FROM m").run(), /D1_ERROR/);
    d.failWhen(null);
    await d.prepare("DELETE FROM m").run();
    d.failWhen((sql, values) => sql.startsWith("SELECT v") && values[0] === "bad");
    await assert.rejects(d.prepare("SELECT v FROM m WHERE k = ?").bind("bad").first(), /D1_ERROR/);
    assert.equal(await d.prepare("SELECT v FROM m WHERE k = ?").bind("good").first("v"), null, "the predicate picks by value");
    d.failWhen(null);
    d.resetCount();
    await d.prepare("SELECT v FROM m WHERE k = ?").bind("q").first();
    await d.batch([st.bind("r", 2)]);
    assert.deepEqual(d.log, ["SELECT v FROM m WHERE k = ?", "INSERT INTO m (k, v) VALUES (?, ?)"]);
    assert.deepEqual(d.args, [["q"], ["r", 2]], "bound values of each statement, same order as log");
    d.close();
  });
});

describe("environment (SPEC 5.1)", () => {
  test("DB, BELL_HOST or VAPID_JWK missing -> 503 on every /api/bell* call, before anything else", async () => {
    const r = makeRig();
    const s = await newSub();
    const broken = [
      { BELL_HOST: HOST, VAPID_JWK, RING_KEY },
      { DB: {}, BELL_HOST: HOST, VAPID_JWK, RING_KEY },
      { DB: r.db, VAPID_JWK, RING_KEY },
      { DB: r.db, BELL_HOST: "", VAPID_JWK, RING_KEY },
      { DB: r.db, BELL_HOST: HOST, RING_KEY },
      { DB: r.db, BELL_HOST: HOST, VAPID_JWK: "", RING_KEY },
    ];
    for (const env of [...broken, undefined, null]) {
      const reqs = [
        pubReq("POST", onBody(s)),
        pubReq("DELETE", offBody(s)),
        ringReq({ op: "init" }),
        bare("GET", URL_BELL),
        bare("OPTIONS", URL_RING),
        bare("GET", "https://evil.example/api/bell"),
      ];
      for (const req of reqs) {
        const out = await r.send(req, env === undefined ? {} : env);
        assert.equal(out.status, 503);
        assert.deepEqual(out.body, { ok: false });
        assert.equal(out.statements, 0);
        assert.equal(out.pushes, 0);
      }
    }
  });

  test("RING_KEY missing or shorter than 32 chars -> ring answers 404, public routes still work", async () => {
    const r = makeRig();
    await r.init();
    for (const key of [undefined, "", "k".repeat(31)]) {
      const env = { ...r.env, RING_KEY: key };
      const out = await r.send(ringReq({ op: "count", hs: [] }, { headers: { "x-bell-key": key || "" } }), env);
      assert.equal(out.status, 404);
      assert.equal(out.statements, 0);
      const s = await newSub();
      const ok = await r.send(pubReq("POST", onBody(s)), env);
      assert.equal(ok.status, 200);
    }
    const env32 = { ...r.env, RING_KEY: "k".repeat(32) };
    const out = await r.send(ringReq({ op: "count", hs: [] }, { headers: { "x-bell-key": "k".repeat(32) } }), env32);
    assert.equal(out.status, 200);
  });

  test("makeHandler needs both functions", () => {
    assert.throws(() => makeHandler(), TypeError);
    assert.throws(() => makeHandler({ sendPush: async () => ({ status: 201 }) }), TypeError);
    assert.throws(() => makeHandler({ now: () => 1 }), TypeError);
  });
});

describe("checks of SPEC 5.4, in order, before any D1 call", () => {
  test("public POST: one request failing everything, fixed one check at a time", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    const good = JSON.stringify(onBody(s));
    const steps = [
      // [expected status, env, method, url, headers, body]
      [503, { ...r.env, VAPID_JWK: undefined }, "GET", "https://evil.example/api/bell", {}, null],
      [404, r.env, "GET", "https://evil.example/api/bell", { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" }, null],
      [404, r.env, "GET", URL_BELL, { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" }, null],
      [403, r.env, "POST", URL_BELL, { origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" }, "x".repeat(3000)],
      [403, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "cross-site", "content-type": "text/plain" }, "x".repeat(3000)],
      [415, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "text/plain" }, "x".repeat(3000)],
      [411, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" }, "x".repeat(3000)],
      [413, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "3000" }, "x".repeat(3000)],
      [413, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "20" }, "x".repeat(3000)],
      [400, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "20" }, "x".repeat(20)],
      [400, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "20" }, '{"e":"x","p":"y"}'],
      [400, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "20" }, JSON.stringify({ ...onBody(s), e: "http://fcm.googleapis.com/x" })],
      [400, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "20" }, JSON.stringify({ ...onBody(s), p: s.a })],
      [400, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "20" }, JSON.stringify({ ...onBody(s), a: s.p })],
      [400, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": "20" }, JSON.stringify({ ...onBody(s), h: 0 })],
      [200, r.env, "POST", URL_BELL, { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": String(good.length) }, good],
    ];
    for (const [want, env, method, url, headers, body] of steps) {
      const req = new Request(url, body === null ? { method, headers } : { method, headers, body });
      const out = await r.send(req, env);
      assert.equal(out.status, want, "step expecting " + want + " " + method + " " + url);
      if (want !== 200) {
        assert.equal(out.statements, 0, "no D1 call before the checks pass (" + want + ")");
        assert.equal(out.pushes, 0);
      }
    }
  });

  test("public DELETE: same ladder", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    const good = JSON.stringify(offBody(s));
    const base = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const steps = [
      [404, "https://town-example.pages.dev/api/bell", { ...base, origin: "https://evil.example" }, "x"],
      [403, URL_BELL, { ...base, origin: "https://evil.example", "sec-fetch-site": "same-site", "content-type": "text/plain" }, "x"],
      [403, URL_BELL, { ...base, "sec-fetch-site": "same-site", "content-type": "text/plain" }, "x"],
      [415, URL_BELL, { ...base, "content-type": "text/plain" }, "x"],
      [411, URL_BELL, base, "x"],
      [413, URL_BELL, { ...base, "content-length": "2049" }, "x"],
      [413, URL_BELL, { ...base, "content-length": "1" }, "y".repeat(2049)],
      [400, URL_BELL, { ...base, "content-length": "1" }, "[]"],
      [400, URL_BELL, { ...base, "content-length": "1" }, JSON.stringify({ ...offBody(s), h: 1 })],
      [400, URL_BELL, { ...base, "content-length": "1" }, JSON.stringify(offBody(s, "short"))],
      [204, URL_BELL, { ...base, "content-length": String(good.length) }, good],
    ];
    for (const [want, url, headers, body] of steps) {
      const out = await r.send(new Request(url, { method: "DELETE", headers, body }));
      assert.equal(out.status, want);
      if (want !== 204) assert.equal(out.statements, 0);
    }
  });

  test("ring: host, path, key, content type, size, JSON, op; all before D1", async () => {
    const r = makeRig();
    await r.init();
    const steps = [
      [404, ringReq({ op: "count", hs: [] }, { url: "https://town-example.pages.dev/api/bell/ring", headers: { "x-bell-key": "no", "content-type": "text/plain" } })],
      [404, ringReq({ op: "count", hs: [] }, { method: "PUT", headers: { "x-bell-key": "no", "content-type": "text/plain" } })],
      [404, ringReq({ op: "count", hs: [] }, { headers: { "x-bell-key": "no", "content-type": "text/plain" } })],
      [404, ringReq({ op: "count", hs: [] }, { headers: { "x-bell-key": undefined, "content-type": "text/plain" } })],
      [415, ringReq({ op: "count", hs: [] }, { headers: { "content-type": "text/plain", "content-length": "70000" } })],
      [415, ringReq({ op: "count", hs: [] }, { headers: { "content-type": "application/json; charset=utf-8" } })],
      [413, ringReq({ op: "count", hs: [] }, { headers: { "content-length": "65537" } })],
      [413, ringReq({ op: "count", hs: [] }, { headers: { "content-length": "12abc" } })],
      [413, ringReq('{"op":"count","hs":[],"pad":"' + "z".repeat(65536) + '"}', { headers: { "content-length": undefined } })],
      [400, ringReq("{nope")],
      [400, ringReq("[1,2]")],
      [400, ringReq({ op: "dance" })],
      [400, ringReq({ op: "count" })],
      [400, ringReq({ hs: [] })],
      [200, ringReq('{"op":"count","hs":[],"pad":"' + "z".repeat(60000) + '"}', { headers: { "content-length": undefined } })],
    ];
    for (const [want, req] of steps) {
      const out = await r.send(req);
      assert.equal(out.status, want);
      if (want !== 200) assert.equal(out.statements, 0);
    }
  });

  test("wrong host, unknown path or method -> 404 with no body and no CORS", async () => {
    const r = makeRig();
    await r.init();
    const reqs = [
      ["POST", "https://town-example.pages.dev/api/bell"],
      ["POST", "https://www.6529town.com/api/bell"],
      ["POST", "https://evil.example/api/bell/ring"],
      ["GET", URL_BELL],
      ["HEAD", URL_BELL],
      ["OPTIONS", URL_BELL],
      ["PUT", URL_BELL],
      ["PATCH", URL_BELL],
      ["GET", URL_RING],
      ["DELETE", URL_RING],
      ["OPTIONS", URL_RING],
      ["POST", ORIGIN + "/api/bell/"],
      ["POST", ORIGIN + "/api/bell/ring/"],
      ["POST", ORIGIN + "/api/bell/x"],
      ["POST", ORIGIN + "/api/bellx"],
      ["POST", ORIGIN + "/api/bell/RING"],
    ];
    for (const [method, url] of reqs) {
      const headers = {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "content-type": "application/json",
        "content-length": "2",
        "x-bell-key": RING_KEY,
      };
      const init = method === "GET" || method === "HEAD" ? { method, headers } : { method, headers, body: "{}" };
      const out = await r.send(new Request(url, init));
      assert.equal(out.status, 404, method + " " + url);
      assert.equal(out.statements, 0);
    }
  });

  test("ring without key, with a wrong key, or with the route off: answer identical to an unknown path", async () => {
    const r = makeRig();
    await r.init();
    const unknown = await r.send(ringReq({ op: "init" }, { url: ORIGIN + "/api/bell/nothing" }));
    const variants = [
      ringReq({ op: "init" }, { headers: { "x-bell-key": undefined } }),
      ringReq({ op: "init" }, { headers: { "x-bell-key": "" } }),
      ringReq({ op: "init" }, { headers: { "x-bell-key": RING_KEY.slice(0, -1) } }),
      ringReq({ op: "init" }, { headers: { "x-bell-key": RING_KEY + "x" } }),
      ringReq({ op: "init" }, { headers: { "x-bell-key": RING_KEY.toUpperCase() } }),
      ringReq({ op: "init" }, { headers: { "x-bell-key": "a".repeat(4096) } }),
    ];
    for (const req of variants) {
      const out = await r.send(req);
      assert.deepEqual([out.status, out.headers, out.text], [unknown.status, unknown.headers, unknown.text]);
      assert.equal(out.statements, 0);
    }
    const noKey = await r.send(ringReq({ op: "init" }), { ...r.env, RING_KEY: undefined });
    assert.deepEqual([noKey.status, noKey.headers, noKey.text], [unknown.status, unknown.headers, unknown.text]);
    const wrongHost = await r.send(ringReq({ op: "init" }, { url: "https://evil.example/api/bell/ring" }));
    assert.deepEqual([wrongHost.status, wrongHost.headers, wrongHost.text], [unknown.status, unknown.headers, unknown.text]);
  });

  test("ring key compare uses the whole digest: a wrong key whose SHA-256 starts like the right one's -> 404", async () => {
    const r = makeRig();
    await r.init();
    const unknown = await r.send(ringReq({ op: "init" }, { url: ORIGIN + "/api/bell/nothing" }));
    // Search (about 65536 tries on average, well under a second) for a wrong key whose SHA-256 shares its first
    // 2 bytes with SHA-256(RING_KEY). A compare cut down to 1 or 2 digest bytes would let it in.
    const want = createHash("sha256").update(RING_KEY, "utf8").digest();
    let near = null;
    for (let i = 0; i < 4000000 && near === null; i++) {
      const k = "wrong-ring-key-" + i.toString(36).padStart(18, "0");
      const d = createHash("sha256").update(k, "utf8").digest();
      if (d[0] === want[0] && d[1] === want[1]) near = k;
    }
    assert.ok(near !== null, "a near key was found");
    assert.notEqual(near, RING_KEY);
    for (const body of [{ op: "init" }, { op: "count", hs: [] }, { op: "off", on: true }]) {
      const out = await r.send(ringReq(body, { headers: { "x-bell-key": near } }));
      assert.deepEqual([out.status, out.headers, out.text], [unknown.status, unknown.headers, unknown.text]);
      assert.equal(out.statements, 0);
    }
    assert.equal(r.meta("off"), null);
    // The compare itself (source text): SHA-256 of both sides, all 32 bytes walked, no early exit and no plain
    // compare of the key texts (a plain === also passes every request above, only slower to guess byte by byte).
    const src = await readFile(new URL("../worker/src/api.js", import.meta.url), "utf8");
    const start = src.indexOf("async function bellKeyMatches(given, wanted) {");
    assert.ok(start >= 0, "bellKeyMatches is there");
    const fn = src.slice(start, src.indexOf("\n}\n", start) + 3);
    assert.equal(
      fn,
      "async function bellKeyMatches(given, wanted) {\n" +
        '  const a = await bellSha256(typeof given === "string" ? given : "");\n' +
        "  const b = await bellSha256(wanted);\n" +
        "  let diff = 0;\n" +
        "  for (let i = 0; i < 32; i++) diff |= a[i] ^ b[i];\n" +
        "  return diff === 0;\n" +
        "}\n",
    );
    assert.equal(src.split('request.headers.get("x-bell-key")').length, 2, "the key header is read once");
    assert.match(src, /if \(!\(await bellKeyMatches\(request\.headers\.get\("x-bell-key"\), key\)\)\) return bellNotFound\(\);/);
    assert.doesNotMatch(src, /RING_KEY\s*[!=]==?|[!=]==?\s*(?:env\.)?RING_KEY|\bkey\s*[!=]==?\s*request|given\s*[!=]==?\s*wanted/);
  });

  test("each header check on its own", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    const cases = [
      [403, { origin: undefined }],
      [403, { origin: "null" }],
      [403, { origin: "http://" + HOST }],
      [403, { origin: ORIGIN + "/" }],
      [403, { origin: "https://town-example.pages.dev" }],
      [403, { origin: "https://www." + HOST }],
      [403, { "sec-fetch-site": "cross-site" }],
      [403, { "sec-fetch-site": "same-site" }],
      [403, { "sec-fetch-site": "none" }],
      [403, { "sec-fetch-site": "" }],
      [415, { "content-type": undefined }],
      [415, { "content-type": "application/json; charset=utf-8" }],
      [415, { "content-type": "Application/JSON" }],
      [415, { "content-type": "text/plain" }],
      [411, { "content-length": undefined }],
      [413, { "content-length": "abc" }],
      [413, { "content-length": "-1" }],
      [413, { "content-length": "1.5" }],
      [413, { "content-length": "1e3" }],
      [413, { "content-length": "+10" }],
      [413, { "content-length": "0x10" }],
      [413, { "content-length": "2049" }],
      [413, { "content-length": "99999999999999999999999" }],
    ];
    for (const [want, headers] of cases) {
      const out = await r.post(onBody(s), { headers });
      assert.equal(out.status, want, JSON.stringify(headers));
      assert.equal(out.statements, 0);
    }
    // Sec-Fetch-Site absent is fine (older browsers)
    const ok = await r.post(onBody(s), { headers: { "sec-fetch-site": undefined } });
    assert.equal(ok.status, 200);
  });

  test("body size: 2048 bytes passes the size check, 2049 bytes or multi-byte overflow is 413", async () => {
    const r = makeRig();
    await r.init();
    const fill = (n) => '{"x":"' + "q".repeat(n - 8) + '"}';
    assert.equal(fill(2048).length, 2048);
    let out = await r.post(fill(2048));
    assert.equal(out.status, 400, "right size, wrong keys");
    out = await r.post(fill(2049), { headers: { "content-length": "2048" } });
    assert.equal(out.status, 413);
    const wide = '{"x":"' + "é".repeat(1100) + '"}'; // 1108 chars, 2208 bytes
    out = await r.post(wide, { headers: { "content-length": "1108" } });
    assert.equal(out.status, 413);
    assert.equal(out.statements, 0);
  });

  test("JSON failure or not a plain object -> 400", async () => {
    const r = makeRig();
    await r.init();
    for (const text of ["", "not json", "[]", "null", "1", '"text"', "true", "{", '{"e":1}x']) {
      const out = await r.post(text);
      assert.equal(out.status, 400, JSON.stringify(text));
      assert.equal(out.statements, 0);
    }
  });
});

describe("POST /api/bell: keys and values (SPEC 5.5)", () => {
  test("exact key set {e, p, a, h}", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    const b = onBody(s);
    const bad = [
      { e: b.e, p: b.p, a: b.a },
      { e: b.e, p: b.p, h: b.h },
      { ...b, x: 1 },
      { ...b, k: "test" },
      {},
    ];
    for (const body of bad) {
      const out = await r.post(body);
      assert.equal(out.status, 400);
      assert.deepEqual(out.body, { ok: false });
      assert.equal(out.statements, 0);
    }
    const proto = '{"e":' + JSON.stringify(b.e) + ',"p":' + JSON.stringify(b.p) + ',"a":' + JSON.stringify(b.a) + ',"__proto__":{"h":3}}';
    assert.equal((await r.post(proto)).status, 400);
    const protoExtra = JSON.stringify(b).slice(0, -1) + ',"__proto__":1}';
    assert.equal((await r.post(protoExtra)).status, 400);
    assert.equal(r.pushes.length, 0);
  });

  test("each bad value -> 400 before D1", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    const b = onBody(s);
    const at = "@";
    const notOnCurve = (() => {
      const x = crypto.getRandomValues(new Uint8Array(65));
      x[0] = 4;
      return bytesToB64u(x);
    })();
    const first3 = (() => {
      const x = new Uint8Array([...Uint8Array.from(atob(b.p.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0))]);
      x[0] = 3;
      return bytesToB64u(x);
    })();
    const badE = [
      "http://fcm.googleapis.com/send/x",
      "https://fcm.googleapis.com:443/send/x",
      "https://fcm.googleapis.com:8443/send/x",
      ["https://u:p", "fcm.googleapis.com/send/x"].join(at),
      "https://evil.example/send/x",
      "https://fcm.googleapis.com.evil.example/send/x",
      "https://evilfcm.googleapis.com/send/x",
      "https://FCM.googleapis.com/send/x",
      "https://fcm.googleapis.com./send/x",
      "https://fcm.googleapis.com/send/x#frag",
      "https://fcm.googleapis.com/send/" + "x".repeat(1024),
      "",
      42,
      null,
      ["https://fcm.googleapis.com/send/x"],
    ];
    const badP = [
      notOnCurve,
      first3,
      b.p.slice(0, -2),
      b.p + "A",
      b.p + "=",
      b.p.replace(/-|_/, "+").replace(/^./, "+"),
      rnd(64),
      "",
      65,
      null,
    ];
    const badA = [rnd(15), rnd(17), b.a + "==", "/" + b.a.slice(1), b.a.slice(0, -1) + "=", "", 16, null, [b.a]];
    const badH = [0, 10000, -1, 1.5, "5", true, null, [5], 1e21, Number.MAX_SAFE_INTEGER];
    const cases = [
      ...badE.map((e) => ({ ...b, e })),
      ...badP.map((p) => ({ ...b, p })),
      ...badA.map((a) => ({ ...b, a })),
      ...badH.map((h) => ({ ...b, h })),
    ];
    for (const body of cases) {
      const out = await r.post(body);
      assert.equal(out.status, 400, JSON.stringify(body).slice(0, 120));
      assert.equal(out.statements, 0);
      assert.equal(out.pushes, 0);
    }
    for (const h of [1, 9999]) {
      const t = await newSub("fcm.googleapis.com", h);
      assert.equal((await r.post(onBody(t))).status, 200);
    }
    for (const host of ["web.push.apple.com", "wns2-db5p.notify.windows.com", "updates.push.services.mozilla.com", "jmt17.google.com"]) {
      const t = await newSub(host);
      assert.equal((await r.post(onBody(t))).status, 200, host);
    }
  });

  test("other spellings of one push address (dot segments, %2e, x/.., backslash) -> 400, one row only", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub("fcm.googleapis.com", 7);
    const token = s.e.slice("https://fcm.googleapis.com/send/".length);
    assert.equal((await r.post(onBody(s))).status, 200);
    const aliases = [
      "https://fcm.googleapis.com/send/./" + token,
      "https://fcm.googleapis.com/./send/" + token,
      "https://fcm.googleapis.com/send/././" + token,
      "https://fcm.googleapis.com/send/%2e/" + token,
      "https://fcm.googleapis.com/send/%2E/" + token,
      "https://fcm.googleapis.com/x/../send/" + token,
      "https://fcm.googleapis.com/x/%2e%2e/send/" + token,
      "https://fcm.googleapis.com/send\\" + token,
      "https://fcm.googleapis.com/send/" + token + "/x/..",
      "https://fcm.googleapis.com/send/{" + token + "}",
      "https://fcm.googleapis.com",
    ];
    for (const e of aliases) {
      // the control: fetch would send each of these to a URL other than the text itself
      assert.notEqual(new Request(e).url, e, e);
      for (const a of [s.a, secret(rnd(16))]) {
        const on = await r.post({ ...onBody(s), e, a });
        assert.equal(on.status, 400, "POST " + e);
        assert.equal(on.statements, 0);
        assert.equal(on.pushes, 0);
        const off = await r.del({ e, a });
        assert.equal(off.status, 400, "DELETE " + e);
        assert.equal(off.statements, 0);
      }
    }
    assert.equal(r.rows().length, 1, "one subscription, one row");
    assert.equal(r.pushes.length, 1, "one test push");
    // real-looking addresses are already in the parser's form and pass: ":" in the path, %-escapes in the query
    const real = [
      "https://fcm.googleapis.com/fcm/send/" + rnd(16) + ":APA91b" + rnd(40),
      "https://wns2-db5p.notify.windows.com/w/?token=" + rnd(30) + "%2b" + rnd(20) + "%2f" + rnd(10) + "%3d%3d",
      "https://updates.push.services.mozilla.com/wpush/v2/" + rnd(60),
      "https://web.push.apple.com/" + rnd(48),
    ];
    for (const e of real) {
      assert.equal(new URL(e).href, e);
      const t = { ...(await newSub()), e: secret(e) };
      assert.equal((await r.post(onBody(t))).status, 200, e);
      assert.ok(r.row(sha256hex(e)), "row id = SHA-256 of e as posted");
      assert.equal((await r.del(offBody(t))).status, 204);
      assert.equal(r.row(sha256hex(e)), null);
    }
  });
});

describe("POST /api/bell: new bell, same bell, caps, off (SPEC 5.5)", () => {
  test("new bell -> exactly one test push -> row stored (7 statements, SPEC 5.5 order)", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub("fcm.googleapis.com", 77);
    const out = await r.post(onBody(s));
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true });
    assert.equal(out.pushes, 1);
    assert.equal(out.statements, 7);
    assert.equal(out.batches, 1);
    // off -> row lookup -> try read -> try count -> caps -> one batch (insert + new:<day>)
    const order = [/^SELECT v FROM meta/, /^SELECT a FROM bells/, /^SELECT v FROM meta/, /RETURNING v$/, /COUNT\(\*\)/,
      /^INSERT INTO bells/, /^INSERT INTO meta .*v \+ 1$/];
    assert.equal(r.db.log.length, order.length);
    order.forEach((re, i) => assert.match(r.db.log[i], re, "statement " + i));
    assert.deepEqual([r.db.args[0], r.db.args[1], r.db.args[2], r.db.args[3], r.db.args[4], r.db.args[6]],
      [["off"], [s.id], ["try:" + DAY], ["try:" + DAY], ["new:" + DAY], ["new:" + DAY]]);
    const p = r.pushes[0];
    assert.equal(p.env, r.env);
    assert.deepEqual(p.sub, { e: s.e, p: s.p, a: s.a });
    assert.deepEqual(p.msg, { k: "test" });
    assert.deepEqual(p.opt, { ttl: 300, urgency: "high", topic: "test" });
    assert.equal(p.deps.now(), r.now);
    const row = r.row(s.id);
    assert.deepEqual(
      { id: row.id, e: row.e, p: row.p, a: row.a, h: row.h, c: row.c, t: row.t, hd: row.hd, ed: row.ed, vl: row.vl, vt: row.vt },
      { id: s.id, e: s.e, p: s.p, a: s.a, h: 77, c: DAY, t: DAY, hd: 0, ed: 0, vl: "", vt: 0 },
    );
    assert.equal(r.meta("new:" + DAY), 1);
    assert.equal(r.meta("try:" + DAY), 1);
  });

  test("test push not accepted -> 502, nothing stored; 200/201/202 accepted", async () => {
    const r = makeRig();
    await r.init();
    for (const status of [410, 404, 400, 401, 403, 413, 429, 500, 503, 301, 204, 0, -1, "undefined", "throw"]) {
      const s = await newSub();
      if (status === "throw") r.push.throwFor.add(s.e);
      else r.push.byEndpoint.set(s.e, status);
      const out = await r.post(onBody(s));
      assert.equal(out.status, 502, "push status " + status);
      assert.deepEqual(out.body, { ok: false });
      assert.equal(out.pushes, 1);
      assert.equal(r.row(s.id), null);
    }
    assert.equal(r.meta("new:" + DAY), null, "new counter not raised");
    assert.equal(r.rows().length, 0);
    for (const status of [200, 201, 202]) {
      const s = await newSub();
      r.push.byEndpoint.set(s.e, status);
      assert.equal((await r.post(onBody(s))).status, 200);
      assert.ok(r.row(s.id));
    }
    assert.equal(r.meta("new:" + DAY), 3);
  });

  test("same endpoint again: same auth -> refresh h and t, no push; other auth -> 403", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub("fcm.googleapis.com", 5);
    assert.equal((await r.post(onBody(s))).status, 200);
    r.now = T0 + 3 * 86400000;
    const again = await r.post(onBody(s, 6));
    assert.equal(again.status, 200);
    assert.equal(again.pushes, 0);
    assert.equal(again.statements, 3);
    assert.equal(r.meta("try:" + (DAY + 3)), null, "a refresh is not an attempt");
    let row = r.row(s.id);
    assert.equal(row.h, 6);
    assert.equal(row.t, DAY + 3);
    assert.equal(row.c, DAY);
    const other = await r.post({ ...onBody(s, 9), a: secret(rnd(16)) });
    assert.equal(other.status, 403);
    assert.deepEqual(other.body, { ok: false });
    assert.equal(other.pushes, 0);
    assert.equal(other.statements, 2);
    assert.equal(r.meta("try:" + (DAY + 3)), null, "a 403 is not an attempt");
    row = r.row(s.id);
    assert.equal(row.h, 6);
    assert.equal(row.a, s.a);
    assert.equal(r.rows().length, 1);
  });

  test("caps: 1000 rows, 200 new per day, 2000 tries per day", async () => {
    const r = makeRig();
    await r.init();
    const keep = await newSub();
    assert.equal((await r.post(onBody(keep))).status, 200);
    for (let i = 0; i < 999; i++) r.seed({ h: (i % 50) + 1 });
    assert.equal(r.rows().length, 1000);
    const late = await newSub();
    let out = await r.post(onBody(late));
    assert.equal(out.status, 503);
    assert.equal(out.pushes, 0);
    assert.equal(r.row(late.id), null);
    out = await r.post(onBody(keep, 3));
    assert.equal(out.status, 200, "an existing bell can still refresh");
    r.db.sql.prepare("DELETE FROM bells WHERE id = ?").run(r.rows()[1].id);
    assert.equal((await r.post(onBody(late))).status, 200, "999 rows -> room for one");

    const r2 = makeRig();
    await r2.init();
    r2.setMeta("new:" + DAY, 199);
    const s1 = await newSub();
    assert.equal((await r2.post(onBody(s1))).status, 200);
    assert.equal(r2.meta("new:" + DAY), 200);
    const s2 = await newSub();
    out = await r2.post(onBody(s2));
    assert.equal(out.status, 503);
    assert.equal(out.pushes, 0);
    r2.now = T0 + 86400000;
    assert.equal((await r2.post(onBody(s2))).status, 200, "a new day has a new count");

    const r3 = makeRig();
    await r3.init();
    r3.setMeta("try:" + DAY, 1999);
    const s3 = await newSub();
    assert.equal((await r3.post(onBody(s3))).status, 200, "attempt 2000 passes");
    assert.equal(r3.meta("try:" + DAY), 2000);
    const s4 = await newSub();
    out = await r3.post(onBody(s4));
    assert.equal(out.status, 503, "attempt 2001 (a new bell) is refused");
    assert.equal(out.pushes, 0);
    assert.equal(r3.meta("try:" + DAY), 2000, "a refused attempt is not written");
    assert.equal(r3.row(s4.id), null);
    assert.equal((await r3.post(onBody(s3, 4))).status, 200, "the bell of attempt 2000 can still refresh");
  });

  test("ring op off: POST -> 410 (not counted), DELETE still works; off false opens again", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    assert.equal((await r.post(onBody(s))).status, 200);
    let out = await r.ring({ op: "off", on: true });
    assert.equal(out.status, 200);
    assert.equal(out.statements, 1);
    assert.equal(r.meta("off"), 1);
    const t = await newSub();
    const tries = r.meta("try:" + DAY);
    out = await r.post(onBody(t));
    assert.equal(out.status, 410);
    assert.deepEqual(out.body, { ok: false });
    assert.equal(out.pushes, 0);
    assert.equal(r.meta("try:" + DAY), tries, "a closed POST is not an attempt");
    assert.equal((await r.post(onBody(s))).status, 410, "also a refresh");
    out = await r.del(offBody(s));
    assert.equal(out.status, 204);
    assert.equal(r.row(s.id), null);
    assert.equal((await r.ring({ op: "off", on: false })).status, 200);
    assert.equal(r.meta("off"), null);
    assert.equal((await r.post(onBody(t))).status, 200);
    for (const bad of [{ op: "off" }, { op: "off", on: 1 }, { op: "off", on: "true" }, { op: "off", on: null }]) {
      out = await r.ring(bad);
      assert.equal(out.status, 400);
      assert.equal(out.statements, 0);
    }
  });

  test("D1 failure at any step -> 503, nothing half stored", async () => {
    const tryRead = (sql, values) => /^SELECT v FROM meta/.test(sql) && values[0] === "try:" + DAY;
    const points = [/^SELECT v FROM meta/, /^SELECT a FROM bells/, tryRead, /RETURNING v$/, /COUNT\(\*\)/, /^INSERT INTO bells/,
      /^INSERT INTO meta .*v \+ 1$/];
    for (const re of points) {
      const r = makeRig();
      await r.init();
      const s = await newSub();
      r.db.failWhen(re);
      const out = await r.post(onBody(s));
      assert.equal(out.status, 503, String(re));
      assert.deepEqual(out.body, { ok: false });
      r.db.failWhen(null);
      assert.equal(r.row(s.id), null);
      assert.equal(r.meta("new:" + DAY), null);
    }
    const r = makeRig();
    await r.init();
    const s = await newSub();
    assert.equal((await r.post(onBody(s))).status, 200);
    r.db.failWhen(/^UPDATE bells SET h/);
    assert.equal((await r.post(onBody(s, 3))).status, 503);
    r.db.failWhen(null);
    const fresh = makeRig();
    const t = await newSub();
    assert.equal((await fresh.post(onBody(t))).status, 503, "no schema yet");
  });
});

describe("POST /api/bell: the try counter counts new bells only (SPEC 5.5, FIXES-2 W1)", () => {
  const TRY = "try:" + DAY;
  const writes = (db) => db.log.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|CREATE|REPLACE)\b/i.test(sql));
  const tryTouches = (db) => db.args.filter((vals) => vals.some((v) => typeof v === "string" && v.startsWith("try:")));
  // Junk: values that pass every check but no real subscription behind them. One real P-256 key and one auth
  // for all of them (rows are keyed by the endpoint, so only e has to vary).
  async function junkMaker() {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const p = bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const a = rnd(16);
    return (i) => ({ e: "https://fcm.googleapis.com/fcm/send/" + rnd(18), p, a, h: 1 + (i % 50) });
  }

  test("(a)+(b) 2000 counted junk attempts: a refresh still answers 200; a new bell gets 503 and the counter stays 2000", async () => {
    const r = makeRig();
    await r.init();
    const honest = await newSub("fcm.googleapis.com", 7);
    r.now = T0 - 86400000; // the honest bell was turned on yesterday
    assert.equal((await r.post(onBody(honest))).status, 200);
    r.now = T0;
    const junk = await junkMaker();
    r.push.status = 404; // the push service does not know these addresses
    const seen = {};
    for (let i = 0; i < 2000; i++) {
      const out = await r.post(junk(i));
      seen[out.status] = (seen[out.status] || 0) + 1;
    }
    assert.deepEqual(seen, { 502: 2000 }, "every junk attempt below the cap is counted and gets its one test push");
    assert.equal(r.meta(TRY), 2000);
    assert.equal(r.rows().length, 1, "junk stores nothing");
    r.push.status = 201;

    // (a) the honest bell refreshes
    const refresh = await r.post(onBody(honest, 8));
    assert.equal(refresh.status, 200, "a refresh of an existing bell still works after the cap");
    assert.deepEqual(refresh.body, { ok: true });
    assert.equal(refresh.pushes, 0);
    assert.deepEqual(tryTouches(r.db), []);
    assert.equal(r.row(honest.id).h, 8);
    assert.equal(r.row(honest.id).t, DAY);
    assert.equal(r.meta(TRY), 2000);

    // (b) a further new bell: 503, nothing written, the counter does not grow (also not after many tries)
    const late = await newSub();
    for (let i = 0; i < 5; i++) {
      for (const body of [onBody(late), junk(i)]) {
        const out = await r.post(body);
        assert.equal(out.status, 503);
        assert.deepEqual(out.body, { ok: false });
        assert.equal(out.pushes, 0);
        assert.equal(out.statements, 3, "off, row lookup, try read");
        assert.deepEqual(writes(r.db), [], "nothing written after the cap");
      }
    }
    assert.equal(r.meta(TRY), 2000, "the counter does not grow after the cap");
    assert.equal(r.row(late.id), null);
    assert.equal(r.meta("new:" + DAY), null);
    assert.equal(r.rows().length, 1);

    // the next UTC day has a new budget
    r.now = T0 + 86400000;
    assert.equal((await r.post(onBody(late))).status, 200);
    assert.equal(r.meta("try:" + (DAY + 1)), 1);
    assert.equal(r.meta(TRY), 2000);
  });

  test("(c) a refresh and a 403 never read or write try:<day>, below and at the cap", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub("fcm.googleapis.com", 5);
    r.now = T0 - 86400000;
    assert.equal((await r.post(onBody(s))).status, 200);
    r.now = T0;
    for (const start of [null, 3, 1999, 2000, 2001]) {
      if (start === null) assert.equal(r.meta(TRY), null);
      else r.setMeta(TRY, start);
      const refresh = await r.post(onBody(s, 6));
      assert.equal(refresh.status, 200, "refresh with try " + start);
      assert.equal(refresh.statements, 3);
      assert.deepEqual(tryTouches(r.db), [], "refresh: no statement with a try: value");
      assert.deepEqual(writes(r.db).length, 1, "refresh: only the row update");
      assert.match(writes(r.db)[0], /^UPDATE bells SET h/);
      const other = await r.post({ ...onBody(s, 9), a: secret(rnd(16)) });
      assert.equal(other.status, 403, "403 with try " + start);
      assert.equal(other.statements, 2);
      assert.equal(other.pushes, 0);
      assert.deepEqual(tryTouches(r.db), [], "403: no statement with a try: value");
      assert.deepEqual(writes(r.db), [], "403 writes nothing");
      assert.equal(r.meta(TRY), start, "try:<day> unchanged");
    }
    assert.equal(r.row(s.id).h, 6);
    assert.equal(r.row(s.id).a, s.a);
  });

  test("(d) D1 statements: new bell 7, refresh 3, 403 2, cap reached 3, counted over the cap 4; never more than 12", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    let out = await r.post(onBody(s));
    assert.equal(out.status, 200);
    assert.equal(out.statements, 7);
    out = await r.post(onBody(s, 2));
    assert.equal(out.status, 200);
    assert.equal(out.statements, 3);
    out = await r.post({ ...onBody(s), a: secret(rnd(16)) });
    assert.equal(out.status, 403);
    assert.equal(out.statements, 2);

    // the read sees 1999, but another request counts first: the upsert gives 2001 -> 503, no push, no row
    r.setMeta(TRY, 1999);
    const raced = await newSub();
    r.db.failWhen((sql, values) => {
      if (/RETURNING v$/.test(sql) && values[0] === TRY) r.setMeta(TRY, 2000);
      return false;
    });
    out = await r.post(onBody(raced));
    r.db.failWhen(null);
    assert.equal(out.status, 503);
    assert.equal(out.statements, 4, "off, row lookup, try read, try count");
    assert.equal(out.pushes, 0);
    assert.equal(r.meta(TRY), 2001);
    assert.equal(r.row(raced.id), null);

    // cap reached: 3 statements, nothing written (and a refresh still works)
    out = await r.post(onBody(raced));
    assert.equal(out.status, 503);
    assert.equal(out.statements, 3);
    assert.deepEqual(writes(r.db), []);
    assert.equal(r.meta(TRY), 2001);
    assert.equal((await r.post(onBody(s, 3))).status, 200);

    // other caps after the count: 1000 rows or 200 new today -> 503 after 5 statements, no push
    const r2 = makeRig();
    await r2.init();
    r2.setMeta("new:" + DAY, 200);
    out = await r2.post(onBody(await newSub()));
    assert.equal(out.status, 503);
    assert.equal(out.statements, 5);
    assert.equal(out.pushes, 0);
    assert.equal(r2.meta(TRY), 1, "the attempt was counted before the caps");

    // a junk counter value that is not a whole number is treated as used up, nothing written
    const r3 = makeRig();
    await r3.init();
    r3.setMeta(TRY, 1.5);
    out = await r3.post(onBody(await newSub()));
    assert.equal(out.status, 503);
    assert.deepEqual(writes(r3.db), []);

    for (const rig of [r, r2, r3]) assert.ok(rig.stats.maxStatements <= 12, "max " + rig.stats.maxStatements);
    assert.equal(r.stats.maxStatements, 7);
  });

  test("(e) a try:<day> or new:<day> value that is not a whole number counts as used up (SPEC 5.5, R2W-1)", async () => {
    // Only a hand-made D1 row can hold such a value; the API itself writes whole numbers only.
    for (const junkValue of [1.5, "x", 1999.5]) {
      const r = makeRig();
      await r.init();
      const honest = await newSub("fcm.googleapis.com", 4);
      r.now = T0 - 86400000; // the honest bell was turned on yesterday
      assert.equal((await r.post(onBody(honest))).status, 200);
      r.now = T0;
      r.setMeta(TRY, junkValue);
      const s = await newSub();
      const out = await r.post(onBody(s));
      assert.equal(out.status, 503, "new bell with try " + junkValue);
      assert.deepEqual(out.body, { ok: false });
      assert.equal(out.statements, 3, "off, row lookup, try read");
      assert.equal(out.pushes, 0);
      assert.deepEqual(writes(r.db), [], "nothing written");
      assert.equal(r.meta(TRY), junkValue, "counter unchanged");
      assert.equal(r.row(s.id), null);
      // an existing bell still refreshes and does not touch the counter
      const refresh = await r.post(onBody(honest, 5));
      assert.equal(refresh.status, 200, "refresh with try " + junkValue);
      assert.deepEqual(tryTouches(r.db), []);
      assert.equal(r.meta(TRY), junkValue);
      assert.equal(r.row(honest.id).h, 5);
    }

    // the upsert gives a value that is not a whole number (another writer stored 1.5 between our read and our
    // upsert) -> 503 after 4 statements, no push, no row
    const r2 = makeRig();
    await r2.init();
    r2.setMeta(TRY, 7);
    r2.db.failWhen((sql, values) => {
      if (/RETURNING v$/.test(sql) && values[0] === TRY) r2.setMeta(TRY, 1.5);
      return false;
    });
    const s2 = await newSub();
    let out = await r2.post(onBody(s2));
    r2.db.failWhen(null);
    assert.equal(out.status, 503);
    assert.equal(out.statements, 4, "off, row lookup, try read, try count");
    assert.equal(out.pushes, 0);
    assert.equal(r2.meta(TRY), 2.5);
    assert.equal(r2.row(s2.id), null);

    // new:<day> not a whole number -> 503 after the count (5 statements), no push, no row
    const r3 = makeRig();
    await r3.init();
    r3.setMeta("new:" + DAY, 1.5);
    const s3 = await newSub();
    out = await r3.post(onBody(s3));
    assert.equal(out.status, 503);
    assert.equal(out.statements, 5, "off, row lookup, try read, try count, caps");
    assert.equal(out.pushes, 0);
    assert.equal(r3.meta(TRY), 1, "the attempt was counted before the caps");
    assert.equal(r3.meta("new:" + DAY), 1.5);
    assert.equal(r3.row(s3.id), null);
  });
});

describe("DELETE /api/bell (SPEC 5.6)", () => {
  test("right auth deletes; wrong auth or unknown endpoint keeps rows; always 204; D1 failure -> 204", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    const t = await newSub();
    assert.equal((await r.post(onBody(s))).status, 200);
    assert.equal((await r.post(onBody(t))).status, 200);
    let out = await r.del(offBody(s, secret(rnd(16))));
    assert.equal(out.status, 204);
    assert.ok(r.row(s.id), "wrong auth keeps the row");
    out = await r.del(offBody(await newSub()));
    assert.equal(out.status, 204);
    out = await r.del(offBody(s));
    assert.equal(out.status, 204);
    assert.equal(out.statements, 1);
    assert.equal(r.row(s.id), null);
    assert.ok(r.row(t.id));
    out = await r.del(offBody(s));
    assert.equal(out.status, 204, "again: still 204");
    r.db.failNext();
    out = await r.del(offBody(t));
    assert.equal(out.status, 204);
    assert.ok(r.row(t.id), "D1 failed, row still there, answer still 204");
  });

  test("exact keys {e, a} and the same value checks -> 400", async () => {
    const r = makeRig();
    await r.init();
    const s = await newSub();
    const bad = [
      { e: s.e },
      { a: s.a },
      { e: s.e, a: s.a, p: s.p },
      { e: s.e, a: s.a, h: 1 },
      { e: "http://fcm.googleapis.com/x", a: s.a },
      { e: s.e, a: rnd(15) },
      { e: s.e, a: 5 },
      { e: 5, a: s.a },
    ];
    for (const body of bad) {
      const out = await r.del(body);
      assert.equal(out.status, 400);
      assert.equal(out.statements, 0);
    }
  });
});

describe("ring ops init, count, prune (SPEC 5.7)", () => {
  test("init creates the schema, again is harmless (3 statements in one batch)", async () => {
    const r = makeRig();
    const out = await r.ring({ op: "init" });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true });
    assert.equal(out.statements, 3);
    assert.equal(out.batches, 1);
    assert.equal((await r.ring({ op: "init", extra: 1 })).status, 200);
    const names = r.db.sql
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((x) => x.name);
    assert.deepEqual(names, ["bells", "bells_h", "meta"]);
    const cols = r.db.sql
      .prepare("PRAGMA table_info(bells)")
      .all()
      .map((x) => x.name);
    assert.deepEqual(cols, ["id", "e", "p", "a", "h", "c", "t", "hd", "ed", "vl", "vt"]);
    r.db.failNext();
    assert.equal((await r.ring({ op: "init" })).status, 503);
  });

  test("count: active and matched, one SELECT; bad lists -> 400", async () => {
    const r = makeRig();
    await r.init();
    for (const h of [1, 1, 2, 3, 500]) r.seed({ h });
    let out = await r.ring({ op: "count", hs: [1, 500, 9999] });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, active: 5, matched: 3 });
    assert.equal(out.statements, 1);
    out = await r.ring({ op: "count", hs: [] });
    assert.deepEqual(out.body, { ok: true, active: 5, matched: 0 });
    const big = Array.from({ length: 2000 }, (_, i) => i + 1);
    out = await r.ring({ op: "count", hs: big });
    assert.deepEqual(out.body, { ok: true, active: 5, matched: 5 });
    for (const hs of [undefined, null, "1", { 1: 1 }, [0], [10000], [1.5], ["1"], [null], [-3], [...big, 2001]]) {
      out = await r.ring({ op: "count", hs });
      assert.equal(out.status, 400, JSON.stringify(hs)?.slice(0, 40));
      assert.equal(out.statements, 0);
    }
    r.db.failNext();
    assert.equal((await r.ring({ op: "count", hs: [1] })).status, 503);
  });

  test("prune: rows with t < day - 120 and try:/new: rows older than 3 days", async () => {
    const r = makeRig();
    await r.init();
    const old = r.seed({ t: DAY - 121 });
    const edge = r.seed({ t: DAY - 120 });
    const now = r.seed({ t: DAY });
    for (const k of ["try:" + (DAY - 4), "new:" + (DAY - 4), "try:" + (DAY - 30)]) r.setMeta(k, 5);
    for (const k of ["try:" + (DAY - 3), "new:" + (DAY - 3), "try:" + DAY, "new:" + DAY, "off"]) r.setMeta(k, 1);
    const out = await r.ring({ op: "prune" });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, removed: 1 });
    assert.equal(out.statements, 2);
    assert.equal(r.row(old.id), null);
    assert.ok(r.row(edge.id));
    assert.ok(r.row(now.id));
    const keys = r.db.sql
      .prepare("SELECT k FROM meta ORDER BY k")
      .all()
      .map((x) => x.k);
    assert.deepEqual(keys, ["new:" + (DAY - 3), "new:" + DAY, "off", "try:" + (DAY - 3), "try:" + DAY].sort());
    const again = await r.ring({ op: "prune" });
    assert.deepEqual(again.body, { ok: true, removed: 0 });
    r.db.failNext();
    assert.equal((await r.ring({ op: "prune" })).status, 503);
  });

  test("unknown op or wrong field type -> 400", async () => {
    const r = makeRig();
    await r.init();
    for (const body of [{}, { op: "" }, { op: "INIT" }, { op: "__proto__" }, { op: "toString" }, { op: 1 }, { op: ["init"] }, { op: null }]) {
      const out = await r.ring(body);
      assert.equal(out.status, 400, JSON.stringify(body));
      assert.equal(out.statements, 0);
    }
  });
});

describe("ring op alert (SPEC 5.7)", () => {
  test("walking with lim, after, more; message and options exact; dedupe on a second walk", async () => {
    const r = makeRig();
    await r.init();
    const rows = [];
    for (let h = 1; h <= 10; h++) rows.push(r.seed({ h }));
    const m = { 2: [1, 1], 3: [2, 3], 5: [1, 1], 7: [1, 2], 9: [1, 1] };
    let out = await r.ring(alertBody({ m, lim: 2 }));
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, sent: 2, gone: 0, denied: 0, failed: 0, matched: 2, after: rows[2].rid, more: true });
    assert.equal(out.statements, 3);
    assert.equal(out.batches, 1, "all row updates of one request in ONE batch");
    const ttl = CLOSE - Math.floor(T0 / 1000);
    assert.deepEqual(
      r.pushes.map((p) => [p.sub.e, p.msg, p.opt]),
      [
        [rows[1].e, { k: "house", close: CLOSE, n: 1, of: 1 }, { ttl, urgency: "high", topic: "house" }],
        [rows[2].e, { k: "house", close: CLOSE, n: 2, of: 3 }, { ttl, urgency: "high", topic: "house" }],
      ],
    );
    assert.deepEqual(r.pushes[0].sub, { e: rows[1].e, p: rows[1].p, a: rows[1].a });
    assert.equal(r.pushes[0].deps.now(), r.now);
    out = await r.ring(alertBody({ m, lim: 2, after: out.body.after }));
    assert.deepEqual(out.body, { ok: true, sent: 2, gone: 0, denied: 0, failed: 0, matched: 2, after: rows[6].rid, more: true });
    out = await r.ring(alertBody({ m, lim: 2, after: out.body.after }));
    assert.deepEqual(out.body, { ok: true, sent: 1, gone: 0, denied: 0, failed: 0, matched: 1, after: rows[9].rid, more: false });
    for (const row of r.rows()) assert.equal(row.hd, row.h in m ? DAY : 0, "hd of house " + row.h);
    const before = r.pushes.length;
    out = await r.ring(alertBody({ m, lim: 8 }));
    assert.deepEqual(out.body, { ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched: 0, after: rows[9].rid, more: false });
    assert.equal(r.pushes.length, before, "second walk the same day sends nothing");
    assert.equal(out.statements, 1, "no batch when nothing changed");
    // the next day the same houses can be told again
    r.now = T0 + 86400000;
    out = await r.ring(alertBody({ m, lim: 8, day: DAY + 1, close: CLOSE + 86400 }));
    assert.equal(out.body.sent, 5);
  });

  test("push answers: 404/410 delete the row, 401/403 denied (row kept), others failed (row untouched)", async () => {
    const r = makeRig();
    await r.init();
    const statuses = [404, 410, 403, 401, 500, 201, 0, -1];
    const rows = statuses.map((s, i) => {
      const row = r.seed({ h: i + 1 });
      r.push.byEndpoint.set(row.e, s);
      return row;
    });
    const thrower = r.seed({ h: 20 });
    r.push.throwFor.add(thrower.e);
    const m = Object.fromEntries([...rows.map((x) => [x.h, [1, 1]]), [20, [1, 1]]]);
    let out = await r.ring(alertBody({ m, lim: 8 }));
    assert.deepEqual(out.body, { ok: true, sent: 1, gone: 2, denied: 2, failed: 3, matched: 8, after: rows[7].rid, more: true });
    assert.equal(out.pushes, 8);
    assert.equal(out.statements, 1 + 3);
    assert.equal(r.row(rows[0].id), null);
    assert.equal(r.row(rows[1].id), null);
    assert.equal(r.row(rows[2].id).hd, 0);
    assert.equal(r.row(rows[3].id).hd, 0);
    assert.equal(r.row(rows[4].id).hd, 0);
    assert.equal(r.row(rows[5].id).hd, DAY);
    out = await r.ring(alertBody({ m, lim: 8, after: out.body.after }));
    assert.deepEqual(out.body, { ok: true, sent: 0, gone: 0, denied: 0, failed: 1, matched: 1, after: thrower.rid, more: false });
    // a new walk tries the denied and failed rows again, not the sent or gone ones
    out = await r.ring(alertBody({ m, lim: 8 }));
    assert.equal(out.body.matched, 6);
  });

  test("lim: default 6, at most 8; budget 8 pushes and 9 statements", async () => {
    const r = makeRig();
    await r.init();
    const m = {};
    for (let h = 1; h <= 12; h++) {
      r.seed({ h });
      m[h] = [1, 1];
    }
    const noLim = alertBody({ m });
    delete noLim.lim;
    let out = await r.ring(noLim);
    assert.equal(out.body.sent, 6);
    assert.equal(out.body.more, true);
    out = await r.ring(alertBody({ m, lim: 8 }));
    assert.equal(out.body.sent, 6);
    assert.equal(out.body.more, false);
    r.now = T0 + 86400000;
    out = await r.ring(alertBody({ m, lim: 8, day: DAY + 1, close: CLOSE + 86400 }));
    assert.equal(out.body.sent, 8);
    assert.equal(out.pushes, 8);
    assert.equal(out.statements, 9);
    for (const lim of [0, 9, -1, 1.5, "6", null]) {
      out = await r.ring(alertBody({ m, lim, day: DAY + 1, close: CLOSE + 86400 }));
      assert.equal(out.status, 400, "lim " + lim);
      assert.equal(out.statements, 0);
    }
  });

  test("page of 200 rows: more is true, after moves to the 200th row; dry counts the whole page", async () => {
    const r = makeRig();
    await r.init();
    const rows = [];
    for (let i = 0; i < 250; i++) rows.push(r.seed({ h: (i % 30) + 1 }));
    const m = { 3: [1, 1], 4: [2, 2], 9999: [1, 1] };
    const inPage1 = rows.slice(0, 200).filter((x) => x.h === 3 || x.h === 4).length;
    const inPage2 = rows.slice(200).filter((x) => x.h === 3 || x.h === 4).length;
    let out = await r.ring(alertBody({ m, dry: true }));
    assert.deepEqual(out.body, { ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched: inPage1, after: rows[199].rid, more: true });
    assert.equal(out.pushes, 0);
    assert.equal(out.statements, 1);
    out = await r.ring(alertBody({ m, dry: true, after: out.body.after }));
    assert.deepEqual(out.body, { ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched: inPage2, after: rows[249].rid, more: false });
    assert.ok(r.rows().every((x) => x.hd === 0), "dry changes nothing");
    out = await r.ring(alertBody({ m: { 9999: [1, 1] } }));
    assert.deepEqual(out.body, { ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched: 0, after: rows[199].rid, more: true });
    out = await r.ring(alertBody({ m: { 9999: [1, 1] }, after: rows[199].rid }));
    assert.deepEqual(out.body, { ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched: 0, after: rows[249].rid, more: false });
    out = await r.ring(alertBody({ m: {}, after: rows[249].rid }));
    assert.deepEqual(out.body, { ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched: 0, after: rows[249].rid, more: false });
  });

  test("day must be the worker's UTC day; house ttl = close - now within 900..86400", async () => {
    const r = makeRig();
    await r.init();
    r.seed({ h: 1 });
    const m = { 1: [1, 1] };
    for (const day of [DAY - 1, DAY + 1, String(DAY), DAY + 0.5, null, undefined]) {
      const body = alertBody({ m, day });
      if (day === undefined) delete body.day;
      const out = await r.ring(body);
      assert.equal(out.status, 400, "day " + day);
      assert.equal(out.statements, 0);
    }
    const nowSec = (close, left) => (close - left) * 1000;
    const tries = [
      [899, 400],
      [900, 200],
      [86400, 200],
      [86401, 400],
      [-5, 400],
    ];
    for (const [left, want] of tries) {
      r.now = nowSec(CLOSE, left);
      const day = Math.floor(r.now / 86400000);
      const out = await r.ring(alertBody({ m, day, dry: true }));
      assert.equal(out.status, want, "ttl " + left);
      if (want === 400) assert.equal(out.statements, 0);
    }
    r.now = T0;
    for (const close of [undefined, null, String(CLOSE), CLOSE + 0.5]) {
      const body = alertBody({ m, close });
      if (close === undefined) delete body.close;
      assert.equal((await r.ring(body)).status, 400, "close " + close);
    }
  });

  test("pause and empty: messages, options and dedupe columns", async () => {
    const r = makeRig();
    await r.init();
    const a = r.seed({ h: 1 });
    const b = r.seed({ h: 2 });
    const c = r.seed({ h: 3 });
    let out = await r.ring(alertBody({ m: { 1: [1, 1] } }));
    assert.equal(out.body.sent, 1);
    r.pushes.length = 0;
    out = await r.ring(alertBody({ k: "pause", close: undefined, m: { 1: [1, 1], 2: [1, 1] } }));
    assert.deepEqual(out.body, { ok: true, sent: 1, gone: 0, denied: 0, failed: 0, matched: 1, after: c.rid, more: false });
    assert.deepEqual(r.pushes.map((p) => [p.sub.e, p.msg, p.opt]), [[b.e, { k: "pause" }, { ttl: 43200, urgency: "high", topic: "house" }]]);
    assert.equal(r.row(b.id).hd, DAY);
    r.pushes.length = 0;
    out = await r.ring({ op: "alert", k: "empty", day: DAY, m: { 1: [1, 1], 3: [1, 1] }, after: 0, dry: false });
    assert.equal(out.body.sent, 2, "empty uses its own column");
    assert.deepEqual(
      r.pushes.map((p) => [p.sub.e, p.msg, p.opt]),
      [
        [a.e, { k: "empty" }, { ttl: 43200, urgency: "high", topic: "empty" }],
        [c.e, { k: "empty" }, { ttl: 43200, urgency: "high", topic: "empty" }],
      ],
    );
    assert.equal(r.row(a.id).ed, DAY);
    assert.equal(r.row(a.id).hd, DAY);
    assert.equal(r.row(c.id).hd, 0);
    out = await r.ring({ op: "alert", k: "empty", day: DAY, close: 5, m: { 1: [1, 1], 3: [1, 1] }, after: 0, dry: false, note: "x" });
    assert.equal(out.status, 200, "close on a non-house alert and extra fields are ignored");
    assert.equal(out.body.sent, 0);
  });

  test("bad k, m, after or dry -> 400 before D1", async () => {
    const r = makeRig();
    await r.init();
    r.seed({ h: 1 });
    const tooMany = {};
    for (let h = 1; h <= 2001; h++) tooMany[h] = [1, 1];
    const bads = [
      { k: "HOUSE" },
      { k: "version" },
      { k: "__proto__" },
      { k: "constructor" },
      { k: undefined },
      { m: undefined },
      { m: null },
      { m: [[1, 1]] },
      { m: "1" },
      { m: { 0: [1, 1] } },
      { m: { 10000: [1, 1] } },
      { m: { "01": [1, 1] } },
      { m: { 1.5: [1, 1] } },
      { m: { " 1": [1, 1] } },
      { m: { 1: [0, 1] } },
      { m: { 1: [2, 1] } },
      { m: { 1: [1, 100] } },
      { m: { 1: [1] } },
      { m: { 1: [1, 1, 1] } },
      { m: { 1: [1.5, 2] } },
      { m: { 1: ["1", "1"] } },
      { m: { 1: { n: 1, of: 1 } } },
      { m: tooMany },
      { after: -1 },
      { after: 1.5 },
      { after: "0" },
      { after: undefined },
      { dry: undefined },
      { dry: "false" },
      { dry: 0 },
    ];
    for (const over of bads) {
      const body = alertBody(over);
      for (const [k, v] of Object.entries(over)) if (v === undefined) delete body[k];
      const out = await r.ring(body);
      assert.equal(out.status, 400, JSON.stringify(over).slice(0, 80));
      assert.equal(out.statements, 0);
      assert.equal(out.pushes, 0);
    }
    const protoText = JSON.stringify(alertBody()).replace('"m":{}', '"m":{"__proto__":[1,1]}');
    assert.equal((await r.send(ringReq(protoText))).status, 400);
    const big = {};
    for (let h = 1; h <= 2000; h++) big[h] = [1, 1];
    assert.equal((await r.ring(alertBody({ m: big, dry: true }))).status, 200, "2000 houses are fine");
  });

  test("D1 failure in the walk or in the batch -> 503", async () => {
    const r = makeRig();
    await r.init();
    r.seed({ h: 1 });
    r.db.failNext();
    let out = await r.ring(alertBody({ m: { 1: [1, 1] } }));
    assert.equal(out.status, 503);
    assert.equal(out.pushes, 0);
    r.db.failWhen(/^UPDATE bells SET hd/);
    out = await r.ring(alertBody({ m: { 1: [1, 1] } }));
    assert.equal(out.status, 503);
    assert.equal(out.pushes, 1);
    r.db.failWhen(null);
  });
});

describe("ring op version (SPEC 5.7)", () => {
  test("72 h gap, numeric compare (rc.9 < rc.10), marks vl and vt, second walk sends nothing", async () => {
    const r = makeRig();
    await r.init();
    const nowSec = Math.floor(T0 / 1000);
    const fresh = r.seed({ h: 1 });
    const nine = r.seed({ h: 2, vl: "rc.9", vt: nowSec - 259201 });
    const ten = r.seed({ h: 3, vl: "rc.10", vt: nowSec - 999999 });
    const edge = r.seed({ h: 4, vl: "rc.9", vt: nowSec - 259200 });
    const recent = r.seed({ h: 5, vl: "rc.9", vt: nowSec - 100 });
    const junk = r.seed({ h: 6, vl: "junk", vt: 0 });
    let out = await r.ring({ op: "version", v: "rc.10", after: 0, lim: 6, dry: false });
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, sent: 3, gone: 0, denied: 0, failed: 0, matched: 3, after: junk.rid, more: false });
    assert.deepEqual(
      r.pushes.map((p) => [p.sub.e, p.msg, p.opt]),
      [fresh, nine, junk].map((x) => [x.e, { k: "version", v: "rc.10" }, { ttl: 43200, urgency: "high", topic: "version" }]),
    );
    for (const x of [fresh, nine, junk]) {
      assert.equal(r.row(x.id).vl, "rc.10");
      assert.equal(r.row(x.id).vt, nowSec);
    }
    assert.equal(r.row(ten.id).vl, "rc.10");
    assert.equal(r.row(edge.id).vl, "rc.9");
    assert.equal(r.row(recent.id).vl, "rc.9");
    out = await r.ring({ op: "version", v: "rc.10", after: 0, lim: 6, dry: false });
    assert.equal(out.body.sent, 0);
    assert.equal(out.body.matched, 0);
    // rc.9 after rc.10 is older: no note even 4 days later
    r.now = T0 + 4 * 86400000;
    out = await r.ring({ op: "version", v: "rc.9", after: 0, lim: 6, dry: false });
    assert.equal(out.body.sent, 0, "rc.9 is not newer than rc.10 (a string compare would say it is)");
    assert.equal(out.body.matched, 0);
  });

  test("version with dry, lim, after and status handling like alert", async () => {
    const r = makeRig();
    await r.init();
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(r.seed({ h: i + 1, vl: "rc.1" }));
    r.push.byEndpoint.set(rows[0].e, 410);
    r.push.byEndpoint.set(rows[1].e, 403);
    let out = await r.ring({ op: "version", v: "rc.2", after: 0, lim: 3, dry: true });
    assert.deepEqual(out.body, { ok: true, sent: 0, gone: 0, denied: 0, failed: 0, matched: 5, after: rows[4].rid, more: false });
    out = await r.ring({ op: "version", v: "rc.2", after: 0, lim: 3, dry: false });
    assert.deepEqual(out.body, { ok: true, sent: 1, gone: 1, denied: 1, failed: 0, matched: 3, after: rows[2].rid, more: true });
    assert.equal(r.row(rows[0].id), null);
    assert.equal(r.row(rows[1].id).vl, "rc.1");
    out = await r.ring({ op: "version", v: "rc.2", after: out.body.after, dry: false });
    assert.deepEqual(out.body, { ok: true, sent: 2, gone: 0, denied: 0, failed: 0, matched: 2, after: rows[4].rid, more: false });
  });

  test("bad v and walk fields -> 400 before D1", async () => {
    const r = makeRig();
    await r.init();
    const base = { op: "version", v: "rc.17", after: 0, lim: 6, dry: false };
    for (const over of [{ v: "rc.1000" }, { v: "rc.17<script>" }, { v: "RC.17" }, { v: "rc." }, { v: "1.0" }, { v: 17 }, { v: " rc.17" }, { v: "rc.17\n" }, { v: undefined }, { lim: 9 }, { after: -1 }, { dry: "no" }]) {
      const body = { ...base, ...over };
      for (const [k, v] of Object.entries(over)) if (v === undefined) delete body[k];
      const out = await r.ring(body);
      assert.equal(out.status, 400, JSON.stringify(over));
      assert.equal(out.statements, 0);
    }
    for (const v of ["rc.0", "rc.999"]) assert.equal((await r.ring({ ...base, v })).status, 200);
  });
});

describe("main.js entry", () => {
  test("/api/bell and /api/bell/* go to the handler, everything else to ASSETS", async () => {
    const main = (await import("../worker/src/main.js")).default;
    assert.equal(typeof main.fetch, "function");
    const seen = [];
    const db = makeFakeD1();
    const env = {
      DB: db,
      BELL_HOST: HOST,
      VAPID_JWK,
      RING_KEY,
      ASSETS: {
        fetch: async (req) => {
          seen.push(new URL(req.url).pathname);
          return new Response("static", { status: 200, headers: { "content-type": "text/html" } });
        },
      },
    };
    for (const path of ["/", "/og.jpg", "/sw.js", "/api/bellx", "/api/other", "/api"]) {
      const res = await main.fetch(new Request(ORIGIN + path), env, CTX);
      assert.equal(await res.text(), "static");
      assert.equal(res.headers.get("x-town-api"), null);
    }
    assert.deepEqual(seen, ["/", "/og.jpg", "/sw.js", "/api/bellx", "/api/other", "/api"]);
    for (const path of ["/api/bell", "/api/bell/ring", "/api/bell/x"]) {
      const out = await look(await main.fetch(new Request(ORIGIN + path), env, CTX));
      assert.equal(out.status, 404);
    }
    const ring = await look(await main.fetch(ringReq({ op: "init" }), env, CTX));
    assert.equal(ring.status, 200);
    assert.equal(seen.length, 6, "ASSETS not used for the bell routes");
    const src = await readFile(new URL("../worker/src/main.js", import.meta.url), "utf8");
    assert.ok(src.split("\n").filter((l) => l.trim() !== "").length <= 14, "main.js stays small");
    assert.doesNotMatch(src, /^(async\s+)?function\s+fetch|^(const|let|var)\s+fetch\b/m, "no top-level fetch name");
  });

  test("_routes.json is exactly the SPEC text", async () => {
    const text = await readFile(new URL("../worker/_routes.json", import.meta.url), "utf8");
    assert.deepEqual(JSON.parse(text), { version: 1, include: ["/api/bell", "/api/bell/*"], exclude: [] });
  });
});

describe("bundle worker/_worker.js (made by bundle.py)", () => {
  const bundleUrl = new URL("../worker/_worker.js", import.meta.url);

  test("holds the current sources and the forbidden words are absent", async (t) => {
    try {
      await access(bundleUrl);
    } catch {
      t.skip("run python3 -I worker/bundle.py first");
      return;
    }
    const bundle = await readFile(bundleUrl, "utf8");
    // The exact text bundle.py writes (build() + strip_part()): the header line, then per part a marker line and
    // the source without its "import " lines (and without the "export { ... }" lines of push.js / api.js),
    // trailing newlines cut to one. Byte for byte: anything added to or changed in the bundle alone fails here.
    let want = "// _worker.js: made by bundle.py from src/push.js, src/api.js, src/main.js. Do not edit by hand.\n";
    for (const name of ["push.js", "api.js", "main.js"]) {
      const src = await readFile(new URL("../worker/src/" + name, import.meta.url), "utf8");
      // Python's splitlines() also splits at these; the sources must not hold them, so split("\n") is the same
      assert.doesNotMatch(src, /[\r\v\f\x1c-\x1e\x85\u2028\u2029]/, "src/" + name + ": plain \\n line ends only");
      const kept = src
        .split("\n")
        .filter((l) => !l.startsWith("import ") && !(name !== "main.js" && /^export\s*\{[^}]*\}\s*;?\s*$/.test(l)))
        .join("\n")
        .replace(/\n+$/, "");
      want += "\n// ---------- src/" + name + " ----------\n" + kept + "\n";
    }
    assert.ok(bundle === want, "worker/_worker.js is exactly what bundle.py makes from src/ (run python3 -I worker/bundle.py)");
    assert.doesNotMatch(bundle, /^import /m);
    for (const word of ["require(", "process.", "Buffer"]) assert.ok(!bundle.includes(word), word);
    assert.doesNotMatch(bundle, /console\./);
  });

  test("bundled worker end to end with a fake global fetch: on, push headers, off", async (t) => {
    try {
      await access(bundleUrl);
    } catch {
      t.skip("run python3 -I worker/bundle.py first");
      return;
    }
    const worker = (await import(bundleUrl.href)).default;
    const db = makeFakeD1();
    const env = { DB: db, BELL_HOST: HOST, VAPID_JWK, RING_KEY, ASSETS: { fetch: async () => new Response("static") } };
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 201 });
    };
    try {
      assert.equal((await look(await worker.fetch(ringReq({ op: "init" }), env, CTX))).status, 200);
      const s = await newSub("updates.push.services.mozilla.com", 42);
      const on = await look(await worker.fetch(pubReq("POST", onBody(s)), env, CTX));
      assert.equal(on.status, 200);
      assert.equal(calls.length, 1);
      const c = calls[0];
      assert.equal(c.url, s.e);
      assert.equal(c.init.method, "POST");
      assert.equal(c.init.redirect, "manual");
      assert.equal(c.init.headers.TTL, "300");
      assert.equal(c.init.headers.Topic, "test");
      assert.equal(c.init.headers.Urgency, "high");
      assert.equal(c.init.headers["Content-Encoding"], "aes128gcm");
      assert.match(c.init.headers.Authorization, /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]{87}$/);
      assert.equal(c.init.body.length, 86 + '{"k":"test"}'.length + 1 + 16);
      const row = db.sql.prepare("SELECT h FROM bells WHERE id = ?").get(s.id);
      assert.equal(row.h, 42);
      const off = await look(await worker.fetch(pubReq("DELETE", offBody(s)), env, CTX));
      assert.equal(off.status, 204);
      assert.equal(db.sql.prepare("SELECT COUNT(*) AS n FROM bells").get().n, 0);
      const page = await worker.fetch(new Request(ORIGIN + "/"), env, CTX);
      assert.equal(await page.text(), "static");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
