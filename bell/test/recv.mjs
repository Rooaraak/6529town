// Test helper: the RECEIVING side of web push (what a browser does with a push body).
// RFC 8291 key combining + RFC 8188 "aes128gcm" decoding, WebCrypto only.
// It follows the RFC 8291 section 3.4 steps literally with plain HMAC-SHA-256, while push.js uses the
// WebCrypto HKDF call, so a round trip through both is a real cross-check and not a mirror.
// Used by push.test.mjs and by the end-to-end test. Imports nothing from the worker.

const te = new TextEncoder();

function bytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError("recv: bytes expected");
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toB64u(u8) {
  return Buffer.from(bytes(u8)).toString("base64url");
}

export function fromB64u(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) throw new TypeError("recv: bad base64url");
  return new Uint8Array(Buffer.from(s, "base64url"));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// A fresh test browser: P-256 key pair + 16-byte auth secret.
// p / a are the strings a browser puts in PushSubscription.toJSON().keys.
export async function makeReceiver() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: pair.privateKey, publicKey, auth, p: toB64u(publicKey), a: toB64u(auth) };
}

// A receiver from known values (base64url): private scalar d, uncompressed public key, auth secret.
export async function receiverFromKeys({ d, publicKey, auth }) {
  const pub = fromB64u(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new TypeError("recv: bad public key");
  const jwk = { kty: "EC", crv: "P-256", x: toB64u(pub.subarray(1, 33)), y: toB64u(pub.subarray(33)), d };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ]);
  const authBytes = fromB64u(auth);
  if (authBytes.length !== 16) throw new TypeError("recv: bad auth");
  return { privateKey, publicKey: pub, auth: authBytes, p: publicKey, a: auth };
}

// Split an aes128gcm body: salt(16) | rs(4) | idlen(1) | keyid(idlen) | ciphertext.
export function parseBody(body) {
  const b = bytes(body);
  if (b.length < 21) throw new Error("recv: body too short");
  const salt = b.slice(0, 16);
  const rs = ((b[16] << 24) >>> 0) + (b[17] << 16) + (b[18] << 8) + b[19];
  const idlen = b[20];
  if (b.length < 21 + idlen) throw new Error("recv: body too short for keyid");
  const keyid = b.slice(21, 21 + idlen);
  const ciphertext = b.slice(21 + idlen);
  return { salt, rs, idlen, keyid, ciphertext };
}

// RFC 8291 section 3.4, step by step (user agent side).
export async function receiverKeys(receiver, asPublic, salt) {
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, receiver.privateKey, 256));
  const prkKey = await hmac(receiver.auth, ecdh);
  const keyInfo = concat([te.encode("WebPush: info"), [0], receiver.publicKey, asPublic]);
  const ikm = await hmac(prkKey, concat([keyInfo, [1]]));
  const prk = await hmac(salt, ikm);
  const cekInfo = concat([te.encode("Content-Encoding: aes128gcm"), [0]]);
  const cek = (await hmac(prk, concat([cekInfo, [1]]))).slice(0, 16);
  const nonceInfo = concat([te.encode("Content-Encoding: nonce"), [0]]);
  const nonce = (await hmac(prk, concat([nonceInfo, [1]]))).slice(0, 12);
  return { ecdh, prkKey, keyInfo, ikm, prk, cekInfo, cek, nonceInfo, nonce };
}

// Decrypt one push body for `receiver` (from makeReceiver / receiverFromKeys). Returns the plaintext
// bytes. Throws on anything a browser would drop: bad header, more than one record, bad tag,
// missing 0x02 delimiter.
export async function decryptPush(body, receiver) {
  const { salt, rs, idlen, keyid, ciphertext } = parseBody(body);
  if (idlen !== 65 || keyid[0] !== 4) throw new Error("recv: keyid is not an uncompressed P-256 key");
  if (rs < 18) throw new Error("recv: rs too small");
  if (ciphertext.length < 17) throw new Error("recv: ciphertext too short");
  if (ciphertext.length > rs) throw new Error("recv: more than one record");
  const { cek, nonce } = await receiverKeys(receiver, keyid, salt);
  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, ciphertext));
  let i = padded.length - 1;
  while (i >= 0 && padded[i] === 0) i--;
  if (i < 0 || padded[i] !== 2) throw new Error("recv: missing 0x02 delimiter");
  return padded.slice(0, i);
}

export async function decryptPushJson(body, receiver) {
  const plain = await decryptPush(body, receiver);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
}
