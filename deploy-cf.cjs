// 6529 Town -> Cloudflare Pages (Direct Upload over the REST API, no wrangler needed).
// usage: node deploy-cf.cjs [--create]     (needs CF_PROJECT, CF_TOKEN_FILE and CF_ACCOUNT_FILE; keep the two files readable only by you)
// Uploads dist/site/ (the page, the link-preview picture, v.json, 404.html) and the songs in music/ to the
// Cloudflare Pages project named in CF_PROJECT.
// Asset hash = BLAKE3(base64(content) + extension) hex[0:32], as wrangler does; BLAKE3 from @noble/hashes.
const fs = require("fs");
const { blake3 } = require(process.env.NOBLE_BLAKE3 || "@noble/hashes/blake3");
if (!process.env.CF_PROJECT || !process.env.CF_TOKEN_FILE || !process.env.CF_ACCOUNT_FILE) {
  console.error("DEPLOY FAILED: set CF_PROJECT, CF_TOKEN_FILE and CF_ACCOUNT_FILE (see config.example.env)"); process.exit(1);
}
const TOKEN = fs.readFileSync(process.env.CF_TOKEN_FILE, "utf8").trim();
const ACCOUNT = fs.readFileSync(process.env.CF_ACCOUNT_FILE, "utf8").trim();
const PROJECT = process.env.CF_PROJECT;
// nothing secret in an error text: the API token, the account ID and the upload token are cut out before anything is printed
let UPLOAD_JWT = "";
const scrub = (s) => [[TOKEN, "<token>"], [ACCOUNT, "<acct>"], [UPLOAD_JWT, "<upload-token>"]].reduce((x, [k, v]) => (k ? x.split(k).join(v) : x), String(s));
// your own private words for the leak gate: leak-extra.txt next to this file, one regular expression per line
const EXTRA = !fs.existsSync(__dirname + "/leak-extra.txt") ? [] : fs.readFileSync(__dirname + "/leak-extra.txt", "utf8")
  .split("\n").map((l, i) => [l.trim(), i + 1]).filter(([l]) => l && !l.startsWith("#")).map(([l, n]) => {
    try { return new RegExp(l, "i"); }   // a broken line is named by its number, never shown
    catch (e) { console.error("DEPLOY FAILED: leak-extra.txt line " + n + " is not a valid JavaScript pattern"); process.exit(1); }
  });
const API = "https://api.cloudflare.com/client/v4";
const FILES = { "/index.html": { path: __dirname + "/dist/site/index.html", type: "text/html" } };
// the link-preview picture is optional: a first run where og.cjs failed still uploads the page
if (fs.existsSync(__dirname + "/dist/site/og.jpg")) FILES["/og.jpg"] = { path: __dirname + "/dist/site/og.jpg", type: "image/jpeg" };
else console.log("note: dist/site/og.jpg (the link-preview picture) is missing, uploading without it");
// only a build of the newer town (step 14) writes these two: the newest reading's time, and the "not found" page
for (const [route, name, type] of [["/v.json", "v.json", "application/json"], ["/404.html", "404.html", "text/html"]]) {
  const p = __dirname + "/dist/site/" + name; if (fs.existsSync(p)) FILES[route] = { path: p, type };
}
// town radio (deploy patch 26): the songs sit next to the page (s1-s8 = phones, p2-p8 = computers); no music folder = no change
const MUSIC = __dirname + "/music";
if (fs.existsSync(MUSIC)) for (const name of fs.readdirSync(MUSIC).filter((n) => /^(s[1-8]|p[2-8])\.mp3$/.test(n)).sort())
  FILES["/" + name] = { path: MUSIC + "/" + name, type: "audio/mpeg" };
// a page with the next-song button plays these songs: it never goes up without all 15 (the last good deployment stays)
if (fs.existsSync(FILES["/index.html"].path) && fs.readFileSync(FILES["/index.html"].path, "utf8").includes('id="snd-nx"')) {
  const gone = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "p2", "p3", "p4", "p5", "p6", "p7", "p8"].filter((n) => !FILES["/" + n + ".mp3"]);
  if (gone.length) { console.error("DEPLOY FAILED: the page plays songs, but music/ lacks " + gone.map((n) => n + ".mp3").join(" ")); process.exit(1); }
}

async function cf(path, opts = {}, auth = TOKEN) {
  const r = await fetch(path.startsWith("http") ? path : API + path, { ...opts, headers: { Authorization: "Bearer " + auth, ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({ success: false, errors: [{ message: "HTTP " + r.status + " (not JSON)" }] }));
  if (!j.success) throw new Error(scrub(path) + ": " + scrub(JSON.stringify(j.errors || j)).slice(0, 400));
  return j.result;
}
const hashOf = (buf, ext) => Buffer.from(blake3(Buffer.from(buf.toString("base64") + ext))).toString("hex").slice(0, 32);

(async () => {
  // a shorter version of the build's privacy check, once more, before anything goes public
  for (const [route, f] of Object.entries(FILES)) {
    if (f.type === "image/jpeg" || f.type === "audio/mpeg") continue;
    const text = fs.readFileSync(f.path, "utf8").replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, "");
    for (const re of [/0x[0-9a-fA-F]{8,}/, /12D3Koo/, /DESKTOP-/i, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, /0x[0-9a-fA-F]{4}…/, /This PC/i, ...EXTRA])
      if (re.test(text)) throw new Error("leak gate tripped in " + route + ": " + (EXTRA.includes(re) ? "a pattern from leak-extra.txt (not shown)" : re));
  }
  if (process.argv.includes("--dry")) { console.log("dry run, would upload:", Object.keys(FILES).join(" ")); return; }

  let project = null;
  try { project = await cf(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}`); } catch (e) { if (!process.argv.includes("--create")) throw e; }
  if (!project) {
    project = await cf(`/accounts/${ACCOUNT}/pages/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: PROJECT, production_branch: "main" }) });
    console.log("created project", project.name, "->", project.subdomain);
  }
  const jwt = (await cf(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}/upload-token`)).jwt;
  UPLOAD_JWT = jwt;

  const manifest = {}, assets = [];
  for (const [route, f] of Object.entries(FILES)) {
    const buf = fs.readFileSync(f.path), ext = f.path.split(".").pop(), h = hashOf(buf, route.split(".").pop());
    manifest[route] = h; assets.push({ key: h, value: buf.toString("base64"), metadata: { contentType: f.type }, base64: true });
  }
  const hashes = assets.map((a) => a.key);
  const missing = await cf(`${API}/pages/assets/check-missing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hashes }) }, jwt);
  const todo = assets.filter((a) => missing.includes(a.key));
  const BUCKET = 8 * 1024 * 1024, buckets = [[]]; let bytes = 0; // at most ~8 MB of file bytes per upload request
  for (const a of todo) {
    const n = Buffer.byteLength(a.value, "base64"); // raw file bytes
    if (buckets[buckets.length - 1].length && bytes + n > BUCKET) { buckets.push([]); bytes = 0; }
    buckets[buckets.length - 1].push(a); bytes += n;
  }
  for (const b of buckets) if (b.length) await cf(`${API}/pages/assets/upload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }, jwt);
  await cf(`${API}/pages/assets/upsert-hashes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hashes }) }, jwt);

  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append("branch", "main");
  const dep = await cf(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}/deployments`, { method: "POST", body: form });
  console.log("uploaded", todo.length, "of", assets.length, "files ·", (fs.statSync(FILES["/index.html"].path).size / 1024).toFixed(0), "KB");
  console.log("deployment", dep.id, dep.url, "| live:", "https://" + (project.subdomain || PROJECT + ".pages.dev"));
})().catch((e) => { console.error("DEPLOY FAILED:", scrub(e && e.message)); process.exit(1); });
