# 6529 Town

A small living town that shows one day of the 6529 validator network. Every validator is a house. Houses that
took part send paper planes, and houses that signed send a gold light to the Ministry of Validation.

**Live:** https://6529town.com

Unofficial community project, not made by 6529.

## What you see

- One house per validator, in a quarter for its continent. Data centers stand apart.
- The day's numbers: validators and accounts taking part, the share of counted TDH (the 6529 network's score for a wallet) that signed, and the day's name once it is final.
- A diary of past days, town records, where validators are and which release they run.
- **Find your house.** Enter a wallet address and the town shows that wallet's house. The check runs inside your browser.
- A postcard of the town, or of your own house, to save or share.
- Eight quiet songs, off until you tap the speaker.
- A short guide to becoming a validator. It points to 6529.io and to the Memes collection on OpenSea.

## How it works

The town is one static page. A few small scripts read the local page of **your own validator**, keep the day's
totals and a private list of houses (it holds addresses and is never published), draw the page, check every
number and upload it.

| File | What it does |
|---|---|
| `capture.sh`, `net-capture.cjs` | Read the validator's local Network, Today and History pages (read-only) into `raw/`. **Private.** |
| `day-guard.py` | The date check. It refuses a reading whose day is not the real today. A refused reading is moved aside and never used. |
| `parse-day.py` | Keeps totals only and writes the day into `data/days.json`. Of several readings of one day the last one counts, but a finished day is never replaced by an unfinished reading, and a finished day keeps its name when a later reading has none. |
| `residents.py` | Builds the list of houses, `data/residents.json`. It is run by `build.py`. **Private.** |
| `stage_fetch.py` | Optional. Fetches the top three of the public 6529.io ranking as posters for the main stage, as user "nobody" in a sandbox. |
| `build.py` | Draws the page into `dist/`. A privacy check stops the run when the page holds an address or one of your private words. The page that failed is moved to `dist/failed-*.html` and nothing is uploaded. |
| `audit.py` | Compares the numbers on the page with the validator's own page from the same reading. If one differs, nothing is published. |
| `og.cjs` | Draws the link-preview picture. |
| `deploy-cf.cjs` | Uploads `dist/site/` and the songs to Cloudflare Pages. It runs a shorter version of the privacy check first. |
| `daily.sh` | One full run: read the validator (with the date check), the final-day check (a day that is final must have its name), fetch the posters, build, check the numbers (with one fresh reading if they differ), draw the preview picture, upload. It writes `daily.log`. |
| `install-cron.sh` | Puts `daily.sh` on a timer: every 2 hours, plus once at 19:40 UTC, after the day is final (19:30 UTC). |
| `cards.py` | Only needed to change the Meme Cards on show. Shrinks the originals to small pictures. |
| `src/globe.js`, `src/land-110m.json` | An older globe view. The page of today does not use it; `build.py` still knows how to build it (that part needs `numpy`). |

The page itself is `src/page.html` (layout, styles, text) and `src/town.js` (the town). `build.py` puts the data
and the script into the page. The finished site is four files (`index.html`, `og.jpg`, `v.json`, `404.html`)
plus the songs. (`og.png` in the same folder is only a working file of `og.cjs`.) If `og.cjs` cannot draw the
picture, the site is still uploaded with the last picture, or with none if there never was one.

## What is never published

`raw/` and `data/residents.json` hold wallet addresses and validator key codes. They stay on your machine and
are in `.gitignore`. The published page gets no wallet address and no key code.

**Find your house** works like this. For every wallet the page carries the first 16 hex characters of
`SHA-256("6529town:" + address)`. When someone types an address, the browser makes the same code and looks for
it. The address is never sent anywhere.

An honest limit: that code is a fingerprint, not encryption. Next to it the page carries the wallet's TDH
(the 6529 network's score for a wallet), locked with a second value made from the same address, and the number
of its houses. For every house it carries the first day, the continent, home or data center, and the days it
signed. So someone who already has a list of wallet addresses, for example the public list on 6529.io, can
test each one and learn which wallets run validators, how many, on which continent, at home or in a data
center, on which days they signed, and their TDH. What the page does not give away is the addresses
themselves, and it holds no names and no country per house.

For every day the page also carries the list of countries that validators named, with counts. Where a
continent has very few houses, this can show which country a house is in.

What the page loads by itself: the song files and a tiny `v.json` (it says whether a newer reading is out)
from its own site, the fonts from Google Fonts, and three.js from cdnjs. None of these requests carries a
wallet. If you keep your house, its number and the name you give it are saved in your browser only.

More things to keep private when you run your own town:

- The link to the validator's local page is an **admin link**. Never share it and never log it.
- `config.env` can hold that link, so make it readable only by you: `chmod 600 config.env`.
- Keep the Cloudflare token and the Discord webhook file outside this folder, readable only by you.
- Put your own private words (your validator's key code, your machine's name, your nickname) into
  `leak-extra.txt`, see `leak-extra.example.txt`. If the finished page contains one of them, the run stops,
  nothing is uploaded, and the page that failed is moved to `dist/failed-*.html`. Never upload that file.

## Run your own

You need:

- Linux, with `python3` (3.10 or newer) and `node` (20 or newer) in `/usr/bin` or `/usr/local/bin`
- Pillow for that system `python3` (tested with Pillow 12.2). `daily.sh` does not see a Python virtual environment.
- Chrome, Chromium or `chrome-headless-shell`, with the system libraries it asks for. The scripts start it with
  `--no-sandbox` and open only your validator's local page and the town's own page with it. The town's page
  loads three.js from cdnjs and, with posters on, shows pictures made from other people's art; with posters on,
  `daily.sh` and this browser run as root. Two ways to get a browser: on Debian
  `sudo apt install chromium` (then `CHROME_PATH=/usr/bin/chromium`), or anywhere
  `npx @puppeteer/browsers install chrome-headless-shell@stable`, which prints the path of the program.
- your own 6529 validator. Its local page must be reachable at `http://127.0.0.1:…` on this machine. If the
  validator runs on another machine, forward the page yourself, for example with `ssh -L`.
- optional: a Cloudflare account for hosting, and `curl` for the Discord message when a run fails

```bash
npm install
sudo apt install python3-pil          # Debian or Ubuntu. Elsewhere: pip install -r requirements.txt
cp config.example.env config.env      # then fill it in
chmod 600 config.env
bash daily.sh                         # one full run; the log is daily.log
```

A new town publishes nothing on its first day until a run between 19:30 UTC and midnight UTC, when the day is
final. Earlier runs stop with "No finished day is recorded yet". That is normal. Your diary starts with your
first reading; days before it are not filled in.

The finished site is in `dist/site/`. Any static host works: upload that folder and put `music/*.mp3` next to
`index.html`. The scripts write their files readable only by the user who runs them, so copy `dist/site/` to
where your web server reads it; a web server running as another user cannot read it in place. `dist/meme-town.html` (the name is the project's early working name) is the same page without a
document head, for embedding.

For Cloudflare Pages, first do one full `bash daily.sh` with the `CF_` lines still off. Then fill in the three
`CF_` settings and create the project once. This also uploads the site for the first time; from then on
`daily.sh` uploads by itself:

```bash
set -a; . ./config.env; set +a
node deploy-cf.cjs --create
```

To run it on a timer (the times assume the machine's clock is UTC):

```bash
bash install-cron.sh
```

The posters on the main stage are optional and need more: `daily.sh` running as root, systemd, the user
`nobody` with the group `nogroup` (as on Debian and Ubuntu), a root-owned copy of `stage_fetch.py` outside
your home folder, a folder that `nobody` may write, and `/usr/bin/ffmpeg` for posters that are videos. See
`config.example.env`. Without them the town simply has no posters.

Two small things for special cases: a day record with `"hand_made": true` in `data/days.json` is never
overwritten by a new reading, and `data/days-old-chain.json` can hold day records from before a chain restart
(normally it is an empty list). A record there counts as an old-chain day only when it carries
`"old_chain": true`. `audit.py` checks those days against a history file, `TOWN_NETWORK_HISTORY` or, when that
is not set, `network-history.jsonl` next to the scripts, and stops the run when the file is missing.

### Your own address and name

The site address `https://6529town.com` is written into `build.py` (link-preview tags) and `src/page.html`.
Search for `6529town.com` and replace it with your own. Leave the `6529town:` and `6529town-tdh:` prefixes of
the wallet codes as they are, or change them in both `build.py` and `src/town.js`.

If you put your own copy online, please give it its own name, and keep the line "Unofficial community project,
not made by 6529." The name is written in `src/page.html`, `src/town.js`, `src/404.html`, `build.py` (the
link-preview titles), `daily.sh` (the Discord message), `stage_fetch.py` (the name it gives to 6529.io),
`install-cron.sh` and `package.json`:
search for `6529 Town` and `6529town`. `build.py` looks for the exact line `<title>6529 Town</title>` at the top
of `src/page.html`, so change that text in both files together. Rename before you run `install-cron.sh`; if the
timer is already installed, remove its old lines with `crontab -e` first.

If you publish your own copy of the code, start a new, empty git repository in this folder first, and check
with `git status` that `raw/`, `data/`, `config.env` and `leak-extra.txt` are not in it.

## The bell (optional)

A visitor who found and kept their house can turn on a bell for it. That phone or computer then gets a
notification when the house has not signed about two hours before signing closes (19:00 UTC), and when a new
validator version is out. The bell is off until you set it up; until then nothing of it is published and the page
looks and works as before.

| File | What it does |
|---|---|
| `bell/worker/_worker.js`, `_routes.json` | A small Cloudflare Pages worker that answers only `/api/bell`. For each bell it keeps the device's notification address and one house number (no wallet, no name) in a D1 database, and it sends the notifications. `bundle.py` makes `_worker.js` from `bell/worker/src/`. |
| `bell/site/` | `sw.js` (the service worker, it shows the notifications), the app manifest and two icons. `sw-off.js` is not published: it is a twin of `sw.js` that removes itself, for the day the bell goes away. |
| `bell/bell-ring.py` | Runs after each upload. It reads the published page and tells the worker which houses have not signed yet, or that a new version is out. It never sees a notification address. |
| `bell/test/` | Tests without network. From `bell/`: `node --test test/<name>.test.mjs` and `python3 -I test/test_ring.py`. |

To turn it on:

1. In the Cloudflare Pages project (production): bind a D1 database as `DB`, set the variable `BELL_HOST` to your
   site's host name, and add two secrets: `VAPID_JWK` (the private P-256 key for the notifications, as JSON) and
   `RING_KEY` (32 or more random characters).
2. Put `bell-public.json` into this folder: `{"host": "your.host", "key": "<public key>", "mode": "hash"}`. The key is
   the public half of `VAPID_JWK` in base64url (87 characters). Mode `hash` shows the bell only to visitors who open
   the page with `#bell` at the end of the address (for a trial), `open` to everyone who kept a house, `off` to no one.
3. Put the ring key into a file outside this folder (`chmod 600`) and name it in `TOWN_BELL_KEY_FILE` in `config.env`.
4. Optional: `bell.json` says what the sender does: `{"house": "dry", "version": "dry", "empty": "off"}`. `dry` only
   counts and sends nothing, `live` sends, `off` skips. Without the file everything is `dry`.

With `bell-public.json` in place, `build.py` writes the bell's line into the page, copies `sw.js`, the manifest and
the icons into `dist/site/` and the worker into `dist/worker/`, and `deploy-cf.cjs` attaches the worker to the same
deployment. If the file is not right, the build prints `BELL CONFIG REFUSED` and goes on with the bell off on the
page. Before the first bell, the worker makes its tables once: a POST to `/api/bell/ring` with the body
`{"op":"init"}`, the header `content-type: application/json` and the ring key in the header `x-bell-key`.
`bell/bell-ring.py` talks only to the first address in its list `ALLOWED_URLS` (`https://6529town.com`); for your
own town, put your site there.

To stop it, put an empty file `bell.STOP` into this folder: the next run takes the bell off the page and the sender
stops. The worker and `sw.js` stay published, so nothing breaks on devices that have a bell; they get no more
notifications. To close the bell for new devices at the worker as well, send the ring operation
`{"op":"off","on":true}` the same way as `init` (`{"op":"off","on":false}` opens it again).

## Credits and licence

The code and the town's own tune (song 1) are under the MIT licence, see `LICENSE`. The other songs, the Meme
Cards and the map data come from other people and keep their own terms, see `CREDITS.md`.

Download the validator only from https://6529.io/validator.
