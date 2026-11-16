// link-preview picture for the website: 1200x630 shot of the top of the page (title, numbers, town). usage: node og.cjs
const p = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await p.launch({ executablePath: process.env.CHROME_PATH, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const pg = await b.newPage(); await pg.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await pg.goto('file://' + __dirname + '/dist/site/index.html', { waitUntil: 'networkidle0', timeout: 90000 }); await sleep(8000);
  await pg.evaluate(() => { const h = document.getElementById('t-hint'); if (h) h.style.display = 'none'; const g = document.getElementById('t-tour-go'); if (g) g.style.display = 'none';
    const w = document.querySelector('.nt-when'); if (w) w.style.display = 'none'; });
  await pg.screenshot({ path: __dirname + '/dist/site/og.png' });
  require('child_process').execFileSync('python3', ['-c', "from PIL import Image; Image.open('" + __dirname + "/dist/site/og.png').convert('RGB').save('" + __dirname + "/dist/site/og.jpg', 'JPEG', quality=86, optimize=True, progressive=True)"]);
  await b.close(); console.log('og.png written');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
