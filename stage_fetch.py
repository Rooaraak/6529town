# The Main Stage posters: fetch the top 3 of "The Memes - Main Stage" (6529.io public API, no login) and make small
# poster pictures. Writes <out>/stage.json:
#   {asof, sort, wave, items:[{rank,id,title,artist,votes,proj,voters,url,src,img,w,h}]}
# Only the fields listed there leave this script: no wallet addresses, no profile data.
# The order is the leaderboard's own "Projected Vote" order; an entry without a usable picture keeps its place
# (dark picture), so the ranks are always the real ones.
# This script decodes other people's media. daily.sh runs it in a sandbox as "nobody" (no home folders, read-only
# system) from a root-owned copy outside the home folder; build.py treats stage.json as untrusted and re-checks every field.
# Usage: python3 -I stage_fetch.py <out-dir>      (downloads go to a temporary folder inside <out-dir>)
import base64, glob, io, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
from PIL import Image

OUT = sys.argv[1]
WAVE = "b6128077-ea78-4dd9-b381-52c4eadb2077"
UA = {"User-Agent": "6529town", "Accept": "application/json"}
API_HOST = "https://api.6529.io/"
MEDIA_HOST = "https://d3lqz0a4bldqgf.cloudfront.net/"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAXB = 60 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 120_000_000


class NoRedirect(urllib.request.HTTPRedirectHandler):  # the two hosts above only: a redirect elsewhere is an error
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def get(url, binary=False):
    assert url.startswith(API_HOST) or url.startswith(MEDIA_HOST), "host"
    with OPENER.open(urllib.request.Request(url, headers=UA), timeout=40) as r:
        b = r.read(MAXB + 1)
    assert len(b) <= MAXB, "too large"
    return b if binary else json.loads(b)


def clean(s, n):
    s = re.sub(r"[\x00-\x1f\x7f<>]", " ", str(s or ""))
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n]


def md(drop, key):
    for m in drop.get("metadata") or []:
        if m.get("data_key") == key:
            return m.get("data_value")
    return None


def picture_urls(drop):
    """Candidate pictures, best first: a real image part, else the entry's own preview picture, else a video frame."""
    imgs, vids = [], []
    for p in drop.get("parts") or []:
        for m in p.get("media") or []:
            mt, u = str(m.get("mime_type") or ""), str(m.get("url") or "")
            if mt.startswith("image/"):
                imgs.append(("image", u))
            elif mt.startswith("video/"):
                vids.append(("video", u))
    extra = []
    for key, fields in (("additional_media", ("preview_image",)), ("proposal_frame", ("preview_image", "media_url"))):
        try:
            o = json.loads(md(drop, key) or "{}")
        except ValueError:
            o = {}
        for f in fields:
            u = o.get(f) if isinstance(o, dict) else None
            if isinstance(u, str) and u and not re.search(r"\.(mp4|mov|webm|html?)$", u, re.I):
                extra.append(("image", u))
    return [q for q in imgs + extra + vids if q[1].startswith(MEDIA_HOST)]


def jpeg(im):
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82, optimize=True, progressive=True)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode(), im.size[0], im.size[1]


def thumb(kind, url, name, dl):
    raw = os.path.join(dl, name + ".bin")
    open(raw, "wb").write(get(url, binary=True))
    src = raw
    if kind == "video":  # one frame; plain video files only (no playlists, no network)
        src = os.path.join(dl, name + ".frame.png")
        subprocess.run(["/usr/bin/ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-protocol_whitelist", "file",
                        "-format_whitelist", "mov,matroska", "-ss", "0.5", "-i", raw, "-frames:v", "1", src],
                       check=True, timeout=120)
    im = Image.open(src)
    im.seek(0)
    im = im.convert("RGB")
    im.thumbnail((560, 560), Image.LANCZOS)
    return jpeg(im)


def main():
    for old in glob.glob(os.path.join(OUT, "dl-*")):  # left behind by a run that was stopped
        shutil.rmtree(old, ignore_errors=True)
    prev = {}  # same entry + same media as last time: keep the picture, fetch only the numbers
    try:
        for it in json.load(open(os.path.join(OUT, "stage.json")))["items"]:
            if it.get("src"):
                prev[(it["id"], it["src"])] = (it["img"], int(it["w"]), int(it["h"]))
    except Exception:
        pass
    lb = get(API_HOST + "api/waves/%s/leaderboard?page_size=8&page=1&sort=RATING_PREDICTION&sort_direction=DESC" % WAVE)
    drops = [d for d in lb["drops"] if UUID.match(str(d.get("id") or ""))][:3]
    assert len(drops) == 3, len(drops)
    dl = tempfile.mkdtemp(prefix="dl-", dir=OUT)
    items = []
    try:
        for k, d in enumerate(drops):
            pic, src, how = None, "", "none"
            for n, (kind, url) in enumerate(picture_urls(d)):
                if (d["id"], url) in prev:
                    pic, src, how = prev[(d["id"], url)], url, "kept"
                    break
                try:
                    pic, src, how = thumb(kind, url, "p%d-%d" % (k + 1, n), dl), url, kind
                    break
                except Exception as e:  # try the next candidate picture
                    print("  skip picture", kind, type(e).__name__, file=sys.stderr)
            if not pic:
                pic = jpeg(Image.new("RGB", (64, 64), (12, 10, 9)))
            items.append({
                "rank": k + 1, "id": d["id"],
                "title": clean(md(d, "title") or d.get("title"), 48) or "Untitled",
                "artist": clean(md(d, "artist") or (d.get("author") or {}).get("handle"), 28) or "unknown",
                "votes": int(d.get("rating") or 0), "proj": int(d.get("rating_prediction") or 0), "voters": int(d.get("raters_count") or 0),
                "url": "https://6529.io/waves/%s?drop=%s" % (WAVE, d["id"]),
                "src": src, "img": pic[0], "w": pic[1], "h": pic[2],
            })
            print(" ", k + 1, items[-1]["title"], "|", items[-1]["artist"], "|", items[-1]["proj"], "|", pic[1], "x", pic[2], "picture:", how)
    finally:
        shutil.rmtree(dl, ignore_errors=True)
    out = {"asof": int(time.time() * 1000), "sort": "projected", "wave": "The Memes - Main Stage", "items": items}
    tmp = os.path.join(OUT, "stage.json.tmp")
    json.dump(out, open(tmp, "w"), ensure_ascii=True)
    os.replace(tmp, os.path.join(OUT, "stage.json"))
    print("stage.json", os.path.getsize(os.path.join(OUT, "stage.json")) // 1024, "KB")


main()
