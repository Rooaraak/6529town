// READ-ONLY. Opens the validator's local page (on this machine's 127.0.0.1:<port>), visits /network,
// and saves (a) every JSON response the page loads and (b) the page's visible text. GET navigation only; clicks only the
// read-only list toggles "Show the other N" and "Show all N countries". usage: LINK='http://127.0.0.1:<port>/login?token=…' node net-capture.cjs <outdir>
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
const fs = require('fs');
const out = process.argv[2], link = process.env.LINK;
// nothing of the admin link may reach a log: a logged line keeps only the origin of any link and no part of the admin link
const scrub = (s) => {
  s = String(s).replace(/(https?:\/\/[^\s\/]+)\/[^\s]*/gi, '$1/…').replace(/token=[^\s&]+/gi, 'token=…');
  const tail = (link || '').replace(/^https?:\/\/[^\/]+/i, '');
  if (tail.length < 2) return s;
  const parts = [tail, encodeURIComponent(link), encodeURIComponent(tail)].concat(tail.split(/[\/?&=#]+/).filter((x) => x.length >= 12));
  for (const x of parts) s = s.split(x).join('…');
  return s;
};
if (!out || !/^http:\/\/127\.0\.0\.1:\d+\//.test(link || '')) { console.error('usage: LINK=… node net-capture.cjs <outdir>'); process.exit(2); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await puppeteer.launch({ executablePath: process.env.CHROME_PATH,
    headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  try {
    const p = await b.newPage(); await p.setViewport({ width: 1280, height: 900 });
    const json = {};
    p.on('response', async (r) => {
      try {
        const ct = r.headers()['content-type'] || '';
        if (r.request().method() !== 'GET' || !ct.includes('json')) return;
        const u = new URL(r.url()); json[u.pathname + u.search] = await r.json();
      } catch (e) {}
    });
    await p.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
    const base = new URL(link).origin;
    await p.goto(base + '/network', { waitUntil: 'networkidle2', timeout: 60000 }); await sleep(3000);
    await p.evaluate(() => { for (const x of document.querySelectorAll('button')) if (/Show the other/.test(x.innerText) || /^Show\s+all\s+\d+\s+countr/.test((x.innerText || '').trim())) x.click(); });
    await sleep(1500);
    fs.writeFileSync(`${out}/network.txt`, await p.evaluate(() => document.body.innerText));
    for (const [r, f] of [['/', 'today.txt'], ['/history', 'history.txt']]) {
      await p.goto(base + r, { waitUntil: 'networkidle2', timeout: 60000 }); await sleep(2500);
      fs.writeFileSync(`${out}/${f}`, await p.evaluate(() => document.body.innerText));
    }
    fs.writeFileSync(`${out}/api.json`, JSON.stringify(json));
    console.log('ok', scrub(Object.keys(json).map((k) => k.split('?')[0]).join(' ')));
  } finally { await b.close(); }
})().catch(e => { console.error('FAIL', scrub(e.message)); process.exit(1); });
