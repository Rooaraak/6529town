// Tests for site/sw.js, site/sw-off.js and site/manifest.webmanifest.
// Run: nice -n 10 node --test test/sw.test.mjs
// The service worker files run inside node:vm with a fake "self". No network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SW = readFileSync(new URL("../site/sw.js", import.meta.url), "utf8");
const OFF = readFileSync(new URL("../site/sw-off.js", import.meta.url), "utf8");
const MANIFEST = readFileSync(new URL("../site/manifest.webmanifest", import.meta.url), "utf8");

const SCOPE = "https://town.example/";
// The two pictures of a notification are kept inside sw.js as base64 text (put there by embed-pics.py).
// What sw.js hands to showNotification must equal these two picture files byte for byte.
const PIC = (name) => "data:image/png;base64," + readFileSync(new URL((name === "badge.png" ? "../icons/" : "../site/") + name, import.meta.url)).toString("base64");
const ICON = PIC("icon-192.png");
const BADGE = PIC("badge.png");
const OFF_PICS = ["/icon-192.png", "/icon-192.png"]; // sw-off.js keeps the picture file's address
// Exactly the two picture statements of sw.js. They are taken out before the file text rules run, so every rule
// ("no data address" too) still holds for all the rest of the file.
const PICS = /^var (?:BELL_ICON|BELL_BADGE) = "data:image\/png;base64," \+\n(?:  "[A-Za-z0-9+/=]{1,76}" \+\n)*  "[A-Za-z0-9+/=]{1,76}";\n/gm;
const SW_RULES = SW.replace(PICS, "");
const FIXED_MS = 1800000000000; // fixed clock inside the vm for exact edge tests
const NOW = FIXED_MS / 1000;

// ---- expected texts, typed from SPEC section 6 character for character ----
const T = {
  test: { title: "6529 Town", body: "The bell on your house works. Unofficial, not made by 6529.", tag: "test" },
  pause: {
    title: "6529 Town",
    body: "Your house has not signed for 3 days. The bell stays quiet until it signs again.",
    tag: "house",
  },
  empty: { title: "Your house is empty today", body: "Your validator is not taking part today.", tag: "empty" },
  town: { title: "6529 Town", body: "Something changed in the town. Tap to look.", tag: "town" },
};
const HOUSE_ONE = "Your house has not signed yet today";
const houseMany = (n, of) => `${n} of your ${of} houses have not signed yet today`;
const houseBody = (time) => `Signing closes around ${time}. Is your validator running?`;
const HOUSE_SOON = "Signing closes soon. Is your validator running?";
const VERSION_BODY = "Already on it? Nothing to do. Update only from the official source.";
const fmt = (close) => new Date(close * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const house = (title, body) => ({ title, body, tag: "house" });
const version = (title) => ({ title, body: VERSION_BODY, tag: "version" });

// ---- fake service worker global ----
function fixedDate(ms) {
  return class FixedDate extends Date {
    static now() {
      return ms;
    }
  };
}

function load(text, opt = {}) {
  const rec = {
    listeners: new Map(),
    notes: [],
    skip: 0,
    claim: 0,
    opened: [],
    matchArgs: [],
    unsub: 0,
    unreg: 0,
    order: [],
    trapped: [],
  };
  const trap = (name) =>
    function () {
      rec.trapped.push(name);
      throw new Error("not allowed: " + name);
    };
  const pushManager =
    "pushManager" in opt
      ? opt.pushManager
      : {
          getSubscription() {
            return Promise.resolve(opt.sub === undefined ? null : opt.sub);
          },
        };
  const g = {};
  vm.createContext(g);
  Object.assign(g, {
    self: g,
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
      pushManager,
      showNotification(title, options) {
        const p = Promise.resolve(undefined);
        rec.notes.push({ title, options, p });
        return p;
      },
      unregister() {
        rec.unreg++;
        rec.order.push("unregister");
        return opt.unregisterFails ? Promise.reject(new Error("no")) : Promise.resolve(true);
      },
    },
    clients: {
      matchAll(q) {
        rec.matchArgs.push(q);
        return opt.matchAllFails ? Promise.reject(new Error("no")) : Promise.resolve(opt.windows || []);
      },
      openWindow(u) {
        rec.opened.push(u);
        return Promise.resolve(null);
      },
      claim() {
        rec.claim++;
        return Promise.resolve();
      },
    },
    fetch: trap("fetch"),
    importScripts: trap("importScripts"),
    XMLHttpRequest: trap("XMLHttpRequest"),
    WebSocket: trap("WebSocket"),
    EventSource: trap("EventSource"),
    eval: trap("eval"),
    Function: trap("Function"),
    setTimeout: trap("setTimeout"),
    setInterval: trap("setInterval"),
    caches: { open: trap("caches.open"), match: trap("caches.match"), keys: trap("caches.keys") },
  });
  if (opt.Date) g.Date = opt.Date;
  vm.runInContext(text, g, { filename: opt.name || "sw.js" });
  return { g, rec };
}

function fire(env, type, event) {
  for (const fn of env.rec.listeners.get(type) || []) fn.call(env.g, event);
}

function textData(text) {
  return {
    text: () => text,
    json: () => JSON.parse(text),
  };
}

// Fires one push and checks the hard contract: one waitUntil with the promise of one showNotification,
// options with exactly body/tag/icon/badge. Returns {title, body, tag} as a plain object of this realm.
// pics = the [icon, badge] the file must use: sw.js its two pictures, sw-off.js (the off file, kept small) the icon file.
async function push(env, data, pics = [ICON, BADGE]) {
  const before = env.rec.notes.length;
  const waits = [];
  fire(env, "push", { data, waitUntil: (p) => waits.push(p) });
  assert.equal(waits.length, 1, "event.waitUntil called exactly once");
  assert.equal(env.rec.notes.length, before + 1, "exactly one notification");
  const n = env.rec.notes[before];
  assert.equal(waits[0], n.p, "waitUntil gets the showNotification promise");
  await Promise.all(waits);
  assert.deepEqual(Object.keys(n.options).sort(), ["badge", "body", "icon", "tag"]);
  assert.equal(n.options.icon === pics[0], true, "the icon is the expected picture");
  assert.equal(n.options.badge === pics[1], true, "the badge is the expected picture");
  for (const s of [n.title, n.options.body, n.options.tag]) {
    assert.equal(typeof s, "string");
    assert.ok(!/[<>]|https?:|javascript:/i.test(s), "no markup or link in a note");
  }
  return { title: n.title, body: n.options.body, tag: n.options.tag };
}

const fixed = () => load(SW, { Date: fixedDate(FIXED_MS) });
const j = (o) => textData(JSON.stringify(o));

// ---- the templates ----
describe("sw.js templates", () => {
  const cases = [
    ["test", { k: "test" }, T.test],
    ["house 1 of 1", { k: "house", close: NOW + 7200, n: 1, of: 1 }, house(HOUSE_ONE, houseBody(fmt(NOW + 7200)))],
    ["house 2 of 3", { k: "house", close: NOW + 7200, n: 2, of: 3 }, house(houseMany(2, 3), houseBody(fmt(NOW + 7200)))],
    ["house 3 of 3", { k: "house", close: NOW + 4500, n: 3, of: 3 }, house(houseMany(3, 3), houseBody(fmt(NOW + 4500)))],
    ["house 1 of 2", { k: "house", close: NOW + 4500, n: 1, of: 2 }, house(houseMany(1, 2), houseBody(fmt(NOW + 4500)))],
    ["house 99 of 99", { k: "house", close: NOW + 4500, n: 99, of: 99 }, house(houseMany(99, 99), houseBody(fmt(NOW + 4500)))],
    ["house without n/of", { k: "house", close: NOW + 4500 }, house(HOUSE_ONE, houseBody(fmt(NOW + 4500)))],
    ["house without close", { k: "house", n: 2, of: 3 }, house(houseMany(2, 3), HOUSE_SOON)],
    ["house close = now - 1 day", { k: "house", close: NOW - 86400 }, house(HOUSE_ONE, houseBody(fmt(NOW - 86400)))],
    ["house close = now - 1 day - 1 s", { k: "house", close: NOW - 86401 }, house(HOUSE_ONE, HOUSE_SOON)],
    ["house close = now + 2 days", { k: "house", close: NOW + 172800 }, house(HOUSE_ONE, houseBody(fmt(NOW + 172800)))],
    ["house close = now + 2 days + 1 s", { k: "house", close: NOW + 172801 }, house(HOUSE_ONE, HOUSE_SOON)],
    ["pause", { k: "pause" }, T.pause],
    ["empty", { k: "empty" }, T.empty],
    ["version rc.17", { k: "version", v: "rc.17" }, version("New validator version: rc.17")],
    ["version rc.0", { k: "version", v: "rc.0" }, version("New validator version: rc.0")],
    ["version rc.999", { k: "version", v: "rc.999" }, version("New validator version: rc.999")],
    ["version without v", { k: "version" }, version("New validator version")],
    ["unknown k", { k: "party" }, T.town],
    ["no k", { n: 1 }, T.town],
    ["empty object", {}, T.town],
  ];
  for (const [name, msg, want] of cases) {
    test(name, async () => {
      assert.deepEqual(await push(fixed(), j(msg)), want);
    });
  }

  test("house time uses the real clock of the vm too", async () => {
    const close = Math.floor(Date.now() / 1000) + 3600;
    const got = await push(load(SW), j({ k: "house", close, n: 1, of: 1 }));
    assert.deepEqual(got, house(HOUSE_ONE, houseBody(fmt(close))));
  });

  test("the time text is a short clock time", () => {
    const s = fmt(NOW + 7200);
    assert.match(s, /\d/);
    assert.ok(s.length <= 12, s);
  });

  test("one worker shows many pushes, one note each", async () => {
    const env = fixed();
    for (let i = 0; i < 5; i++) assert.deepEqual(await push(env, j({ k: "pause" })), T.pause);
    assert.equal(env.rec.notes.length, 5);
  });

  test("payload read through json() when the data has no text()", async () => {
    const env = fixed();
    assert.deepEqual(await push(env, { json: () => ({ k: "empty" }) }), T.empty);
  });
});

// ---- hostile payloads ----
const SOME_CLOSE = NOW + 7200;
const HOSTILE = [
  ["no data (undefined)", undefined, T.town],
  ["no data (null)", null, T.town],
  ["empty text", textData(""), T.town],
  ["not JSON", textData("not json"), T.town],
  ["broken JSON", textData('{"k":"test"'), T.town],
  ["single quotes", textData("{'k':'test'}"), T.town],
  ["JSON with a byte order mark", textData('﻿{"k":"test"}'), T.town],
  ["text() throws", { text: () => { throw new Error("x"); }, json: () => { throw new Error("x"); } }, T.town],
  ["json() throws and no text()", { json: () => { throw new Error("x"); } }, T.town],
  ["data without text() or json()", { arrayBuffer: () => new ArrayBuffer(0) }, T.town],
  ["data is a string", '{"k":"test"}', T.town],
  ["text() gives a number", { text: () => 5 }, T.town],
  ["text() gives an object", { text: () => ({ k: "test" }) }, T.town],
  ["JSON null", textData("null"), T.town],
  ["JSON true", textData("true"), T.town],
  ["JSON number", textData("5"), T.town],
  ["JSON string", textData('"test"'), T.town],
  ["JSON empty array", textData("[]"), T.town],
  ["JSON array of k", textData('["test"]'), T.town],
  ["JSON array of objects", textData('[{"k":"test"}]'), T.town],
  ["json() gives an array", { json: () => [{ k: "test" }] }, T.town],
  ["huge text, valid test message inside", j({ k: "test", x: "A".repeat(5000) }), T.town],
  ["huge text, 1 MB of letters", textData("A".repeat(1 << 20)), T.town],
  ["huge v", j({ k: "version", v: "rc." + "1".repeat(3000) }), version("New validator version")],
  ["huge k", j({ k: "t".repeat(4000) }), T.town],
  ["huge n as string", j({ k: "house", n: "9".repeat(300), of: "9".repeat(300), close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["n = 1e400 (Infinity)", textData(`{"k":"house","n":1e400,"of":1e400,"close":${SOME_CLOSE}}`), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["HTML in k", j({ k: "<b>test</b>" }), T.town],
  [
    "HTML and links in other fields",
    j({
      k: "test",
      title: "<script>alert(1)</script>",
      body: "<img src=x onerror=alert(1)>",
      tag: "evil",
      icon: "https://evil.example/x.png",
      badge: "https://evil.example/b.png",
      url: "https://evil.example/",
      data: { url: "https://evil.example/" },
      actions: [{ action: "go", title: "Enter your seed phrase" }],
    }),
    T.test,
  ],
  ["HTML in v", j({ k: "version", v: "<b>rc.1</b>" }), version("New validator version")],
  ["HTML in n", j({ k: "house", n: "<i>2</i>", of: 3, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["HTML in close", j({ k: "house", close: "<b>19:00</b>" }), house(HOUSE_ONE, HOUSE_SOON)],
  ["k = __proto__", j({ k: "__proto__" }), T.town],
  ["own __proto__ key holding k", textData('{"__proto__":{"k":"test"}}'), T.town],
  [
    "own __proto__ key holding n/of",
    textData(`{"__proto__":{"n":2,"of":3},"k":"house","close":${SOME_CLOSE}}`),
    house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE))),
  ],
  ["k = constructor", j({ k: "constructor" }), T.town],
  ["k = toString", j({ k: "toString" }), T.town],
  ["k = hasOwnProperty", j({ k: "hasOwnProperty" }), T.town],
  ["k = valueOf", j({ k: "valueOf" }), T.town],
  ["k upper case", j({ k: "TEST" }), T.town],
  ["k with a space", j({ k: "test " }), T.town],
  ["k is a number", j({ k: 1 }), T.town],
  ["k is null", j({ k: null }), T.town],
  ["k is an array", j({ k: ["test"] }), T.town],
  ["k is an object", j({ k: { toString: "test" } }), T.town],
  ["duplicate k, last one wins", textData('{"k":"empty","k":"test"}'), T.test],
  ["n > of", j({ k: "house", n: 3, of: 2, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["n = 0", j({ k: "house", n: 0, of: 2, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["negative n", j({ k: "house", n: -1, of: 2, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["negative n and of", j({ k: "house", n: -3, of: -1, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["float n", j({ k: "house", n: 1.5, of: 2, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["float of", j({ k: "house", n: 2, of: 2.5, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["of = 100", j({ k: "house", n: 1, of: 100, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["n, of as strings", j({ k: "house", n: "2", of: "3", close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["n, of as booleans", j({ k: "house", n: true, of: true, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["n, of as arrays", j({ k: "house", n: [2], of: [3], close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["n, of null", j({ k: "house", n: null, of: null, close: SOME_CLOSE }), house(HOUSE_ONE, houseBody(fmt(SOME_CLOSE)))],
  ["close 30 days ahead", j({ k: "house", close: NOW + 30 * 86400 }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close 30 days ago", j({ k: "house", close: NOW - 30 * 86400 }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close 0", j({ k: "house", close: 0 }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close negative", j({ k: "house", close: -1 }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close 1e21", j({ k: "house", close: 1e21 }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close in milliseconds", j({ k: "house", close: FIXED_MS + 7200000 }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close float", j({ k: "house", close: NOW + 3600.5 }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close as string", j({ k: "house", close: String(SOME_CLOSE) }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close null", j({ k: "house", close: null }), house(HOUSE_ONE, HOUSE_SOON)],
  ["close array", j({ k: "house", close: [SOME_CLOSE] }), house(HOUSE_ONE, HOUSE_SOON)],
  ["v = rc.17<script>", j({ k: "version", v: "rc.17<script>" }), version("New validator version")],
  ["v = rc.1000", j({ k: "version", v: "rc.1000" }), version("New validator version")],
  ["v = RC.17", j({ k: "version", v: "RC.17" }), version("New validator version")],
  ["v with a leading space", j({ k: "version", v: " rc.17" }), version("New validator version")],
  ["v with a trailing new line", j({ k: "version", v: "rc.17\n" }), version("New validator version")],
  ["v = rc.-1", j({ k: "version", v: "rc.-1" }), version("New validator version")],
  ["v = rc.1.2", j({ k: "version", v: "rc.1.2" }), version("New validator version")],
  ["v = rc.", j({ k: "version", v: "rc." }), version("New validator version")],
  ["v = rcx17", j({ k: "version", v: "rcx17" }), version("New validator version")],
  ["v with other digits", j({ k: "version", v: "rc.١٧" }), version("New validator version")],
  ["v is a number", j({ k: "version", v: 17 }), version("New validator version")],
  ["v is an array", j({ k: "version", v: ["rc.17"] }), version("New validator version")],
  ["v is null", j({ k: "version", v: null }), version("New validator version")],
];

describe("sw.js hostile payloads: one note, template text only", () => {
  for (const [name, data, want] of HOSTILE) {
    test(name, async () => {
      const env = fixed();
      assert.deepEqual(await push(env, data), want);
      assert.deepEqual(env.rec.trapped, []);
    });
  }
});

// ---- click ----
function clickEvent(extra = {}) {
  const ev = {
    closed: 0,
    waits: [],
    notification: {
      title: "x",
      tag: "house",
      data: { url: "https://evil.example/" },
      close() {
        ev.closed++;
      },
    },
    action: "",
    waitUntil(p) {
      ev.waits.push(p);
    },
    ...extra,
  };
  return ev;
}

function win(url) {
  const w = {
    url,
    focused: 0,
    focus() {
      w.focused++;
      return Promise.resolve(w);
    },
  };
  return w;
}

async function click(env, extra) {
  const ev = clickEvent(extra);
  fire(env, "notificationclick", ev);
  assert.equal(ev.closed, 1, "notification closed once");
  assert.equal(ev.waits.length, 1, "waitUntil once");
  await Promise.all(ev.waits);
  assert.equal(env.rec.matchArgs.length, 1);
  assert.deepEqual({ ...env.rec.matchArgs[0] }, { type: "window", includeUncontrolled: true });
  for (const u of env.rec.opened) assert.equal(u, SCOPE);
  return ev;
}

for (const [label, text] of [["sw.js", SW], ["sw-off.js", OFF]]) {
  describe(`${label} notificationclick`, () => {
    test("no window open: opens the scope address", async () => {
      const env = load(text, { name: label });
      await click(env);
      assert.deepEqual(env.rec.opened, [SCOPE]);
    });

    test("focuses the first window under the scope, nothing else", async () => {
      const ws = [win("https://evil.example/"), win(SCOPE + "#house"), win(SCOPE)];
      const env = load(text, { name: label, windows: ws });
      await click(env);
      assert.deepEqual(ws.map((w) => w.focused), [0, 1, 0]);
      assert.deepEqual(env.rec.opened, []);
    });

    test("look-alike windows do not count: opens the scope address", async () => {
      const ws = [win("https://town.example.evil.example/"), win("http://town.example/"), { url: null }, win("")];
      const env = load(text, { name: label, windows: ws });
      await click(env);
      assert.deepEqual(ws.map((w) => w.focused || 0), [0, 0, 0, 0]);
      assert.deepEqual(env.rec.opened, [SCOPE]);
    });

    test("an action or a link in the notification data is ignored", async () => {
      const env = load(text, { name: label });
      await click(env, { action: "https://evil.example/" });
      assert.deepEqual(env.rec.opened, [SCOPE]);
    });

    test("matchAll failing does not throw and opens nothing else", async () => {
      const env = load(text, { name: label, matchAllFails: true });
      await click(env);
      assert.ok(env.rec.opened.length <= 1);
    });

    test("after a hostile push, the click still goes to the scope only", async () => {
      const env = load(text, { name: label });
      await push(env, j({ k: "test", url: "https://evil.example/" }), label === "sw-off.js" ? OFF_PICS : undefined);
      await click(env);
      assert.deepEqual(env.rec.opened, [SCOPE]);
    });
  });
}

// ---- install / activate / listeners ----
describe("sw.js life cycle", () => {
  test("listens to install, activate, push, notificationclick only (no fetch handler)", () => {
    const env = load(SW);
    assert.deepEqual([...env.rec.listeners.keys()].sort(), ["activate", "install", "notificationclick", "push"]);
    for (const fns of env.rec.listeners.values()) assert.equal(fns.length, 1);
  });

  test("install calls skipWaiting", async () => {
    const env = load(SW);
    const waits = [];
    fire(env, "install", { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(env.rec.skip, 1);
  });

  test("activate claims the clients", async () => {
    const env = load(SW);
    const waits = [];
    fire(env, "activate", { waitUntil: (p) => waits.push(p) });
    assert.equal(waits.length, 1);
    await Promise.all(waits);
    assert.equal(env.rec.claim, 1);
    assert.deepEqual(env.rec.trapped, []);
  });
});

// ---- sw-off.js ----
describe("sw-off.js", () => {
  function sub(rec, fails) {
    return {
      unsubscribe() {
        rec.unsub++;
        rec.order.push("unsubscribe");
        return fails ? Promise.reject(new Error("no")) : Promise.resolve(true);
      },
    };
  }

  async function activate(env) {
    const waits = [];
    fire(env, "activate", { waitUntil: (p) => waits.push(p) });
    assert.equal(waits.length, 1, "waitUntil once");
    await Promise.all(waits); // must not reject
  }

  test("listens to install, activate, push, notificationclick only", () => {
    const env = load(OFF, { name: "sw-off.js" });
    assert.deepEqual([...env.rec.listeners.keys()].sort(), ["activate", "install", "notificationclick", "push"]);
    for (const fns of env.rec.listeners.values()) assert.equal(fns.length, 1);
  });

  test("install calls skipWaiting", async () => {
    const env = load(OFF, { name: "sw-off.js" });
    const waits = [];
    fire(env, "install", { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.equal(env.rec.skip, 1);
  });

  test("activate with a subscription: unsubscribe, then unregister", async () => {
    const env = load(OFF, { name: "sw-off.js", sub: null });
    const s = sub(env.rec, false);
    env.g.registration.pushManager = { getSubscription: () => Promise.resolve(s) };
    await activate(env);
    assert.equal(env.rec.unsub, 1);
    assert.equal(env.rec.unreg, 1);
    assert.deepEqual(env.rec.order, ["unsubscribe", "unregister"]);
  });

  test("activate without a subscription: unregister only", async () => {
    const env = load(OFF, { name: "sw-off.js" });
    await activate(env);
    assert.equal(env.rec.unsub, 0);
    assert.equal(env.rec.unreg, 1);
  });

  test("activate: unsubscribe fails, still unregisters", async () => {
    const env = load(OFF, { name: "sw-off.js" });
    const s = sub(env.rec, true);
    env.g.registration.pushManager = { getSubscription: () => Promise.resolve(s) };
    await activate(env);
    assert.deepEqual(env.rec.order, ["unsubscribe", "unregister"]);
  });

  test("activate: getSubscription rejects, still unregisters", async () => {
    const env = load(OFF, {
      name: "sw-off.js",
      pushManager: { getSubscription: () => Promise.reject(new Error("no")) },
    });
    await activate(env);
    assert.equal(env.rec.unreg, 1);
  });

  test("activate: getSubscription throws, still unregisters", async () => {
    const env = load(OFF, {
      name: "sw-off.js",
      pushManager: {
        getSubscription() {
          throw new Error("no");
        },
      },
    });
    await activate(env);
    assert.equal(env.rec.unreg, 1);
  });

  test("activate: no push manager, still unregisters", async () => {
    const env = load(OFF, { name: "sw-off.js", pushManager: undefined });
    await activate(env);
    assert.equal(env.rec.unreg, 1);
  });

  test("activate: unregister failing does not reject", async () => {
    const env = load(OFF, { name: "sw-off.js", unregisterFails: true });
    await activate(env);
    assert.equal(env.rec.unreg, 1);
  });

  test("push fallback for a real message, no data and every hostile payload", async () => {
    const env = load(OFF, { name: "sw-off.js", Date: fixedDate(FIXED_MS) });
    const all = [["test message", j({ k: "test" })], ["house message", j({ k: "house", n: 2, of: 3, close: SOME_CLOSE })]];
    for (const [name, data] of [...all, ...HOSTILE.map(([n, d]) => [n, d])]) {
      assert.deepEqual(await push(env, data, OFF_PICS), T.town, name);
    }
    assert.deepEqual(env.rec.trapped, []);
  });
});

// ---- file text checks ----
describe("file text", () => {
  test("sw.js: the only data addresses are its two picture statements", () => {
    const found = SW.match(PICS) || [];
    assert.deepEqual(found.map((s) => s.slice(4, s.indexOf(" ="))), ["BELL_ICON", "BELL_BADGE"]);
    assert.equal(SW.split("data:").length - 1, 2, "no data address outside the two statements");
    assert.equal(SW_RULES.length, SW.length - found[0].length - found[1].length);
    assert.equal(SW.split("BELL_ICON").length - 1, 3, "BELL_ICON: the note, the statement, one use");
    assert.equal(SW.split("BELL_BADGE").length - 1, 3, "BELL_BADGE: the note, the statement, one use");
    assert.equal(OFF.match(PICS), null, "sw-off.js holds no picture");
    assert.ok(Buffer.from(ICON.slice(22), "base64").subarray(1, 4).equals(Buffer.from("PNG")), "icon is a PNG");
    assert.ok(Buffer.from(BADGE.slice(22), "base64").subarray(1, 4).equals(Buffer.from("PNG")), "badge is a PNG");
  });

  for (const [label, full, text] of [["sw.js", SW, SW_RULES], ["sw-off.js", OFF, OFF]]) {
    test(`${label} has no forbidden words`, () => {
      for (const w of ["fetch(", "importScripts", "eval", "Function(", "caches", "XMLHttpRequest", "WebSocket",
        "sendBeacon", "require(", "setTimeout", "setInterval", "postMessage", "innerHTML", "wallet", "seed", "verif",
        "password", "private key"]) {
        assert.ok(!text.includes(w), `${label} contains ${w}`);
      }
      assert.ok(!/^\s*(import|export)\b/m.test(text), "plain script, no module syntax");
      assert.ok(!/(?:https?|javascript|wss?):/i.test(text), "no link to any site");
      assert.ok(!/\bdata:[a-z]/i.test(text), "no data address");
      assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), "no e-mail address");
      assert.ok(!/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(text), "no IP address");
      assert.ok(!/0x[0-9a-fA-F]{40}/.test(text), "no wallet");
      assert.ok(!/\/(?:root|home|etc|var|tmp|opt)\//.test(text), "no server path");
      assert.ok(!/addEventListener\(\s*["']fetch["']/.test(text), "no fetch handler");
      assert.doesNotThrow(() => new vm.Script(full, { filename: label }), "plain script that compiles");
    });
  }

  test("sw.js holds every template text verbatim", () => {
    for (const s of [T.test.body, T.pause.body, T.empty.title, T.empty.body, T.town.body, HOUSE_ONE,
      " houses have not signed yet today", "Signing closes around ", ". Is your validator running?", HOUSE_SOON,
      "New validator version: ", "New validator version", VERSION_BODY]) {
      assert.ok(SW.includes(JSON.stringify(s).slice(1, -1)), s);
    }
  });
});

// ---- manifest ----
describe("manifest.webmanifest", () => {
  test("is the JSON of SPEC section 6", () => {
    assert.deepEqual(JSON.parse(MANIFEST), {
      id: "/",
      name: "6529 Town",
      short_name: "Town",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0b1020",
      theme_color: "#0b1020",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  });
});
