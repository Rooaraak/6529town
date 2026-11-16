// Tests for worker/src/push.js (owner W1).
// Run: nice -n 10 node --test test/push.test.mjs
// No network: every fetch here is a fake.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as push from "../worker/src/push.js";
import {
  makeReceiver,
  receiverFromKeys,
  receiverKeys,
  parseBody,
  decryptPush,
  decryptPushJson,
  toB64u,
  fromB64u,
} from "./recv.mjs";

const { b64uToBytes, bytesToB64u, pushHostOk, encryptPayload, vapidAuth, sendPush } = push;
const te = new TextEncoder();
const td = new TextDecoder();

// ---------------------------------------------------------------------------------------------
// RFC 8291, section 5 "Push Message Encryption Example" (values as printed, line pieces joined).
// The example's request line says "Content-Length: 145", but the body it shows is 192 base64url
// characters = 144 bytes (86 header + 41 plaintext + 1 delimiter + 16 tag); 144 is asserted below.
const RFC8291_S5 = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  receiverPublic: ["BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx", "aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"].join(""),
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  senderPublic: ["BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg", "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"].join(""),
  body: [
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  ].join(""),
};

// RFC 8291, Appendix A "Intermediate Values for Encryption" (same example).
const RFC8291_A = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  uaPublic: ["BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-", "JvLexhqUzORcx", "aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"].join(""),
  asPublic: ["BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg", "Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"].join(""),
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  prkKey: "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
  keyInfo: [
    "V2ViUHVzaDogaW5mbwAEJXGyvs3942BVG",
    "q8e0PTNNmwR",
    "zr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3",
    "ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0Ew",
    "bZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAv",
    "MBKiiujwa7t45ewP",
  ].join(""),
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cekInfo: "Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonceInfo: "Q29udGVudC1FbmNvZGluZzogbm9uY2UA",
  nonce: "4h_95klXJ5E_qnoN",
  header: [
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z",
    "9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
    "mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz",
    "AC8wEqKK6PBru3jl7A8",
  ].join(""),
  paddedPlaintext: ["V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0", "byBiZSBhIHdhdGVybWVsb24C"].join(""),
  ciphertext: ["8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd", "irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs", "bI_0LpXMuGvnzQ"].join(""),
};

// The RFC sender key as the private JWK that `inject.asPrivateJwk` takes.
function rfcSenderJwk() {
  const pub = fromB64u(RFC8291_S5.senderPublic);
  return {
    kty: "EC",
    crv: "P-256",
    x: toB64u(pub.subarray(1, 33)),
    y: toB64u(pub.subarray(33, 65)),
    d: RFC8291_S5.senderPrivate,
  };
}

// ---------------------------------------------------------------------------------------------
// helpers

const T = 1790000000; // a fixed "now" in unix seconds for VAPID tests
const NOW_MS = 1790000123456; // a fixed "now" in milliseconds for sendPush tests
const HEADER_B64U = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9"; // {"typ":"JWT","alg":"ES256"}

async function makeVapidEnv(extra = {}) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const j = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const jwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d, ...extra };
  return { env: { VAPID_JWK: JSON.stringify(jwk) }, jwk };
}

function parseVapid(value) {
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(value);
  assert.ok(m, "header value has the shape 'vapid t=<jwt>, k=<key>'");
  return {
    h: m[1],
    c: m[2],
    s: m[3],
    k: m[4],
    headerText: td.decode(fromB64u(m[1])),
    claimsText: td.decode(fromB64u(m[2])),
    claims: JSON.parse(td.decode(fromB64u(m[2]))),
    sig: fromB64u(m[3]),
    pub: fromB64u(m[4]),
  };
}

async function verifyVapid(v, publicKeyRaw = v.pub) {
  const key = await crypto.subtle.importKey("raw", publicKeyRaw, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
  // verify(algorithm, key, signature, data)
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, v.sig, te.encode(v.h + "." + v.c));
}

function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return typeof respond === "function" ? respond(url, init) : respond;
  };
  f.calls = calls;
  return f;
}

const GOOD_HOSTS = [
  "https://fcm.googleapis.com/fcm/send/cA1b2C3d4E5:APA91bH-x_y0z9",
  "https://jmt17.google.com/fcm/send/cA1b2C3d4E5:APA91bH-x_y0z9",
  "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABtestTOKEN-_",
  "https://web.push.apple.com/QGtestTOKEN-_0123456789",
  "https://wns2-ab1c.notify.windows.com/w/?token=BQYAAABtest%2bAA%3d%3d",
  "https://fcm.googleapis.com",
];

const AT = String.fromCharCode(64);

function exactLength(n) {
  const prefix = "https://fcm.googleapis.com/fcm/send/";
  return prefix + "a".repeat(n - prefix.length);
}

const BAD_HOSTS = [
  ["http:", "http://fcm.googleapis.com/fcm/send/x"],
  ["port 443 written out", "https://fcm.googleapis.com:443/fcm/send/x"],
  ["other port", "https://fcm.googleapis.com:8443/fcm/send/x"],
  // userinfo cases are joined at run time so no e-mail-shaped text sits in the file
  ["userinfo user", "https://user" + AT + "fcm.googleapis.com/fcm/send/x"],
  ["userinfo user:pass", "https://user:pass" + AT + "fcm.googleapis.com/fcm/send/x"],
  ["allowed name as userinfo", "https://fcm.googleapis.com" + AT + "evil.example/fcm/send/x"],
  // IP literals are built from documentation-range numbers at run time (no address text in files)
  ["IPv4 literal", "https://" + [192, 0, 2, 1].join(".") + "/fcm/send/x"],
  ["IPv4 literal, one number", "https://" + String(192 * 2 ** 24 + 2 * 2 ** 8 + 1) + "/fcm/send/x"],
  ["IPv4 literal, hex", "https://0x" + (192 * 2 ** 24 + 2 * 2 ** 8 + 1).toString(16) + "/fcm/send/x"],
  ["IPv6 literal", "https://[" + ["2001", "db8", "", "1"].join(":") + "]/fcm/send/x"],
  ["look-alike suffix", "https://evilfcm.googleapis.com.example/fcm/send/x"],
  ["look-alike prefix", "https://evilfcm.googleapis.com/fcm/send/x"],
  ["allowed name plus more", "https://fcm.googleapis.com.evil.example/fcm/send/x"],
  ["trailing dot", "https://fcm.googleapis.com./fcm/send/x"],
  ["trailing dot on suffix host", "https://web.push.apple.com./x"],
  ["upper case host", "https://FCM.googleapis.com/fcm/send/x"],
  ["mixed case host", "https://fcm.GoogleApis.com/fcm/send/x"],
  ["upper case suffix host", "https://Web.Push.Apple.com/x"],
  ["upper case scheme", "HTTPS://fcm.googleapis.com/fcm/send/x"],
  ["1025 chars", exactLength(1025)],
  ["fragment", "https://fcm.googleapis.com/fcm/send/x#frag"],
  ["empty fragment", "https://fcm.googleapis.com/fcm/send/x#"],
  ["suffix host without a label", "https://push.apple.com/x"],
  ["suffix host with an empty label", "https://.push.apple.com/x"],
  ["suffix as a prefix", "https://evilpush.apple.com/x"],
  ["windows suffix bare", "https://notify.windows.com/x"],
  ["windows suffix plus more", "https://wns2.notify.windows.com.evil.example/x"],
  ["backslash after host", "https://fcm.googleapis.com\\" + AT + "evil.example/x"],
  ["percent-encoded host", "https://fcm%2Egoogleapis.com/fcm/send/x"],
  ["leading space", " https://fcm.googleapis.com/fcm/send/x"],
  ["trailing newline", "https://fcm.googleapis.com/fcm/send/x\n"],
  ["tab inside host", "https://fcm.google\tapis.com/fcm/send/x"],
  ["non-ASCII look-alike", "https://ｆcm.googleapis.com/fcm/send/x"],
  ["RFC example host", "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV"],
  ["wss:", "wss://fcm.googleapis.com/x"],
  ["javascript:", "javascript:alert(1)"],
  ["no scheme", "fcm.googleapis.com/fcm/send/x"],
  ["scheme-relative", "//fcm.googleapis.com/fcm/send/x"],
  ["empty", ""],
  ["not a URL", "https://"],
];

// ---------------------------------------------------------------------------------------------

describe("base64url helpers", () => {
  test("RFC 4648 section 10 vectors, URL-safe alphabet, no padding", () => {
    const vectors = [
      ["", ""],
      ["f", "Zg"],
      ["fo", "Zm8"],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg"],
      ["fooba", "Zm9vYmE"],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [plain, enc] of vectors) {
      assert.equal(bytesToB64u(te.encode(plain)), enc);
      assert.equal(td.decode(b64uToBytes(enc)), plain);
    }
    assert.equal(bytesToB64u(new Uint8Array([0xfb, 0xff, 0xbf])), "-_-_");
    assert.deepEqual([...b64uToBytes("-_-_")], [0xfb, 0xff, 0xbf]);
  });

  test("round trip for every length 0..80 matches Node's base64url", () => {
    for (let n = 0; n <= 80; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      const s = bytesToB64u(b);
      assert.equal(s, Buffer.from(b).toString("base64url"));
      const back = b64uToBytes(s);
      assert.ok(back instanceof Uint8Array);
      assert.deepEqual([...back], [...b]);
    }
  });

  test("bytesToB64u takes ArrayBuffer and views", () => {
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    assert.equal(bytesToB64u(b.buffer), "AQIDBAU");
    assert.equal(bytesToB64u(new DataView(b.buffer, 1, 3)), "AgME");
  });

  test("b64uToBytes throws on bad characters, padding, bad length, non-string", () => {
    const bad = ["Zg==", "Zm8=", "Zm+v", "Zm/v", "Zm 9v", "Zm9v\n", "Z", "Zm9vY", "éé", "%41", "Zm9v="];
    for (const s of bad) assert.throws(() => b64uToBytes(s), TypeError, JSON.stringify(s));
    for (const v of [null, undefined, 12, {}, new Uint8Array(2)]) assert.throws(() => b64uToBytes(v), TypeError);
  });

  test("b64uToBytes accepts a non-canonical spelling (SPEC 5.2 lists only characters and length)", () => {
    assert.deepEqual([...b64uToBytes("Zh")], [0x66]); // unused low bits set, same byte as "Zg"
    assert.deepEqual([...b64uToBytes("Zm9")], [0x66, 0x6f]);
    assert.equal(b64uToBytes("x".repeat(22)).length, 16); // a hand-made 16-byte fixture
    assert.equal(b64uToBytes("x".repeat(87)).length, 65); // a hand-made 65-byte fixture
  });
});

describe("pushHostOk", () => {
  test("allowed push services", () => {
    for (const u of GOOD_HOSTS) assert.equal(pushHostOk(u), true, u);
  });

  test("length limit: 1024 is fine, 1025 is not", () => {
    assert.equal(exactLength(1024).length, 1024);
    assert.equal(pushHostOk(exactLength(1024)), true);
    assert.equal(exactLength(1025).length, 1025);
    assert.equal(pushHostOk(exactLength(1025)), false);
  });

  for (const [name, u] of BAD_HOSTS) {
    test(`refused: ${name}`, () => {
      assert.equal(pushHostOk(u), false);
    });
  }

  test("non-strings are refused, never thrown on", () => {
    for (const v of [null, undefined, 1, true, {}, [], new URL("https://fcm.googleapis.com/x"), Symbol("x")]) {
      assert.equal(pushHostOk(v), false);
    }
  });
});

describe("RFC 8291 section 5 example", () => {
  test("encryptPayload reproduces the example body byte for byte", async () => {
    const body = await encryptPayload(
      te.encode(RFC8291_S5.plaintext),
      fromB64u(RFC8291_S5.receiverPublic),
      fromB64u(RFC8291_S5.authSecret),
      { salt: fromB64u(RFC8291_A.salt), asPrivateJwk: rfcSenderJwk() },
    );
    assert.ok(body instanceof Uint8Array);
    assert.equal(body.length, 144);
    assert.equal(bytesToB64u(body), RFC8291_S5.body);
    assert.deepEqual(Buffer.from(body), Buffer.from(RFC8291_S5.body, "base64url"));
    // and its two halves against Appendix A
    assert.equal(toB64u(body.subarray(0, 86)), RFC8291_A.header);
    assert.equal(toB64u(body.subarray(86)), RFC8291_A.ciphertext);
  });

  test("the example values agree with each other", () => {
    assert.equal(RFC8291_A.uaPublic, RFC8291_S5.receiverPublic);
    assert.equal(RFC8291_A.asPublic, RFC8291_S5.senderPublic);
    assert.equal(td.decode(fromB64u(RFC8291_A.plaintext)), RFC8291_S5.plaintext);
    assert.equal(td.decode(fromB64u(RFC8291_A.paddedPlaintext)), RFC8291_S5.plaintext + "\x02");
    assert.equal(RFC8291_S5.body.length, 192);
  });

  test("test receiver (recv.mjs) matches every Appendix A intermediate value", async () => {
    const r = await receiverFromKeys({
      d: RFC8291_S5.receiverPrivate,
      publicKey: RFC8291_S5.receiverPublic,
      auth: RFC8291_S5.authSecret,
    });
    const k = await receiverKeys(r, fromB64u(RFC8291_A.asPublic), fromB64u(RFC8291_A.salt));
    assert.equal(toB64u(k.ecdh), RFC8291_A.ecdhSecret);
    assert.equal(toB64u(k.prkKey), RFC8291_A.prkKey);
    assert.equal(toB64u(k.keyInfo), RFC8291_A.keyInfo);
    assert.equal(toB64u(k.ikm), RFC8291_A.ikm);
    assert.equal(toB64u(k.prk), RFC8291_A.prk);
    assert.equal(toB64u(k.cekInfo), RFC8291_A.cekInfo);
    assert.equal(toB64u(k.cek), RFC8291_A.cek);
    assert.equal(toB64u(k.nonceInfo), RFC8291_A.nonceInfo);
    assert.equal(toB64u(k.nonce), RFC8291_A.nonce);
  });

  test("test receiver decrypts the RFC's own body with the RFC receiver key", async () => {
    const r = await receiverFromKeys({
      d: RFC8291_S5.receiverPrivate,
      publicKey: RFC8291_S5.receiverPublic,
      auth: RFC8291_S5.authSecret,
    });
    const plain = await decryptPush(fromB64u(RFC8291_S5.body), r);
    assert.equal(td.decode(plain), RFC8291_S5.plaintext);
    const h = parseBody(fromB64u(RFC8291_S5.body));
    assert.equal(h.rs, 4096);
    assert.equal(h.idlen, 65);
    assert.equal(toB64u(h.keyid), RFC8291_S5.senderPublic);
  });
});

describe("encryptPayload round trip", () => {
  test("a fresh test receiver decrypts to the same JSON", async () => {
    const r = await makeReceiver();
    const msg = { k: "test" };
    const plain = te.encode(JSON.stringify(msg));
    const body = await encryptPayload(plain, r.publicKey, r.auth);
    assert.ok(body instanceof Uint8Array);
    assert.equal(body.length, 86 + plain.length + 1 + 16);
    const h = parseBody(body);
    assert.equal(h.rs, 4096);
    assert.equal(h.idlen, 65);
    assert.equal(h.keyid[0], 4);
    assert.deepEqual(await decryptPushJson(body, r), msg);
  });

  test("new sender key pair and new salt for every message", async () => {
    const r = await makeReceiver();
    const plain = te.encode('{"k":"house","close":1790000000,"n":1,"of":1}');
    const a = await encryptPayload(plain, r.publicKey, r.auth);
    const b = await encryptPayload(plain, r.publicKey, r.auth);
    const ha = parseBody(a);
    const hb = parseBody(b);
    assert.notDeepEqual([...ha.salt], [...hb.salt]);
    assert.notDeepEqual([...ha.keyid], [...hb.keyid]);
    assert.notDeepEqual([...a], [...b]);
    assert.equal(td.decode(await decryptPush(a, r)), td.decode(plain));
    assert.equal(td.decode(await decryptPush(b, r)), td.decode(plain));
  });

  test("empty and maximum plaintext (3993 bytes) round trip; 3994 is refused", async () => {
    const r = await makeReceiver();
    const empty = await encryptPayload(new Uint8Array(0), r.publicKey, r.auth);
    assert.equal((await decryptPush(empty, r)).length, 0);
    const big = crypto.getRandomValues(new Uint8Array(3993));
    const body = await encryptPayload(big, r.publicKey, r.auth);
    assert.equal(body.length, 4096);
    assert.deepEqual([...(await decryptPush(body, r))], [...big]);
    await assert.rejects(encryptPayload(new Uint8Array(3994), r.publicKey, r.auth), RangeError);
  });

  test("another receiver, or the wrong auth secret, cannot decrypt", async () => {
    const r = await makeReceiver();
    const other = await makeReceiver();
    const body = await encryptPayload(te.encode('{"k":"test"}'), r.publicKey, r.auth);
    await assert.rejects(decryptPush(body, other));
    await assert.rejects(decryptPush(body, { ...r, auth: other.auth }));
  });

  test("bad receiver key or auth secret is refused", async () => {
    const r = await makeReceiver();
    const plain = te.encode('{"k":"test"}');
    await assert.rejects(encryptPayload(plain, r.publicKey.subarray(0, 64), r.auth));
    const notUncompressed = r.publicKey.slice();
    notUncompressed[0] = 3;
    await assert.rejects(encryptPayload(plain, notUncompressed, r.auth));
    const offCurve = new Uint8Array(65).fill(1);
    offCurve[0] = 4;
    await assert.rejects(encryptPayload(plain, offCurve, r.auth));
    await assert.rejects(encryptPayload(plain, r.publicKey, r.auth.subarray(0, 15)));
    await assert.rejects(encryptPayload(plain, r.publicKey, new Uint8Array(17)));
    await assert.rejects(encryptPayload("text", r.publicKey, r.auth));
  });
});

describe("RFC 8292 VAPID", () => {
  test("token verifies with the k= key; header and claims are exact", async () => {
    const { env, jwk } = await makeVapidEnv();
    const aud = "https://fcm.googleapis.com";
    const v = parseVapid(await vapidAuth(env, aud, T));
    assert.equal(v.h, HEADER_B64U);
    assert.equal(v.headerText, '{"typ":"JWT","alg":"ES256"}');
    assert.equal(v.claimsText, `{"aud":"https://fcm.googleapis.com","exp":${T + 43200},"sub":"https://6529town.com"}`);
    assert.deepEqual(Object.keys(v.claims), ["aud", "exp", "sub"]);
    assert.equal(v.sig.length, 64, "raw r|s signature");
    assert.equal(v.pub.length, 65);
    assert.equal(v.pub[0], 4);
    assert.equal(toB64u(v.pub.subarray(1, 33)), jwk.x);
    assert.equal(toB64u(v.pub.subarray(33)), jwk.y);
    assert.equal(await verifyVapid(v), true);
    // the same check with the public JWK from the env key
    const pubKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    assert.equal(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, v.sig, te.encode(v.h + "." + v.c)),
      true,
    );
    assert.ok(!v.claimsText.includes("mailto") && !v.claimsText.includes(AT), "no e-mail in sub");
  });

  test("a changed claim or another key does not verify", async () => {
    const { env } = await makeVapidEnv();
    const v = parseVapid(await vapidAuth(env, "https://updates.push.services.mozilla.com", T));
    const forged = toB64u(te.encode(v.claimsText.replace(String(T + 43200), String(T + 86400))));
    assert.equal(await verifyVapid({ ...v, c: forged }), false);
    const other = await makeVapidEnv();
    const ov = parseVapid(await vapidAuth(other.env, "https://updates.push.services.mozilla.com", T));
    assert.equal(await verifyVapid(v, ov.pub), false);
  });

  test("cached token reused while exp - now > 3600, renewed at exactly 3600", async () => {
    const { env } = await makeVapidEnv();
    const aud = "https://edge1.push.apple.com";
    const first = await vapidAuth(env, aud, T);
    assert.equal(await vapidAuth(env, aud, T + 1), first);
    assert.equal(await vapidAuth(env, aud, T + 43200 - 3601), first, "3601 s left: reuse");
    const renewed = await vapidAuth(env, aud, T + 43200 - 3600);
    assert.notEqual(renewed, first, "3600 s left: renew");
    const rv = parseVapid(renewed);
    assert.equal(rv.claims.exp, T + 43200 - 3600 + 43200);
    assert.equal(rv.claims.aud, aud);
    assert.equal(await verifyVapid(rv), true);
    assert.equal(await vapidAuth(env, aud, T + 43200 - 3599), renewed, "the new token is cached in turn");
  });

  test("cache is per audience", async () => {
    const { env } = await makeVapidEnv();
    const a1 = "https://audience-a.notify.windows.com";
    const a2 = "https://audience-b.notify.windows.com";
    const t1 = await vapidAuth(env, a1, T);
    const t2 = await vapidAuth(env, a2, T);
    assert.notEqual(t1, t2);
    assert.equal(parseVapid(t1).claims.aud, a1);
    assert.equal(parseVapid(t2).claims.aud, a2);
    assert.equal(await vapidAuth(env, a1, T + 10), t1);
    assert.equal(await vapidAuth(env, a2, T + 10), t2);
  });

  test("another key for the same audience gets its own token", async () => {
    const one = await makeVapidEnv();
    const two = await makeVapidEnv();
    const aud = "https://edge2.push.apple.com";
    const t1 = await vapidAuth(one.env, aud, T);
    const t2 = await vapidAuth(two.env, aud, T);
    assert.notEqual(t1, t2);
    assert.equal(await verifyVapid(parseVapid(t2)), true);
    assert.equal(parseVapid(t2).k, toB64u(new Uint8Array([4, ...fromB64u(two.jwk.x), ...fromB64u(two.jwk.y)])));
  });

  test("a clock that went back gets a fresh token, never one more than 12 h ahead", async () => {
    const { env } = await makeVapidEnv();
    const aud = "https://edge3.push.apple.com";
    const t1 = await vapidAuth(env, aud, T);
    const back = await vapidAuth(env, aud, T - 100);
    assert.notEqual(back, t1);
    assert.equal(parseVapid(back).claims.exp, T - 100 + 43200);
  });

  test("extra JWK fields (key_ops, ext, use) do not break the import", async () => {
    const { env } = await makeVapidEnv({ key_ops: ["verify"], ext: true, use: "enc", alg: "ES256" });
    const v = parseVapid(await vapidAuth(env, "https://edge4.push.apple.com", T));
    assert.equal(await verifyVapid(v), true);
  });

  test("bad key, audience or time rejects", async () => {
    const { env, jwk } = await makeVapidEnv();
    const aud = "https://fcm.googleapis.com";
    await assert.rejects(vapidAuth({}, aud, T));
    await assert.rejects(vapidAuth(undefined, aud, T));
    await assert.rejects(vapidAuth({ VAPID_JWK: "{not json" }, aud, T));
    await assert.rejects(vapidAuth({ VAPID_JWK: JSON.stringify({ ...jwk, d: undefined }) }, aud, T));
    await assert.rejects(vapidAuth({ VAPID_JWK: JSON.stringify({ ...jwk, crv: "P-384" }) }, aud, T));
    await assert.rejects(vapidAuth({ VAPID_JWK: JSON.stringify(jwk).replace(jwk.x, "AAAA") }, aud, T));
    await assert.rejects(vapidAuth(env, "https://fcm.googleapis.com/fcm/send/x", T));
    await assert.rejects(vapidAuth(env, "http://fcm.googleapis.com", T));
    await assert.rejects(vapidAuth(env, "", T));
    await assert.rejects(vapidAuth(env, aud, NaN));
    await assert.rejects(vapidAuth(env, aud, 0));
  });
});

describe("sendPush", () => {
  const ENDPOINT = "https://fcm.googleapis.com/fcm/send/cTestToken:APA91b-test_0";
  const OPT = { ttl: 300, urgency: "normal", topic: "test" };

  async function setup() {
    const { env } = await makeVapidEnv();
    const r = await makeReceiver();
    return { env, r, sub: { e: ENDPOINT, p: r.p, a: r.a } };
  }

  test("posts one encrypted request with the exact headers and returns the status", async () => {
    const { env, r, sub } = await setup();
    const f = fakeFetch({ status: 201 });
    const out = await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS });
    assert.deepEqual(out, { status: 201 });
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, ENDPOINT);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.deepEqual(Object.keys(init.headers).sort(), [
      "Authorization",
      "Content-Encoding",
      "Content-Type",
      "TTL",
      "Topic",
      "Urgency",
    ]);
    assert.equal(init.headers.TTL, "300");
    assert.equal(init.headers.Urgency, "normal");
    assert.equal(init.headers.Topic, "test");
    assert.equal(init.headers["Content-Encoding"], "aes128gcm");
    assert.equal(init.headers["Content-Type"], "application/octet-stream");
    const v = parseVapid(init.headers.Authorization);
    assert.equal(v.claims.aud, "https://fcm.googleapis.com");
    assert.equal(v.claims.exp, Math.floor(NOW_MS / 1000) + 43200);
    assert.equal(v.claims.sub, "https://6529town.com");
    assert.equal(await verifyVapid(v), true);
    assert.ok(init.body instanceof Uint8Array);
    assert.deepEqual(await decryptPushJson(init.body, r), { k: "test" });
  });

  test("audience is the origin of the endpoint", async () => {
    const { env, r } = await setup();
    const cases = [
      ["https://web.push.apple.com/QGtestTOKEN", "https://web.push.apple.com"],
      ["https://wns2-ab1c.notify.windows.com/w/?token=BQYAAABtest%2bAA%3d%3d", "https://wns2-ab1c.notify.windows.com"],
      ["https://updates.push.services.mozilla.com/wpush/v2/gAAAAABtest", "https://updates.push.services.mozilla.com"],
    ];
    for (const [e, origin] of cases) {
      const f = fakeFetch({ status: 201 });
      const out = await sendPush(env, { e, p: r.p, a: r.a }, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS });
      assert.equal(out.status, 201);
      assert.equal(f.calls[0].url, e);
      assert.equal(parseVapid(f.calls[0].init.headers.Authorization).claims.aud, origin);
    }
  });

  test("every message in the spec's shapes decrypts back unchanged", async () => {
    const { env, r, sub } = await setup();
    const msgs = [
      [{ k: "test" }, { ttl: 300, urgency: "high", topic: "test" }],
      [{ k: "house", close: 1790035200, n: 2, of: 3 }, { ttl: 7200, urgency: "high", topic: "house" }],
      [{ k: "pause" }, { ttl: 43200, urgency: "high", topic: "house" }],
      [{ k: "empty" }, { ttl: 43200, urgency: "high", topic: "empty" }],
      [{ k: "version", v: "rc.17" }, { ttl: 43200, urgency: "high", topic: "version" }],
    ];
    for (const [msg, opt] of msgs) {
      const f = fakeFetch({ status: 201 });
      assert.equal((await sendPush(env, sub, msg, opt, { fetch: f, now: () => NOW_MS })).status, 201);
      const { init } = f.calls[0];
      assert.equal(init.headers.TTL, String(opt.ttl));
      assert.equal(init.headers.Urgency, opt.urgency);
      assert.equal(init.headers.Topic, opt.topic);
      assert.deepEqual(await decryptPushJson(init.body, r), msg);
    }
  });

  test("push service status is passed through (also redirects, not followed)", async () => {
    const { env, sub } = await setup();
    for (const s of [200, 201, 202, 301, 302, 400, 401, 403, 404, 410, 413, 429, 500, 503]) {
      const f = fakeFetch({ status: s });
      assert.deepEqual(await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS }), { status: s });
      assert.equal(f.calls.length, 1);
    }
  });

  test("a real Response object works and its body is not needed", async () => {
    const { env, sub } = await setup();
    const f = fakeFetch(() => new Response("some text from the push service", { status: 410 }));
    assert.deepEqual(await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS }), { status: 410 });
  });

  test("Topic header left out when no topic is given; urgency defaults to normal", async () => {
    const { env, sub } = await setup();
    const f = fakeFetch({ status: 201 });
    await sendPush(env, sub, { k: "test" }, { ttl: 60 }, { fetch: f, now: () => NOW_MS });
    assert.equal("Topic" in f.calls[0].init.headers, false);
    assert.equal(f.calls[0].init.headers.Urgency, "normal");
    assert.equal(f.calls[0].init.headers.TTL, "60");
  });

  test("bad host: {status: -1} and fetch is never called", async () => {
    const { env, r } = await setup();
    const f = fakeFetch({ status: 201 });
    for (const [, e] of BAD_HOSTS) {
      const out = await sendPush(env, { e, p: r.p, a: r.a }, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS });
      assert.deepEqual(out, { status: -1 }, e);
    }
    for (const e of [null, undefined, 5, {}]) {
      assert.deepEqual(await sendPush(env, { e, p: r.p, a: r.a }, { k: "test" }, OPT, { fetch: f }), { status: -1 });
    }
    assert.equal(f.calls.length, 0);
  });

  test("fetch rejects (network error): {status: 0}", async () => {
    const { env, sub } = await setup();
    const f = fakeFetch(() => Promise.reject(new TypeError("network down")));
    assert.deepEqual(await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS }), { status: 0 });
    assert.equal(f.calls.length, 1);
  });

  test("fetch throws synchronously: {status: 0}", async () => {
    const { env, sub } = await setup();
    const f = () => {
      throw new Error("boom");
    };
    assert.deepEqual(await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS }), { status: 0 });
  });

  test("fetch rejects with a timeout error: {status: 0}", async () => {
    const { env, sub } = await setup();
    const f = fakeFetch(() => Promise.reject(new DOMException("The operation timed out.", "TimeoutError")));
    assert.deepEqual(await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS }), { status: 0 });
  });

  test("timeout is AbortSignal.timeout(8000) and a hanging fetch ends as {status: 0}", async () => {
    const { env, sub } = await setup();
    const realTimeout = AbortSignal.timeout;
    const asked = [];
    AbortSignal.timeout = (ms) => {
      asked.push(ms);
      return realTimeout.call(AbortSignal, 20); // same path, but do not wait 8 s in a test
    };
    // Node does not let an AbortSignal.timeout timer keep the process alive; this timer does.
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      const hanging = (url, init) =>
        new Promise((resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      const out = await sendPush(env, sub, { k: "test" }, OPT, { fetch: hanging, now: () => NOW_MS });
      assert.deepEqual(out, { status: 0 });
      assert.deepEqual(asked, [8000]);
    } finally {
      clearTimeout(keepAlive);
      AbortSignal.timeout = realTimeout;
    }
  });

  test("fetch gives no usable status: {status: 0}", async () => {
    const { env, sub } = await setup();
    for (const res of [null, undefined, {}, { status: "201" }, { status: 201.5 }, { status: -3 }, 42]) {
      const f = fakeFetch(res);
      assert.deepEqual(await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS }), { status: 0 });
    }
    const throwing = fakeFetch({
      get status() {
        throw new Error("no");
      },
    });
    assert.deepEqual(await sendPush(env, sub, { k: "test" }, OPT, { fetch: throwing, now: () => NOW_MS }), {
      status: 0,
    });
  });

  test("bad input is refused before any network call: {status: -1}", async () => {
    const { env, r, sub } = await setup();
    const f = fakeFetch({ status: 201 });
    const deps = { fetch: f, now: () => NOW_MS };
    const big = { k: "x".repeat(300) };
    const cases = [
      [env, null, { k: "test" }, OPT, deps],
      [env, "not an object", { k: "test" }, OPT, deps],
      [env, { ...sub, p: "not+base64url" }, { k: "test" }, OPT, deps],
      [env, { ...sub, p: r.a }, { k: "test" }, OPT, deps],
      [env, { ...sub, p: undefined }, { k: "test" }, OPT, deps],
      [env, { ...sub, a: r.p }, { k: "test" }, OPT, deps],
      [env, { ...sub, a: "" }, { k: "test" }, OPT, deps],
      [env, sub, null, OPT, deps],
      [env, sub, "text", OPT, deps],
      [env, sub, ["k", "test"], OPT, deps],
      [env, sub, new Date(0), OPT, deps],
      [env, sub, big, OPT, deps],
      [env, sub, { k: 1n }, OPT, deps],
      [env, sub, { k: "test" }, undefined, deps],
      [env, sub, { k: "test" }, { ...OPT, ttl: -1 }, deps],
      [env, sub, { k: "test" }, { ...OPT, ttl: 1.5 }, deps],
      [env, sub, { k: "test" }, { ...OPT, ttl: "300" }, deps],
      [env, sub, { k: "test" }, { ...OPT, ttl: 2419201 }, deps],
      [env, sub, { k: "test" }, { ...OPT, urgency: "urgent" }, deps],
      [env, sub, { k: "test" }, { ...OPT, topic: "has space" }, deps],
      [env, sub, { k: "test" }, { ...OPT, topic: "t".repeat(33) }, deps],
      [env, sub, { k: "test" }, { ...OPT, topic: "" }, deps],
      [{}, sub, { k: "test" }, OPT, deps],
      [null, sub, { k: "test" }, OPT, deps],
      [{ VAPID_JWK: "{bad json" }, sub, { k: "test" }, OPT, deps],
      [env, sub, { k: "test" }, OPT, { fetch: "not a function", now: () => NOW_MS }],
      [env, sub, { k: "test" }, OPT, { fetch: f, now: () => NaN }],
      [env, sub, { k: "test" }, OPT, { fetch: f, now: () => -5 }],
    ];
    for (const args of cases) {
      assert.deepEqual(await sendPush(...args), { status: -1 });
    }
    assert.equal(f.calls.length, 0);
  });

  test("message size limit: 256 bytes of JSON is fine, 257 is refused", async () => {
    const { env, sub } = await setup();
    const fill = (n) => ({ k: "x".repeat(n - '{"k":""}'.length) });
    assert.equal(JSON.stringify(fill(256)).length, 256);
    const f = fakeFetch({ status: 201 });
    assert.equal((await sendPush(env, sub, fill(256), OPT, { fetch: f, now: () => NOW_MS })).status, 201);
    assert.equal((await sendPush(env, sub, fill(257), OPT, { fetch: f, now: () => NOW_MS })).status, -1);
    assert.equal(f.calls.length, 1);
  });

  test("never throws, whatever it is given", async () => {
    const { env, sub } = await setup();
    const evil = {
      get e() {
        throw new Error("getter");
      },
    };
    const evilMsg = {
      toJSON() {
        throw new Error("toJSON");
      },
    };
    const evilDeps = {
      get fetch() {
        throw new Error("getter");
      },
    };
    const calls = [
      [],
      [undefined, undefined, undefined, undefined, undefined],
      [env, evil, { k: "test" }, OPT],
      [env, sub, evilMsg, OPT, { fetch: fakeFetch({ status: 201 }) }],
      [env, sub, { k: "test" }, OPT, evilDeps],
      [
        env,
        sub,
        { k: "test" },
        OPT,
        {
          fetch: fakeFetch({ status: 201 }),
          now: () => {
            throw new Error("clock");
          },
        },
      ],
    ];
    for (const args of calls) {
      const out = await sendPush(...args);
      assert.ok(out && (out.status === -1 || out.status === 0), JSON.stringify(out));
    }
  });

  test("now() in seconds still gives a valid token time", async () => {
    const { env, sub } = await setup();
    const f = fakeFetch({ status: 201 });
    await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => Math.floor(NOW_MS / 1000) });
    assert.equal(parseVapid(f.calls[0].init.headers.Authorization).claims.exp, Math.floor(NOW_MS / 1000) + 43200);
  });

  test("defaults: global fetch and Date.now when deps is left out", async () => {
    const { env, r, sub } = await setup();
    const realFetch = globalThis.fetch;
    const f = fakeFetch({ status: 202 });
    globalThis.fetch = f;
    try {
      const before = Math.floor(Date.now() / 1000);
      const out = await sendPush(env, sub, { k: "test" }, OPT);
      const after = Math.floor(Date.now() / 1000);
      assert.deepEqual(out, { status: 202 });
      assert.equal(f.calls.length, 1);
      const exp = parseVapid(f.calls[0].init.headers.Authorization).claims.exp;
      assert.ok(exp >= before + 43200 && exp <= after + 43200);
      assert.deepEqual(await decryptPushJson(f.calls[0].init.body, r), { k: "test" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("two sends: fresh salt and sender key each time, same cached VAPID token", async () => {
    const { env, r, sub } = await setup();
    const f = fakeFetch({ status: 201 });
    await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS });
    await sendPush(env, sub, { k: "test" }, OPT, { fetch: f, now: () => NOW_MS + 5000 });
    const [a, b] = f.calls.map((c) => parseBody(c.init.body));
    assert.notDeepEqual([...a.salt], [...b.salt]);
    assert.notDeepEqual([...a.keyid], [...b.keyid]);
    assert.equal(f.calls[0].init.headers.Authorization, f.calls[1].init.headers.Authorization);
    for (const c of f.calls) assert.deepEqual(await decryptPushJson(c.init.body, r), { k: "test" });
  });
});

describe("push.js source rules (bundle.py joins it with api.js and main.js)", () => {
  const SRC_URL = new URL("../worker/src/push.js", import.meta.url);

  test("exports exactly the six spec names", () => {
    assert.deepEqual(Object.keys(push).sort(), [
      "b64uToBytes",
      "bytesToB64u",
      "encryptPayload",
      "pushHostOk",
      "sendPush",
      "vapidAuth",
    ]);
  });

  test("ends with one export line; no import, Node API, logging or eval", async () => {
    const src = await readFile(SRC_URL, "utf8");
    const lines = src.split("\n");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    const last = lines[lines.length - 1];
    assert.match(last, /^export \{ [A-Za-z0-9_, ]+ \};$/);
    assert.equal(lines.filter((l) => /^\s*export\b/.test(l)).length, 1, "only one export line");
    assert.equal(lines.filter((l) => /^import /.test(l)).length, 0, "no import lines");
    for (const bad of ["require(", "process.", "Buffer", "console.", "eval(", "Function(", "importScripts", "node:", "globalThis"]) {
      assert.equal(src.includes(bad), false, `push.js must not contain ${bad}`);
    }
  });

  test("no e-mail address or IP address in the file", async () => {
    const src = await readFile(SRC_URL, "utf8");
    assert.doesNotMatch(src, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    assert.doesNotMatch(src, /mailto:/i);
    assert.doesNotMatch(src, /\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });
});
