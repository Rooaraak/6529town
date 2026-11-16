  /* ================= the town: an imaginary country that grows with every validator ================= */
  var CKEYS = ["north_america", "europe", "asia", "south_america", "oceania", "africa", "not_reported"];
  var CCOL = { north_america: "#c8291e", europe: "#2f7f86", asia: "#d9a441", south_america: "#4e9a50", oceania: "#8f5cff", africa: "#cd7f32", not_reported: "#45454e" };
  var CLAB = { north_america: "North America", europe: "Europe", asia: "Asia", south_america: "South America", oceania: "Oceania", africa: "Africa", not_reported: "Place not shown" };
  function h2(a, b) { var n = Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663); n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n ^= n >>> 4; n = Math.imul(n, 668265261); n ^= n >>> 15; return (n >>> 0) / 4294967295; }

  // Every validator ever seen gets a house, in the order they arrived. Houses are never torn down.
  function townPlan() {
    var houses = [], have = {}, dcHave = 0;
    CKEYS.forEach(function (c) { have[c] = 0; });
    DAYS.forEach(function (d, k) {
      var cs = d.continents || {}, adds = [];
      CKEYS.forEach(function (c) { var n = (cs[c] || 0) - have[c]; for (var i = 0; i < n; i++) adds.push(c); if (n > 0) have[c] += n; });
      for (var i = adds.length - 1; i > 0; i--) { var j = Math.floor(h2(k + 11, i) * (i + 1)), t = adds[i]; adds[i] = adds[j]; adds[j] = t; }
      adds.forEach(function (c) { houses.push({ c: c, day: k, idx: houses.length, dc: false }); });
      var dc = (d.places || {}).data_center || 0;
      if (dc > dcHave) {
        houses.filter(function (h) { return !h.dc && h.c !== "not_reported"; }).sort(function (a, b) { return h2(a.idx, 7) - h2(b.idx, 7); })
          .slice(0, dc - dcHave).forEach(function (h) { h.dc = true; });
        dcHave = dc;
      }
    });
    var per = {}; houses.forEach(function (h) { per[h.c] = (per[h.c] || 0) + 1; h.rank = per[h.c] - 1; });
    return houses;
  }
  // the houses that go up the day after d: ONE number for every place that shows it (stats tile, building site, ferry, tour, key, postcard), null = not recorded.
  // The newest day: registered for tomorrow. A past day: what really happened. Up to the first day of house records (FIRSTDAY,
  // set in page.html: Sun 8 Nov) the next day's validators minus this day's; after it the houses whose first day is the next day (DATA.homes.list)
  function nextNew(d) {
    var i = DAYS.indexOf(d), L = DATA.homes && DATA.homes.list, n = 0;
    if (i < 0 || d.next_validators == null) return null;
    if (i === DAYS.length - 1) return Math.max(0, d.next_validators - (d.validators || 0));
    if (i + 1 <= FIRSTDAY || !(L && L.length)) return Math.max(0, (DAYS[i + 1].validators || 0) - (d.validators || 0));
    L.forEach(function (r) { if (r[0] === i + 1) n++; });
    return n;
  }
  function tomorrowCount(d) { return Math.min(90, nextNew(d) || 0); } // building-site frames drawn (capped)
  function unkSay(d) { return d.old_chain && d.keys === "unknown" ? "The old chain kept only the day's totals, not the number of validators." : ""; } // "" on every other day
  function notSigned(d) { return d.final ? "Took part on " + d.label + ", did not sign." : "Taking part on " + d.label + ", not signed yet."; } // a house that took part without a signature

  // The street grid: a street every third row and column, the plaza in the middle, three blocks kept for landmarks.
  function street(v) { return ((v % 3) + 3) % 3 === 0; }
  function blk(v) { return Math.floor((v - 1) / 3); }
  var KEEP = { factory: [1, -2], museum: [-2, 0], pond: [0, 1], square: [-1, 1] }; // pond + square = the town square in front of the Ministry
  function kept(x, z) { for (var k in KEEP) if (blk(x) === KEEP[k][0] && blk(z) === KEEP[k][1]) return k; return null; }
  function plaza(x, z) { return Math.abs(x) <= 2 && Math.abs(z) <= 2; }
  var SQ = [0, 4.15]; // the pond in the middle of the town square
  function makeLots(n) {
    var R = Math.ceil(Math.sqrt(n * 2.4 / Math.PI)) + 4, cells = [];
    for (var x = -R; x <= R; x++) for (var z = -R; z <= R; z++) {
      if (plaza(x, z) || street(x) || street(z) || kept(x, z)) continue;
      cells.push({ x: x, z: z, r: Math.hypot(x, z) + h2(x + 999, z - 999) * 1.6 });
    }
    cells.sort(function (a, b) { return a.r - b.r; });
    return cells.slice(0, n);
  }

  function mergeGeo(list) { // list of [geometry, dx, dy, dz]
    var pos = [], nor = [];
    list.forEach(function (it) {
      var g = it[0].toNonIndexed(); g.translate(it[1] || 0, it[2] || 0, it[3] || 0);
      pos.push.apply(pos, g.attributes.position.array); nor.push.apply(nor, g.attributes.normal.array);
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    return out;
  }

  function flagDraw(x, W, H, name) {
    var F = {
      "France": ["v", "#0055a4", "#ffffff", "#ef4135"], "Italy": ["v", "#009246", "#ffffff", "#ce2b37"], "Belgium": ["v", "#111111", "#fdda24", "#ef3340"],
      "Ireland": ["v", "#169b62", "#ffffff", "#ff883e"], "Mexico": ["v", "#006847", "#ffffff", "#ce1126"], "Romania": ["v", "#002b7f", "#fcd116", "#ce1126"], "Nigeria": ["v", "#008751", "#ffffff", "#008751"], "Peru": ["v", "#d91023", "#ffffff", "#d91023"],
      "Germany": ["h", "#111111", "#dd0000", "#ffce00"], "Netherlands": ["h", "#ae1c28", "#ffffff", "#21468b"], "Estonia": ["h", "#0072ce", "#111111", "#ffffff"],
      "Austria": ["h", "#c8102e", "#ffffff", "#c8102e"], "Hungary": ["h", "#ce2939", "#ffffff", "#477050"], "Bulgaria": ["h", "#ffffff", "#00966e", "#d62612"], "Lithuania": ["h", "#fdb913", "#006a44", "#c1272d"],
      "Russia": ["h", "#ffffff", "#0039a6", "#d52b1e"], "Argentina": ["h", "#74acdf", "#ffffff", "#74acdf"], "Luxembourg": ["h", "#ed2939", "#ffffff", "#00a1de"], "Egypt": ["h", "#ce1126", "#ffffff", "#111111"],
      "Latvia": ["h", "#9e3039", "#ffffff", "#9e3039"], "Poland": ["h", "#ffffff", "#dc143c"], "Ukraine": ["h", "#0057b7", "#ffd700"], "Indonesia": ["h", "#ce1126", "#ffffff"], "Colombia": ["h", "#fcd116", "#fcd116", "#003893", "#ce1126"],
      "Spain": ["h", "#aa151b", "#f1bf00", "#f1bf00", "#aa151b"], "Thailand": ["h", "#a51931", "#f4f5f8", "#2d2a4a", "#2d2a4a", "#f4f5f8", "#a51931"], "Croatia": ["h", "#ff0000", "#ffffff", "#171796"], "Serbia": ["h", "#c6363c", "#0c4076", "#ffffff"]
    }[name];
    x.save();
    function band(dir, cols) { cols.forEach(function (c, k) { x.fillStyle = c; if (dir === "v") x.fillRect(k * W / cols.length, 0, W / cols.length + 1, H); else x.fillRect(0, k * H / cols.length, W, H / cols.length + 1); }); }
    function nordic(bg, cross, inner) { x.fillStyle = bg; x.fillRect(0, 0, W, H); x.fillStyle = cross; x.fillRect(W * 0.28, 0, W * 0.16, H); x.fillRect(0, H * 0.4, W, H * 0.2); if (inner) { x.fillStyle = inner; x.fillRect(W * 0.32, 0, W * 0.08, H); x.fillRect(0, H * 0.45, W, H * 0.1); } }
    function crescent(cx, cy, r, bg) { x.fillStyle = "#ffffff"; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill(); x.fillStyle = bg; x.beginPath(); x.arc(cx + r * 0.35, cy - r * 0.1, r * 0.85, 0, 7); x.fill(); }
    if (F) band(F[0], F.slice(1));
    else if (name === "United States") { for (var k = 0; k < 13; k++) { x.fillStyle = k % 2 ? "#ffffff" : "#b22234"; x.fillRect(0, k * H / 13, W, H / 13 + 1); } x.fillStyle = "#3c3b6e"; x.fillRect(0, 0, W * 0.42, H * 7 / 13); x.fillStyle = "#ffffff"; for (var i = 0; i < 4; i++) for (var j = 0; j < 3; j++) { x.beginPath(); x.arc(W * (0.06 + i * 0.1), H * (0.1 + j * 0.15), Math.max(1, W * 0.018), 0, 7); x.fill(); } }
    else if (name === "United Kingdom") { x.fillStyle = "#012169"; x.fillRect(0, 0, W, H); x.strokeStyle = "#ffffff"; x.lineWidth = H * 0.2; x.beginPath(); x.moveTo(0, 0); x.lineTo(W, H); x.moveTo(W, 0); x.lineTo(0, H); x.stroke(); x.strokeStyle = "#c8102e"; x.lineWidth = H * 0.07; x.stroke(); x.fillStyle = "#ffffff"; x.fillRect(W * 0.42, 0, W * 0.16, H); x.fillRect(0, H * 0.37, W, H * 0.26); x.fillStyle = "#c8102e"; x.fillRect(W * 0.455, 0, W * 0.09, H); x.fillRect(0, H * 0.42, W, H * 0.16); }
    else if (name === "Brazil") { x.fillStyle = "#009c3b"; x.fillRect(0, 0, W, H); x.fillStyle = "#ffdf00"; x.beginPath(); x.moveTo(W * 0.08, H / 2); x.lineTo(W / 2, H * 0.1); x.lineTo(W * 0.92, H / 2); x.lineTo(W / 2, H * 0.9); x.closePath(); x.fill(); x.fillStyle = "#002776"; x.beginPath(); x.arc(W / 2, H / 2, H * 0.22, 0, 7); x.fill(); }
    else if (name === "India") { band("h", ["#ff9933", "#ffffff", "#138808"]); x.strokeStyle = "#000080"; x.lineWidth = Math.max(1, H * 0.04); x.beginPath(); x.arc(W / 2, H / 2, H * 0.12, 0, 7); x.stroke(); }
    else if (name === "Iran") { band("h", ["#239f40", "#ffffff", "#da0000"]); var ir = H * 0.12; x.strokeStyle = "#da0000"; x.lineWidth = Math.max(1.2, H * 0.045); x.lineCap = "round"; [[W / 2 + ir * 0.2, 2.25, 4.03], [W / 2 - ir * 0.2, -0.89, 0.89]].forEach(function (a) { x.beginPath(); x.arc(a[0], H / 2, ir, a[1], a[2]); x.stroke(); }); x.beginPath(); x.moveTo(W / 2, H / 2 - ir * 0.95); x.lineTo(W / 2, H / 2 + ir * 0.95); x.stroke(); }
    else if (name === "Norway") nordic("#ba0c2f", "#ffffff", "#00205b");
    else if (name === "Denmark") nordic("#c8102e", "#ffffff");
    else if (name === "Sweden") nordic("#006aa7", "#fecc00");
    else if (name === "Finland") nordic("#ffffff", "#002f6c");
    else if (name === "Iceland") nordic("#02529c", "#ffffff", "#dc1e35");
    else if (name === "Switzerland") { x.fillStyle = "#da291c"; x.fillRect(0, 0, W, H); x.fillStyle = "#ffffff"; x.fillRect(W * 0.42, H * 0.2, W * 0.16, H * 0.6); x.fillRect(W * 0.3, H * 0.4, W * 0.4, H * 0.2); }
    else if (name === "Japan") { x.fillStyle = "#ffffff"; x.fillRect(0, 0, W, H); x.fillStyle = "#bc002d"; x.beginPath(); x.arc(W / 2, H / 2, H * 0.3, 0, 7); x.fill(); }
    else if (name === "Singapore") { band("h", ["#ef3340", "#ffffff"]); crescent(W * 0.2, H * 0.25, H * 0.15, "#ef3340"); }
    else if (name === "Pakistan") { x.fillStyle = "#01411c"; x.fillRect(0, 0, W, H); x.fillStyle = "#ffffff"; x.fillRect(0, 0, W * 0.25, H); crescent(W * 0.6, H * 0.5, H * 0.26, "#01411c"); }
    else if (name === "Turkey") { x.fillStyle = "#e30a17"; x.fillRect(0, 0, W, H); crescent(W * 0.4, H * 0.5, H * 0.28, "#e30a17"); }
    else if (name === "Canada") { band("v", ["#d80621", "#ffffff", "#ffffff", "#d80621"]); x.fillStyle = "#d80621"; x.beginPath(); x.moveTo(W / 2, H * 0.2); x.lineTo(W * 0.62, H * 0.55); x.lineTo(W / 2, H * 0.8); x.lineTo(W * 0.38, H * 0.55); x.closePath(); x.fill(); }
    else if (name === "China" || name === "Vietnam") { x.fillStyle = "#de2910"; x.fillRect(0, 0, W, H); x.fillStyle = "#ffde00"; x.beginPath(); x.arc(name === "China" ? W * 0.2 : W / 2, H * (name === "China" ? 0.3 : 0.5), H * 0.14, 0, 7); x.fill(); }
    else if (name === "Australia" || name === "New Zealand") { x.fillStyle = "#012169"; x.fillRect(0, 0, W, H); x.fillStyle = name === "Australia" ? "#ffffff" : "#c8102e"; [[0.7, 0.3], [0.8, 0.55], [0.66, 0.75], [0.25, 0.75]].forEach(function (p) { x.beginPath(); x.arc(W * p[0], H * p[1], H * 0.06, 0, 7); x.fill(); }); }
    else if (name === "Czechia") { band("h", ["#ffffff", "#d7141a"]); x.fillStyle = "#11457e"; x.beginPath(); x.moveTo(0, 0); x.lineTo(W / 2, H / 2); x.lineTo(0, H); x.closePath(); x.fill(); }
    else if (name === "Israel") { x.fillStyle = "#ffffff"; x.fillRect(0, 0, W, H); x.fillStyle = "#0038b8"; x.fillRect(0, H * 0.11, W, H * 0.13); x.fillRect(0, H * 0.76, W, H * 0.13); x.strokeStyle = "#0038b8"; x.lineWidth = Math.max(1.2, H * 0.045); var sr = H * 0.17; [1, -1].forEach(function (s) { x.beginPath(); x.moveTo(W / 2, H / 2 - s * sr); x.lineTo(W / 2 + sr * 0.866, H / 2 + s * sr * 0.5); x.lineTo(W / 2 - sr * 0.866, H / 2 + s * sr * 0.5); x.closePath(); x.stroke(); }); }
    else { x.fillStyle = "#efe5cf"; x.fillRect(0, 0, W, H); x.fillStyle = "#0a0a0a"; x.font = "700 " + Math.round(H * 0.42) + "px 'Martian Mono', monospace"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 3).toUpperCase(), W / 2, H / 2); }
    x.restore(); x.strokeStyle = "#0a0a0a"; x.lineWidth = 3; x.strokeRect(1.5, 1.5, W - 3, H - 3);
  }

  function makeTownView(canvas, stage) {
    var renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true }); } catch (e) { return null; }
    if (!renderer.getContext()) return null;
    renderer.setClearColor(0x000000, 0);
    var scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-10, 10, 10, -10, -300, 600), tStart = performance.now();
    scene.add(new THREE.HemisphereLight(0xb9c6ff, 0x1a1410, 0.62));
    var moon = new THREE.DirectionalLight(0xfff0d8, 0.62); moon.position.set(-30, 60, 25); scene.add(moon);
    var grad = new THREE.DataTexture(new Uint8Array([90, 90, 90, 175, 175, 175, 255, 255, 255]), 3, 1, THREE.RGBFormat);
    grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.generateMipmaps = false; grad.needsUpdate = true;
    function toon(color, extra) { return new THREE.MeshToonMaterial(Object.assign({ color: color, gradientMap: grad }, extra || {})); }
    var inkBack = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
    var basic = function (c, o) { return new THREE.MeshBasicMaterial(Object.assign({ color: c }, o || {})); };

    // one house per validator (DATA.homes, built from the validator's own list); without it, houses from the day totals
    // <layout>
    // quarters (step 27): every continent has its own quarter around the plaza, a wedge that grows outward. Behind the factory
    // there is a wood (no house, no building site, ever) and behind the wood, on the shore, the data centers stand apart.
    var HOMES = DATA.homes && DATA.homes.list && DATA.homes.list.length ? DATA.homes : null;
    var HDAY = HOMES ? HOMES.days.map(function (b64) { var t = atob(b64), a = new Uint8Array(t.length); for (var i = 0; i < t.length; i++) a[i] = t.charCodeAt(i); return a; }) : null;
    var CBYTE = [null, "north_america", "europe", "asia", "south_america", "oceania", "africa", "not_reported"];
    // dz = a data center on any day (its lot is in the district), q = the quarter the house lives in: the last continent it
    // reported over all days. Both are fixed for one page load, so a house stands on the same lot on every day.
    var HOUSES = HOMES ? HOMES.list.map(function (r, i) {
      var lr = 0, dz = !!r[1];
      HDAY.forEach(function (a) { var v = a[i] || 0, c = v & 7; if (v && c >= 1 && c <= 6) lr = c; if (v & 16) dz = true; });
      return { idx: i, day: r[0], dc: !!r[1], g: r[2], c: "not_reported", dz: dz, q: lr ? CBYTE[lr] : "not_reported" };
    }) : townPlan().map(function (h) { h.g = h.idx; h.dz = !!h.dc; h.q = h.c; return h; });
    // Wed 4 - Sat 7 Nov ran on the network's old chain, which kept only totals: on those days the first N houses that are
    // not data centers stand in for the day's N validators, while every house keeps its real first day (Sun 8 Nov or later)
    var FIRSTNEW = 0; while (FIRSTNEW < DAYS.length - 1 && DAYS[FIRSTNEW].old_chain) FIRSTNEW++;
    var OLDT = FIRSTNEW > 0 ? FIRSTNEW - 1 : 0;
    // the quarters, counter-clockwise by the angle (degrees) of a block's centre: QORD[i] starts at QDEG[i] and ends where the next starts
    var QORD = ["europe", "asia", "oceania", "africa", "south_america", "north_america", "not_reported"], QDEG = [315, 30, 72, 90, 99, 124, 216];
    function zoneOf(bx, bz) { // "dc" = the data center district, null = the wood, else the quarter's continent
      if (bx >= 3 && bz <= -4) return "dc";
      if (bx >= 1 && bz <= -2) return null;
      var a = ((Math.atan2(bz * 3 + 1.5, bx * 3 + 1.5) * 180 / Math.PI) % 360 + 360) % 360;
      for (var i = 0; i < 7; i++) if (((a - QDEG[i]) % 360 + 360) % 360 < ((QDEG[(i + 1) % 7] - QDEG[i]) % 360 + 360) % 360) return QORD[i];
      return "not_reported";
    }
    // lots are the 2x2 blocks between the streets; r = the town-wide order (nearest first), rq = the order inside a quarter
    var BLOCKS = (function () {
      var need = HOUSES.length + 140, B = Math.ceil(Math.sqrt(need / 4 * 1.6 / Math.PI)) + 6, out = [];
      for (var bx = -B; bx <= B; bx++) for (var bz = -B; bz <= B; bz++) {
        if ((bx === -1 || bx === 0) && (bz === -1 || bz === 0)) continue;
        var keep = false; for (var k in KEEP) if (KEEP[k][0] === bx && KEEP[k][1] === bz) keep = true; if (keep) continue;
        out.push({ bx: bx, bz: bz, z: zoneOf(bx, bz), used: [-1, -1, -1, -1],
                   r: Math.hypot(bx * 3 + 1.5, bz * 3 + 1.5) + h2(bx + 777, bz - 777) * 2.2,
                   rq: Math.hypot(bx * 3 + 1.5, bz * 3 + 1.5) + h2(bx + 777, bz - 777) * 1.2,
                   cells: [[bx * 3 + 1, bz * 3 + 1], [bx * 3 + 2, bz * 3 + 1], [bx * 3 + 1, bz * 3 + 2], [bx * 3 + 2, bz * 3 + 2]] });
      }
      return out.sort(function (a, b) { return a.r - b.r; });
    })();
    var ORDER = []; BLOCKS.forEach(function (b) { b.cells.forEach(function (c) { ORDER.push({ x: c[0], z: c[1] }); }); });
    // the fill order of a quarter: its nearest block first, then always a block that shares a side (else a corner) with one already listed
    var QB = {}, QGAP = 0;
    CKEYS.forEach(function (k) {
      var cand = BLOCKS.filter(function (b) { return b.z === k; }).sort(function (a, b) { return a.rq - b.rq; }), list = [], inL = {};
      function has(x, z) { return inL[x + "," + z] === 1; }
      while (cand.length) {
        var i = 0, j, c;
        if (list.length) {
          for (i = -1, j = 0; j < cand.length && i < 0; j++) { c = cand[j]; if (has(c.bx - 1, c.bz) || has(c.bx + 1, c.bz) || has(c.bx, c.bz - 1) || has(c.bx, c.bz + 1)) i = j; }
          for (j = 0; j < cand.length && i < 0; j++) { c = cand[j]; if (has(c.bx - 1, c.bz - 1) || has(c.bx + 1, c.bz - 1) || has(c.bx - 1, c.bz + 1) || has(c.bx + 1, c.bz + 1)) i = j; }
          if (i < 0) { i = 0; QGAP++; }
        }
        var b = cand.splice(i, 1)[0]; list.push(b); inL[b.bx + "," + b.bz] = 1;
      }
      QB[k] = list;
    });
    // the district's lots, nearest the plaza first; QOVER = every block a house may use when its own quarter is full
    var DLOTS = []; BLOCKS.forEach(function (b) { if (b.z === "dc") b.cells.forEach(function (c, ci) { DLOTS.push({ x: c[0], z: c[1], b: b, ci: ci }); }); });
    DLOTS.sort(function (a, b) { return (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z) || a.x - b.x || a.z - b.z; });
    var QOVER = BLOCKS.filter(function (b) { return b.z && b.z !== "dc"; }), ALLOC_BAD = 0, ALLOC_OVER = 0;
    // data centers go to the district, in list order. Then day by day: a wallet's validators share a block of their quarter
    // where they fit, and every newcomer takes the next free lot in its quarter's fill order, so each quarter grows outward
    (function allocate() {
      function free(b) { return b.used.filter(function (u) { return u < 0; }).length; }
      function fill(b, list) { for (var c = 0; c < 4 && list.length; c++) if (b.used[c] < 0) { var h = list.shift(); b.used[c] = h.idx; h.x = b.cells[c][0]; h.z = b.cells[c][1]; } return list; }
      function first(list, need) { for (var j = 0; j < list.length; j++) if (free(list[j]) >= need) return list[j]; return null; }
      var di = 0, home = {};
      HOUSES.forEach(function (h) { if (!h.dz) return; var L = DLOTS[di++]; if (!L) { ALLOC_BAD++; return; } L.b.used[L.ci] = h.idx; h.x = L.x; h.z = L.z; });
      for (var d = 0; d < Math.max(DAYS.length, 1); d++) {
        var groups = [], gi = {};
        HOUSES.forEach(function (h) { if (h.dz || h.day !== d) return; var k = h.g + "|" + h.q; if (!(k in gi)) { gi[k] = groups.length; groups.push([]); } groups[gi[k]].push(h); });
        groups.forEach(function (gr) {
          var left = gr.slice(), key = gr[0].g + "|" + gr[0].q, L = QB[gr[0].q];
          if (home[key]) left = fill(home[key], left);
          while (left.length) {
            var b = first(L, Math.min(4, left.length)) || first(L, 1);
            if (!b) { // the quarter is full: the house still gets a lot, in the nearest free block of any quarter (counted)
              b = first(QOVER, 1); if (!b) { ALLOC_BAD += left.length; break; }
              ALLOC_OVER += Math.min(free(b), left.length);
            }
            left = fill(b, left); home[key] = b;
          }
        });
      }
    })();
    // who stands on day i. An old-chain day kept only its total: the first N houses that are not data centers stand in.
    var ORANK = [], OLDN = [];
    (function () {
      var rk = 0; HOUSES.forEach(function (h) { ORANK[h.idx] = h.dz ? 1e9 : rk++; });
      DAYS.forEach(function (d, i) { var n = 0; if (HDAY && d.old_chain && HDAY[i]) for (var j = 0; j < HDAY[i].length; j++) if (HDAY[i][j]) n++; OLDN[i] = n; });
    })();
    function standing(h, i) {
      if (i < 0 || h.x == null) return false;
      if (HDAY && DAYS[i] && DAYS[i].old_chain) return ORANK[h.idx] < OLDN[i];
      return h.day <= i || !!(HDAY && HDAY[i] && HDAY[i][h.idx]);
    }
    // the building sites of day i, n gold frames {x, z, q}: first where tomorrow's houses go up, the rest shared between the
    // quarters like the houses standing that day, each from the start of its quarter's fill order
    function siteLotsFor(i, n) {
      var out = [], taken = {}, j, h;
      if (!(n > 0)) return out;
      if (i + 1 < DAYS.length) for (j = 0; j < HOUSES.length && out.length < n; j++) {
        h = HOUSES[j]; if (h.dz || h.x == null || standing(h, i) || !standing(h, i + 1)) continue;
        out.push({ x: h.x, z: h.z, q: h.q }); taken[h.x + "," + h.z] = 1;
      }
      var m = n - out.length; if (!m) return out;
      var cnt = {}, T = 0, share = {}, frac = [], given = 0, carry = 0;
      CKEYS.forEach(function (k) { cnt[k] = 0; });
      HOUSES.forEach(function (o) { if (!o.dz && standing(o, i)) { cnt[o.q]++; T++; } });
      CKEYS.forEach(function (k, ki) { var e = T ? m * cnt[k] / T : (k === "not_reported" ? m : 0); share[k] = Math.floor(e); given += share[k]; frac.push([e - share[k], ki]); });
      frac.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });
      for (j = 0; j < m - given; j++) share[CKEYS[frac[j % 7][1]]]++;
      function take(k, want) {
        var got = 0, L = QB[k];
        for (var bi = 0; bi < L.length && got < want; bi++) for (var c = 0; c < 4 && got < want; c++) {
          var u = L[bi].used[c], x = L[bi].cells[c][0], z = L[bi].cells[c][1];
          if (taken[x + "," + z] || (u >= 0 && standing(HOUSES[u], i))) continue;
          out.push({ x: x, z: z, q: k }); taken[x + "," + z] = 1; got++;
        }
        return want - got;
      }
      CKEYS.forEach(function (k) { carry = take(k, share[k] + carry); });
      if (carry) CKEYS.forEach(function (k) { if (carry) carry = take(k, carry); }); // what the last quarter could not place
      return out;
    }
    // the crane: the frame nearest the middle of the quarter with the most frames
    function craneFor(list) {
      if (!list.length) return null;
      var c = {}, bk = null, cx = 0, cz = 0, bd = Infinity;
      list.forEach(function (L) { c[L.q] = (c[L.q] || 0) + 1; });
      CKEYS.forEach(function (k) { if (c[k] && (bk === null || c[k] > c[bk])) bk = k; });
      var q = list.filter(function (L) { return L.q === bk; }), best = q[0];
      q.forEach(function (L) { cx += L.x; cz += L.z; }); cx /= q.length; cz /= q.length;
      q.forEach(function (L) { var d2 = (L.x - cx) * (L.x - cx) + (L.z - cz) * (L.z - cz); if (d2 < bd) { bd = d2; best = L; } });
      return { x: best.x, z: best.z, q: bk };
    }
    // where the quarters' flags stand on day i: { key: {x, z} }, a street crossing each, no two flags on one crossing and
    // never the plaza's own. Quarters with more standing houses choose first. A quarter's crossing is the corner, nearest
    // the middle of its standing houses, of its block (holding one of them) nearest that middle.
    function flagSpots(i) {
      var per = {}, out = {}, usedX = {}, O = [[0, 0], [3, 0], [0, 3], [3, 3]];
      CKEYS.forEach(function (k) { per[k] = []; });
      HOUSES.forEach(function (h) { if (!h.dz && h.x != null && standing(h, i)) per[h.q].push(h); });
      CKEYS.filter(function (k) { return per[k].length; }).sort(function (a, b) { return per[b].length - per[a].length || CKEYS.indexOf(a) - CKEYS.indexOf(b); }).forEach(function (key) {
        var hs = per[key], cx = 0, cz = 0, on = {}, cand = [], spot = null;
        hs.forEach(function (h) { cx += h.x; cz += h.z; on[h.idx] = 1; }); cx /= hs.length; cz /= hs.length;
        [QB[key], QOVER].forEach(function (list) { // QOVER: only when the quarter's standing houses sit in overflow blocks
          if (!cand.length) list.forEach(function (b) {
            if (!b.used.some(function (u) { return u >= 0 && on[u]; })) return;
            var dx = b.bx * 3 + 1.5 - cx, dz = b.bz * 3 + 1.5 - cz; cand.push([dx * dx + dz * dz, b]);
          });
        });
        cand.sort(function (a, b) { return a[0] - b[0]; });
        for (var ci = 0; ci < cand.length && !spot; ci++) for (var oi = 0, sd = Infinity; oi < 4; oi++) {
          var X = cand[ci][1].bx * 3 + O[oi][0], Z = cand[ci][1].bz * 3 + O[oi][1], d2 = (X - cx) * (X - cx) + (Z - cz) * (Z - cz);
          if ((!X && !Z) || usedX[X + "," + Z]) continue;
          if (d2 < sd) { sd = d2; spot = { x: X, z: Z }; }
        }
        if (spot) { out[key] = spot; usedX[spot.x + "," + spot.z] = 1; }
      });
      return out;
    }
    // the island: the built town plus every building site of every day, and enough shore behind every lot (district included)
    var SITES = DAYS.map(function (d, i) { return siteLotsFor(i, tomorrowCount(d)); });
    function shoreK(a) { return 1 + 0.07 * Math.sin(3 * a + 0.5) + 0.05 * Math.sin(5 * a + 2) + 0.025 * Math.sin(9 * a); }
    var builtR = 4, shoreNeed = 0;
    (function () {
      function sn(x, z) { shoreNeed = Math.max(shoreNeed, (Math.hypot(x, z) + 2.8) / shoreK(Math.atan2(z, x))); }
      HOUSES.forEach(function (h) { if (h.x == null) return; if (!h.dz) builtR = Math.max(builtR, Math.hypot(h.x, h.z)); sn(h.x, h.z); });
      SITES.forEach(function (l) { l.forEach(function (L) { builtR = Math.max(builtR, Math.hypot(L.x, L.z) + 1); sn(L.x, L.z); }); });
    })();
    var ISL = Math.max(14, builtR + 4.5, shoreNeed), EXT = ISL + 8;
    function islandR(a) { return ISL * (1 + 0.07 * Math.sin(3 * a + 0.5) + 0.05 * Math.sin(5 * a + 2) + 0.025 * Math.sin(9 * a)); }
    function onIsland(x, z, m) { return Math.hypot(x, z) < islandR(Math.atan2(z, x)) - (m || 0); }
    // </layout>

    /* ground: one painted map of the island */
    function paintGround() {
      var S = 2048, c = document.createElement("canvas"); c.width = c.height = S; // 2048 keeps phones safe from running out of GPU memory
      var x = c.getContext("2d"), s = S / (2 * EXT);
      function X(v) { return (v + EXT) * s; }
      x.fillStyle = "#07080a"; x.fillRect(0, 0, S, S);
      var dots = document.createElement("canvas"); dots.width = dots.height = 8; var dx = dots.getContext("2d"); dx.fillStyle = "#101116"; dx.beginPath(); dx.arc(4, 4, 1.1, 0, 7); dx.fill();
      x.fillStyle = x.createPattern(dots, "repeat"); x.fillRect(0, 0, S, S);
      var isl = new Path2D(); for (var i = 0; i <= 240; i++) { var a = i / 240 * Math.PI * 2, r = islandR(a); if (i) isl.lineTo(X(Math.cos(a) * r), X(Math.sin(a) * r)); else isl.moveTo(X(Math.cos(a) * r), X(Math.sin(a) * r)); }
      isl.closePath(); x.lineJoin = "round";
      [[5.2, "#2a0f0b"], [4.6, "#07080a"], [3.0, "#5a1710"], [2.5, "#07080a"], [1.2, "#d9cdb0"]].forEach(function (w) { x.lineWidth = w[0] * s; x.strokeStyle = w[1]; x.stroke(isl); });
      x.fillStyle = "#1a1c1e"; x.fill(isl);
      x.save(); x.clip(isl);
      var n = document.createElement("canvas"); n.width = n.height = 96; var nx = n.getContext("2d"), id = nx.createImageData(96, 96);
      for (var j = 0; j < id.data.length; j += 4) { var v = 22 + Math.random() * 12; id.data[j] = v; id.data[j + 1] = v + 3; id.data[j + 2] = v; id.data[j + 3] = 255; }
      nx.putImageData(id, 0, 0); x.globalAlpha = 0.6; x.fillStyle = x.createPattern(n, "repeat"); x.fill(isl); x.globalAlpha = 1;
      for (var v = -Math.ceil(EXT / 3) * 3; v <= EXT; v += 3) { // streets
        x.fillStyle = "#0d0d10"; x.fillRect(X(v - 0.46), 0, 0.92 * s, S); x.fillRect(0, X(v - 0.46), S, 0.92 * s);
      }
      x.strokeStyle = "rgba(232,212,138,.28)"; x.lineWidth = Math.max(1, 0.05 * s); x.setLineDash([0.35 * s, 0.35 * s]); x.beginPath();
      for (v = -Math.ceil(EXT / 3) * 3; v <= EXT; v += 3) { x.moveTo(X(v), 0); x.lineTo(X(v), S); x.moveTo(0, X(v)); x.lineTo(S, X(v)); }
      x.stroke(); x.setLineDash([]);
      x.fillStyle = "#26252b"; x.fillRect(X(-2.55), X(-2.55), 5.1 * s, 5.1 * s); // the plaza, with a poster sunburst on its floor
      x.save(); x.beginPath(); x.rect(X(-2.5), X(-2.5), 5 * s, 5 * s); x.clip();
      for (var k = 0; k < 32; k++) { x.beginPath(); x.moveTo(X(0), X(0)); x.arc(X(0), X(0), 4 * s, k * Math.PI / 16, (k + 0.5) * Math.PI / 16); x.closePath(); x.fillStyle = "#5c130d"; x.fill(); }
      x.restore(); x.strokeStyle = "#d9cdb0"; x.lineWidth = 0.08 * s; x.strokeRect(X(-2.5), X(-2.5), 5 * s, 5 * s);
      x.fillStyle = "#22232a"; x.fillRect(X(3.5), X(-5.5), 2 * s, 2 * s); x.fillRect(X(-5.5), X(0.5), 2 * s, 2 * s);
      // the town square: paved from the plaza's front edge over the two kept blocks, stone grid, the pond in its middle
      x.fillStyle = "#26252b"; x.fillRect(X(-2.55), X(2.45), 5.1 * s, 3.1 * s);
      x.strokeStyle = "rgba(217,205,176,.13)"; x.lineWidth = Math.max(1, 0.03 * s); x.beginPath();
      for (var gx = -2.5; gx <= 2.51; gx += 0.5) { x.moveTo(X(gx), X(2.5)); x.lineTo(X(gx), X(5.5)); }
      for (var gz = 2.5; gz <= 5.51; gz += 0.5) { x.moveTo(X(-2.5), X(gz)); x.lineTo(X(2.5), X(gz)); }
      x.stroke(); x.strokeStyle = "#d9cdb0"; x.lineWidth = 0.08 * s; x.strokeRect(X(-2.5), X(2.5), 5 * s, 3 * s);
      x.fillStyle = "#1d3b3f"; x.beginPath(); x.ellipse(X(SQ[0]), X(SQ[1]), 0.85 * s, 0.75 * s, 0, 0, 7); x.fill(); x.strokeStyle = "#d9cdb0"; x.lineWidth = 0.07 * s; x.stroke();
      x.restore();
      var fade = x.createRadialGradient(S / 2, S / 2, (ISL + 4.6) * s, S / 2, S / 2, (EXT - 0.2) * s); fade.addColorStop(0, "rgba(0,0,0,1)"); fade.addColorStop(1, "rgba(0,0,0,0)");
      x.globalCompositeOperation = "destination-in"; x.fillStyle = fade; x.fillRect(0, 0, S, S); x.globalCompositeOperation = "source-over";
      var t = new THREE.CanvasTexture(c); t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      var g = new THREE.Mesh(new THREE.PlaneGeometry(2 * EXT, 2 * EXT), basic(0xffffff, { map: t, transparent: true })); g.rotation.x = -Math.PI / 2; g.renderOrder = -1; scene.add(g);
      scene.userData.ground = g; return g;
    }
    var lotTex = new THREE.DataTexture(new Uint8Array(128 * 128), 128, 128, THREE.LuminanceFormat); lotTex.magFilter = lotTex.minFilter = THREE.LinearFilter; lotTex.needsUpdate = true; // which lots are town (paved) and which are still forest
    var groundU = { uFw: { value: new THREE.Vector2(0.03, 0.03) }, uISL: { value: ISL }, uEXT: { value: EXT }, uSQ: { value: new THREE.Vector2(SQ[0], SQ[1]) }, uT: { value: 0 }, uLots: { value: lotTex }, uMd: { value: new THREE.Vector2(0.7071, 0.7071) } };
    var ground = new THREE.Mesh(new THREE.PlaneGeometry(2 * EXT, 2 * EXT), new THREE.ShaderMaterial({ uniforms: groundU, transparent: true,
      vertexShader: ["varying vec2 vW;",
      "void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }"].join("\n"),
      fragmentShader: ["uniform vec2 uFw; uniform float uISL; uniform float uEXT; uniform vec2 uSQ; uniform float uT; uniform vec2 uMd; uniform sampler2D uLots;",
      "varying vec2 vW;",
      "float cov(float x, float a, float b, float w) { return clamp((min(b, x + 0.5 * w) - max(a, x - 0.5 * w)) / w, 0.0, 1.0); }",
      "float box(vec2 p, vec2 lo, vec2 hi, vec2 w) { return cov(p.x, lo.x, hi.x, w.x) * cov(p.y, lo.y, hi.y, w.y); }",
      "float frame(vec2 p, vec2 lo, vec2 hi, float hw, vec2 w) { return clamp(box(p, lo - hw, hi + hw, w) - box(p, lo + hw, hi - hw, w), 0.0, 1.0); }",
      "float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
      "float hash1(float n) { return fract(sin(n * 91.3458) * 47453.5453); }",
      "float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }",
      "void main() {",
      "  vec2 p = vW, w = max(uFw, vec2(0.0001)); float wm = max(w.x, w.y);",
      "  float r = length(p), ang = atan(p.y, p.x);",
      "  float sd = r - uISL * (1.0 + 0.07 * sin(3.0 * ang + 0.5) + 0.05 * sin(5.0 * ang + 2.0) + 0.025 * sin(9.0 * ang));",
      "  vec3 cream = vec3(0.851, 0.804, 0.69);",
      "  /* sea: near-black with a fine dot screen */",
      "  vec3 col = vec3(0.0275, 0.0314, 0.0392);",
      "  vec2 dq = (fract(p / 0.22) - 0.5) * 0.22;",
      "  float dots = mix(clamp(0.5 - (length(dq) - 0.03) / wm, 0.0, 1.0), 0.058, clamp(wm / 0.08, 0.0, 1.0));",
      "  col = mix(col, vec3(0.0627, 0.0667, 0.0863), dots);",
      "  /* the moon on the water: a column of pale bars that breathe */",
      "  vec2 md = uMd; float al = dot(p, md), la = p.x * md.y - p.y * md.x;",
      "  float row = floor(al / 0.5), fr = (fract(al / 0.5) - 0.5) * 0.5;",
      "  float hl = (0.4 + 2.4 * hash1(row)) * (0.6 + 0.4 * sin(uT * 0.7 + row * 1.7)) * (0.9 + 0.017 * al);",
      "  float off = (hash1(row + 37.0) - 0.5) * 0.9;",
      "  float reach = smoothstep(0.2, 2.2, sd);",
      "  col += vec3(0.02, 0.03, 0.052) * exp(-la * la / 9.0) * reach;",
      "  col = mix(col, vec3(0.62, 0.68, 0.82), cov(fr, -0.045, 0.045, wm) * cov(la - off, -hl, hl, wm) * reach * 0.72);",
      "  /* shore: two poster rings in the water, a thin line of foam, the beach */",
      "  col = mix(col, vec3(0.165, 0.059, 0.043), cov(sd, 2.3, 2.6, wm));",
      "  col = mix(col, vec3(0.353, 0.09, 0.063), cov(sd, 1.25, 1.5, wm));",
      "  float fo = 0.76 + 0.06 * sin(uT * 0.5 + ang * 9.0);",
      "  col = mix(col, vec3(0.75, 0.78, 0.8), cov(sd, fo, fo + 0.07, wm) * 0.45);",
      "  col = mix(col, cream, cov(sd, -1.0, 0.6, wm));",
      "  /* land: dark paper with a little grain, greener where the forest is */",
      "  float gr = mix(hash(floor(p * 36.0)), 0.5, clamp(wm * 36.0 - 0.5, 0.0, 1.0));",
      "  vec3 lc = mix(vec3(0.102, 0.11, 0.118), vec3(0.0863, 0.098, 0.0863) + 0.047 * gr, 0.6);",
      "  float wild = 1.0 - smoothstep(0.3, 0.7, texture2D(uLots, (p + 64.5) / 128.0).r);",
      "  float me = max(wm * 0.5, 0.012), mv = vn(p * 0.42 + 7.3);",
      "  vec3 wc = mix(vec3(0.052, 0.098, 0.074), vec3(0.075, 0.135, 0.085), smoothstep(0.5 - me, 0.5 + me, mv));",
      "  wc = mix(wc, vec3(0.1, 0.165, 0.092), smoothstep(0.7 - me, 0.7 + me, mv));",
      "  lc = mix(lc, wc + 0.024 * (gr - 0.5), wild * 0.9);",
      "  /* streets every 3 units, kerbs, dashed centre lines (not across the crossings) */",
      "  vec2 dS = abs(mod(p + 1.5, 3.0) - 1.5);",
      "  float sx = cov(dS.x, -0.46, 0.46, w.x), sz = cov(dS.y, -0.46, 0.46, w.y);",
      "  float kerb = max(cov(dS.x, 0.46, 0.5, w.x) * (1.0 - sz), cov(dS.y, 0.46, 0.5, w.y) * (1.0 - sx));",
      "  lc = mix(lc, vec3(0.17, 0.175, 0.19), kerb * 0.5 * (1.0 - wild));",
      "  lc = mix(lc, vec3(0.051, 0.051, 0.063), max(sx, sz) * (1.0 - 0.72 * wild));",
      "  float da = cov(mod(p.y + uEXT + 0.175, 0.7) - 0.35, -0.175, 0.175, w.y); da = mix(da, 0.5, clamp((w.y - 0.25) / 0.35, 0.0, 1.0));",
      "  float db = cov(mod(p.x + uEXT + 0.175, 0.7) - 0.35, -0.175, 0.175, w.x); db = mix(db, 0.5, clamp((w.x - 0.25) / 0.35, 0.0, 1.0));",
      "  float ln = max(cov(dS.x, -0.028, 0.028, w.x) * da * (1.0 - sz), cov(dS.y, -0.028, 0.028, w.y) * db * (1.0 - sx));",
      "  lc = mix(lc, vec3(0.91, 0.831, 0.541), ln * 0.3 * (1.0 - wild));",
      "  /* the plaza with its sunburst floor */",
      "  lc = mix(lc, vec3(0.149, 0.145, 0.169), box(p, vec2(-2.55), vec2(2.55), w));",
      "  float wa = wm / max(r, 0.05), ua = mod(ang + 0.049087, 0.19635) - 0.098175;",
      "  float sb = mix(cov(ua, -0.049087, 0.049087, wa), 0.5, clamp((wa - 0.07) / 0.1, 0.0, 1.0));",
      "  lc = mix(lc, vec3(0.361, 0.075, 0.051), sb * box(p, vec2(-2.5), vec2(2.5), w));",
      "  lc = mix(lc, cream, frame(p, vec2(-2.5), vec2(2.5), 0.04, w));",
      "  /* the two kept blocks, the town square with its stone grid, the pond */",
      "  lc = mix(lc, vec3(0.133, 0.137, 0.165), max(box(p, vec2(3.5, -5.5), vec2(5.5, -3.5), w), box(p, vec2(-5.5, 0.5), vec2(-3.5, 2.5), w)));",
      "  lc = mix(lc, vec3(0.149, 0.145, 0.169), box(p, vec2(-2.55, 2.45), vec2(2.55, 5.55), w));",
      "  vec2 dG = abs(mod(p + 0.25, 0.5) - 0.25);",
      "  lc = mix(lc, cream, max(cov(dG.x, -0.016, 0.016, w.x), cov(dG.y, -0.016, 0.016, w.y)) * box(p, vec2(-2.5, 2.5), vec2(2.5, 5.5), w) * 0.13);",
      "  lc = mix(lc, cream, frame(p, vec2(-2.5, 2.5), vec2(2.5, 5.5), 0.04, w));",
      "  float pd = (length((p - uSQ) / vec2(0.85, 0.75)) - 1.0) * 0.8;",
      "  lc = mix(lc, vec3(0.114, 0.231, 0.247), clamp(0.5 - pd / wm, 0.0, 1.0));",
      "  lc = mix(lc, cream, cov(pd, -0.035, 0.035, wm));",
      "  col = mix(col, lc, clamp(0.5 - sd / wm, 0.0, 1.0));",
      "  gl_FragColor = vec4(col, 1.0 - smoothstep(uISL + 4.6, uEXT - 0.2, r));",
      "}"].join("\n") }));
    ground.rotation.x = -Math.PI / 2; ground.renderOrder = -1; scene.add(ground); scene.userData.ground = ground;
    var groundChecked = false;

    /* houses: walls, roof (continent colour), windows (lit or dark), ink outline */
    // ---- houses: four shapes, each with real windows, a door, a stone base and a chimney
    function mergeCol(list) { // list of [geometry, dx, dy, dz, colour]: one geometry that keeps a colour per part
      var pos = [], nor = [], col = [], c = new THREE.Color();
      list.forEach(function (it) {
        var g = it[0].index ? it[0].toNonIndexed() : it[0]; g.translate(it[1] || 0, it[2] || 0, it[3] || 0); c.set(it[4] || "#ffffff");
        pos.push.apply(pos, g.attributes.position.array); nor.push.apply(nor, g.attributes.normal.array);
        for (var k = 0; k < g.attributes.position.count; k++) col.push(c.r, c.g, c.b);
      });
      var out = new THREE.BufferGeometry();
      out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      return out;
    }
    function flat(g) { g = g.index ? g.toNonIndexed() : g; g.computeVertexNormals(); return g; }
    function prism(len, hw, rh) { // a gable: a triangle 2 * hw wide and rh high, pulled along x
      var x0 = -len / 2, x1 = len / 2, A0 = [x0, 0, -hw], B0 = [x0, 0, hw], C0 = [x0, rh, 0], A1 = [x1, 0, -hw], B1 = [x1, 0, hw], C1 = [x1, rh, 0], P = [];
      [A0, B0, C0, A1, C1, B1, B0, B1, C1, B0, C1, C0, A1, A0, C0, A1, C0, C1].forEach(function (v) { P.push(v[0], v[1], v[2]); });
      var g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.computeVertexNormals(); return g;
    }
    function houseGeo(o) {
      var FRAME = "#2a2530", STONE = "#b9ae96", BRICK = "#8a4a3a", DOOR = o.door || "#8f1911";
      var W = [[new THREE.BoxGeometry(o.w, o.h, o.d), 0, o.h / 2, 0]], R = [], G = [], T = [[new THREE.BoxGeometry(o.w + 0.05, 0.07, o.d + 0.05), 0, 0.035, 0, STONE]];
      var O = [[new THREE.BoxGeometry(o.w + 0.11, o.h + 0.05, o.d + 0.11), 0, o.h / 2, 0]], chim, cb;
      // f = which wall: 0 front (+z), 1 right (+x), 2 back, 3 left; u = place along the wall
      function pl(f, u, y, pw, ph, off, c) { var g = new THREE.PlaneGeometry(pw, ph); g.rotateY(f * Math.PI / 2); return f === 0 ? [g, u, y, o.d / 2 + off, c] : f === 1 ? [g, o.w / 2 + off, y, -u, c] : f === 2 ? [g, -u, y, -o.d / 2 - off, c] : [g, -o.w / 2 - off, y, u, c]; }
      function bx(f, u, y, pw, ph, th, c) { var sg = f < 2 ? 1 : -1; return f % 2 === 0 ? [new THREE.BoxGeometry(pw, ph, th), sg * u, y, sg * o.d / 2, c] : [new THREE.BoxGeometry(th, ph, pw), sg * o.w / 2, y, -sg * u, c]; }
      function windowAt(f, u, y) { // dark frame, stone sill, four panes of glass
        T.push(pl(f, u, y, 0.3, 0.32, 0.008, FRAME), bx(f, u, y - 0.18, 0.34, 0.04, 0.07, STONE));
        [-1, 1].forEach(function (a) { [-1, 1].forEach(function (b) { G.push(pl(f, u + a * 0.07, y + b * 0.075, 0.115, 0.125, 0.016)); }); });
      }
      for (var f = 0; f < 4; f++) {
        var fw = f % 2 === 0 ? o.w : o.d;
        for (var ri = 0; ri < o.rows.length; ri++) {
          if (f === 0 && ri === 0) { windowAt(0, 0.235 * fw, o.rows[0]); continue; } // the door takes the other half of the front
          windowAt(f, -0.235 * fw, o.rows[ri]); windowAt(f, 0.235 * fw, o.rows[ri]);
        }
      }
      var du = -0.235 * o.w; // door: frame, leaf, step, a small lit pane
      T.push(pl(0, du, 0.225, 0.27, 0.45, 0.006, FRAME), [new THREE.BoxGeometry(0.2, 0.42, 0.04), du, 0.21, o.d / 2, DOOR], [new THREE.BoxGeometry(0.32, 0.05, 0.16), du, 0.025, o.d / 2 + 0.08, STONE]);
      G.push(pl(0, du, 0.335, 0.12, 0.07, 0.026));
      if (o.roof === "hip") {
        var c = new THREE.ConeGeometry(0.7071, o.rh, 4, 1); c.rotateY(Math.PI / 4); c.scale(o.w + 0.18, 1, o.d + 0.18); R.push([flat(c), 0, o.h + o.rh / 2 - 0.01, 0]);
        var c2 = new THREE.ConeGeometry(0.7071, o.rh + 0.13, 4, 1); c2.rotateY(Math.PI / 4); c2.scale(o.w + 0.32, 1, o.d + 0.32); O.push([c2, 0, o.h + o.rh / 2 + 0.005, 0]);
        chim = [0.2, o.h + o.rh * 0.62 + 0.26, -0.08]; cb = o.h + o.rh * 0.3;
      } else {
        var gx = o.roof === "gx", L = gx ? o.w : o.d, hw = (gx ? o.d : o.w) / 2, rh = hw * o.pitch, th = Math.atan2(rh, hw), sl = Math.sqrt(rh * rh + hw * hw) + 0.13;
        var turn = function (g) { if (!gx) g.rotateY(Math.PI / 2); return g; };
        W.push([turn(prism(L, hw, rh)), 0, o.h, 0]);
        [0, 1].forEach(function (s) { var b = new THREE.BoxGeometry(L + 0.18, 0.06, sl + 0.05); b.translate(0, 0.03, sl / 2 - 0.025); b.rotateX(th); if (s) b.rotateY(Math.PI); R.push([turn(b), 0, o.h + rh, 0]); });
        var hw2 = hw + 0.3, rh2 = hw2 * o.pitch; O.push([turn(prism(L + 0.3, hw2, rh2)), 0, o.h + rh - rh2 + 0.11 / Math.cos(th), 0]);
        var ce = L / 2 - 0.24; chim = gx ? [ce, o.h + rh + 0.26, 0] : [0, o.h + rh + 0.26, -ce]; cb = o.h + rh - 0.2;
        (gx ? [1, 3] : [0, 2]).forEach(function (f2) { T.push(pl(f2, 0, o.h + rh * 0.36, 0.2, 0.2, 0.008, FRAME)); G.push(pl(f2, 0, o.h + rh * 0.36, 0.125, 0.125, 0.016)); }); // attic window
      }
      T.push([new THREE.BoxGeometry(0.15, chim[1] - cb, 0.15), chim[0], (chim[1] + cb) / 2, chim[2], BRICK], [new THREE.BoxGeometry(0.2, 0.04, 0.2), chim[0], chim[1], chim[2], FRAME]);
      O.push([new THREE.BoxGeometry(0.23, chim[1] - cb + 0.07, 0.23), chim[0], (chim[1] + cb) / 2 + 0.02, chim[2]]);
      return { walls: mergeCol(W), roof: mergeCol(R), win: mergeCol(G), trim: mergeCol(T), out: mergeCol(O), chim: chim };
    }
    var HV = [houseGeo({ w: 1, d: 1, h: 0.7, roof: "hip", rh: 0.6, rows: [0.4] }), houseGeo({ w: 1.12, d: 0.86, h: 0.7, roof: "gx", pitch: 0.95, rows: [0.4] }),
              houseGeo({ w: 0.84, d: 0.84, h: 1.28, roof: "hip", rh: 0.62, rows: [0.4, 0.95] }), houseGeo({ w: 0.9, d: 1.08, h: 0.72, roof: "gz", pitch: 1.05, rows: [0.4], door: "#6b4a2f" })];
    var HK = ["walls", "roof", "win", "trim", "out"];
    var TG = {
      body: mergeGeo([[new THREE.BoxGeometry(0.86, 2.0, 0.86), 0, 1.0, 0], [new THREE.BoxGeometry(0.5, 0.25, 0.5), 0, 2.12, 0]]),
      win: mergeGeo([0.45, 0.85, 1.25, 1.65].map(function (y) { return [new THREE.BoxGeometry(0.9, 0.09, 0.9), 0, y, 0]; })),
      out: mergeGeo([[new THREE.BoxGeometry(0.96, 2.1, 0.96), 0, 1.0, 0]])
    };
    var CAP = Math.max(HOUSES.length, 90) + 4;
    function inst(geo, mat, colors) { var m = new THREE.InstancedMesh(geo, mat, Math.max(1, CAP)); m.count = 0; m.frustumCulled = false; if (colors) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, CAP) * 3), 3); scene.add(m); return m; }
    var M = { tbody: inst(TG.body, toon(0x3a3a42)), twin: inst(TG.win, basic(0xffffff), true), tout: inst(TG.out, inkBack) }; M.tbody.userData.slot = "t";
    var wallMat = toon(0xffffff), roofMat = toon(0xffffff), winMat = basic(0xffffff), trimMat = toon(0xffffff, { vertexColors: true }), HPICK = [];
    var MV = HV.map(function (g, i) { var o = { walls: inst(g.walls, wallMat, true), roof: inst(g.roof, roofMat, true), win: inst(g.win, winMat, true), trim: inst(g.trim, trimMat, true), out: inst(g.out, inkBack) }; o.walls.userData.slot = o.roof.userData.slot = "h" + i; HPICK.push(o.walls, o.roof); return o; });
    var TRIMON = new THREE.Color(1, 1, 1), TRIMOFF = new THREE.Color(0.3, 0.3, 0.33), smokeSrc = [];
    var WALL = [new THREE.Color("#efe5cf"), new THREE.Color("#e6dac0"), new THREE.Color("#f4ecdb")];
    var ROOFC = {}; CKEYS.forEach(function (c) { ROOFC[c] = new THREE.Color(CCOL[c]); });
    var DIMW = new THREE.Color("#3a3a40"), DIMR = new THREE.Color("#26262c"), filter = null;
    function matches(h) {
      if (!filter) return true;
      if (typeof filter === "object") return filter.group != null ? h.g === filter.group : filter.lit != null ? !!litNow[h.idx] === filter.lit :
        filter.signed ? !!signedNow[h.idx] : filter.fresh ? !!fresh[h.idx] : filter.old ? standing(h, OLDT) : h.day === filter.day;
      return filter === "dc" ? h.dc : h.c === filter;
    }
    var LITC = new THREE.Color("#ffcf6b"), DARKC = new THREE.Color("#23232a"), CURT = new THREE.Color("#ff7a3a"), CURD = new THREE.Color("#3a1a12"), CYAN = new THREE.Color("#00e0f0"), CYD = new THREE.Color("#16323a");
    var SLOT = []; // for each house: which instance index in which mesh
    HOUSES.forEach(function (h) {
      h.rot = Math.floor(h2(h.idx, 3) * 4) * Math.PI / 2;
      h.tall = !h.dc && h2(h.idx, 5) > 0.8; h.s = 0.6 + h2(h.idx, 9) * 0.1; h.v = h2(h.idx, 5) > 0.8 ? 2 : [0, 1, 3][Math.min(2, Math.floor(h2(h.idx, 13) * 3))];
    });
    var shown = [], fresh = {}, litNow = {}, signedNow = {}, born = {}, tm = new THREE.Matrix4(), tq = new THREE.Quaternion(), ts = new THREE.Vector3(), tp = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
    var anim = false, hopAt = {};
    /* a gold welcome flag (a small banner with the word WELCOME) on every house that is new on the shown day: up for its
       first day only. Not on the day the house records start (every house would fly one). The country flags (plain
       rectangles) stay on the town square. */
    var BALC = "#f0c24a", balOn = false, balList = [], balE = new THREE.Euler(), balAz = 0;
    var BALW = 0.92, BALH = 0.23, BALY = 0.74; // the cloth: width, height, lower edge above the roof top
    function balShape() { var s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(1, 0); s.lineTo(0.875, 0.5); s.lineTo(1, 1); s.lineTo(0, 1); return s; } // a banner with a swallowtail end, in 0..1
    function balCloth(g, d) { return new THREE.ExtrudeGeometry(balShape(), { depth: d, bevelEnabled: false }).scale(BALW + 2 * g, BALH + 2 * g, 1).translate(0.014 - g, BALY - g, -d / 2); } // g grows it (the ink outline), d = how thick
    var BALTOP = HV.map(function (g) { g.roof.computeBoundingBox(); return g.roof.boundingBox.max.y; });
    var balM = inst(mergeCol([[new THREE.BoxGeometry(0.028, 0.98, 0.028), 0, 0.49, 0, "#e6dfcf"], [new THREE.SphereGeometry(0.04, 8, 6), 0, 1.0, 0, BALC],
      [balCloth(0, 0.02), 0, 0, 0, BALC]]), toon(0xffffff, { vertexColors: true, emissive: 0x2a1d05 }));
    var balO = inst(balCloth(0.024, 0.07), inkBack);
    var balCv = document.createElement("canvas"); balCv.width = 512; balCv.height = 128;
    var balTex = new THREE.CanvasTexture(balCv); balTex.anisotropy = 8;
    var balT = inst(new THREE.ShapeGeometry(balShape()).scale(BALW, BALH, 1).translate(0.014, BALY, 0.014), basic(0xffffff, { map: balTex })); // the side you see
    function drawWelcome() { // gold cloth with soft folds and the word; drawn again when the page's letters have loaded
      var x = balCv.getContext("2d"), w = 512, h = 128, px = 136, m, a, g = x.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, "#f8d268"); g.addColorStop(0.3, "#ebb93e"); g.addColorStop(0.56, "#f6cd5a"); g.addColorStop(0.82, "#e5af36"); g.addColorStop(1, "#f0c24a");
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.fillStyle = "#1a1408"; x.textAlign = "center"; x.textBaseline = "alphabetic";
      do { px -= 4; x.font = "900 " + px + "px 'Big Shoulders Stencil Display', Anton, sans-serif"; m = x.measureText("WELCOME"); a = m.actualBoundingBoxAscent || px * 0.72; } while (px > 24 && (m.width > w * 0.78 || a > h * 0.72));
      x.fillText("WELCOME", w * 0.445, (h + a) / 2); balTex.needsUpdate = true;
    }
    drawWelcome();
    balM.userData.slot = "b";
    function placeBalloons(now) {
      var n = 0, t = now / 1000;
      balList.forEach(function (h) {
        var a = Math.max(0, Math.min(1, (now - born[h.idx]) / 520)), e = Math.max(0.0001, a >= 1 ? 1 : 1 - Math.pow(1 - a, 3) * Math.cos(a * 5.5));
        var hp = hopAt[h.idx] ? (now - hopAt[h.idx]) / 650 : 2, sw = reduce ? 0 : Math.sin(t * 1.3 + h.idx * 1.7);
        tp.set(h.x, (hp < 1 ? Math.sin(Math.PI * hp) * 0.42 : 0) + ((h.dc ? 2.245 : BALTOP[h.v]) * h.s - 0.05) * e, h.z);
        balAz = st ? st.az : 0; balE.set(0, balAz + sw * 0.22, 0); tq.setFromEuler(balE); // faces you like the ministry's flag, sways a little around its pole
        ts.set(e, e, e); tm.compose(tp, tq, ts); balM.setMatrixAt(n, tm); balO.setMatrixAt(n, tm); balT.setMatrixAt(n, tm); n++;
      });
      balM.count = balO.count = balT.count = n; balM.instanceMatrix.needsUpdate = balO.instanceMatrix.needsUpdate = balT.instanceMatrix.needsUpdate = true;
    }
    function placeHouses(now) {
      var busy = false, vcnt = [0, 0, 0, 0], ti = 0;
      shown.forEach(function (h) {
        var a = Math.max(0, Math.min(1, (now - born[h.idx]) / 520)); if (a < 1) busy = true;
        var e = a >= 1 ? 1 : 1 - Math.pow(1 - a, 3) * Math.cos(a * 5.5), sc = h.s * Math.max(0.0001, e);
        var hp = hopAt[h.idx] ? (now - hopAt[h.idx]) / 650 : 2; if (hp < 1) busy = true;
        tp.set(h.x, hp < 1 ? Math.sin(Math.PI * hp) * 0.42 : 0, h.z); tq.setFromAxisAngle(UPV, h.rot);
        if (h.dc) { ts.set(sc, sc, sc); tm.compose(tp, tq, ts); M.tbody.setMatrixAt(ti, tm); M.twin.setMatrixAt(ti, tm); M.tout.setMatrixAt(ti, tm); SLOT[h.idx] = ["t", ti++]; }
        else { ts.set(sc, sc, sc); tm.compose(tp, tq, ts); var mv = MV[h.v], vi = vcnt[h.v]++; HK.forEach(function (k) { mv[k].setMatrixAt(vi, tm); }); SLOT[h.idx] = ["h" + h.v, vi]; }
      });
      MV.forEach(function (mv, i) { HK.forEach(function (k) { mv[k].count = vcnt[i]; mv[k].instanceMatrix.needsUpdate = true; }); });
      ["tbody", "twin", "tout"].forEach(function (k) { M[k].count = ti; M[k].instanceMatrix.needsUpdate = true; });
      if (gtPlace(now)) busy = true; // garden trees and lanterns
      placeBalloons(now);
      return busy;
    }
    var lightAt = {}, lighting = false, lightEnd = 0;
    function colourHouses(now) {
      var vc = [0, 0, 0, 0], ti = 0, gp = 0; now = now || performance.now(); smokeSrc.length = 0;
      shown.forEach(function (h) {
        var on = matches(h), lit = on && litNow[h.idx] && now >= (lightAt[h.idx] || 0), priv = h.c === "not_reported";
        if (h.dc) { M.twin.setColorAt(ti++, lit ? CYAN : CYD); }
        else {
          var mv = MV[h.v], vi = vc[h.v]++;
          mv.walls.setColorAt(vi, on ? WALL[h.idx % 3] : DIMW); mv.roof.setColorAt(vi, on ? ROOFC[h.c] : DIMR); mv.trim.setColorAt(vi, on ? TRIMON : TRIMOFF);
          mv.win.setColorAt(vi, priv ? (lit ? CURT : CURD) : (lit ? LITC : DARKC));
          if (lit && h2(h.idx, 23) < 0.6) { var C = HV[h.v].chim, ca = Math.cos(h.rot), sa = Math.sin(h.rot); smokeSrc.push([h.x + (C[0] * ca + C[2] * sa) * h.s, C[1] * h.s + 0.04, h.z + (C[2] * ca - C[0] * sa) * h.s, h2(h.idx, 21)]); }
        }
        if (lit) { glowPos[gp * 3] = h.x; glowPos[gp * 3 + 1] = h.dc ? 1.1 : 0.3; glowPos[gp * 3 + 2] = h.z; tp.set(h.x, 0, h.z); tq.identity(); ts.set(1, 1, 1); tm.compose(tp, tq, ts); hpool.setMatrixAt(gp, tm); hpool.setColorAt(gp, h.dc ? POOLC : priv ? POOLO : POOLW); gp++; }
      });
      M.twin.instanceColor.needsUpdate = true; MV.forEach(function (mv) { ["walls", "roof", "win", "trim"].forEach(function (k) { mv[k].instanceColor.needsUpdate = true; }); });
      glowGeo.attributes.position.needsUpdate = true; glowGeo.setDrawRange(0, gp);
      hpool.count = gp; hpool.instanceMatrix.needsUpdate = true; hpool.instanceColor.needsUpdate = true;
      balList = balOn ? shown.filter(function (h) { return fresh[h.idx] && matches(h); }) : []; placeBalloons(now); if (!anim) gtPlace(now);
    }
    var glowGeo = new THREE.BufferGeometry(), glowPos = new Float32Array(Math.max(1, CAP) * 3);
    glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPos, 3)); glowGeo.setDrawRange(0, 0);
    var glowTex = (function () { var c = document.createElement("canvas"); c.width = c.height = 64; var x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,207,107,.7)"); g.addColorStop(0.35, "rgba(255,160,60,.22)"); g.addColorStop(1, "rgba(255,140,40,0)"); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    var glowMat = new THREE.PointsMaterial({ size: 24, opacity: 0.8, sizeAttenuation: false, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    var glows = new THREE.Points(glowGeo, glowMat); glows.frustumCulled = false; glows.renderOrder = 4; scene.add(glows);

    /* garden trees (addition gt): every house has one small tree in a corner of its lot. It is planted on the house's
       first day in the records and is a little bigger every day after: a staked sapling on day one, full size after
       about forty days, still well below the roof. The houses here since the first day of house records also have a
       small lantern by the door, lit when the house is. On the old chain's days the houses only stand in: no garden. */
    var gtGreens = ["#4a7a48", "#3a6a45", "#5a8a44", "#35604f"].map(function (c) { return new THREE.Color(c); }), gtFresh = new THREE.Color("#b4d468");
    var gtWood = new THREE.Color("#4a3426"), gtPale = new THREE.Color("#c9b48a"), gtDim = new THREE.Color("#2b2f2d"), gtC = new THREE.Color();
    var gtLit = new THREE.Color("#ffc65e"), gtUnlit = new THREE.Color("#4a3c26"), gtOff = new THREE.Color("#26262c");
    var gtTrunk = inst(new THREE.CylinderGeometry(0.75, 1, 1, 6, 1, true).translate(0, 0.5, 0), toon(0xffffff), true); // one unit high, sized per tree
    var gtBall = inst(new THREE.IcosahedronGeometry(0.15, 1).translate(0, 0.12, 0), toon(0xffffff), true); // a round crown (also drawn tall and slim)
    var gtCone = inst(mergeGeo([[new THREE.ConeGeometry(0.15, 0.28, 7, 1, true), 0, 0.12, 0], [new THREE.ConeGeometry(0.105, 0.24, 7, 1, true), 0, 0.28, 0]]), toon(0xffffff), true); // a small fir
    var gtStake = inst(mergeGeo([[new THREE.BoxGeometry(0.016, 0.17, 0.016), 0.046, 0.085, 0], [new THREE.BoxGeometry(0.046, 0.012, 0.012), 0.023, 0.1, 0]]), toon(0xffffff), true); // stake and tie
    var gtLamp = inst(mergeCol([[new THREE.BoxGeometry(0.02, 0.24, 0.02), 0, 0.12, 0, "#2a2a30"], [new THREE.BoxGeometry(0.056, 0.012, 0.056), 0, 0.24, 0, "#2a2a30"],
      [new THREE.ConeGeometry(0.046, 0.042, 4, 1, true).rotateY(Math.PI / 4), 0, 0.311, 0, "#2a2a30"], [new THREE.BoxGeometry(0.036, 0.046, 0.036), 0, 0.269, 0]]), basic(0xffffff, { vertexColors: true }), true); // a short dark post with a little roof and a warm glass
    var gtMeshes = [gtTrunk, gtBall, gtCone, gtStake, gtLamp], gtL = [0, 0];
    var gtHaloPos = new Float32Array(Math.max(1, CAP) * 3), gtHaloCol = new Float32Array(Math.max(1, CAP) * 3), gtHaloK = new Float32Array(Math.max(1, CAP)), gtHaloPh = new Float32Array(Math.max(1, CAP));
    var gtHN = 0, gtHaloGeo = new THREE.BufferGeometry(); gtHaloGeo.setAttribute("position", new THREE.BufferAttribute(gtHaloPos, 3)); gtHaloGeo.setAttribute("color", new THREE.BufferAttribute(gtHaloCol, 3)); gtHaloGeo.setDrawRange(0, 0);
    var gtHaloMat = new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    var gtHalo = new THREE.Points(gtHaloGeo, gtHaloMat); gtHalo.frustumCulled = false; gtHalo.renderOrder = 4; gtHalo.raycast = function () {}; scene.add(gtHalo);
    var gtWD = HV.map(function (g) { g.walls.computeBoundingBox(); return [g.walls.boundingBox.max.x, g.walls.boundingBox.max.z]; }); // half width and depth of each house shape
    // each tree takes a corner of its lot on a street side (never the street lamp's corner); two houses never share one.
    // The walkers keep to the + side of every street and the night bus to the - side of the ring road, 6 from the middle
    // (see busAt): a full-grown crown must not reach into them, so a tree stands a little back from the walkers' kerb and
    // takes the bus's kerb only when its house has no other corner left, and then well back. It keeps clear of the lanterns
    // too: a tree that cannot stays a little smaller.
    var gtSpot = {}, gtUsed = {}, gtTodo = [[], [], []], gtLans = [];
    if (HOMES) HOUSES.forEach(function (h) { if (h.day === FIRSTNEW && h.x != null && !plaza(h.x, h.z)) gtLans.push(gtLanAt(h)); });
    function gtBus(v, w) { return Math.abs(v) === 6 && w > -6.9 && w < 6.45; }
    function gtBack(kerb, bus, walk, r) { return !kerb ? 0.48 + 0.04 * r : bus ? 0.4 : walk ? 0.47 - 0.01 * r : 0.5 + 0.03 * r; } // how far out from the house's middle
    function gtLanD(x, z) { var d = 9; gtLans.forEach(function (L) { if (Math.abs(L[0] - x) < 0.3 && Math.abs(L[1] - z) < 0.3) d = Math.min(d, Math.hypot(L[0] - x, L[1] - z)); }); return d; } // to the nearest lantern
    HOUSES.forEach(function (h) {
      if (h.x == null || plaza(h.x, h.z)) return;
      var ax = street(h.x - 1) ? -1 : 1, az = street(h.z - 1) ? -1 : 1, c = [[ax, az], [ax, -az], [-ax, az]];
      if (ax < 0 && az < 0) c.shift();
      c = c.map(function (q) {
        var bx = q[0] === ax && ax > 0 && gtBus(h.x + ax, h.z + 0.5 * q[1]), bz = q[1] === az && az > 0 && gtBus(h.z + az, h.x + 0.5 * q[0]);
        var x = h.x + q[0] * gtBack(q[0] === ax, bx, ax < 0, h2(h.idx, 143)), z = h.z + q[1] * gtBack(q[1] === az, bz, az < 0, h2(h.idx, 145));
        var d = gtLanD(x, z); return { q: q, x: x, z: z, d: d, key: (2 * h.x + q[0]) + "," + (2 * h.z + q[1]), cost: (bx ? 2 : 0) + (bz ? 2 : 0) + (d < 0.22 ? 1 : 0) };
      });
      gtTodo[c.length < 3 ? 0 : c.some(function (o) { return o.cost; }) ? 1 : 2].push([h, c]);
    });
    gtTodo.forEach(function (list) { list.forEach(function (t) { // the lamp's houses first (they have two corners only), then those with a corner to avoid, then the rest
      var h = t[0], c = t[1], best = null;
      for (var k = 0, k0 = Math.floor(h2(h.idx, 141) * c.length); k < c.length; k++) { var o = c[(k0 + k) % c.length]; if (!gtUsed[o.key] && (!best || o.cost < best.cost)) best = o; }
      if (!best) return; gtUsed[best.key] = 1;
      var f = h2(h.idx, 147);
      gtSpot[h.idx] = { x: best.x, z: best.z, r: h2(h.idx, 149) * 6.283, k: Math.min(0.92 + 0.14 * h2(h.idx, 151), (best.d - 0.05) / 0.15), f: f < 0.42 ? 0 : f < 0.72 ? 1 : 2, c: gtGreens[Math.floor(h2(h.idx, 153) * gtGreens.length) % gtGreens.length] };
    }); });
    function gtLanAt(h, o) { // beside the door step, out from under the eaves
      o = o || []; var wd = h.dc ? [0.43, 0.43] : gtWD[h.v], lx = h.dc ? -0.24 : -0.47 * wd[0] - 0.2, lz = Math.min(0.46 / h.s, wd[1] + 0.2), ca = Math.cos(h.rot), sa = Math.sin(h.rot);
      o[0] = h.x + (lx * ca + lz * sa) * h.s; o[1] = h.z + (lz * ca - lx * sa) * h.s; return o;
    }
    function gtSize(a) { // the crown after a days: a small tuft on day one, a clear step each of the first days, then slower, full size after about forty days
      a = Math.max(0, a); var u = Math.min(1, a / 40); return 0.22 + 0.78 * (0.72 * (1 - Math.exp(-a / 2.6)) + 0.28 * (1 - (1 - u) * (1 - u)));
    }
    function gtGlow(t) { // the lanterns breathe slowly, each at its own pace; steady when motion is reduced (t < 0)
      for (var i = 0; i < gtHN; i++) { var f = gtHaloK[i] * (t < 0 ? 0.85 : 0.72 + 0.28 * Math.sin(t * 0.75 + gtHaloPh[i])); gtHaloCol[i * 3] = f * 0.9; gtHaloCol[i * 3 + 1] = f * 0.72; gtHaloCol[i * 3 + 2] = f * 0.45; }
      gtHaloGeo.attributes.color.needsUpdate = true;
    }
    function gtFrame(t, px) { gtHaloMat.size = Math.max(5, Math.min(44, 0.45 * px)); if (!reduce && gtHN) gtGlow(t); }
    var gtCur = {}, gtTw = {}, gtSeen = {}, gtDay = null;
    function gtPlace(now) { // trees and lanterns of the shown houses: they pop in, hide and dim with their house; called by placeHouses and colourHouses
      var day = lastShown, old = day < FIRSTNEW || !!(DAYS[day] && DAYS[day].old_chain), busy = false, n = [0, 0, 0, 0, 0];
      if (day !== gtDay) { // another day: each tree grows (or shrinks back) from what it is now to its age on that day
        var seen = gtSeen; gtSeen = {}; gtDay = day;
        shown.forEach(function (h) { var to = old ? -1 : Math.max(0, day - h.day); gtTw[h.idx] = [seen[h.idx] && !reduce ? gtCur[h.idx] : to, to, reduce ? now - 1e5 : now + h2(h.idx, 155) * 300]; gtSeen[h.idx] = 1; });
      }
      shown.forEach(function (h) {
        var sp = gtSpot[h.idx], tw = gtTw[h.idx]; if (!tw) return;
        var p = Math.max(0, Math.min(1, (now - tw[2]) / 900)), A = tw[0] + (tw[1] - tw[0]) * (1 - Math.pow(1 - p, 3)); if (p < 1) busy = true; gtCur[h.idx] = A;
        var b = Math.max(0, Math.min(1, (now - born[h.idx]) / 520)), e = Math.max(0.0001, b >= 1 ? 1 : 1 - Math.pow(1 - b, 3) * Math.cos(b * 5.5));
        var pr = Math.max(0, Math.min(1, A + 1)) * e, on = matches(h); if (pr < 0.003) return;
        if (sp) {
          // the stem shoots up in the first days, the crown keeps filling out for weeks
          var s = gtSize(A) * sp.k, th = (0.09 + 0.11 * (1 - Math.exp(-Math.max(0, A) / 1.8))) * (sp.f === 2 ? 0.6 : 1) * sp.k * pr, rb = 0.032 * Math.pow(s, 0.7) * pr, cs = s * pr, m = sp.f === 2 ? gtCone : gtBall, j = sp.f === 2 ? 2 : 1;
          tp.set(sp.x, 0, sp.z); tq.setFromAxisAngle(UPV, sp.r); ts.set(rb, th, rb); tm.compose(tp, tq, ts); gtTrunk.setMatrixAt(n[0], tm); gtTrunk.setColorAt(n[0]++, on ? gtWood : gtDim);
          tp.y = th * 0.97; if (sp.f === 1) ts.set(cs * 0.84, cs * 1.25, cs * 0.84); else ts.set(cs, cs, cs); tm.compose(tp, tq, ts);
          m.setMatrixAt(n[j], tm); m.setColorAt(n[j]++, on ? gtC.copy(sp.c).lerp(gtFresh, 0.85 * Math.max(0, 1 - Math.max(0, A) / 3)) : gtDim); // young leaves are lighter; by the fourth day they have their own green
          var sk = Math.max(0, Math.min(1, 2 - A)) * pr; // the stake comes out once the tree stands on its own
          if (sk > 0.003) { tp.y = 0; ts.set(sk, sk, sk); tm.compose(tp, tq, ts); gtStake.setMatrixAt(n[3], tm); gtStake.setColorAt(n[3]++, on ? gtPale : gtDim); }
        }
        if (HOMES && h.day === FIRSTNEW) { // only with real house records
          var L = gtLanAt(h, gtL), lit = on && litNow[h.idx] && now >= (lightAt[h.idx] || 0), i = n[4]++;
          tp.set(L[0], 0, L[1]); tq.setFromAxisAngle(UPV, h.rot); ts.set(pr, pr, pr); tm.compose(tp, tq, ts); gtLamp.setMatrixAt(i, tm);
          gtLamp.setColorAt(i, lit ? gtLit : on ? gtUnlit : gtOff);
          gtHaloPos[i * 3] = L[0]; gtHaloPos[i * 3 + 1] = 0.269 * pr; gtHaloPos[i * 3 + 2] = L[1]; gtHaloK[i] = lit ? pr : 0; gtHaloPh[i] = h2(h.idx, 157) * 6.283;
        }
      });
      gtTrunk.count = n[0]; gtBall.count = n[1]; gtCone.count = n[2]; gtStake.count = n[3]; gtLamp.count = gtHN = n[4];
      gtMeshes.forEach(function (m) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
      gtHaloGeo.attributes.position.needsUpdate = true; gtHaloGeo.setDrawRange(0, gtHN); gtGlow(reduce ? -1 : (now - tStart) / 1000);
      return busy;
    }

    /* building sites for tomorrow, and the forest on lots nobody has claimed yet */
    function scafGeo() { // four posts, two rings of rails, one plank
      var L = [], w = 0.036, r = 0.34;
      [-r, r].forEach(function (x) { [-r, r].forEach(function (z) { L.push([new THREE.BoxGeometry(w, 0.98, w), x, 0.57, z]); }); });
      [0.46, 0.84].forEach(function (y) { [-r, r].forEach(function (v) { L.push([new THREE.BoxGeometry(2 * r, 0.028, 0.028), 0, y, v], [new THREE.BoxGeometry(0.028, 0.028, 2 * r), v, y, 0]); }); });
      L.push([new THREE.BoxGeometry(2 * r, 0.02, 0.17), 0, 0.485, r - 0.1]);
      return mergeGeo(L);
    }
    var site = { slab: inst(new THREE.BoxGeometry(0.86, 0.08, 0.86).translate(0, 0.04, 0), toon(0x2a2a30)), frame: inst(scafGeo(), toon(0xe8d48a, { emissive: 0x5a4a1c })),
      wall: inst(mergeGeo([[new THREE.BoxGeometry(0.56, 0.42, 0.07), 0, 0.29, -0.245], [new THREE.BoxGeometry(0.07, 0.34, 0.56), -0.245, 0.25, 0], [new THREE.BoxGeometry(0.07, 0.26, 0.56), 0.245, 0.21, 0], [new THREE.BoxGeometry(0.56, 0.16, 0.07), 0, 0.16, 0.245]]), toon(0xb3a78c)) };
    var TREEC = ["#3a6a45", "#2f5a4a", "#4a7a48", "#5a8a44", "#35604f"].map(function (c) { return new THREE.Color(c); });
    var trees = { top: new THREE.InstancedMesh(mergeGeo([[new THREE.ConeGeometry(0.36, 0.62, 7), 0, 0.6, 0], [new THREE.ConeGeometry(0.26, 0.52, 7), 0, 0.95, 0]]), toon(0xffffff), 1400),
      top2: new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.36, 1).scale(1, 0.92, 1).translate(0, 0.66, 0), toon(0xffffff), 1400), trunk: new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.08, 0.32, 5).translate(0, 0.16, 0), toon(0x4a3426), 1400) };
    [trees.top, trees.top2].forEach(function (m) { m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(1400 * 3), 3); });
    [trees.top, trees.top2, trees.trunk].forEach(function (m) { m.frustumCulled = false; m.count = 0; scene.add(m); });
    var crane = new THREE.Group(); (function () {
      var y = toon(0xe8d48a), k = toon(0x17110e);
      var mast = new THREE.Mesh(new THREE.BoxGeometry(0.22, 5, 0.22), y); mast.position.y = 2.5; crane.add(mast);
      var jib = new THREE.Group(); jib.position.y = 5;
      var arm = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.18, 0.18), y); arm.position.x = 1.2; jib.add(arm);
      var cw = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.5), k); cw.position.x = -0.8; jib.add(cw);
      var cab = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), toon(0xc8291e)); cab.position.set(0, -0.3, 0); jib.add(cab);
      var line = new THREE.Mesh(new THREE.BoxGeometry(0.02, 2.2, 0.02), k); line.position.set(2.9, -1.1, 0); jib.add(line);
      var load = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.35, 0.45), toon(0xefe5cf)); load.position.set(2.9, -2.3, 0); jib.add(load);
      crane.add(jib); crane.userData.jib = jib; crane.traverse(function (m) { if (m.isMesh) m.userData.pick = "site"; });
    })(); crane.scale.setScalar(0.62); scene.add(crane);
    var siteLots = [], coreR = 4, allR = 4, dzOn = false, livedB = {};
    // a street lamp stands at a crossing when one of its four blocks is lived in (a house shown that day), is one of the
    // plaza's or holds a landmark. So the wood stays dark, but for one lamp half way down the lane to the data centers.
    function lampAt(x, z) {
      if ((x === 0 && z === 0) || !onIsland(x, z, 1.5)) return false;
      if (dzOn && x === 9 && z === -6) return true;
      for (var a = -1; a <= 0; a++) for (var b = -1; b <= 0; b++) { var bx = x / 3 + a, bz = z / 3 + b; if (livedB[bx + "," + bz] || plaza(bx * 3 + 1, bz * 3 + 1) || kept(bx * 3 + 1, bz * 3 + 1)) return true; }
      return false;
    }
    function placeSites(dayIdx, nSite, now) {
      var taken = {}; livedB = {}; dzOn = false; shown.forEach(function (h) { taken[h.x + "," + h.z] = 1; livedB[blk(h.x) + "," + blk(h.z)] = 1; if (h.dz) dzOn = true; }); siteLots = siteLotsFor(dayIdx, nSite);
      siteLots.forEach(function (L) { taken[L.x + "," + L.z] = 1; });
      // the town proper ends at coreR; the data centers beyond the wood stretch only allR. The camera and the relay towers
      // take townR: the district is in the picture, but it does not push everything else outwards.
      coreR = radiusOf(shown.filter(function (h) { return !h.dz; }).concat(siteLots)); allR = radiusOf(shown.concat(siteLots)); townR = Math.max(coreR, 0.92 * allR);
      stageG.userData.put(coreR, shown.concat(siteLots)).forEach(function (k) { taken[k] = 1; });
      var ld = lotTex.image.data, mark = function (x, z) { for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) { var u = Math.round(x) + a + 64, v = Math.round(z) + b + 64; if (u >= 0 && u < 128 && v >= 0 && v < 128) ld[v * 128 + u] = 255; } };
      ld.fill(0); for (var ma = -6; ma <= 6; ma++) for (var mb = -6; mb <= 6; mb++) mark(ma, mb);
      shown.forEach(function (h) { if (h.x != null) mark(h.x, h.z); }); siteLots.forEach(function (L) { mark(L.x, L.z); });
      if (dzOn) [[9, -8], [9, -7], [9, -6], [9, -5], [9, -4], [9, -3], [8, -3]].forEach(function (c) { ld[(c[1] + 64) * 128 + c[0] + 64] = 255; }); // the one lane through the wood, to the data centers
      lotTex.needsUpdate = true;
      siteLots.forEach(function (L, i) {
        tp.set(L.x, 0, L.z); tq.identity(); ts.set(1, 1, 1); tm.compose(tp, tq, ts);
        site.slab.setMatrixAt(i, tm); site.frame.setMatrixAt(i, tm);
        tq.setFromAxisAngle(UPV, Math.floor(h2(i, 77) * 4) * Math.PI / 2); tm.compose(tp, tq, ts); site.wall.setMatrixAt(i, tm);
      });
      site.slab.count = site.frame.count = site.wall.count = siteLots.length; site.slab.instanceMatrix.needsUpdate = site.frame.instanceMatrix.needsUpdate = site.wall.instanceMatrix.needsUpdate = true;
      var cp = craneFor(siteLots); crane.visible = !!cp; if (cp) crane.position.set(cp.x, 0, cp.z);
      gsPut(townR, taken); // the gas station
      var n = 0, nA = 0, nB = 0;
      for (var i = 0; i < ORDER.length && n < 1400; i++) {
        var L = ORDER[i]; if (taken[L.x + "," + L.z] || !onIsland(L.x, L.z, 1.2)) continue;
        for (var k = 0, kn = zoneOf(blk(L.x), blk(L.z)) === null ? 3 : 2; k < kn && n < 1400; k++) { // the wood is denser: up to three trees on a lot
          var jx = (h2(i, k + 21) - 0.5) * 0.7, jz = (h2(i, k + 31) - 0.5) * 0.7, s = 0.75 + h2(i, k + 41) * 0.6;
          if (k && h2(i, 50 + k) > (k > 1 ? 0.8 : 0.55)) continue;
          tp.set(L.x + jx, 0, L.z + jz); tq.identity(); ts.set(s, s, s); tm.compose(tp, tq, ts);
          var tc = TREEC[Math.floor(h2(i, k + 71) * TREEC.length) % TREEC.length];
          if ((Math.sin(L.x * 0.33 + 1.3) + Math.cos(L.z * 0.29 - 0.4)) * 0.5 + (h2(i, k + 61) - 0.5) * 0.9 > 0) { trees.top.setMatrixAt(nA, tm); trees.top.setColorAt(nA, tc); nA++; }
          else { trees.top2.setMatrixAt(nB, tm); trees.top2.setColorAt(nB, tc); nB++; }
          trees.trunk.setMatrixAt(n, tm); n++;
        }
      }
      var nm = 0;
      for (var mi = 0; mi < ORDER.length && nm < 70; mi++) {
        var ML = ORDER[mi]; if (h2(mi, 91) > 0.13 || !onIsland(ML.x, ML.z, 2.2) || ld[(Math.round(ML.z) + 64) * 128 + Math.round(ML.x) + 64]) continue;
        var msz = 3.4 + h2(mi, 93) * 3.2;
        tp.set(ML.x, 0.3, ML.z); tq.setFromAxisAngle(UPV, h2(mi, 95) * Math.PI); ts.set(msz, 1, msz * (0.45 + h2(mi, 97) * 0.3)); tm.compose(tp, tq, ts); mist.setMatrixAt(nm++, tm);
      }
      mist.count = nm; mist.instanceMatrix.needsUpdate = true;
      trees.top.count = nA; trees.top2.count = nB; trees.trunk.count = n;
      [trees.top, trees.top2, trees.trunk].forEach(function (m) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; });
    }

    /* street lamps at the crossings: warm pools of light on a night town */
    function instN(geo, mat, cap) { var m = new THREE.InstancedMesh(geo, mat, cap); m.count = 0; m.frustumCulled = false; scene.add(m); return m; }
    var LAMPS = 700, poolTex = (function () { var c = document.createElement("canvas"); c.width = c.height = 64; var x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,196,120,.55)"); g.addColorStop(0.45, "rgba(255,170,90,.18)"); g.addColorStop(1, "rgba(255,150,70,0)"); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    var lamp = {
      post: instN(new THREE.CylinderGeometry(0.03, 0.045, 1.05, 6).translate(0, 0.52, 0), toon(0x2a2a30), LAMPS),
      head: instN(new THREE.SphereGeometry(0.085, 10, 8).translate(0, 1.1, 0), basic(0xffe2b0), LAMPS),
      pool: instN(new THREE.PlaneGeometry(2.4, 2.4).rotateX(-Math.PI / 2).translate(0, 0.025, 0), basic(0xffffff, { map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), LAMPS)
    };
    lamp.pool.renderOrder = 2;
    var softTex = (function () { var c = document.createElement("canvas"); c.width = c.height = 64; var x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,255,.5)"); g.addColorStop(0.42, "rgba(255,255,255,.17)"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    var hpool = inst(new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2).translate(0, 0.02, 0), basic(0xffffff, { map: softTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), true); hpool.renderOrder = 2; hpool.raycast = function () {};
    var SMK = 5, smokePos = new Float32Array(Math.max(1, CAP) * SMK * 3), smokeF = new Float32Array(Math.max(1, CAP) * SMK * 2), smokeGeo = new THREE.BufferGeometry();
    smokeGeo.setAttribute("position", new THREE.BufferAttribute(smokePos, 3)); smokeGeo.setAttribute("aF", new THREE.BufferAttribute(smokeF, 2)); smokeGeo.setDrawRange(0, 0);
    var smokeMat = new THREE.ShaderMaterial({ uniforms: { map: { value: softTex }, uSize: { value: 10 } }, transparent: true, depthWrite: false, // each puff grows and fades as it rises
      vertexShader: "attribute vec2 aF; uniform float uSize; varying float vA; void main() { vA = aF.x; gl_PointSize = uSize * aF.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "uniform sampler2D map; varying float vA; void main() { gl_FragColor = vec4(0.8, 0.82, 0.88, texture2D(map, gl_PointCoord).a * vA); }" });
    var smoke = new THREE.Points(smokeGeo, smokeMat); smoke.frustumCulled = false; smoke.renderOrder = 4; smoke.raycast = function () {}; scene.add(smoke);
    var mist = instN(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), basic(0x9db3c9, { map: softTex, transparent: true, opacity: 0.56, depthWrite: false }), 70); mist.renderOrder = 1; mist.raycast = function () {};
    var POOLW = new THREE.Color(0.4, 0.27, 0.13), POOLO = new THREE.Color(0.42, 0.17, 0.07), POOLC = new THREE.Color(0, 0.3, 0.34);
    var lampGlowGeo = new THREE.BufferGeometry(), lampGlowPos = new Float32Array(LAMPS * 3);
    lampGlowGeo.setAttribute("position", new THREE.BufferAttribute(lampGlowPos, 3)); lampGlowGeo.setDrawRange(0, 0);
    var lampGlowMat = new THREE.PointsMaterial({ size: 20, sizeAttenuation: false, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe0b0 });
    var lampGlow = new THREE.Points(lampGlowGeo, lampGlowMat); lampGlow.frustumCulled = false; lampGlow.renderOrder = 4; scene.add(lampGlow);
    function placeLamps() { // by occupancy (lampAt), not inside a radius
      var n = 0, lim = Math.ceil((allR + 2) / 3) * 3;
      for (var x = -lim; x <= lim; x += 3) for (var z = -lim; z <= lim; z += 3) {
        if (n >= LAMPS || !lampAt(x, z)) continue;
        tp.set(x + 0.44, 0, z + 0.44); tq.identity(); ts.set(1, 1, 1); tm.compose(tp, tq, ts);
        lamp.post.setMatrixAt(n, tm); lamp.head.setMatrixAt(n, tm); lamp.pool.setMatrixAt(n, tm);
        lampGlowPos[n * 3] = x + 0.44; lampGlowPos[n * 3 + 1] = 1.1; lampGlowPos[n * 3 + 2] = z + 0.44; n++;
      }
      ["post", "head", "pool"].forEach(function (k) { lamp[k].count = n; lamp[k].instanceMatrix.needsUpdate = true; });
      lampGlowGeo.attributes.position.needsUpdate = true; lampGlowGeo.setDrawRange(0, n);
    }

    /* the ferry brings tomorrow's newcomers to the building site */
    var ferry = new THREE.Group(), ferryPath = null, ferrySignCanvas = document.createElement("canvas"); ferrySignCanvas.width = 256; ferrySignCanvas.height = 128;
    (function () {
      function add(geo, mat, x, y, z, o) { var m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); ferry.add(m); m.userData.pick = "ferry"; if (o) { var b = new THREE.Mesh(geo, inkBack); b.position.copy(m.position); b.scale.setScalar(o); ferry.add(b); } return m; }
      add(new THREE.BoxGeometry(1.5, 0.3, 0.62), toon(0x8f1911), 0, 0.15, 0, 1.06);
      var bow = add(new THREE.ConeGeometry(0.44, 0.5, 4, 1), toon(0x8f1911), 0.98, 0.15, 0); bow.rotation.set(Math.PI / 4, 0, -Math.PI / 2); bow.scale.set(1, 1, 0.7);
      add(new THREE.BoxGeometry(1.56, 0.06, 0.66), toon(0xefe5cf), 0.02, 0.32, 0);
      add(new THREE.BoxGeometry(0.62, 0.32, 0.46), toon(0xefe5cf), -0.12, 0.5, 0, 1.08);
      add(new THREE.CylinderGeometry(0.09, 0.1, 0.34, 12), toon(0xc8291e), -0.2, 0.83, 0, 1.15);
      add(new THREE.CylinderGeometry(0.1, 0.1, 0.07, 12), toon(0x17110e), -0.2, 1.02, 0);
      for (var k = 0; k < 3; k++) add(new THREE.BoxGeometry(0.1, 0.08, 0.02), basic(0xffcf6b), -0.3 + k * 0.18, 0.52, 0.24);
      var sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(ferrySignCanvas), transparent: true, depthWrite: false }));
      sign.center.set(0.5, 0); sign.scale.set(1.3, 0.65, 1); sign.position.y = 1.25; sign.userData.pick = "ferry"; ferry.add(sign); ferry.userData.sign = sign;
      ferry.scale.setScalar(0.9); ferry.visible = false; scene.add(ferry);
    })();
    var foam = []; for (var fk = 0; fk < 7; fk++) { var fs = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.2, 16).rotateX(-Math.PI / 2), basic(0xefeff1, { transparent: true, opacity: 0.4, depthWrite: false })); fs.position.y = 0.02; scene.add(fs); foam.push(fs); }
    function drawFerrySign(n) {
      var x = ferrySignCanvas.getContext("2d"); x.clearRect(0, 0, 256, 128);
      x.fillStyle = "#0a0a0a"; x.fillRect(18, 18, 220, 92); x.strokeStyle = "#ffcf6b"; x.lineWidth = 5; x.strokeRect(18, 18, 220, 92);
      x.fillStyle = "#ffcf6b"; x.textAlign = "center"; x.textBaseline = "middle"; x.font = "900 64px 'Big Shoulders Stencil Display', Anton, sans-serif"; x.fillText("+" + n, 128, 68);
      ferry.userData.sign.material.map.needsUpdate = true;
    }
    function bez(a, b, c, t, out) { var u = 1 - t; return out.set(u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], 0, u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]); }
    function polar(a, r) { return [Math.cos(a) * r, Math.sin(a) * r]; }
    var fP = new THREE.Vector3(), fQ = new THREE.Vector3();
    function ferryAt(t, out, ahead) {
      var P = ferryPath, ph = t % 1, k;
      if (ph < 0.42) { k = ph / 0.42; k = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; return bez(P.S, P.C1, P.D, Math.min(1, k + (ahead || 0)), out); }
      if (ph < 0.58) return out.set(P.D[0], 0, P.D[1]);
      k = (ph - 0.58) / 0.42; k = k * k; return bez(P.D, P.C2, P.E, Math.min(1, k + (ahead || 0)), out);
    }

    /* the Ministry of Validation in the plaza */
    var ministry = new THREE.Group(), boardCanvas = document.createElement("canvas"); boardCanvas.width = 512; boardCanvas.height = 256;
    (function () {
      var cream = toon(0xf7eed9), cream2 = toon(0xd6cbb2), red = toon(0xc8291e);
      function add(geo, mat, x, y, z, o) { var m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); ministry.add(m); m.userData.pick = "ministry";
        if (o) { var b = new THREE.Mesh(geo, inkBack); b.position.copy(m.position); b.scale.setScalar(o); ministry.add(b); } return m; }
      add(new THREE.BoxGeometry(1.5, 0.1, 1.1), cream2, 0, 0.05, 0, 1.04);
      add(new THREE.BoxGeometry(1.32, 0.1, 0.94), cream, 0, 0.15, 0, 1.05);
      add(new THREE.BoxGeometry(1.06, 0.62, 0.56), cream2, 0, 0.5, -0.12, 1.06);
      for (var k = 0; k < 6; k++) add(new THREE.CylinderGeometry(0.05, 0.055, 0.6, 10), cream, -0.5 + k * 0.2, 0.5, 0.3, 1.25);
      add(new THREE.BoxGeometry(1.24, 0.12, 0.86), cream, 0, 0.86, 0, 1.05);
      var ped = new THREE.CylinderGeometry(0.62, 0.62, 0.84, 3, 1); ped.rotateZ(Math.PI / 2); ped.rotateX(Math.PI / 6); ped.scale(1, 0.42, 1); add(ped, red, 0, 1.05, 0, 1.06);
      add(new THREE.CylinderGeometry(0.26, 0.28, 0.2, 24), cream, 0, 1.26, -0.12, 1.08);
      add(new THREE.SphereGeometry(0.27, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), red, 0, 1.36, -0.12, 1.07);
      add(new THREE.CylinderGeometry(0.012, 0.012, 0.62, 6), toon(0x17110e), 0, 1.92, -0.12);
      // the town hall flies the 6529 logo, drawn from the logo's own vector shapes, white on black like 6529.io
      var fc = document.createElement("canvas"); fc.width = fc.height = 128; var fx = fc.getContext("2d");
      fx.fillStyle = "#0a0a0a"; fx.fillRect(0, 0, 128, 128); fx.strokeStyle = "#efe5cf"; fx.lineWidth = 5; fx.strokeRect(2.5, 2.5, 123, 123);
      var LOGO = ["M" + "38.3 99.4 85.82 99.4 85.82 106.18 38.3 106.18 38.3 112.97 92.6 112.97 92.6 92.6 45.09 92.6 45.09 85.82 146.91 85.82 146.91 92.6 99.4 92.6 99.4 112.97 153.69 112.97 153.69 106.18 106.18 106.18 106.18 99.4 153.69 99.4 153.69 79.03 38.3 79.03 38.3 99.4".split(" ").reduce(function (o, v, i) { return o + (i && i % 2 === 0 ? " L" : " ") + v; }, "") + " Z",
        "M38.3,140.12H146.91v6.79H38.3v6.79H153.7V119.76H38.3Zm6.79-13.57H146.91v6.78H45.09Z",
        "M153.7,45.09V38.3H38.3V72.24H153.7V51.88H45.09V45.09Zm-6.79,13.58v6.78H45.09V58.67Z"];
      fx.save(); var lk = 82 / 115.4; fx.translate(64, 64); fx.scale(lk, lk); fx.translate(-96, -96); fx.fillStyle = "#ffffff";
      if (window.Path2D) LOGO.forEach(function (d) { fx.fill(new Path2D(d)); });
      fx.restore();
      var flag = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.46).translate(0.23, 0, 0), basic(0xffffff, { map: new THREE.CanvasTexture(fc), side: THREE.DoubleSide })); flag.position.set(0.012, 2.0, -0.12); ministry.add(flag); ministry.userData.flag = flag;
      var bt = new THREE.CanvasTexture(boardCanvas); ministry.userData.boardTex = bt;
      [-1, 1].forEach(function (side) {
        var board = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), basic(0xffffff, { map: bt })); board.position.set(0, 0.46, side * 0.88); if (side < 0) board.rotation.y = Math.PI; board.rotation.x += side * -0.25; board.userData.pick = "ministry"; ministry.add(board);
        var bo = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.53), basic(0x000000, { side: THREE.DoubleSide })); bo.position.copy(board.position).multiplyScalar(0.995); bo.rotation.copy(board.rotation); ministry.add(bo);
      });
    })();
    ministry.scale.setScalar(2.3); scene.add(ministry);
    /* the vote flag (vf): a small flagpole on the flat left end of the Ministry's roof. When houses holding two thirds of
       the counted TDH have signed the shown day (the meter's own test), a red flag with a cream tick goes up the pole as the
       meter passes its red ring, then waves; at the top a small bell rings (only after the visitor has turned the sound on).
       Not two thirds yet: a bare pole, the flag waits rolled up at its foot. Share not recorded (old chain Wed 4 / Thu 5, no
       meter either): a bare pole, no flag. Reduced motion: no rise, no wave, the flag is simply up. */
    function vfOk(d) { return !!d && d.signed_pct >= 66.67; } // the same test as the meter's ring
    var vfCW = 0.3, vfCH = 0.2, vfFoot = 0.24, vfTop = 0.7; // the cloth; height of its top edge at the foot and at the top
    var vfG = new THREE.Group(); vfG.position.set(-0.54, 0.92, 0.3); ministry.add(vfG); // front left corner of the roof's flat end: clear of the dome as the view turns after the opening
    var vfPole = new THREE.Mesh(mergeCol([[new THREE.BoxGeometry(0.075, 0.035, 0.075), 0, 0.0175, 0, "#d6cbb2"], [new THREE.CylinderGeometry(0.011, 0.014, 0.69, 8), 0, 0.38, 0, "#e6dfcf"],
      [new THREE.SphereGeometry(0.026, 10, 8), 0, 0.735, 0, "#ffcf6b"]]), toon(0xffffff, { vertexColors: true, emissive: 0x2a1d05 })); // stone foot, pale pole, gold ball
    vfPole.userData.pick = "ministry"; vfG.add(vfPole);
    var vfCv = document.createElement("canvas"); vfCv.width = 256; vfCv.height = 128;
    (function () { // red cloth with soft folds, one cream tick, the ink edge every flag in town has (drawn 3:2, stretched onto 256 x 128)
      var x = vfCv.getContext("2d"), w = 192, h = 128, g = x.createLinearGradient(0, 0, w, 0);
      x.scale(256 / 192, 1);
      g.addColorStop(0, "#b3231a"); g.addColorStop(0.14, "#cf3223"); g.addColorStop(0.4, "#bd271c"); g.addColorStop(0.66, "#d03424"); g.addColorStop(0.9, "#ba261b"); g.addColorStop(1, "#c8291e");
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.strokeStyle = "#efe5cf"; x.lineWidth = 19; x.lineCap = "round"; x.lineJoin = "round";
      x.beginPath(); x.moveTo(w * 0.33, h * 0.53); x.lineTo(w * 0.45, h * 0.7); x.lineTo(w * 0.68, h * 0.3); x.stroke();
      x.strokeStyle = "#17171a"; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6);
    })();
    var vfTex = new THREE.CanvasTexture(vfCv); vfTex.anisotropy = 4;
    var vfGeo = new THREE.PlaneGeometry(vfCW, vfCH, 8, 1).translate(vfCW / 2 + 0.012, -vfCH / 2, 0), vfBase = vfGeo.attributes.position.array.slice();
    var vfCloth = new THREE.Mesh(vfGeo, basic(0xffffff, { map: vfTex, side: THREE.DoubleSide })); vfCloth.position.y = vfFoot; vfCloth.visible = false;
    vfCloth.userData.pick = "ministry"; vfG.add(vfCloth);
    var vfH = 0, vfFrom = 0, vfTo = 0, vfT0 = 0, vfDur = 1, vfRang = true, vfSeen = -1; // how far up (0 foot .. 1 top), the move under way, the day last seen
    function vfFrame(now, t) {
      var d = lastShown >= 0 ? DAYS[lastShown] : null, ok = vfOk(d), up = ok && (reduce || meter.userData.fill.scale.y * 100 >= 66.67 - 1e-6);
      if (reduce) { vfH = up ? 1 : 0; if (lastShown !== vfSeen) { vfSeen = lastShown; if (up && !playing) snd.bell(); } } // no rise: simply up, one bell when you land on the day
      else {
        if ((up ? 1 : 0) !== vfTo) { vfFrom = vfH; vfTo = up ? 1 : 0; vfT0 = now; vfDur = up ? 1050 : 380; vfRang = !up; } // up in about a second, down quickly
        var p = Math.max(0, Math.min(1, (now - vfT0) / vfDur)), e = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
        vfH = vfFrom + (vfTo - vfFrom) * e;
        if (!vfRang && p >= 1) { vfRang = true; snd.bell(); } // at the top: one small bell (silent until the speaker is tapped)
      }
      var k = Math.max(0, Math.min(1, (vfH - 0.1) / 0.8)); k = k * k * (3 - 2 * k); // rolled up at the foot, open at the top
      vfCloth.position.y = vfFoot + (vfTop - vfFoot) * vfH; vfCloth.scale.x = vfTex.repeat.x = 0.24 + 0.76 * k; vfTex.offset.x = 1 - vfTex.repeat.x; // rolled up: only its plain free end shows, the tick opens out from the pole
      vfCloth.visible = (!!d && d.signed_pct != null) || vfH > 0.001;
      if (!vfCloth.visible) return;
      vfCloth.rotation.y = st.az + (reduce ? 0 : Math.sin(t * 2.2 + 1.9) * 0.2 * k); // faces you like the other flags, swings a little on its pole
      if (reduce) return;
      var a = vfGeo.attributes.position.array; // a gentle wave that runs out to the free end
      for (var i = 0; i < a.length; i += 3) { var u = (vfBase[i] - 0.012) / vfCW, w = u * k;
        a[i + 1] = vfBase[i + 1] + 0.014 * w * Math.sin(u * 5.5 - t * 4.6); a[i + 2] = 0.03 * w * Math.sin(u * 4.2 - t * 4.6 + 0.8); }
      vfGeo.attributes.position.needsUpdate = true;
    }
    function vfSay(d, timed) { // the few words on the Ministry's card: after its "two thirds reached" sentence, or in its place
      if (timed) return vfOk(d) ? ", so the small flag on the roof goes up." : ".";
      return vfOk(d) ? " Two thirds reached, so the small flag on the roof goes up." : "";
    }
    function drawBoard(d) {
      var x = boardCanvas.getContext("2d"); x.fillStyle = "#f7eed9"; x.fillRect(0, 0, 512, 256);
      x.fillStyle = "#c8291e"; x.fillRect(0, 0, 512, 58);
      x.fillStyle = "#f7eed9"; x.textAlign = "center"; x.textBaseline = "middle"; x.font = "600 26px 'Martian Mono', monospace"; x.fillText("NOTICE · " + d.label.toUpperCase(), 256, 31);
      x.fillStyle = "#0a0a0a"; x.font = "900 76px 'Big Shoulders Stencil Display', Anton, sans-serif"; x.fillText((d.name || "—").toUpperCase(), 256, 120);
      x.font = "600 25px 'Martian Mono', monospace";
      x.fillText((d.signed_pct != null ? d.signed_pct + "% SIGNED" : "") + (sinceOpen(d.two_thirds_utc) ? " · 2/3 IN " + sinceOpen(d.two_thirds_utc).toUpperCase() : ""), 256, 186);
      var bl = d.final ? "FINAL" : "IN PROGRESS · FINAL " + localClock("19:30", d.date).toUpperCase(), bpx = 20;
      x.fillStyle = "#6c6156"; do { x.font = "500 " + bpx + "px 'Martian Mono', monospace"; bpx -= 1; } while (bpx > 11 && x.measureText(bl).width > 470);
      x.fillText(bl, 256, 226);
      ministry.userData.boardTex.needsUpdate = true;
    }

    /* the agreement meter: a glass column on the plaza that fills to the day's % of counted TDH signed; the red ring is 2/3 */
    var meter = new THREE.Group(), MH = 3.6;
    (function () {
      var base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.58, 0.3, 20), toon(0xd6cbb2)); base.position.y = 0.15; meter.add(base);
      var bo = new THREE.Mesh(base.geometry, inkBack); bo.position.copy(base.position); bo.scale.setScalar(1.08); meter.add(bo);
      var glass = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, MH, 24, 1, true), basic(0xcfd8ff, { transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })); glass.position.y = 0.3 + MH / 2; meter.add(glass);
      var fill = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, MH, 20).translate(0, MH / 2, 0), basic(0xffcf6b)); fill.position.y = 0.3; fill.scale.y = 0.001; meter.add(fill);
      var ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.05, 8, 32), basic(0xff3b2a)); ring.rotation.x = Math.PI / 2; ring.position.y = 0.3 + MH * 2 / 3; meter.add(ring);
      var cap = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.3, 0.16, 20), toon(0xc8291e)); cap.position.y = 0.38 + MH; meter.add(cap);
      meter.traverse(function (m) { if (m.isMesh) m.userData.pick = "meter"; });
      meter.userData.fill = fill; meter.position.set(1.95, 0, 1.95); scene.add(meter);
    })();
    var meterAnim = { from: 0, to: 0, t0: 0, dur: 3200, crossed: true };
    var flags = []; // one flag per country named, in a U around the town square, open toward the Ministry
    function squareSpot(k, n) { var L = 2.2, F = 4.3, tot = 2 * L + F, u = n > 1 ? k * tot / (n - 1) : tot / 2;
      return u <= L ? [-2.15, 2.95 + u] : u <= L + F ? [-2.15 + (u - L), 5.15] : [2.15, 5.15 - (u - L - F)]; }
    function placeFlags(d) {
      flags.forEach(function (f) { scene.remove(f.g); f.g.traverse(function (m) { if (m.isMesh) { m.geometry.dispose(); m.material.dispose(); } }); f.tex.dispose(); }); flags = [];
      var list = (d.countries || []).slice(0, 20), n = list.length;
      list.forEach(function (c, i) {
        var sp = squareSpot(i, n), g = new THREE.Group();
        var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 1.7, 6).translate(0, 0.85, 0), toon(0xcfcfd4)); g.add(pole);
        var cv = document.createElement("canvas"); cv.width = 96; cv.height = 64; flagDraw(cv.getContext("2d"), 96, 64, c[0]);
        var tex = new THREE.CanvasTexture(cv), fl = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4).translate(0.3, 0, 0), basic(0xffffff, { map: tex, side: THREE.DoubleSide }));
        fl.position.y = 1.48; g.add(fl); g.position.set(sp[0], 0, sp[1]);
        g.traverse(function (m) { if (m.isMesh) { m.userData.pick = "flag"; m.userData.country = c; } });
        scene.add(g); flags.push({ g: g, fl: fl, tex: tex, ph: i * 0.7 });
      });
    }

    /* quarter flags and quarter tags: one banner per continent quarter, with the day's count on a small tag over it.
       They are their own meshes (not the country flags of the square): no pick kind, no raycast, never in pickList. */
    var qFlags = [], qTags = {}, qOrder = [];
    (function () {
      var noHit = function () {}, card = $("t-card");
      var poleG = new THREE.CylinderGeometry(0.03, 0.05, 3.2, 6).translate(0, 1.6, 0), poleM = toon(0x2a2a30), knobG = new THREE.SphereGeometry(0.075, 8, 6).translate(0, 3.22, 0);
      // tag dots (step 28): every quarter tag starts with a dot in the colour of that quarter's roofs (data centers: the cyan of their lights)
      function tag(id, name, col) { // <div class="lab q"><span class="tag"><i></i>name<b>number</b></span><span class="stem"></span></div>, next to the other labels
        var el = document.createElement("div"), tg = document.createElement("span"), b = document.createElement("b"), stem = document.createElement("span"), dot = document.createElement("i");
        el.className = "lab q"; el.id = "t-lab-q-" + id; tg.className = "tag"; dot.style.background = col; tg.appendChild(dot); tg.appendChild(document.createTextNode(name)); tg.appendChild(b); stem.className = "stem";
        el.appendChild(tg); el.appendChild(stem); stage.insertBefore(el, card);
        return { el: el, b: b, x: 0, y: 0, z: 0, n: 0 };
      }
      QORD.forEach(function (key, k) {
        var g = new THREE.Group(); g.add(new THREE.Mesh(poleG, poleM)); g.add(new THREE.Mesh(knobG, poleM));
        var tex = canvasTex(96, 60, function (x, w, h) { x.fillStyle = CCOL[key]; x.fillRect(0, 0, w, h); x.strokeStyle = "#0a0a0a"; x.lineWidth = 4; x.strokeRect(2, 2, w - 4, h - 4); });
        var cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.75, 8, 1).translate(0.6, 0, 0), basic(0xffffff, { map: tex, side: THREE.DoubleSide }));
        cloth.position.y = 2.78; g.add(cloth);
        g.traverse(function (m) { m.raycast = noHit; });
        g.visible = false; scene.add(g);
        qFlags.push({ key: key, g: g, cloth: cloth, flat: Array.prototype.slice.call(cloth.geometry.attributes.position.array), ph: k * 0.9 });
        qTags[key] = tag(key, CLAB[key], CCOL[key]);
      });
      qTags.dc = tag("dc", "Data centers", "#00e0f0");
    })();
    function placeQuarters(d, i) { // the shown day: a quarter nobody reported from has no flag and no tag; an old-chain day has none at all
      var cs = d.continents || {}, sp = d.old_chain ? {} : flagSpots(i);
      qOrder = [];
      qFlags.forEach(function (f) {
        var n = cs[f.key] || 0, s = sp[f.key], on = n > 0 && !!s, tg = qTags[f.key];
        f.g.visible = on;
        if (!on) { tg.el.classList.remove("on"); return; }
        f.g.position.set(s.x - 0.44, 0, s.z - 0.44); // the lamp of this crossing stands on the opposite corner
        tg.x = s.x - 0.44; tg.y = 3.4; tg.z = s.z - 0.44; tg.n = n; tg.b.textContent = fmt(n); qOrder.push(tg);
      });
      qOrder.sort(function (a, b) { return b.n - a.n; }); // the largest quarter's tag is placed first, so a small one yields to it
      var dn = d.old_chain ? 0 : (d.places || {}).data_center || 0, dl = null, dt = qTags.dc;
      for (var k = 0; dn > 0 && k < DLOTS.length && !dl; k++) if (shown.some(function (h) { return h.dz && h.x === DLOTS[k].x && h.z === DLOTS[k].z; })) dl = DLOTS[k];
      if (dl) { dt.x = dl.x; dt.y = 3.2; dt.z = dl.z; dt.n = dn; dt.b.textContent = fmt(dn); qOrder.push(dt); } else dt.el.classList.remove("on"); // the district's tag comes last
    }
    function waveQuarters(t) { // the cloth faces the viewer, swings a little on its pole and ripples toward its free end
      qFlags.forEach(function (f) {
        if (!f.g.visible) return;
        if (reduce) { f.cloth.rotation.y = st.az; return; } // "reduce motion": the cloth hangs still, turned to the viewer
        f.cloth.rotation.y = st.az + Math.sin(t * 1.6 + f.ph) * 0.16;
        var pos = f.cloth.geometry.attributes.position, a = pos.array, o = f.flat;
        for (var v = 0; v < a.length; v += 3) a[v + 2] = Math.sin(o[v] * 5.2 - t * 3.1 + f.ph) * 0.07 * o[v] / 1.2;
        pos.needsUpdate = true;
      });
    }

    /* the Meme Factory, the Museum, the pond and its frog */
    function blockCenter(b) { return [b[0] * 3 + 1.5, b[1] * 3 + 1.5]; }
    var cardImgs = CARDS.map(function (cd) { var im = new Image(); im.src = cd.src; return im; });
    function canvasTex(w, h, draw) { var c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); return new THREE.CanvasTexture(c); }
    function warmGlass(x, w, h, cols, rows) { // a lit window: warm glass, dark frame and bars
      var g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#fff0c0"); g.addColorStop(1, "#f0a94a"); x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.fillStyle = "#2a2420"; var b = Math.max(3, Math.round(h * 0.06)), i;
      x.fillRect(0, 0, w, b); x.fillRect(0, h - b, w, b); x.fillRect(0, 0, b, h); x.fillRect(w - b, 0, b, h);
      for (i = 1; i < cols; i++) x.fillRect(Math.round(w * i / cols - b / 2), 0, b, h);
      for (i = 1; i < rows; i++) x.fillRect(0, Math.round(h * i / rows - b / 2), w, b);
    }
    var factory = new THREE.Group(), smoke = [];
    (function () {
      var c = blockCenter(KEEP.factory), wall = toon(0xd6cbb2), dark = toon(0x3a3a42), red = toon(0xc8291e), HP = Math.PI / 2;
      function add(geo, mat, x, y, z, o) { var m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); factory.add(m); if (o) { var b = new THREE.Mesh(geo, inkBack); b.position.copy(m.position); b.scale.setScalar(o); factory.add(b); } return m; }
      function pane(w, h, mat, x, y, z, ry) { var m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.position.set(x, y, z); m.rotation.y = ry || 0; factory.add(m); return m; }
      /* the hall: brick foot, lit windows on every side, a gate with a half-open shutter */
      add(new THREE.BoxGeometry(1.9, 1.0, 1.5), wall, 0, 0.5, 0, 1.04);
      add(new THREE.BoxGeometry(1.94, 0.12, 1.54), toon(0x7a2f25), 0, 0.06, 0);
      var win = basic(0xffffff, { map: canvasTex(64, 96, function (x, w, h) { warmGlass(x, w, h, 2, 3); }) });
      [-0.66, -0.22, 0.22, 0.66].forEach(function (wx) { pane(0.24, 0.3, win, wx, 0.36, 0.762, 0); pane(0.26, 0.44, win, wx, 0.52, -0.762, Math.PI); });
      [-0.45, 0, 0.45].forEach(function (wz) { pane(0.26, 0.44, win, -0.962, 0.52, wz, -HP); });
      [-0.24, -0.56].forEach(function (wz) { pane(0.22, 0.44, win, 0.962, 0.52, wz, HP); });
      add(new THREE.BoxGeometry(0.06, 0.66, 0.64), dark, 0.96, 0.33, 0.3);
      pane(0.52, 0.58, basic(0xffffff, { map: canvasTex(96, 96, function (x, w, h) {
        warmGlass(x, w, h, 1, 1); x.fillStyle = "#4a4a55"; x.fillRect(6, 6, w - 12, 30); x.fillStyle = "#2c2c33"; for (var i = 0; i < 5; i++) x.fillRect(6, 10 + i * 6, w - 12, 2);
      }) }), 0.996, 0.31, 0.3, HP);
      /* the saw-tooth roof: every tooth has a lit glass side */
      var glassL = basic(0xffffff, { map: canvasTex(384, 96, function (x, w, h) { warmGlass(x, w, h, 6, 1); }) }), glassS = basic(0xffffff, { map: canvasTex(256, 96, function (x, w, h) { warmGlass(x, w, h, 4, 1); }) });
      for (var k = 0; k < 3; k++) {
        var tooth = new THREE.CylinderGeometry(0.36, 0.36, 1.5, 3, 1); tooth.rotateX(Math.PI / 2); tooth.rotateZ(Math.PI / 6); add(tooth, dark, -0.62 + k * 0.62, 1.15, 0, 1.06);
        pane(k ? 1.38 : 0.92, 0.36, k ? glassL : glassS, -0.62 + k * 0.62 + 0.195, 1.225, k ? 0 : -0.23, HP); // the first one stops before the chimney
      }
      [[-0.5, 0.45], [0.55, -0.4]].forEach(function (p) {
        add(new THREE.CylinderGeometry(0.13, 0.16, 1.9, 12), red, p[0], 1.35, p[1], 1.12); add(new THREE.CylinderGeometry(0.165, 0.165, 0.14, 12), toon(0xefe5cf), p[0], 1.8, p[1]);
        add(new THREE.CylinderGeometry(0.15, 0.15, 0.07, 12), dark, p[0], 2.3, p[1]);
      });
      /* the sign: a marquee with bulbs */
      var sc = document.createElement("canvas"); sc.width = 512; sc.height = 128; factory.userData.signCanvas = sc;
      factory.userData.sign = pane(1.6, 0.4, basic(0xffffff, { map: new THREE.CanvasTexture(sc) }), 0, 0.77, 0.762, 0);
      /* the production line in front: machine -> belt -> crate, with small Meme Cards riding on it */
      var z0 = 0.96, steel = toon(0x4a4a55);
      add(new THREE.BoxGeometry(0.36, 0.5, 0.34), steel, -0.74, 0.25, z0, 1.05);
      pane(0.24, 0.26, basic(0xffc56b), -0.545, 0.36, z0, HP); pane(0.2, 0.1, basic(0xffe2b0), -0.74, 0.37, z0 + 0.182, 0);
      add(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 8), basic(0xff5a3c), -0.74, 0.525, z0);
      add(new THREE.BoxGeometry(1.24, 0.05, 0.28), toon(0x2c2c33), 0.06, 0.195, z0);
      [-0.45, 0.06, 0.57].forEach(function (lx) { add(new THREE.BoxGeometry(0.05, 0.17, 0.22), dark, lx, 0.085, z0); });
      var beltTex = canvasTex(32, 16, function (x) { x.fillStyle = "#34343c"; x.fillRect(0, 0, 32, 16); x.fillStyle = "#565662"; x.fillRect(0, 0, 5, 16); });
      beltTex.wrapS = THREE.RepeatWrapping; beltTex.repeat.set(10, 1);
      var top = new THREE.Mesh(new THREE.PlaneGeometry(1.24, 0.22).rotateX(-HP), basic(0xffffff, { map: beltTex })); top.position.set(0.06, 0.2215, z0); factory.add(top);
      add(new THREE.BoxGeometry(0.36, 0.22, 0.32), toon(0xb9793e), 0.86, 0.11, z0, 1.05);
      var inside = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.26).rotateX(-HP), basic(0x3a2412)); inside.position.set(0.86, 0.2215, z0); factory.add(inside);
      var minis = [], N = 4, nextIm = 0;
      function mini(x, y, z, rz) {
        var cv = document.createElement("canvas"); cv.width = 64; cv.height = 80;
        var m = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.25), basic(0xffffff, { map: new THREE.CanvasTexture(cv), side: THREE.DoubleSide })); m.position.set(x, y, z); m.rotation.set(-0.3, 0, rz || 0); factory.add(m);
        minis.push({ m: m, cv: cv, im: nextIm++, last: 0 });
      }
      function drawMini(q) {
        var x = q.cv.getContext("2d"), im = cardImgs[q.im % cardImgs.length]; x.fillStyle = "#f7f1e3"; x.fillRect(0, 0, 64, 80);
        if (im && im.complete && im.naturalWidth) { var sw = im.naturalWidth, sh = im.naturalHeight; if (sw / sh > 58 / 74) sw = sh * 58 / 74; else sh = sw * 74 / 58; x.drawImage(im, (im.naturalWidth - sw) / 2, (im.naturalHeight - sh) / 2, sw, sh, 3, 3, 58, 74); }
        else { x.fillStyle = "#c8291e"; x.fillRect(3, 3, 58, 74); }
        q.m.material.map.needsUpdate = true;
      }
      for (var i = 0; i < N; i++) mini(0, 0.345, z0);
      mini(0.8, 0.28, z0 - 0.03, 0.25); mini(0.93, 0.26, z0 + 0.04, -0.22);
      factory.userData.redraw = function () { minis.forEach(drawMini); };
      factory.userData.line = function (t) { // the cards ride from the machine to the crate and drop in
        for (var i = 0; i < N; i++) {
          var q = minis[i], p = (t * 0.07 + (i + 0.5) / N) % 1;
          if (p < q.last) { q.im = nextIm++; drawMini(q); } q.last = p;
          q.m.visible = p > 0.03 && p < 0.985; q.m.position.x = -0.6 + p * 1.44; q.m.position.y = 0.345 - (p > 0.9 ? (p - 0.9) * 1.2 : 0);
        }
        beltTex.offset.x = -t * 0.64;
      };
      factory.userData.redraw();
      var fg = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.2).rotateX(-HP), basic(0xffc27a, { map: poolTex, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending })); fg.position.set(0, 0.03, 0.75); fg.renderOrder = 2; fg.raycast = function () {}; factory.add(fg);
      factory.traverse(function (m) { m.userData.pick = "factory"; });
      factory.position.set(c[0], 0, c[1] - 0.2); scene.add(factory);
      var st = (function () { var cc = document.createElement("canvas"); cc.width = cc.height = 64; var x = cc.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, "rgba(206,207,212,.55)"); g.addColorStop(1, "rgba(206,207,212,0)"); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(cc); })();
      for (var j = 0; j < 10; j++) { var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: st, transparent: true, depthWrite: false })); scene.add(sp); smoke.push({ s: sp, ph: j / 10, ch: j % 2 }); }
    })();
    var signPh = 0;
    function drawFactorySign(ph) {
      if (ph != null) signPh = ph;
      var x = factory.userData.signCanvas.getContext("2d"), i;
      x.fillStyle = "#0a0a0a"; x.fillRect(0, 0, 512, 128);
      function bulb(bx, by, n) { var on = (n + signPh) % 2 === 0; x.fillStyle = on ? "#ffd76a" : "#6b4a16"; x.beginPath(); x.arc(bx, by, on ? 5.5 : 4.5, 0, 6.3); x.fill(); }
      for (i = 0; i < 16; i++) { bulb(16 + i * 32, 13, i); bulb(16 + i * 32, 115, i + 1); }
      bulb(16, 47, 1); bulb(16, 81, 0); bulb(496, 47, 0); bulb(496, 81, 1);
      x.fillStyle = "#efe5cf"; x.textAlign = "center"; x.textBaseline = "middle"; x.font = "900 60px 'Big Shoulders Stencil Display', Anton, sans-serif"; x.fillText("MEME FACTORY", 256, 67);
      factory.userData.sign.material.map.needsUpdate = true;
    }
    var museum = new THREE.Group(), WORKS = 8, hang = [], workCv = [], workTex = [];
    (function () {
      var c = blockCenter(KEEP.museum), HP = Math.PI / 2;
      function add(geo, mat, x, y, z, o) { var m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); museum.add(m); if (o) { var b = new THREE.Mesh(geo, inkBack); b.position.copy(m.position); b.scale.setScalar(o); museum.add(b); } return m; }
      var stone = toon(0xd9cdb0), cream = toon(0xf4ecdb), ink = toon(0x2a1c12), roofRed = toon(0x8f1911);
      /* two steps, the hall, its cornice and the red roof with a skylight */
      add(new THREE.BoxGeometry(2.3, 0.05, 2.1), toon(0x4a4448), 0, 0.025, 0);
      add(new THREE.BoxGeometry(2.14, 0.05, 1.98), stone, 0, 0.075, 0);
      add(new THREE.BoxGeometry(1.8, 1.0, 1.36), cream, 0, 0.6, -0.27, 1.04);
      [[-0.93, -0.97], [0.93, -0.97], [-0.93, 0.43], [0.93, 0.43]].forEach(function (q) { add(new THREE.CylinderGeometry(0.07, 0.08, 1.0, 8), stone, q[0], 0.6, q[1]); });
      add(new THREE.BoxGeometry(2.0, 0.1, 1.56), stone, 0, 1.15, -0.27, 1.03);
      var mroof = new THREE.CylinderGeometry(0.52, 1.5, 0.4, 4, 1).rotateY(Math.PI / 4).toNonIndexed(); mroof.scale(0.94, 1, 0.735); mroof.computeVertexNormals();
      add(mroof, roofRed, 0, 1.4, -0.27);
      add(new THREE.BoxGeometry(0.58, 0.05, 0.44), basic(0xffe2b0), 0, 1.61, -0.27);
      add(new THREE.BoxGeometry(0.6, 0.06, 0.03), ink, 0, 1.612, -0.27); add(new THREE.BoxGeometry(0.03, 0.06, 0.46), ink, 0, 1.612, -0.27);
      /* the front: a red wall behind four columns, a lit door, the name on the frieze and a gable above */
      add(new THREE.BoxGeometry(1.52, 0.86, 0.02), toon(0x8a1c14), 0, 0.55, 0.425);
      add(new THREE.BoxGeometry(0.46, 0.72, 0.03), ink, 0, 0.46, 0.44);
      var door = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.64), basic(0xffffff, { map: canvasTex(64, 112, function (x, w, h) {
        var g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "#fff3cf"); g.addColorStop(1, "#f2b560"); x.fillStyle = g; x.fillRect(0, 0, w, h); x.fillStyle = "#2a1c12"; x.fillRect(w / 2 - 1.5, 0, 3, h); x.fillRect(0, 26, w, 3);
      }) })); door.position.set(0, 0.44, 0.458); museum.add(door);
      add(new THREE.BoxGeometry(0.54, 0.04, 0.05), toon(0xd9b45a), 0, 0.84, 0.445);
      [-0.63, -0.23, 0.23, 0.63].forEach(function (cx) {
        add(new THREE.BoxGeometry(0.18, 0.03, 0.18), stone, cx, 0.115, 0.78);
        add(new THREE.CylinderGeometry(0.06, 0.07, 0.83, 10), cream, cx, 0.545, 0.78);
        add(new THREE.BoxGeometry(0.18, 0.04, 0.18), stone, cx, 0.98, 0.78);
      });
      add(new THREE.BoxGeometry(1.56, 0.19, 0.5), stone, 0, 1.095, 0.655, 1.03);
      var nc = document.createElement("canvas"); nc.width = 512; nc.height = 52; museum.userData.nameCanvas = nc;
      var np = new THREE.Mesh(new THREE.PlaneGeometry(1.46, 0.148), basic(0xffffff, { map: new THREE.CanvasTexture(nc) })); np.position.set(0, 1.095, 0.918); museum.add(np); museum.userData.name = np;
      var ped = new THREE.CylinderGeometry(0.5, 0.5, 0.8, 3, 1).rotateX(HP).rotateZ(Math.PI).toNonIndexed(); ped.scale(1.917, 0.427, 1); ped.computeVertexNormals();
      add(ped, stone, 0, 1.297, 0.505, 1.03);
      [-1, 1].forEach(function (s) { var sl = add(new THREE.BoxGeometry(0.93, 0.035, 0.86), roofRed, s * 0.423, 1.371, 0.5); sl.rotation.z = -s * 0.368; });
      var medal = new THREE.Mesh(new THREE.CircleGeometry(0.075, 20), basic(0xe8c66a)); medal.position.set(0, 1.29, 0.922); museum.add(medal);
      var mg = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6).rotateX(-HP), basic(0xffffff, { map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); mg.position.y = 0.03; mg.renderOrder = 2; mg.raycast = function () {}; museum.add(mg);
      /* eight works, every one different: two by the door, two on each side wall, two at the back */
      [[-0.47, 0.57, 0.447, 0, 0.352, 0.44], [0.47, 0.57, 0.447, 0, 0.352, 0.44],
       [-0.912, 0.62, 0.07, -HP, 0.5, 0.625], [-0.912, 0.62, -0.61, -HP, 0.5, 0.625],
       [0.912, 0.62, -0.61, HP, 0.5, 0.625], [0.912, 0.62, 0.07, HP, 0.5, 0.625],
       [0.45, 0.62, -0.962, Math.PI, 0.5, 0.625], [-0.45, 0.62, -0.962, Math.PI, 0.5, 0.625]].forEach(function (f, k) {
        var cv = document.createElement("canvas"); cv.width = 256; cv.height = 320; workCv.push(cv); var tx = new THREE.CanvasTexture(cv); workTex.push(tx); hang.push(k % CARDS.length);
        var p = new THREE.Mesh(new THREE.PlaneGeometry(f[4], f[5]), basic(0xffffff, { map: tx })); p.position.set(f[0], f[1], f[2]); p.rotation.y = f[3]; p.userData.work = k; museum.add(p);
      });
      museum.traverse(function (m) { m.userData.pick = "museum"; });
      museum.position.set(c[0], 0, c[1]); museum.rotation.y = HP; scene.add(museum);
    })();
    function drawMuseumName() {
      var x = museum.userData.nameCanvas.getContext("2d"), s = "MEME MUSEUM", gap = 9, w = 0, i;
      x.fillStyle = "#17110e"; x.fillRect(0, 0, 512, 52); x.fillStyle = "#e8c66a"; x.fillRect(0, 0, 512, 3); x.fillRect(0, 49, 512, 3);
      x.font = "34px Anton, 'Big Shoulders Stencil Display', sans-serif"; x.textAlign = "left"; x.textBaseline = "middle";
      for (i = 0; i < s.length; i++) w += x.measureText(s[i]).width + (i ? gap : 0);
      var px = 256 - w / 2; for (i = 0; i < s.length; i++) { x.fillText(s[i], px, 28); px += x.measureText(s[i]).width + gap; }
      museum.userData.name.material.map.needsUpdate = true;
    }
    function drawWork(k) { // one framed work on a lit wall
      var x = workCv[k].getContext("2d"), im = cardImgs[hang[k]];
      var wg = x.createRadialGradient(128, 110, 20, 128, 160, 230); wg.addColorStop(0, "#fff0c9"); wg.addColorStop(1, "#dfa456");
      x.fillStyle = wg; x.fillRect(0, 0, 256, 320); x.fillStyle = "#3a2a14"; x.fillRect(20, 20, 216, 280); x.fillStyle = "#e8d48a"; x.fillRect(23, 23, 210, 274); x.fillStyle = "#f7f1e3"; x.fillRect(32, 32, 192, 256);
      if (im && im.complete && im.naturalWidth) { var ar = im.naturalWidth / im.naturalHeight, w = 178, h = w / ar; if (h > 242) { h = 242; w = h * ar; } x.fillStyle = "#17110e"; x.fillRect(128 - w / 2 - 2, 160 - h / 2 - 2, w + 4, h + 4); x.drawImage(im, 128 - w / 2, 160 - h / 2, w, h); }
      workTex[k].needsUpdate = true;
    }
    function drawMuseum() { for (var k = 0; k < WORKS; k++) drawWork(k); }
    var hangTurn = 0, hangNext = WORKS;
    function rehang() { // one work changes at a time; the walls never show the same card twice
      if (CARDS.length <= WORKS) return;
      var k = [0, 2, 5, 1, 3, 6, 4, 7][hangTurn++ % WORKS]; hang[k] = hangNext++ % CARDS.length; drawWork(k);
    }
    cardImgs.forEach(function (im) { im.addEventListener("load", function () { drawMuseum(); factory.userData.redraw(); }); });
    drawMuseum();
    function workText(ci) { var cd = CARDS[ci]; return (hang.indexOf(ci) >= 0 ? "Now on the wall: " : "From the back room: ") + "#" + cd.id + " " + cd.name + " by " + cd.artist + ". Free entry, open all night. Every work is a CC0 Meme Card."; }
    function workNext(bodyEl, ci) { // the museum card: step through the whole collection in place
      bodyEl.querySelector(".next").addEventListener("click", function (ev) {
        ev.stopPropagation(); ci = (ci + 1) % CARDS.length; bodyEl.querySelector("img").src = CARDS[ci].src; bodyEl.querySelector("p").textContent = workText(ci);
      });
    }
    var SAYS = ["“GM!”", "“Did you sign today?”", "“My validator is at home doing the work. I'm out for a walk.”", "“Seize the memes of production!”", "“Don't trust, check. So I run my own.”", "“Off to the museum. Free entry!”"], sayN = 0;
    /* the Main Stage: jumbo posters of the three submissions that lead the vote right now, out in the far woods.
       They face the town. Seen from behind they fade away, so they never stand in front of the houses. */
    var STAGE = /*__STAGE__*/null;
    var stageG = new THREE.Group(), stageOK = !!(STAGE && STAGE.items && STAGE.items.length === 3), STAGE_A = 3.49, stageFar = 0;
    // the ranking is read with every 3-hour update; if the updates stop, the posters stay but no longer claim to be "right now"
    function stageOld() { return !!STAGE && Date.now() - STAGE.asof > 12 * 3600e3; }
    function stageDay() { try { return new Date(STAGE.asof).toLocaleDateString([], { day: "numeric", month: "short" }); } catch (e) { return ""; } }
    if (stageOK && stageOld()) { var stS = document.getElementById("t-stage-s"); if (stS && stageDay()) stS.textContent = "top 3 on " + stageDay(); }
    function stageNum(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n); }
    (function () {
      stageG.userData.on = false; stageG.userData.top = [0, 0, 0];
      stageG.userData.tick = stageG.userData.draw = function () {}; stageG.userData.put = function () { return []; };
      if (!stageOK) return;
      var HP = Math.PI / 2, mats = [], posts = [], lastK = -1;
      function mk(m) { m.userData.o = m.opacity; m.userData.tr = m.transparent; m.userData.dw = m.depthWrite; mats.push(m); return m; }
      var steel = mk(toon(0x34323a)), body = mk(toon(0x1a1412)), lampM = mk(basic(0xffe2b0)), outM = mk(new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }));
      var SIZE = [[3.3, 3.87, 0.65], [2.75, 3.22, 0.5], [2.75, 3.22, 0.5]], RIM = ["#e8c66a", "#cdd2d6", "#cf9463"], SIDE = [0, -1, 1];
      STAGE.items.forEach(function (it, k) {
        var g = new THREE.Group(), w = SIZE[k][0], h = SIZE[k][1], leg = SIZE[k][2], cy = leg + h / 2;
        function add(geo, mat, x, y, z, o) { var m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); if (o) { var b = new THREE.Mesh(geo, outM); b.position.copy(m.position); b.scale.setScalar(o); g.add(b); } return m; }
        /* two legs and a cross bar behind, the dark panel, a catwalk below and a lamp bar above */
        [-1, 1].forEach(function (s) { add(new THREE.BoxGeometry(0.14, leg + h * 0.62, 0.14), steel, s * w * 0.3, (leg + h * 0.62) / 2, -0.14); });
        add(new THREE.BoxGeometry(w * 0.6 + 0.14, 0.08, 0.08), steel, 0, leg + h * 0.34, -0.14);
        add(new THREE.BoxGeometry(w + 0.2, h + 0.2, 0.12), body, 0, cy, 0, 1.025);
        add(new THREE.BoxGeometry(w + 0.34, 0.05, 0.36), steel, 0, leg - 0.13, 0.17);
        add(new THREE.BoxGeometry(w + 0.26, 0.07, 0.3), steel, 0, leg + h + 0.14, 0.11);
        for (var i = 0; i < 4; i++) add(new THREE.BoxGeometry(0.2, 0.05, 0.12), lampM, (i - 1.5) * w / 4, leg + h + 0.09, 0.25);
        /* the poster itself: unlit, so it glows like a lit billboard at night */
        var cv = document.createElement("canvas"); cv.width = 512; cv.height = 600;
        var tx = new THREE.CanvasTexture(cv); tx.anisotropy = 4;
        var pm = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mk(basic(0xffffff, { map: tx }))); pm.position.set(0, cy, 0.068); g.add(pm);
        var gl = new THREE.Mesh(new THREE.PlaneGeometry(w + 2.4, 3.2).rotateX(-HP), mk(basic(0xffd9a0, { map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.75 })));
        gl.position.set(0, 0.03, 1.15); gl.renderOrder = 2; gl.raycast = function () {}; g.add(gl);
        g.traverse(function (m) { m.userData.pick = "stage"; m.userData.stage = k; });
        var im = new Image(), p = { g: g, cv: cv, tx: tx, it: it, im: im, w: w, top: leg + h, side: SIDE[k], rim: RIM[k] };
        im.onload = function () { draw(p); }; im.src = it.img;
        stageG.add(g); posts.push(p);
      });
      function fitFont(x, s, maxW, px, min, face) { for (;;) { x.font = px + "px " + face; if (px <= min || x.measureText(s).width <= maxW) return; px -= 2; } }
      function draw(p) {
        var x = p.cv.getContext("2d"), W = 512, H = 600, it = p.it, im = p.im, rank = String(it.rank);
        x.fillStyle = "#100c0a"; x.fillRect(0, 0, W, H);
        x.textAlign = "left"; x.textBaseline = "alphabetic";
        x.fillStyle = p.rim; x.font = "92px Anton, 'Big Shoulders Stencil Display', sans-serif"; x.fillText(rank, 24, 88);
        var nx = 24 + x.measureText(rank).width + 18;
        x.fillStyle = "#f4ecdb"; x.font = "600 31px 'Big Shoulders Stencil Display', Anton, sans-serif"; x.fillText("MAIN STAGE", nx, 46);
        x.fillStyle = p.rim; x.font = "21px 'Martian Mono', monospace"; x.fillText(stageNum(it.proj) + " TDH", nx, 80);
        var ax = 20, ay = 102, aw = W - 40, ah = 384;
        x.fillStyle = "#050404"; x.fillRect(ax, ay, aw, ah);
        if (im.complete && im.naturalWidth) { var ar = im.naturalWidth / im.naturalHeight, w = aw, h = w / ar; if (h > ah) { h = ah; w = h * ar; } x.drawImage(im, ax + (aw - w) / 2, ay + (ah - h) / 2, w, h); }
        x.fillStyle = "#f4ecdb"; fitFont(x, it.title.toUpperCase(), W - 48, 42, 20, "Anton, 'Big Shoulders Stencil Display', sans-serif"); x.fillText(it.title.toUpperCase(), 24, 540);
        x.fillStyle = "#b9ab8f"; fitFont(x, "by " + it.artist, W - 48, 21, 13, "'Martian Mono', monospace"); x.fillText("by " + it.artist, 24, 576);
        x.strokeStyle = p.rim; x.lineWidth = 7; x.strokeRect(3.5, 3.5, W - 7, H - 7);
        p.tx.needsUpdate = true;
      }
      stageG.userData.draw = function () { posts.forEach(draw); };
      /* stand just behind the last houses, in a slight arc that faces the town; returns the lots to keep free of trees.
         A phone shows the whole island with sky to spare, so the posters are bigger there. */
      stageG.userData.put = function (tr, lots) { // lots: those of the day's houses and building frames
        var keys = [], rMax = islandR(STAGE_A) - 3, r0 = Math.min(rMax, tr + 1), S = aspect() < 1 ? 1.3 : 1;
        var tws = towers.map(function (q) { return towerSpot(q.a, townR); });
        var each = function (r, fn) { posts.forEach(function (p) { var a = STAGE_A + p.side * 3.58 * S / r, ca = Math.cos(a), sa = Math.sin(a); fn(p, ca * r, sa * r, ca, sa); }); };
        var front = function (r) { // how near the nearest house or frame stands in front of a poster, were the stage at r (9: none)
          var m = 9;
          each(r, function (p, x, z, ca, sa) { lots.forEach(function (L) { var dx = L.x - x, dz = L.z - z, f = -(dx * ca + dz * sa), s = Math.abs(dz * ca - dx * sa); if (s < p.w * S / 2 + 0.75 && f > -0.85 && f < m) m = f; }); });
          return m;
        };
        var clear = function (r) { // no relay tower's mound at a poster, were the stage at r
          var ok = true;
          each(r, function (p, x, z, ca, sa) { tws.forEach(function (q) { var dx = q[0] - x, dz = q[1] - z; if (Math.hypot(dx * ca + dz * sa, Math.max(0, Math.abs(dz * ca - dx * sa) - p.w * S / 2)) < 1.5) ok = false; }); });
          return ok;
        };
        // a quarter's houses can reach right up to the posters: the stage then steps back, at most 1.5, never nearer the shore
        // than before and not into a relay tower
        if (lots) for (var back = 0; back < 6 && r0 < rMax && front(r0) < 2.2 && clear(Math.min(rMax, r0 + 0.25)); back++) r0 = Math.min(rMax, r0 + 0.25);
        stageG.userData.back = r0 - Math.min(rMax, tr + 1); // how far it stepped back: a computer screen's fit makes that much more room at the top
        posts.forEach(function (p, k) {
          var a = STAGE_A + p.side * 3.58 * S / r0, ca = Math.cos(a), sa = Math.sin(a), x = ca * r0, z = sa * r0;
          p.g.position.set(x, 0, z); p.g.rotation.y = Math.atan2(-ca, -sa); p.g.scale.setScalar(S);
          if (!k) stageG.userData.top = [x, p.top * S + 0.45, z];
          for (var ix = Math.floor(x - 5); ix <= Math.ceil(x + 5); ix++) for (var iz = Math.floor(z - 5); iz <= Math.ceil(z + 5); iz++) {
            var dx = ix - x, dz = iz - z, f = -(dx * ca + dz * sa), s = Math.abs(dz * ca - dx * sa);
            if (s < p.w * S / 2 + 0.75 && f > -0.85 && f < 2.3 * S) keys.push(ix + "," + iz);
          }
        });
        return keys;
      };
      /* front or back? the camera looks along one direction everywhere, so one number decides it.
         stageFar (1 = the posters stand at the far side) lets a computer screen make room for them at the top. */
      stageG.userData.tick = function () {
        if (cap) { stageG.visible = false; lastK = -1; return; } /* a postcard shows the town only: the posters are other people's work */
        var cx = cam.position.x - st.tx, cz = cam.position.z - st.tz, c = (cx * Math.cos(STAGE_A) + cz * Math.sin(STAGE_A)) / (Math.hypot(cx, cz) || 1);
        var f = Math.min(1, Math.max(0, (-c - 0.15) / 0.55)); stageFar = f * f * (3 - 2 * f);
        var u = Math.min(1, Math.max(0, (c - 0.02) / 0.4)), k = 1 - u * u * (3 - 2 * u);
        stageG.userData.on = k > 0.72;
        if (k === lastK) return; lastK = k;
        stageG.visible = k > 0.004;
        mats.forEach(function (m) { m.opacity = m.userData.o * k; m.transparent = m.userData.tr || k < 0.999; m.depthWrite = m.userData.dw && k > 0.5; });
      };
      stageG.userData.dbg = function () { return { on: stageG.userData.on, k: +lastK.toFixed(2), at: posts.map(function (p) { return [+p.g.position.x.toFixed(2), +p.g.position.z.toFixed(2), p.top]; }) }; };
      scene.add(stageG);
    })();
    var pond = new THREE.Group(), frog = new THREE.Group();
    (function () {
      var c = SQ;
      var water = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.06, 32), toon(0x2f7f86)); water.scale.set(1, 1, 0.88); water.position.y = 0.03; pond.add(water);
      [[0.3, -0.25, 0.18], [-0.35, 0.2, 0.14]].forEach(function (l) { var pad = new THREE.Mesh(new THREE.CylinderGeometry(l[2], l[2], 0.02, 14, 1, false, 0.4, 5.6), toon(0x6cae48)); pad.position.set(l[0], 0.07, l[1]); pond.add(pad); });
      var g = toon(0x6cae48), w = toon(0xf7eed9), k = toon(0x17110e);
      var body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 14), g); body.scale.set(1, 0.72, 0.9); body.position.y = 0.3; frog.add(body);
      var bo = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 14), inkBack); bo.scale.set(1.07, 0.79, 0.97); bo.position.y = 0.3; frog.add(bo);
      var belly = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 10), toon(0xefe5cf)); belly.scale.set(1, 0.6, 0.6); belly.position.set(0, 0.22, 0.2); frog.add(belly);
      [-1, 1].forEach(function (s) {
        var eye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), w); eye.position.set(s * 0.19, 0.6, 0.12); frog.add(eye);
        var pu = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), k); pu.position.set(s * 0.19, 0.62, 0.25); frog.add(pu);
        var leg = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), g); leg.scale.set(1, 0.5, 1.4); leg.position.set(s * 0.36, 0.1, -0.02); frog.add(leg);
      });
      var smile = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.022, 6, 16, Math.PI), k); smile.rotation.set(Math.PI, 0, 0); smile.position.set(0, 0.36, 0.36); frog.add(smile);
      frog.scale.setScalar(0.62); frog.position.set(0.72, 0, 0.42); frog.rotation.y = 0.6; pond.add(frog);
      pond.traverse(function (m) { if (m.isMesh) m.userData.pick = "frog"; });
      pond.position.set(c[0], 0, c[1]); scene.add(pond);
    })();

    /* cc: the cheese & chocolate shop. A small Swiss-village kiosk on the town square, between the flags and the pond:
       a red and cream awning, a lit window (it is open late), a counter with a wheel of cheese and a few chocolate bars,
       its name on a board on the roof. It faces the pond, stays clear of the flags, the walker passing by and the gold lights,
       and is lower than a two-storey house. Nothing in it moves. Five draw calls. */
    var ccShop = new THREE.Group(), ccCv = document.createElement("canvas"); ccCv.width = ccCv.height = 512; // one picture holds the sign, the window and the small windows
    var ccTex = new THREE.CanvasTexture(ccCv); ccTex.anisotropy = 8;
    function ccSign() { // a cream board with a red line and the name in stencil letters; drawn again when the page's letters have loaded
      var x = ccCv.getContext("2d"), w = 512, h = 240, px = 132, m, a, F = "px 'Big Shoulders Stencil Display', Anton, sans-serif", g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#f7efdc"); g.addColorStop(1, "#e4d6b8"); x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.strokeStyle = "#c8291e"; x.lineWidth = 6; x.strokeRect(17, 17, w - 34, h - 34);
      do { px -= 4; x.font = "900 " + px + F; m = x.measureText("CHOCOLATE"); a = m.actualBoundingBoxAscent || px * 0.72; } while (px > 20 && (m.width > w * 0.8 || a > h * 0.3));
      var gap = (h - 2 * a) / 3, w1 = x.measureText("CHEESE ").width, w2 = x.measureText("&").width;
      x.textAlign = "left"; x.textBaseline = "alphabetic";
      x.fillStyle = "#17171a"; x.fillText("CHEESE ", (w - w1 - w2) / 2, gap + a); x.fillText("CHOCOLATE", (w - m.width) / 2, 2 * gap + 2 * a);
      x.fillStyle = "#c8291e"; x.fillText("&", (w + w1 - w2) / 2, gap + a);
      ccTex.needsUpdate = true;
    }
    (function () {
      var x = ccCv.getContext("2d"), k, g;
      x.save(); x.translate(0, 256); // the shop window: warm light, a shelf of cheese wheels, a shelf of chocolate bars
      g = x.createLinearGradient(0, 0, 0, 136); g.addColorStop(0, "#fff3cf"); g.addColorStop(1, "#f2b560"); x.fillStyle = g; x.fillRect(0, 0, 320, 136);
      x.fillStyle = "#8a5530"; x.fillRect(0, 58, 320, 7); x.fillRect(0, 112, 320, 7);
      for (k = 0; k < 5; k++) { x.fillStyle = "#d99a2b"; x.beginPath(); x.ellipse(44 + k * 58, 41, 23, 16, 0, 0, 7); x.fill(); x.fillStyle = "#f6cf6a"; x.beginPath(); x.ellipse(44 + k * 58, 35, 21, 9, 0, 0, 7); x.fill(); }
      for (k = 0; k < 11; k++) { x.fillStyle = ["#c8291e", "#5a3320", "#d9b45a"][k % 3]; x.fillRect(22 + k * 26, 80, 17, 32); }
      x.fillStyle = "#2a2420"; x.fillRect(0, 0, 320, 6); x.fillRect(0, 130, 320, 6); x.fillRect(0, 0, 6, 136); x.fillRect(314, 0, 6, 136);
      x.restore();
      x.save(); x.translate(336, 256); warmGlass(x, 96, 112, 2, 2); x.restore(); // the small windows at the sides and the back
      ccSign();
      var ac = document.createElement("canvas"); ac.width = 256; ac.height = 128; var ax = ac.getContext("2d"), sw = 256 / 7; // the awning: seven stripes, a scalloped edge
      for (k = 0; k < 7; k++) { ax.fillStyle = k % 2 ? "#efe5cf" : "#c8291e"; ax.fillRect(Math.floor(k * sw), 0, Math.ceil(sw) + 1, 60); ax.fillRect(Math.floor(k * sw), 64, Math.ceil(sw) + 1, 36); ax.beginPath(); ax.arc((k + 0.5) * sw, 100, sw / 2, 0, Math.PI); ax.fill(); }
      var awnTex = new THREE.CanvasTexture(ac); awnTex.anisotropy = 8;
      var WOOD = "#6b4a2f", DARK = "#2a2420", CREAM = "#f4ecdb", STONE = "#b9ae96", ROOF = "#6e4630", TOP = "#9a6a40", CHEESE = "#f2c14e", HOLE = "#c9962e";
      var DP = 0.72, HT = 1.0, HW = DP / 2, RH = HW * 0.85, TH = Math.atan2(RH, HW), SL = Math.hypot(RH, HW) + 0.13, FZ = HW; // depth, wall height, the roof (half depth, rise, slope, slab), the front wall
      var SY = 1.36, SZ = 0.25, LEAN = 0.2, AY = 0.9, AL = 0.21, AA = 0.38, AW = 1.04, WX = -0.24, WZ = FZ + 0.085, CX = 0.22; // the sign board, the awning, the cheese, the chocolate
      var tipZ = FZ + AL * Math.cos(AA), tipY = AY - AL * Math.sin(AA);
      function rx(q, r) { q.rotateX(r); return q; }
      function ry(q, r) { q.rotateY(r); return q; }
      function slab(s, gr) { var b = new THREE.BoxGeometry(1.18 + gr, 0.06 + gr, SL + 0.05 + gr); b.translate(0, 0.03, SL / 2 - 0.025); b.rotateX(TH); if (s) b.rotateY(Math.PI); return b; }
      function board(w, h, d) { return rx(new THREE.BoxGeometry(w, h, d), -LEAN); }
      function awn(gr) { var b = new THREE.BoxGeometry(AW + gr, 0.022 + gr, AL + gr); b.translate(0, 0, AL / 2); b.rotateX(AA); return b; }
      function wheel(r, d, cut) { var s = new THREE.Shape(), a0 = -Math.PI / 4 + cut / 2; s.moveTo(0, 0); s.absarc(0, 0, r, a0, a0 + Math.PI * 2 - cut, false); s.lineTo(0, 0);
        return new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 20 }).rotateX(-Math.PI / 2); } // a wheel lying flat, a slice cut out toward the front
      function part(q, r) { var uv = q.attributes.uv; for (var i = 0; i < uv.count; i++) uv.setXY(i, r.length === 2 ? r[0] : r[0] + uv.getX(i) * (r[2] - r[0]), r.length === 2 ? r[1] : r[1] + uv.getY(i) * (r[3] - r[1])); return q; } // its place in the picture
      function merge(list) { var pos = [], nor = [], uvs = [];
        list.forEach(function (it) { var q = it[0].index ? it[0].toNonIndexed() : it[0]; q.translate(it[1], it[2], it[3]); pos.push.apply(pos, q.attributes.position.array); nor.push.apply(nor, q.attributes.normal.array); uvs.push.apply(uvs, q.attributes.uv.array); });
        var out = new THREE.BufferGeometry(); out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); return out; }
      var SOL = [ // stone foot, wooden skirt, cream walls with wooden corners, the roof, the counter, the goods, the board's frame
        [new THREE.BoxGeometry(1.12, 0.06, 0.84), 0, 0.03, 0, STONE], [new THREE.BoxGeometry(1.03, 0.25, DP + 0.03), 0, 0.185, 0, WOOD],
        [new THREE.BoxGeometry(1.0, HT - 0.06, DP), 0, (HT + 0.06) / 2, 0, CREAM], [prism(1.0, HW, RH), 0, HT, 0, CREAM],
        [slab(0, 0), 0, HT + RH, 0, ROOF], [slab(1, 0), 0, HT + RH, 0, ROOF], [new THREE.BoxGeometry(1.22, 0.06, 0.08), 0, HT + RH + 0.05, 0, DARK],
        [new THREE.BoxGeometry(0.88, 0.42, 0.02), 0, 0.515, FZ + 0.005, DARK], [new THREE.BoxGeometry(0.96, 0.04, 0.19), 0, 0.3, FZ + 0.085, TOP],
        [new THREE.BoxGeometry(0.02, 0.27, 0.24), 0.505, 0.6, 0, DARK], [new THREE.BoxGeometry(0.02, 0.27, 0.24), -0.505, 0.6, 0, DARK], [new THREE.BoxGeometry(0.24, 0.27, 0.02), 0, 0.6, -HW - 0.005, DARK],
        [wheel(0.11, 0.085, 1.0), WX, 0.32, WZ, CHEESE],
        [new THREE.BoxGeometry(0.2, 0.026, 0.09), CX, 0.333, WZ, "#5a3320"], [new THREE.BoxGeometry(0.06, 0.03, 0.094), CX, 0.333, WZ, "#d9b45a"],
        [ry(new THREE.BoxGeometry(0.2, 0.026, 0.09), 0.22), CX + 0.01, 0.359, WZ, "#c8291e"], [ry(new THREE.BoxGeometry(0.06, 0.03, 0.094), 0.22), CX + 0.01, 0.359, WZ, "#d9b45a"],
        [ry(new THREE.BoxGeometry(0.18, 0.024, 0.085), -0.16), CX - 0.01, 0.384, WZ, "#4a2a1a"],
        [board(0.98, 0.5, 0.035), 0, SY, SZ, DARK]
      ];
      [[-0.05, 0.03], [0.01, -0.06], [-0.04, -0.03]].forEach(function (o) { SOL.push([rx(new THREE.CircleGeometry(0.016, 10), -Math.PI / 2), WX + o[0], 0.407, WZ + o[1], HOLE]); }); // holes in the cheese
      for (var k2 = -1; k2 <= 1; k2 += 2) for (var k3 = -1; k3 <= 1; k3 += 2) SOL.push([new THREE.BoxGeometry(0.06, HT - 0.06, 0.06), k2 * 0.5, (HT + 0.06) / 2, k3 * HW, WOOD]);
      [-1, 1].forEach(function (s) { SOL.push([new THREE.BoxGeometry(1.04, 0.05, 0.03), 0, HT - 0.02, s * (HW + 0.005), WOOD]); });
      var OUT = [ // the ink line round the big parts, like the houses
        [new THREE.BoxGeometry(1.07, HT - 0.01, DP + 0.07), 0, (HT + 0.06) / 2, 0], [slab(0, 0.05), 0, HT + RH, 0], [slab(1, 0.05), 0, HT + RH, 0],
        [board(1.03, 0.55, 0.07), 0, SY, SZ], [new THREE.BoxGeometry(1.0, 0.075, 0.23), 0, 0.3, FZ + 0.085], [awn(0.04), 0, AY, FZ],
        [wheel(0.125, 0.115, 1.0), WX, 0.305, WZ], [new THREE.BoxGeometry(0.25, 0.1, 0.13), CX, 0.358, WZ]
      ];
      var SW = [0.65625, 0.28125, 0.84375, 0.5], LIT = [ // what glows: the sign, the shop window, the small windows
        [part(rx(new THREE.PlaneGeometry(0.92, 0.43), -LEAN), [0, 0.53125, 1, 1]), 0, SY + 0.02 * Math.sin(LEAN), SZ + 0.02 * Math.cos(LEAN)],
        [part(new THREE.PlaneGeometry(0.8, 0.34), [0, 0.234375, 0.625, 0.5]), 0, 0.515, FZ + 0.017],
        [part(ry(new THREE.PlaneGeometry(0.2, 0.233), Math.PI / 2), SW), 0.517, 0.6, 0], [part(ry(new THREE.PlaneGeometry(0.2, 0.233), -Math.PI / 2), SW), -0.517, 0.6, 0],
        [part(ry(new THREE.PlaneGeometry(0.2, 0.233), Math.PI), SW), 0, 0.6, -HW - 0.017]
      ];
      var AWN = [[part(awn(0), [0, 0.53125, 1, 1]), 0, AY, FZ], [part(new THREE.PlaneGeometry(AW, 0.08), [0, 0, 1, 0.5]), 0, tipY - 0.03, tipZ + 0.006]];
      var pool = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2).rotateX(-Math.PI / 2), basic(0xffc27a, { map: poolTex, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      pool.position.set(0, 0.04, FZ + 0.36); pool.renderOrder = 2; pool.raycast = function () {}; // warm light on the stones in front
      ccShop.add(new THREE.Mesh(mergeCol(SOL), toon(0xffffff, { vertexColors: true, emissive: 0x140c05 })), new THREE.Mesh(mergeCol(OUT), inkBack),
        new THREE.Mesh(merge(LIT), basic(0xffffff, { map: ccTex })), new THREE.Mesh(merge(AWN), toon(0xffffff, { map: awnTex, alphaTest: 0.5, side: THREE.DoubleSide })), pool);
      ccShop.traverse(function (m) { m.userData.pick = "shop"; });
      // at the front of the square: seen from the usual view, the back row of flags then flies below its sign and awning, not across them
      ccShop.position.set(-1.38, 0, SQ[1] - 0.28); ccShop.rotation.y = Math.PI / 2; ccShop.scale.setScalar(0.64); scene.add(ccShop); // its window looks at the pond
    })();

    /* relay radio towers on the hills outside town */
    var towers = RELAYS.map(function (r, i) {
      var g = new THREE.Group(), k = toon(0x17110e);
      var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.22, 3.2, 4, 1), toon(0x2a2a30)); mast.position.y = 1.6; g.add(mast);
      [0.8, 1.6, 2.4].forEach(function (y) { var b = new THREE.Mesh(new THREE.BoxGeometry(0.42 - y * 0.1, 0.05, 0.05), k); b.position.y = y; g.add(b); });
      var lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), basic(0xff3b2a)); lamp.position.y = 3.3; g.add(lamp);
      var hill = new THREE.Mesh(new THREE.SphereGeometry(1.1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon(0x22252a)); hill.scale.set(1, 0.32, 1); g.add(hill);
      var ringGeo = new THREE.RingGeometry(0.955, 1, 56), wave = new THREE.Mesh(ringGeo, basic(0xff5a3c, { transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })); wave.rotation.x = -Math.PI / 2; wave.position.y = 3.3; g.add(wave);
      var wave2 = new THREE.Mesh(ringGeo, wave.material.clone()); wave2.rotation.x = -Math.PI / 2; wave2.position.y = 3.3; g.add(wave2);
      g.traverse(function (m) { if (m.isMesh && m !== wave && m !== wave2) { m.userData.pick = "relay"; m.userData.relay = r.name; } });
      scene.add(g); return { g: g, lamp: lamp, wave: wave, wave2: wave2, ph: i * 0.37, a: i / RELAYS.length * Math.PI * 2 + 0.35 };
    });

    /* gas station (addition gs): nothing can be paid for on this network yet (no transactions, so no gas), and the town's
       gas station stands closed. A low station on the road east out of town, past the last street lamp: a flat canopy on
       two posts, two pumps, a kiosk with dark windows, one dim red lamp and a tall sign. No light of its own; the sign is
       pale enough to find at night. It is placed again every day, on the first block out that is clear of everything. */
    var gsG = new THREE.Group(), gsCv = document.createElement("canvas"), gsLots = []; gsCv.width = 512; gsCv.height = 256;
    (function () {
      var PX = 0, SX = -0.86; // where the pumps' canopy and the sign stand on the forecourt (across the road's direction)
      var CRM = "#efe5cf", ROOF = "#ddd2b9", WALLC = "#e6dac0", RED = "#c8291e", DRED = "#8f1911", STONE = "#b9ae96", STEEL = "#3a3a42", INK = "#17110e", FRAME = "#2a2530";
      function bx(w, h, d, q) { return new THREE.BoxGeometry(w + 2 * q, h + 2 * q, d + 2 * q); }
      function cyl(r, h, q) { return new THREE.CylinderGeometry(r + q, r + q, h + 2 * q, 10); }
      function parts(q) { // the parts with an ink line round them (q grows each one); the front (+z) faces the road
        var L = [[bx(0.98, 0.07, 0.3, q), PX, 0.085, 0.2, STONE]]; // the pump island
        [-0.2, 0.2].forEach(function (u) { // two pumps: red body, round cream globe on top
          L.push([bx(0.15, 0.32, 0.13, q), PX + u, 0.28, 0.2, RED], [new THREE.SphereGeometry(0.058 + q, 12, 8), PX + u, 0.49, 0.2, CRM]);
        });
        [-0.42, 0.42].forEach(function (u) { L.push([cyl(0.032, 0.62, q), PX + u, 0.43, 0.2, STEEL]); }); // the two canopy posts
        L.push([bx(1.3, 0.1, 0.9, q), PX, 0.79, 0.2, RED]); // the canopy: a red band round a flat roof
        L.push([bx(0.7, 0.4, 0.46, q), 0.48, 0.3, -0.6, WALLC], [bx(0.84, 0.08, 0.6, q), 0.48, 0.54, -0.6, DRED]); // the kiosk and its flat roof
        L.push([bx(0.16, 0.08, 0.16, q), SX, 0.09, 0.5, STONE], [bx(0.07, 1.5, 0.07, q), SX, 0.8, 0.5, STEEL]); // the sign's foot and its one tall pole
        L.push([bx(0.06, 0.48, 0.92, q), SX, 1.79, 0.5, INK]); // the sign's frame
        L.push([bx(0.56, 0.05, 0.035, q), PX, 0.21, 0.8, RED]); // a barrier across the way in: closed
        return L;
      }
      var body = parts(0).concat([
        [new THREE.BoxGeometry(1.92, 0.05, 1.92), 0, 0.025, 0, "#2c2b31"], // the forecourt
        [new THREE.BoxGeometry(1.26, 0.035, 0.86), PX, 0.857, 0.2, ROOF], [new THREE.BoxGeometry(1.32, 0.016, 0.92), PX, 0.775, 0.2, CRM], // the roof and a cream line on the band
        [new THREE.BoxGeometry(0.8, 0.025, 0.56), 0.48, 0.592, -0.6, ROOF], [new THREE.BoxGeometry(0.74, 0.05, 0.5), 0.48, 0.075, -0.6, STONE], // the kiosk's roof and its stone foot
        [new THREE.BoxGeometry(0.36, 0.24, 0.01), 0.62, 0.31, -0.368, FRAME], [new THREE.BoxGeometry(0.18, 0.32, 0.01), 0.25, 0.26, -0.368, FRAME], [new THREE.BoxGeometry(0.01, 0.22, 0.28), 0.832, 0.31, -0.6, FRAME], // window and door frames
        [new THREE.BoxGeometry(0.1, 0.04, 0.96), SX, 2.05, 0.5, RED] // a red cap on the sign
      ]);
      [-0.2, 0.2].forEach(function (u) { // the pumps' cream faces, hoses and nozzles
        body.push([new THREE.BoxGeometry(0.11, 0.12, 0.012), PX + u, 0.33, 0.267, CRM], [new THREE.BoxGeometry(0.018, 0.2, 0.018), PX + 0.09 + u, 0.27, 0.23, INK], [new THREE.BoxGeometry(0.03, 0.05, 0.05), PX + 0.09 + u, 0.37, 0.23, INK]);
      });
      [-0.165, -0.055, 0.055, 0.165].forEach(function (u, k) { if (k % 2) body.push([new THREE.BoxGeometry(0.11, 0.054, 0.04), PX + u, 0.21, 0.8, CRM]); }); // the barrier's stripes
      [-0.25, 0.25].forEach(function (u) { body.push([new THREE.BoxGeometry(0.03, 0.19, 0.1), PX + u, 0.14, 0.8, INK]); }); // its legs
      var solid = new THREE.Mesh(mergeCol(body), toon(0xffffff, { vertexColors: true })), hull = new THREE.Mesh(mergeGeo(parts(0.024)), inkBack);
      var dark = new THREE.Mesh(mergeCol([ // unlit: the dark glass, the pumps' dials, and one dim red lamp on the kiosk's roof
        [new THREE.BoxGeometry(0.32, 0.2, 0.012), 0.62, 0.31, -0.364, "#23232a"], [new THREE.BoxGeometry(0.14, 0.28, 0.012), 0.25, 0.25, -0.364, "#23232a"], [new THREE.BoxGeometry(0.012, 0.18, 0.24), 0.836, 0.31, -0.6, "#23232a"],
        [new THREE.BoxGeometry(0.08, 0.04, 0.014), PX - 0.2, 0.355, 0.27, "#23232a"], [new THREE.BoxGeometry(0.08, 0.04, 0.014), PX + 0.2, 0.355, 0.27, "#23232a"],
        [new THREE.SphereGeometry(0.034, 10, 8), 0.76, 0.635, -0.4, "#9a2619"]]), basic(0xffffff, { vertexColors: true }));
      var tex = new THREE.CanvasTexture(gsCv), faces = [], fg; tex.anisotropy = 8;
      [1, -1].forEach(function (s) { fg = new THREE.PlaneGeometry(0.82, 0.41).rotateY(s * Math.PI / 2).toNonIndexed(); fg.translate(SX + s * 0.0315, 1.79, 0.5); faces.push(fg); }); // both sides read the right way
      var sg = new THREE.BufferGeometry();
      ["position", "normal", "uv"].forEach(function (k) { var a = []; faces.forEach(function (g) { a.push.apply(a, g.attributes[k].array); }); sg.setAttribute(k, new THREE.Float32BufferAttribute(a, k === "uv" ? 2 : 3)); });
      var sign = new THREE.Mesh(sg, basic(0xffffff, { map: tex }));
      gsG.add(solid, hull, dark, sign); gsG.userData.tex = tex; gsG.visible = false;
      gsG.traverse(function (m) { m.userData.pick = "gas"; });
      scene.add(gsG);
    })();
    function gsDrawSign() { // dim paper with a red band and the words in the town's stencil letters: nothing on it is lit
      var x = gsCv.getContext("2d"), w = 512, h = 256, px = 168, m, a, g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#d6cbb0"); g.addColorStop(1, "#aaa088"); x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.fillStyle = "#8f1911"; x.fillRect(0, 0, w, 50); x.fillRect(0, h - 26, w, 26);
      x.fillStyle = "rgba(239,229,207,.5)"; x.fillRect(0, 56, w, 4); x.fillRect(0, h - 36, w, 3);
      x.fillStyle = "#17171a"; x.textAlign = "center"; x.textBaseline = "alphabetic";
      do { px -= 4; x.font = "900 " + px + "px 'Big Shoulders Stencil Display', Anton, sans-serif"; m = x.measureText("NO GAS YET"); a = m.actualBoundingBoxAscent || px * 0.72; } while (px > 24 && (m.width > w * 0.84 || a > 130));
      x.fillText("NO GAS YET", w / 2, 60 + (h - 96 + a) / 2);
      x.strokeStyle = "#17171a"; x.lineWidth = 12; x.strokeRect(6, 6, w - 12, h - 12);
      gsG.userData.tex.needsUpdate = true;
    }
    gsDrawSign();
    // where it stands: the first block out along a road from the middle of town (the road east first, its south side
    // first) whose lots are all free and, on the first try, with no street lamp at its corners: the last houses may be
    // across the street, the town's lights stop before it. Never in the crane's sweep, by a relay tower or near the shore
    // (the ferry stays in the water), never on the museum's, factory's or town square's block. The road west is the Main Stage's
    // side. Null when no block fits: no station that day.
    function gsSpot(taken, lampR, cr, tw) {
      var ROADS = [[1, 0, -1], [1, 0, 1], [0, 1, -1], [0, -1, -1]]; // the road's direction (x, z) and which side of it
      for (var pass = 0; pass < 2; pass++) for (var k = 0; k < ROADS.length; k++) {
        var dx = ROADS[k][0], dz = ROADS[k][1], s = ROADS[k][2];
        for (var b = 1; b < 99; b++) {
          var u = 3 * b + 1.5, cx = dx * u - dz * s * 1.5, cz = dz * u + dx * s * 1.5, ok = true, i, j;
          for (i = -1; i <= 1; i += 2) for (j = -1; j <= 1; j += 2) if (!onIsland(cx + i * 1.1, cz + j * 1.1, 1.5)) ok = false;
          if (!ok) break; // the shore: no room further out on this road
          for (i = -0.5; i <= 0.5; i++) for (j = -0.5; j <= 0.5; j++) if (taken[(cx + i) + "," + (cz + j)]) ok = false; // houses, building site, stage
          var zn = zoneOf(Math.floor(cx / 3), Math.floor(cz / 3)); if (!zn || zn === "dc") ok = false; // not in the wood, not among the data centers
          if (kept(cx, cz) || Math.hypot(cx - SQ[0], cz - SQ[1]) < 6 || (pass && Math.hypot(cx, cz) <= lampR)) ok = false; // never on the landmarks' blocks or by the town square, always past the last houses
          if (!pass) for (i = -1; i <= 1; i += 2) for (j = -1; j <= 1; j += 2) if (lampAt(cx + i * 1.5, cz + j * 1.5)) ok = false;
          if (cr && Math.hypot(cx - cr.x, cz - cr.z) < 4.2) ok = false;
          tw.forEach(function (p) { if (Math.hypot(cx - p[0], cz - p[1]) < 3.3) ok = false; });
          if (ok) return { x: cx, z: cz, ry: Math.atan2(s * dz, -s * dx), cells: [[cx - 0.5, cz - 0.5], [cx + 0.5, cz - 0.5], [cx - 0.5, cz + 0.5], [cx + 0.5, cz + 0.5]] };
        }
      }
      return null;
    }
    // a relay tower stands outside town on its own bearing. While data centers are shown, a tower whose spot falls in or
    // by their district swings round into the wood beside it, until it stands 3 clear of the district's blocks.
    function towerSpot(a, tr) {
      for (var n = 0; ; n++) {
        var r = Math.min(islandR(a) - 2.6, tr + 3.2), x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (!dzOn || n >= 40 || Math.hypot(Math.max(0, 9 - x), Math.max(0, z + 9)) >= 3) return [x, z];
        a += 0.02;
      }
    }
    function gsPut(tr, taken) { // placeSites calls this once the houses, the building site, the crane and the stage stand
      var tw = towers.map(function (q) { return towerSpot(q.a, tr); }); // where showDay puts the relay towers
      var sp = gsSpot(taken, radiusOf(shown.filter(function (h) { return !h.dz; })), crane.visible ? crane.position : null, tw), ld = lotTex.image.data;
      gsLots = sp ? sp.cells : []; gsG.visible = !!sp; if (!sp) return;
      gsG.position.set(sp.x, 0, sp.z); gsG.rotation.y = sp.ry;
      gsLots.forEach(function (c) { // no tree grows through it, and its lot is paved like the town's
        taken[c[0] + "," + c[1]] = 1;
        for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) { var u = c[0] + a + 64, v = c[1] + b + 64; if (u >= 0 && u < 128 && v >= 0 && v < 128) ld[v * 128 + u] = 255; }
      });
      lotTex.needsUpdate = true;
    }

    /* paper planes, citizens, fireworks */
    var planeGeo = new THREE.BufferGeometry();
    var dartV = [0, 0, 0.62, -0.34, 0.07, -0.5, -0.04, 0, -0.5, 0, 0, 0.62, 0.04, 0, -0.5, 0.34, 0.07, -0.5, 0, 0, 0.62, -0.04, 0, -0.5, 0.04, 0, -0.5, 0, 0, 0.62, 0, -0.16, -0.42, -0.04, 0, -0.5, 0, 0, 0.62, 0.04, 0, -0.5, 0, -0.16, -0.42], dartC = [];
    [[0.957, 0.925, 0.859], [0.83, 0.79, 0.69], [0.6, 0.56, 0.46], [0.66, 0.61, 0.5], [0.5, 0.46, 0.38]].forEach(function (c) { for (var q = 0; q < 3; q++) dartC.push(c[0], c[1], c[2]); });
    planeGeo.setAttribute("position", new THREE.Float32BufferAttribute(dartV, 3)); planeGeo.setAttribute("color", new THREE.Float32BufferAttribute(dartC, 3));
    var planeMat = basic(0xffffff, { side: THREE.DoubleSide, vertexColors: true }), edge = new THREE.LineBasicMaterial({ color: 0x000000 });
    var trailMat = new THREE.LineDashedMaterial({ color: 0xefeff1, dashSize: 0.25, gapSize: 0.3, transparent: true, opacity: 0.35 });
    var planes = []; for (var pk = 0; pk < (reduce ? 0 : 8); pk++) {
      var pm = new THREE.Mesh(planeGeo, planeMat); pm.scale.setScalar(0.56); scene.add(pm);
      var tr = new THREE.Line(new THREE.BufferGeometry(), trailMat); scene.add(tr); planes.push({ m: pm, trail: tr, t: 1, ph: pk * 1.7 });
    }
    function arcAt(pl, t, out) { return out.set(pl.a.x + (pl.b.x - pl.a.x) * t, 0.6 + Math.sin(Math.PI * t) * pl.h, pl.a.z + (pl.b.z - pl.a.z) * t); }
    function route(pl) {
      var lit = shown.filter(function (h) { return litNow[h.idx]; }); if (lit.length < 2) return;
      var a = lit[Math.floor(Math.random() * lit.length)], b = lit[Math.floor(Math.random() * lit.length)];
      pl.a = new THREE.Vector3(a.x, 0, a.z); pl.b = new THREE.Vector3(b.x, 0, b.z); var dd = pl.a.distanceTo(pl.b); if (dd < 3) { pl.t = 1; return; }
      pl.h = 1.2 + dd * 0.22; pl.t = 0; pl.dur = 2.2 + dd * 0.18;
      var pts = []; for (var k = 0; k <= 40; k++) pts.push(arcAt(pl, k / 40, new THREE.Vector3()));
      pl.trail.geometry.dispose(); pl.trail.geometry = new THREE.BufferGeometry().setFromPoints(pts); pl.trail.computeLineDistances();
    }
    /* the news plane: on a day a new validator release came out, a small plane tows a banner with its name round the
       sky (DATA.releases = [[name, date], ...] newest first, from the validator's own release list). On the newest day a
       release from the day before still counts as news. The plane lives in the town: it flies a slow loop above the
       houses, higher than anything built near it, and it turns and grows with the town when the visitor turns or zooms.
       Its banner has two faces, each with its own words, so they read the right way from both sides. It is left out of
       postcards and of pictures taken by robots (the link-preview picture is made by one). With reduced motion it
       stands still. */
    // news plane in the town (step 29)
    var news = (function () {
      var REL = (DATA.releases || []).filter(function (r) { return r && r[0] && /^\d{4}-\d\d-\d\d$/.test(r[1] || ""); });
      if (!REL.length || navigator.webdriver) return { pick: function () { return []; }, frame: function () {}, draw: function () {}, label: function () { return ""; }, card: function () { return ["", ""]; }, box: function () { return null; } };
      var L = 4.6, H = 1.6, X0 = 1.3, YB = -0.45, RL = 4.7, LOOP = 32, A0 = 4.11, STILL = -3.0, BANK = 0.2, RED = "#c8291e", CRM = "#f3ead6", INK = "#17110e"; // the banner: length, height, where it starts behind the plane, its middle; the loop: its radius in plane sizes, seconds for one round, where the plane starts, where it stands with reduced motion; how far the plane leans into the turn
      var g = new THREE.Group(), v = new THREE.Vector3(), none = function () {}, name = "", fresh = false, rel = null, seen = -1;
      g.visible = false; scene.add(g);
      function cyl(a, b, h, q) { return new THREE.CylinderGeometry(a + q, b + q, h + 2 * q, 10).rotateZ(Math.PI / 2); } // lies along x, radius a at the nose
      function box(w, h, d, q) { return new THREE.BoxGeometry(w + 2 * q, h + 2 * q, d + 2 * q); }
      function parts(q) { // the plane, nose to the left; q grows every part (the ink outline)
        return [[cyl(0.17, 0.075, 1.1, q), 0, 0, 0, RED], [new THREE.SphereGeometry(0.11 + q, 10, 8), -0.57, 0, 0, CRM],
          [box(0.36, 0.04, 1.14, q), -0.14, 0.03, 0, RED], [box(0.36, 0.044, 0.22, q), -0.14, 0.03, 0.68, CRM], [box(0.36, 0.044, 0.22, q), -0.14, 0.03, -0.68, CRM],
          [box(0.2, 0.035, 0.56, q), 0.46, 0.03, 0, RED], [box(0.2, 0.27, 0.035, q), 0.46, 0.17, 0, CRM],
          [new THREE.SphereGeometry(0.115 + q, 10, 8), -0.12, 0.13, 0, "#ffd98a"]];
      }
      var body = new THREE.Mesh(mergeCol(parts(0)), toon(0xffffff, { vertexColors: true, emissive: 0x24100c }));
      var hull = new THREE.Mesh(mergeGeo(parts(0.03)), inkBack); hull.raycast = none;
      var prop = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.58, 0.075), basic(0xf3ead6)); prop.position.x = -0.7; prop.raycast = none;
      function line(x1, y1, x2, y2) { var dx = x2 - x1, dy = y2 - y1; return [new THREE.BoxGeometry(Math.hypot(dx, dy), 0.03, 0.03).rotateZ(Math.atan2(dy, dx)), (x1 + x2) / 2, (y1 + y2) / 2, 0]; }
      var rope = new THREE.Mesh(mergeGeo([line(0.52, 0.09, X0, YB + H * 0.42), line(0.52, 0.09, X0, YB - H * 0.42)]), basic(0xcfc5ad)); rope.raycast = none;
      var pl = new THREE.Group(); pl.add(body, hull, prop); // level here: frame() leans it into the turn
      function bend(p) { for (var i = 0; i < p.count; i++) { var q = p.array[3 * i] / RL; p.array[3 * i] = Math.sin(q) * RL; p.array[3 * i + 2] += (1 - Math.cos(q)) * RL; } } // the cloth and its ropes lie on the loop the plane flies, not on a straight line behind it
      var cv = document.createElement("canvas"), cv2 = document.createElement("canvas"); cv.width = cv2.width = 1024; cv.height = cv2.height = 256;
      var tex = new THREE.CanvasTexture(cv), tex2 = new THREE.CanvasTexture(cv2); tex.anisotropy = tex2.anisotropy = 8;
      var geo = new THREE.PlaneGeometry(L, H, 36, 1).translate(X0 + L / 2, YB, 0), pos = geo.attributes.position; bend(pos); bend(rope.geometry.attributes.position);
      var ban = new THREE.Mesh(geo, basic(0xffffff, { map: tex, alphaTest: 0.5 })), bak = new THREE.Mesh(geo, basic(0xffffff, { map: tex2, alphaTest: 0.5, side: THREE.BackSide })), base = Float32Array.from(pos.array); // one cloth, two faces: each face has its own picture of the words, so they never read mirrored
      function wave(t) { // the cloth waves more toward its free end
        for (var i = 0; i < pos.count; i++) { var u = (i % 37) / 36; pos.array[3 * i + 1] = base[3 * i + 1] + Math.sin(u * 9 - t * 4.2) * 0.09 * (0.12 + u); } // u: 0 at the ropes, 1 at the free end (37 points along the cloth)
        pos.needsUpdate = true;
      }
      wave(0.6); ban.geometry.computeBoundingSphere(); ban.geometry.boundingSphere.radius += 0.3;
      body.userData.pick = ban.userData.pick = bak.userData.pick = "news";
      g.add(pl, rope, ban, bak);
      function paint(cv, tex, m) { // one face of the cloth: cream with an ink edge, a swallowtail end and two lines of words, each as big as fits. m = -1 is the back face: its words are drawn mirrored, so they read the right way from behind
        var x = cv.getContext("2d"), w = 1024, h = w * H / L, b = 16, nt = 120, A = name.toUpperCase(), mid = (w - m * nt * 0.7) / 2, gr = x.createLinearGradient(0, 0, w, 0);
        var rows = fresh ? [[A, " IS OUT", 0.24], ["", "UPDATE NOW", 0.42]] : [[A, "", 0.42], ["", "CAME OUT THIS DAY", 0.24]]; // a line: its red words, its ink words, how much of the cloth's height its letters may take (the main line is the big one)
        function cloth(i) { x.beginPath(); x.moveTo(i, i); x.lineTo(w - i * 1.9, i); x.lineTo(w - nt - i * 1.2, h / 2); x.lineTo(w - i * 1.9, h - i); x.lineTo(i, h - i); x.closePath(); x.fill(); }
        x.setTransform(1, 0, 0, 256 / h, 0, 0); x.clearRect(0, 0, w, h);
        x.fillStyle = INK; cloth(0);
        gr.addColorStop(0, "#fbf4e1"); gr.addColorStop(0.3, "#eee4cb"); gr.addColorStop(0.56, "#faf2dd"); gr.addColorStop(0.82, "#e9dec4"); gr.addColorStop(1, "#f3ead6");
        x.fillStyle = gr; cloth(b);
        x.textAlign = "left"; x.textBaseline = "alphabetic";
        rows.forEach(function (r) { // finds the line's letter size r[3], its letters' height r[4] and its width r[5]
          var px = 244; do { px -= 4; x.font = "900 " + px + "px 'Big Shoulders Stencil Display', Anton, sans-serif"; r[5] = x.measureText(r[0] + r[1]).width; r[4] = x.measureText(r[0] + r[1]).actualBoundingBoxAscent || px * 0.72; } while (px > 24 && (r[5] > (w - nt) * 0.86 || r[4] > h * r[2]));
          r[3] = px;
        });
        var y = (h - rows[0][4] - rows[1][4] - h * 0.1) / 2; // the two lines stand in the middle of the cloth, a tenth of its height apart
        x.setTransform(m, 0, 0, 256 / h, m < 0 ? w : 0, 0); // the back face: mirrored in the picture, the right way round in the sky
        rows.forEach(function (r) {
          var px = r[3]; y += r[4]; x.font = "900 " + px + "px 'Big Shoulders Stencil Display', Anton, sans-serif";
          x.fillStyle = RED; x.fillText(r[0], mid - r[5] / 2, y); // the name in red
          x.fillStyle = INK; x.fillText(r[1], mid - r[5] / 2 + x.measureText(r[0]).width, y); y += h * 0.1;
        });
        tex.needsUpdate = true;
      }
      function draw() { if (name) { paint(cv, tex, 1); paint(cv2, tex2, -1); } } // drawn again when the page's letters have loaded
      function dayBefore(s) { return new Date(Date.parse(s + "T00:00:00Z") - 864e5).toISOString().slice(0, 10); }
      function relOf(i) { // the release that is news on day i
        var d = DAYS[i], k; if (!d || !d.date) return null;
        for (k = 0; k < REL.length; k++) if (REL[k][1] === d.date) return REL[k];
        if (i === DAYS.length - 1) for (k = 0; k < REL.length; k++) if (REL[k][1] === dayBefore(d.date)) return REL[k];
        return null;
      }
      function look() { if (seen !== current) { seen = current; rel = relOf(current); var f = current === DAYS.length - 1; if (rel && (rel[0] !== name || f !== fresh)) { name = rel[0]; fresh = f; draw(); } } return rel; } // "update now" only on the newest day
      function dayName(s) { for (var k = 0; k < DAYS.length; k++) if (DAYS[k].date === s) return DAYS[k].label; return s; }
      function where() { // where the plane and the four quarters of its cloth are on the screen: five boxes [left, top, right, bottom] in stage pixels, or null. A name tag hides while one of them is on it
        if (!g.visible) return null;
        var W = stage.clientWidth, Hs = stage.clientHeight, out = [];
        g.updateMatrixWorld();
        for (var j = 0; j < 5; j++) {
          var b = [1e9, 1e9, -1e9, -1e9];
          for (var i = 0; i < 8; i++) { // the corners of the plane's box (j = 0), or of one quarter of the cloth with room for its waves (the first quarter starts at the plane's tail: the ropes are in it)
            if (j) { var q = (j > 1 || i & 1 ? X0 + L * (j - 1 + (i & 1)) / 4 : 0.5) / RL; v.set(Math.sin(q) * RL, YB + (i & 2 ? 1 : -1) * (H / 2 + 0.1), (1 - Math.cos(q)) * RL); }
            else v.set(i & 1 ? 0.6 : -0.75, i & 2 ? 0.42 : -0.3, i & 4 ? 0.8 : -0.8);
            g.localToWorld(v).project(cam); var x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * Hs;
            b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
          }
          out.push(b);
        }
        return out;
      }
      return {
        pick: function () { return g.visible ? [body, ban, bak] : []; }, draw: draw, box: where,
        label: function () { return look() ? rel[0] + " is out" : ""; },
        card: function (d) {
          if (!look()) return ["", ""];
          var vs = d.versions || [], got = vs.filter(function (e) { return e[0] === rel[0]; })[0], pc = got ? (got[1] > 0 ? got[1] + "%" : "under 1%") : "";
          return [rel[0] + " is out", "Validator update " + rel[0] + " came out on " + dayName(rel[1]) + "." + (!vs.length ? "" :
            got ? (d.final ? " By the end of " + d.label + ", validators with " + pc + " of the validating TDH ran it." : " So far on " + d.label + ", validators with " + pc + " of the validating TDH run it.") :
            d.final ? " No validator's daily report showed it yet on " + d.label + "." : " No daily report shows it yet: validators report once a day, so it shows from the next day.")];
        },
        frame: function (t) {
          if (!look() || cap) { g.visible = false; return; }
          var w = Math.min(1, Math.max(0, (aspect() - 0.68) / 0.32)), s = fitHalf * (0.76 - 0.12 * w) / RL * (1 + camOff), a = reduce ? STILL : A0 - t * 2 * Math.PI / LOOP; // w: 0 on a phone, 1 on a computer, between the two on a window that is nearly square. The loop is as wide as the full view allows; a phone has more sky than sides: a bigger plane, higher. In the tour the picture moves up for the card, so the plane is a little smaller: it stays in the picture
          var y = Math.max(2.4 + 1.35 * s, fitHalf * (0.727 - 0.227 * w)); // the height follows the town's size like the loop's width does: the same picture on a small day and on a big one; never down at the roofs
          g.position.set(Math.cos(a) * RL * s, y + (reduce ? 0 : Math.sin(t * 0.9) * 0.1), Math.sin(a) * RL * s);
          g.rotation.y = -Math.PI / 2 - a; g.scale.setScalar(s); // the nose along the loop, the cloth on the loop behind it
          pl.rotation.x = BANK + (reduce ? 0 : Math.sin(t * 0.7) * 0.05); // only the plane leans into the turn: the cloth stays upright, so its words never turn over
          if (!reduce) { prop.rotation.x = t * 26; wave(t); }
          g.visible = true;
        }
      };
    })();
    /* the town's sound. All of it is made by the page itself (no sound files, nothing loaded): night air (wind, crickets,
       rain on a rainy day), a slow quiet tune that never repeats, and three small sounds: a chime when a gold light is
       counted at the Ministry, a bell when a card opens, a soft whoosh for a paper plane. Silent until Sound is tapped. */
    function townSound(ctx) {
      var i, c, rnd = Math.random, now = function () { return ctx.currentTime; };
      function gain(v, to) { var g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; }
      function filt(type, f, q, to) { var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (to) b.connect(to); return b; }
      function pan(p, to) { if (!ctx.createStereoPanner) return to; var n = ctx.createStereoPanner(); n.pan.value = p; n.connect(to); return n; }
      function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
      var VOL = 1.6, lim = ctx.createWaveShaper(), cv = new Float32Array(2049), post = gain(2, ctx.destination);
      for (i = 0; i < 2049; i++) { var x = (i - 1024) / 512, a = Math.abs(x); cv[i] = (a <= 0.7 ? x : (x < 0 ? -1 : 1) * (0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3))) / 2; } // a soft ceiling: untouched below 0.7, rounded off above
      lim.curve = cv; lim.connect(post);
      var master = gain(0, gain(0.5, lim));
      // the room: a soft echo, made from fading noise
      var len = Math.floor(ctx.sampleRate * 3), ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (c = 0; c < 2; c++) { var d = ir.getChannelData(c), y = 0; for (i = 0; i < len; i++) { y = y * 0.74 + (rnd() * 2 - 1) * 0.26; d[i] = y * Math.pow(1 - i / len, 2.8); } }
      var room = ctx.createConvolver(); room.buffer = ir; room.connect(gain(0.8, master));
      var air = gain(1, master), pad = gain(1, master), mel = gain(1, master), fx = gain(1, master);
      var padS = gain(0.3, room), melS = gain(0.5, room), fxS = gain(0.65, room); pad.connect(padS); mel.connect(melS); fx.connect(fxS);
      var padF = filt("lowpass", 1150, 0.5, pad);
      // a quiet repeat of the tune's notes, a beat and a half later
      var dl = ctx.createDelay(1.5), fb = gain(0.3), dlF = filt("lowpass", 1700, 0.5, fb); dl.delayTime.value = 0.69; mel.connect(dl); dl.connect(dlF); fb.connect(dl); fb.connect(gain(0.5, master)); fb.connect(melS);

      /* night air */
      var nb = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), nd = nb.getChannelData(0); for (i = 0; i < nd.length; i++) nd[i] = rnd() * 2 - 1;
      function noise(to) { var s = ctx.createBufferSource(); s.buffer = nb; s.loop = true; s.connect(to); s.start(0, rnd() * 3); return s; }
      function sway(f, depth, param) { var o = ctx.createOscillator(); o.frequency.value = f; o.connect(gain(depth, param)); o.start(); }
      var windG = gain(0.12, air), windF = filt("lowpass", 400, 0.7, windG); noise(windF); sway(0.07, 0.05, windG.gain); sway(0.043, 150, windF.frequency);
      var rainG = gain(0, air), rainM = gain(1, rainG), rainF = filt("lowpass", 6500, 0.4, rainM), rainH = filt("highpass", 1300, 0.5, rainF); noise(rainH); sway(0.11, 0.17, rainM.gain);
      var crG = gain(1, air), CR = [{ f: 4350, p: -0.55, g: 1, next: 0.6, left: 0 }, { f: 4820, p: 0.6, g: 0.7, next: 1.5, left: 0 }, { f: 3900, p: 0.15, g: 0.4, next: 2.4, left: 0 }];
      CR.forEach(function (k) { k.out = pan(k.p, crG); });
      function chirp(k, t) { // three short pulses
        var o = ctx.createOscillator(), g = gain(0, k.out); o.frequency.value = k.f * (1 + (rnd() - 0.5) * 0.012); o.connect(g);
        for (var j = 0; j < 3; j++) { var a = t + j * 0.034; g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(0.013 * k.g, a + 0.008); g.gain.linearRampToValueAtTime(0, a + 0.024); }
        o.start(t); o.stop(t + 0.13);
      }
      function crickets(until) {
        CR.forEach(function (k) {
          while (k.next < until) {
            if (k.left <= 0) { k.left = 4 + Math.floor(rnd() * 7); k.next += 2 + rnd() * 5; continue; } // a spell of chirps, then a pause
            chirp(k, k.next); k.left--; k.next += 0.62 + rnd() * 0.12;
          }
        });
      }

      /* the tune: four slow chords under a few soft notes of one five-note scale; the notes walk at random, so it never repeats */
      var STEP = 0.46, BAR = 16, PENT = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84];
      var CH = { F: [41, 57, 60, 64], Am: [45, 55, 60, 64], C: [48, 55, 60, 62], G: [43, 57, 62, 67], Em: [40, 55, 62, 64] }; // chord tones are notes of the same scale, so no note of the tune can clash
      var SEQ = ["F", "Am", "C", "G", "F", "Am", "C", "G", "Am", "F", "C", "Em"];
      var tNext = 0, stepN = 0, at = 5, rest = 6, phrase = 30;
      function hold(f, t, dur, peak, att, type, cents) { // one long soft voice of a chord
        var o = ctx.createOscillator(), g = gain(0, padF); o.type = type; o.frequency.value = f; o.detune.value = cents; o.connect(g);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + att); g.gain.setValueAtTime(peak, t + dur - 0.3); g.gain.setTargetAtTime(0, t + dur - 0.3, 1.1);
        o.start(t); o.stop(t + dur + 6);
      }
      function chord(ch, t, dur) {
        hold(hz(ch[0]), t, dur, 0.075, 1.4, "sine", 0); hold(hz(ch[0] + 12), t, dur, 0.026, 1.8, "sine", 0); // the low note, and a quiet one above it for small speakers
        for (var j = 1; j < ch.length; j++) { hold(hz(ch[j]), t + (j - 1) * 0.14, dur, 0.04, 2.4, "triangle", -3); hold(hz(ch[j]), t + (j - 1) * 0.14, dur, 0.011, 2.4, "sine", 5); } // each tone: a main voice and a quiet second one a hair apart, a slow shimmer
      }
      function pluck(f, t, vel, p) { // a soft plucked note, like a music box
        var o = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = gain(0.3), g = gain(0, pan(p, mel));
        o.frequency.value = f; o2.frequency.value = f * 2; o.connect(g); o2.connect(g2); g2.connect(g);
        g2.gain.setValueAtTime(0.3, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.14 * vel, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
        o.start(t); o2.start(t); o.stop(t + 2.5); o2.stop(t + 0.4);
      }
      function note(k, ch, t) {
        if (rest > 0) { rest--; return; }
        if (--phrase <= 0) { rest = 6 + Math.floor(rnd() * 9); phrase = 22 + Math.floor(rnd() * 20); return; } // a phrase, then a breath
        if (rnd() > (k % 4 === 0 ? 0.62 : k % 2 === 0 ? 0.34 : 0.1)) return;
        at = Math.max(0, Math.min(PENT.length - 1, at + [-2, -1, -1, 0, 1, 1, 2][Math.floor(rnd() * 7)]));
        if (at > 8 && rnd() < 0.5) at -= 2; if (at < 2 && rnd() < 0.5) at += 2;
        if (k === 0) for (var j = 0; j < 3; j++) { // on a chord's first beat: one of its own notes
          var up = Math.min(PENT.length - 1, at + j), dn = Math.max(0, at - j), has = function (m) { return ch.some(function (q) { return (q - m) % 12 === 0; }); };
          if (has(PENT[up])) { at = up; break; } if (has(PENT[dn])) { at = dn; break; }
        }
        pluck(hz(PENT[at]), t + rnd() * 0.015, k % 4 === 0 ? 1 : 0.6 + rnd() * 0.25, (rnd() - 0.5) * 0.7);
        if (k % 8 === 0 && rnd() < 0.3 && at + 2 < PENT.length) pluck(hz(PENT[at + 2]), t + 0.03, 0.45, (rnd() - 0.5) * 0.7);
      }
      function run(until) { // writes the sound ahead, up to this time
        var t = now();
        if (tNext < t + 0.05) { tNext = t + 0.2; stepN = Math.ceil(stepN / BAR) * BAR; CR.forEach(function (k) { if (k.next < t) k.next = t + 0.4 + rnd() * 2; }); } // after a pause: start again on a new chord
        for (; tNext < until; tNext += STEP, stepN++) {
          var k = stepN % BAR, ch = CH[SEQ[Math.floor(stepN / BAR) % SEQ.length]];
          if (k === 0) chord(ch, tNext, BAR * STEP);
          note(k, ch, tNext);
        }
        crickets(until);
      }

      /* the small sounds */
      function ring(f, t, peak, dur, parts, p) { // a small bell: a few pure tones that fade
        var g = gain(0, pan(p, fx)); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        parts.forEach(function (q) { var o = ctx.createOscillator(); o.frequency.value = f * q[0]; o.connect(gain(q[1], g)); o.start(t); o.stop(t + dur + 0.05); });
      }
      var lastC = -9, lastB = -9, lastW = -9;
      return {
        bus: { air: air, pad: pad, mel: mel, fx: fx }, run: run,
        on: function (b) { var t = now(); master.gain.cancelScheduledValues(t); master.gain.setTargetAtTime(b ? VOL : 0, t, b ? 0.5 : 0.1); },
        rain: function (b, t) { t = t || now(); rainG.gain.setTargetAtTime(b ? 0.07 : 0, t, 1.2); crG.gain.setTargetAtTime(b ? 0 : 1, t, 0.8); }, // rain instead of crickets
        chime: function (t) { t = t || now(); if (t - lastC < 3.5) return; lastC = t; ring(hz([76, 79, 81, 84, 88][Math.floor(rnd() * 5)]), t, 0.026, 1.2, [[1, 1], [2.76, 0.22]], (rnd() - 0.5) * 0.5); },
        bell: function (t) { t = t || now(); if (t - lastB < 0.25) return; lastB = t; ring(hz(88), t, 0.05, 1.5, [[1, 1], [2, 0.4], [3.01, 0.14]], 0); },
        whoosh: function (t, p) {
          t = t || now(); if (t - lastW < 6) return; lastW = t;
          var s = ctx.createBufferSource(), g = gain(0, pan(p || 0, fx)), f = filt("bandpass", 420, 2.2, g); s.buffer = nb; s.connect(f);
          f.frequency.setValueAtTime(420, t); f.frequency.exponentialRampToValueAtTime(1500, t + 0.4); f.frequency.exponentialRampToValueAtTime(600, t + 1.05);
          g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.13, t + 0.38); g.gain.linearRampToValueAtTime(0, t + 1.05);
          s.start(t, rnd() * 2.5); s.stop(t + 1.1);
        }
      };
    }
    /* the speaker button. Nothing is made and nothing plays before the first tap. */
    /* town radio (addition tr): eight songs; a next button beside the speaker while the sound is on, and the song's name for a
       few seconds. On a phone or a tablet (touch first) the page makes no sound of its own (there it broke up and was too
       loud): the speaker plays finished, very quiet music files through one plain <audio> element, the phone's own player.
       On a computer song 1 is the town's own sound, exactly as before; songs 2 to 8 are files, and while one plays the tune
       rests and the night air and the small sounds go on. A song ends, the next begins; after song 8 comes song 1. */
    var snd = (function () {
      var btn = $("snd-go"), AC = window.AudioContext || window.webkitAudioContext, ctx = null, eng = null, on = false, wet = null, offT = 0, none = function () {};
      var trNx = $("snd-nx"), trNt = $("snd-nt"), trAu = null, trN = 1, trFail = 0, trBlob = {}, trNtT = 0, trOffAt = 0, trLate = false, trUa = navigator.userAgent || "", trByHide = false;
      var trSongs = [["Town tune", ""], ["Town Theme RPG", "cynicmusic"], ["Calming RPG Town Theme", "Destin715"], ["RPG town", "KarateStudios"],
        ["Poor, But Happy", "HoliznaCC0"], ["Ease into Night", "HoliznaCC0"], ["Lights at Night", "Tsorthan Grove"], ["Lullabies For The End Of The World #1", "HoliznaCC0"]];
      var trPhone = !!((window.matchMedia && matchMedia("(pointer: coarse)").matches) || /Android|iPhone|iPad|iPod/.test(trUa) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)); // touch first: files only, never an AudioContext
      if (!btn || (!AC && !trPhone)) { if (btn) btn.hidden = true; return { chime: none, bell: none, whoosh: none }; }
      trAu = document.createElement("audio"); trAu.id = "snd-a"; trAu.preload = "none"; trAu.volume = trPhone ? 1 : 0.7; // nothing is loaded before a tap
      trAu.setAttribute("data-n", "1"); trAu.setAttribute("data-u", ""); document.body.appendChild(trAu);
      function call(m) { try { var q = ctx[m](); if (q && q.catch) q.catch(none); } catch (e) {} }
      function live() { return on && ctx && ctx.state === "running" && !document.hidden; }
      function show() {
        var b = !!(on && (trPhone ? !trHeld() : ctx && ctx.state === "running")); btn.setAttribute("aria-pressed", b ? "true" : "false");
        if (trNx) { trNx.hidden = !b; if (btn.parentNode && btn.parentNode.classList) btn.parentNode.classList.toggle("snd-two", b); } // the next button only while the sound is on
      }
      function tick() { // writes the next moments of sound, a little ahead of the clock
        if (!live()) return;
        var r = weather === "storm"; if (r !== wet) { wet = r; eng.rain(r); }
        eng.run(ctx.currentTime + 0.7);
      }
      function set(b) {
        if (b && !ctx && !trPhone) {
          try { ctx = new AC(); eng = townSound(ctx); } catch (e) { ctx = null; btn.hidden = true; return; }
          ctx.onstatechange = show; setInterval(tick, 120);
        }
        on = b; clearTimeout(offT);
        try { if (navigator.audioSession) navigator.audioSession.type = b ? "playback" : "auto"; } catch (e) {} // asked for by a tap: plays on a phone set to silent too
        if (b && ctx) { call("resume"); eng.on(true); }
        else if (ctx) { eng.on(false); offT = setTimeout(function () { if (!on) call("suspend"); }, 700); } // fades out, then stops working
        if (trFileNow()) { if (!b) trAu.pause(); else if (trAu.error || !trAu.getAttribute("src")) trLoad(); else trPlay(); } // a song from a file goes on from the same place
        if (b) trSay(); else trOffAt = Date.now();
        trUI(); show();
      }
      function trFileNow() { return trPhone || trN > 1; } // the song now is a file (on a computer song 1 is the town's own sound)
      function trHeld() { return trAu.paused && !trAu.ended && !trAu.error && !document.hidden && !!trAu.getAttribute("src"); } // the phone stopped it (a call, another app)
      function trPlay() { // refused (no tap): the button says off and the next tap tries again; a file that does not load: see "error"
        if (document.hidden) return;
        var q; try { q = trAu.play(); } catch (e) { q = null; }
        if (q && q.catch) q.catch(function (e) { if (on && trFileNow() && e && e.name !== "AbortError" && e.name !== "NotSupportedError") set(false); });
      }
      function trLoad() { // the song now, from its start; a file this visit already had to fetch plays from memory
        var u = (trPhone ? "s" : "p") + trN + ".mp3"; trAu.setAttribute("data-n", trN); trAu.setAttribute("data-u", u); trAu.src = trBlob[u] || u; trPlay();
      }
      function trStop() { trAu.setAttribute("data-n", "1"); trAu.setAttribute("data-u", ""); trAu.pause(); trAu.removeAttribute("src"); try { trAu.load(); } catch (e) {} }
      function trTune(v) { // the tune rests while a file plays (and comes back after); the air and the small sounds go on
        if (!eng) return; var t = ctx.currentTime;
        [eng.bus.mel, eng.bus.pad].forEach(function (g) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(v, t, 0.4); });
      }
      function trSay() { // "(note sign) title - artist", small, for about four seconds
        if (!trNt) return; var s = trSongs[trN - 1];
        trNt.textContent = "\u266a " + s[0] + (s[1] ? " \u00b7 " + s[1] : ""); trNt.classList.add("on");
        clearTimeout(trNtT); trNtT = setTimeout(function () { trNt.classList.remove("on"); }, 4000);
      }
      function trUI() { if (!on && trNt) { clearTimeout(trNtT); trNt.classList.remove("on"); } } // sound off: the song's name goes too
      function trGo(n, late) { // to song n (1..8), from its start; late: its name shows once it plays (a song skipped over says nothing)
        trN = n; trLate = !!late && trFileNow(); if (!trLate) trSay();
        if (trFileNow()) { trTune(0); trLoad(); } else { trFail = 0; trStop(); trTune(1); }
      }
      function trSkip() { // this song cannot be played here: the next one; after eight in a row the sound goes off, quietly
        if (++trFail >= 8) { trFail = 0; trN = 1; trStop(); set(false); return; } // back to the start: song 1, nothing loaded
        trGo(trN % 8 + 1, true);
      }
      trAu.addEventListener("error", function () { // the plain way did not work here: fetch the file, then play it from memory; failing that, the next song
        var u = trAu.getAttribute("data-u"); if (!on || !u || !trFileNow()) return;
        if (trBlob[u] || !window.fetch || !window.URL || !URL.createObjectURL) { trSkip(); return; }
        fetch(u).then(function (r) { if (!r.ok) throw 0; return r.blob(); }).then(function (b) {
          trBlob[u] = URL.createObjectURL(b); if (on && trAu.getAttribute("data-u") === u) { trAu.src = trBlob[u]; trPlay(); }
        }).catch(function () { if (on && trAu.getAttribute("data-u") === u) trSkip(); });
      });
      trAu.addEventListener("ended", function () { if (on && trFileNow()) trGo(trN % 8 + 1); });
      trAu.addEventListener("playing", function () { trFail = 0; if (trLate && on) { trLate = false; trSay(); } show(); });
      trAu.addEventListener("pause", show);
      trAu.addEventListener("play", function () { trByHide = false; if (!on && trFileNow() && Date.now() - trOffAt > 1000) set(true); else show(); }); // started from outside (the lock screen): the button says so
      if (trNx) trNx.addEventListener("click", function () { if (on) trGo(trN % 8 + 1); });
      btn.addEventListener("click", function () {
        if (trPhone) { if (on && trHeld()) trPlay(); else set(!on); return; } // stopped by the phone (a call, another app): one tap brings it back
        if (on && ctx.state !== "running") { call("resume"); return; } set(!on);
      });
      document.addEventListener("visibilitychange", function () { if (ctx && on) call(document.hidden ? "suspend" : "resume"); });
      document.addEventListener("visibilitychange", function () { // the music stops while the page is put away; it comes back only if the page itself stopped it
        if (document.hidden) { trByHide = !!(on && trFileNow() && !trAu.paused); if (trByHide) trAu.pause(); return; }
        if (trByHide && on && trFileNow()) trPlay(); trByHide = false; if (on) show();
      });
      function ev(name, lo, hi) { // a small sound, never more often than every lo..hi seconds
        var next = 0;
        return function () { var n = Date.now(); if (!live() || n < next) return; next = n + (lo + Math.random() * (hi - lo)) * 1000; eng[name](0, Math.random() * 0.8 - 0.4); };
      }
      if (trPhone) return { chime: none, bell: none, whoosh: none }; // a phone: no sound made by the page
      return { chime: ev("chime", 3.6, 8), bell: ev("bell", 0.3, 0.3), whoosh: ev("whoosh", 13, 24) };
    })();

    function makeCitizen(shirt) {
      var g = new THREE.Group(), legs = [], red = toon(shirt), ink = toon(0x17110e), skin = toon(0xd9a07a), cream = toon(0xf7eed9);
      function box(w, h, d, mat, x, y, z) { var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); m.userData.pick = "citizen"; return m; }
      [-0.13, 0.13].forEach(function (x) { var l = box(0.16, 0.4, 0.16, ink, x, 0.4, 0); l.geometry.translate(0, -0.2, 0); legs.push(l); });
      box(0.46, 0.46, 0.28, red, 0, 0.63, 0); box(0.36, 0.36, 0.36, skin, 0, 1.04, 0); box(0.4, 0.14, 0.4, ink, 0, 1.27, 0);
      box(0.07, 0.07, 0.02, ink, -0.08, 1.06, 0.18); box(0.07, 0.07, 0.02, ink, 0.08, 1.06, 0.18); box(0.32, 0.2, 0.22, cream, 0, 0.66, 0.2);
      g.scale.setScalar(0.42); scene.add(g); return { g: g, legs: legs };
    }
    var shirts = [0xc8291e, 0x2f7f86, 0xd9a441, 0x8f5cff, 0x4e9a50, 0xefe5cf, 0xc8291e, 0x3a3a42];
    function makePunk() { // the 6529 punk out for a walk: hoodie and nerd glasses (on many CC0 Meme Cards, its owner's to share)
      var g = new THREE.Group(), legs = [], hood = toon(0x6b6b75), hood2 = toon(0x55555f), ink = toon(0x17110e), skin = toon(0xd9a07a), jeans = toon(0x23324a), lens = toon(0xefeff1);
      function box(w, h, d, mat, x, y, z) { var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); m.userData.pick = "citizen"; m.userData.who = "punk"; return m; }
      [-0.13, 0.13].forEach(function (x) { var l = box(0.16, 0.4, 0.16, jeans, x, 0.4, 0); l.geometry.translate(0, -0.2, 0); legs.push(l); });
      box(0.48, 0.48, 0.3, hood, 0, 0.63, 0); box(0.22, 0.12, 0.02, hood2, 0, 0.58, 0.16);
      box(0.46, 0.46, 0.42, hood, 0, 1.06, -0.02); box(0.32, 0.32, 0.04, skin, 0, 1.03, 0.2);
      [-0.08, 0.08].forEach(function (x) { box(0.12, 0.09, 0.03, ink, x, 1.07, 0.225); box(0.07, 0.05, 0.02, lens, x, 1.07, 0.24); });
      box(0.06, 0.025, 0.03, ink, 0, 1.08, 0.225);
      g.scale.setScalar(0.44); scene.add(g); return { g: g, legs: legs };
    }
    function makeHopper() { // a frog of the town's own, hopping along the streets
      var f = frog.clone(true); f.position.set(0, 0, 0); f.rotation.set(0, 0, 0); f.scale.setScalar(0.5);
      f.traverse(function (m) { if (m.isMesh) { m.userData.pick = "citizen"; m.userData.who = "frog"; } }); scene.add(f); return { g: f, legs: [], hop: true };
    }
    var people = shirts.slice(0, reduce ? 2 : 8).map(function (c, i) { var p = makeCitizen(c); p.axis = i % 2; p.line = [-9, -6, -3, 3, 6, 9][Math.floor(h2(i, 61) * 6)] /* not the middle street: it crosses the Ministry and the pond */; p.ph = h2(i, 71) * 10; p.sp = 0.5 + h2(i, 81) * 0.5; return p; });
    people.push(Object.assign(makePunk(), { axis: 0, line: 6, ph: 3.3, sp: 0.55 }), Object.assign(makeHopper(), { axis: 1, line: -3, ph: 7.1, sp: 0.42 }));
    people.forEach(function (p) { // nobody walks through the wood: lo and hi are where the street of this walker enters it
      var wood = function (q) { var a = Math.floor(q / 3), b = p.line / 3; return !(p.axis ? zoneOf(b - 1, a) || zoneOf(b, a) : zoneOf(a, b - 1) || zoneOf(a, b)); };
      p.lo = -99; p.hi = 99;
      for (var q = 1.5; q < 60; q += 3) { if (p.hi > 90 && wood(q)) p.hi = q - 1.5; if (p.lo < -90 && wood(-q)) p.lo = 1.5 - q; }
    });
    var FW = 160, fwGeo = new THREE.BufferGeometry(), fwP = new Float32Array(FW * 3), fwC = new Float32Array(FW * 3), fwV = new Float32Array(FW * 3), fwLife = new Float32Array(FW);
    fwGeo.setAttribute("position", new THREE.BufferAttribute(fwP, 3)); fwGeo.setAttribute("color", new THREE.BufferAttribute(fwC, 3));
    var dotTex = (function () { var c = document.createElement("canvas"); c.width = c.height = 64; var x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.28, "rgba(255,255,255,.9)"); g.addColorStop(0.55, "rgba(255,255,255,.2)"); g.addColorStop(1, "rgba(255,255,255,0)"); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    var fwMat = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    var fw = new THREE.Points(fwGeo, fwMat); fw.frustumCulled = false; scene.add(fw);
    var FWC = [new THREE.Color("#ff3b2a"), new THREE.Color("#ffcf6b"), new THREE.Color("#efe5cf"), new THREE.Color("#00e0f0")];
    function burst(bx, bz) {
      if (reduce) return; var cx = bx != null ? bx : (Math.random() - 0.5) * 3, cz = bz != null ? bz : (Math.random() - 0.5) * 3, cy = bx != null ? 5.2 : 6.5 + Math.random() * 1.5, col = FWC[Math.floor(Math.random() * FWC.length)];
      for (var i = 0; i < FW; i++) {
        var u = Math.random() * 2 - 1, a = Math.random() * 6.283, r = Math.sqrt(1 - u * u), sp = 2.2 + Math.random() * 1.2;
        fwP[i * 3] = cx; fwP[i * 3 + 1] = cy; fwP[i * 3 + 2] = cz; fwV[i * 3] = r * Math.cos(a) * sp; fwV[i * 3 + 1] = u * sp + 0.6; fwV[i * 3 + 2] = r * Math.sin(a) * sp;
        fwLife[i] = 1.4 + Math.random() * 0.5; fwC[i * 3] = col.r; fwC[i * 3 + 1] = col.g; fwC[i * 3 + 2] = col.b;
      }
    }

    /* camera: an isometric look at the town that you can turn, tilt and zoom */
    var st = { az: Math.PI / 4 + 0.15, el: 0.62, half: 12, halfT: 12, tx: 0, tz: 0, auto: !reduce, drag: null, idle: 0 }, fitHalf = 12, tween = null;
    var cap = null; // set while a postcard is being drawn: the picture's own size instead of the stage's
    function aspect() { return cap ? cap.w / cap.h : stage.clientWidth / Math.max(1, stage.clientHeight); }
    var camOff = 0, camOffX = 0, stOff = 0, flyN = 0;
    function placeCam() {
      var d = 120, asp = aspect();
      cam.position.set(st.tx + d * Math.sin(st.az) * Math.cos(st.el), d * Math.sin(st.el), st.tz + d * Math.cos(st.az) * Math.cos(st.el));
      cam.lookAt(st.tx, 0, st.tz);
      var hh = st.half, hw = hh * asp; if (asp < 1) { hw = hh; hh = hh / asp; }
      var offT = tour ? (asp < 1 ? -0.12 : -0.09) : 0, offXT = 0;
      camOff += (offT - camOff) * 0.06; camOffX += (offXT - camOffX) * 0.06; if (!cap) { var zz = st.half / (fitHalf || 1e9), wz = Math.min(1, Math.max(0, (zz - 0.45) / 0.35)) * Math.min(1, Math.max(0, (1.5 - zz) / 0.5)); stOff += ((asp >= 1 && !tour ? 0.25 * (stageFar || 0) * wz : 0) - stOff) * 0.06; }
      var off = hh * (camOff + (cap ? 0 : stOff)), offX = hw * camOffX;
      cam.left = -hw - offX; cam.right = hw - offX; cam.top = hh + off; cam.bottom = -hh + off; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    }
    function radiusOf(list) { var r = 4; list.forEach(function (L) { r = Math.max(r, Math.hypot(L.x, L.z)); }); return r; }
    function flyTo(tx, tz, half, el, az, dur) {
      flyN++;
      var da = az == null ? 0 : Math.atan2(Math.sin(az - st.az), Math.cos(az - st.az));
      tween = { t0: performance.now(), x0: st.tx, z0: st.tz, h0: st.halfT, e0: st.el, a0: st.az, da: da, tx: tx, tz: tz, h: half, e: el == null ? st.el : el, dur: reduce ? 1 : (dur || 1400) };
    }
    var ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), gpt = new THREE.Vector3();
    function groundAt(cx, cy) { var r = canvas.getBoundingClientRect(); ndc.set((cx - r.left) / r.width * 2 - 1, -(cy - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, cam); return ray.ray.intersectPlane(groundPlane, gpt) ? gpt.clone() : null; }
    var pointers = {}, pinch = null;
    canvas.addEventListener("pointerdown", function (e) {
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY }; tween = null; st.auto = false;
      var ids = Object.keys(pointers);
      if (ids.length === 2) { var a = pointers[ids[0]], b = pointers[ids[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), half: st.halfT, mid: groundAt((a.x + b.x) / 2, (a.y + b.y) / 2) }; st.drag = null; return; }
      st.drag = { x: e.clientX, y: e.clientY, az: st.az, el: st.el, tx: st.tx, tz: st.tz, moved: 0, pan: e.button === 2 || e.shiftKey, g: groundAt(e.clientX, e.clientY) };
    });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    canvas.addEventListener("pointermove", function (e) {
      if (!(e.pointerId in pointers)) return; pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (pinch && ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y);
        st.halfT = st.half = Math.max(3, Math.min(fitHalf * 1.6, pinch.half * pinch.d / d)); placeCam();
        var m = groundAt((a.x + b.x) / 2, (a.y + b.y) / 2); if (m && pinch.mid) { st.tx += pinch.mid.x - m.x; st.tz += pinch.mid.z - m.z; }
        return;
      }
      if (!st.drag) return;
      var dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y; st.drag.moved = Math.max(st.drag.moved, Math.abs(dx) + Math.abs(dy));
      if (st.drag.moved > 6) { try { canvas.setPointerCapture(e.pointerId); } catch (x) {} stage.classList.add("drag"); $("t-hint").style.opacity = 0; }
      if (st.drag.pan) { placeCam(); var g = groundAt(e.clientX, e.clientY); if (g && st.drag.g) { st.tx += st.drag.g.x - g.x; st.tz += st.drag.g.z - g.z; } }
      else { st.az = st.drag.az - dx * 0.008; st.el = Math.max(0.32, Math.min(1.3, st.drag.el + dy * 0.005)); }
    });
    function up(e) {
      var tap = st.drag && st.drag.moved <= 6 && Object.keys(pointers).length === 1; delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      if (tap && e.type === "pointerup") pick(e);
      if (!Object.keys(pointers).length) { st.drag = null; stage.classList.remove("drag"); st.idle = performance.now(); }
    }
    canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault(); tween = null; st.auto = false; st.idle = performance.now();
      var before = groundAt(e.clientX, e.clientY);
      st.halfT = st.half = Math.max(3, Math.min(fitHalf * 1.6, st.halfT * Math.exp(e.deltaY * 0.0012))); placeCam();
      var after = groundAt(e.clientX, e.clientY); if (before && after) { st.tx += before.x - after.x; st.tz += before.z - after.z; }
    }, { passive: false });

    /* taps */
    var pickList = function () { return HPICK.concat([M.tbody, balM, ministry, meter, factory, museum, pond, crane, site.frame, site.slab, ferry], stageG.userData.on ? [stageG] : []).concat(flags.map(function (f) { return f.g; })).concat(towers.map(function (t) { return t.g; }), people.map(function (p) { return p.g; }), life.pick, news.pick()); };
    var gsPickBase = pickList; pickList = function () { return gsPickBase().concat(gsG.visible ? [gsG] : []); }; // the gas station can be tapped too
    var ccPickBase = pickList; pickList = function () { return ccPickBase().concat([ccShop]); }; // cc: the shop can be tapped too
    function hitAt(cx, cy) {
      var r = canvas.getBoundingClientRect(); ndc.set((cx - r.left) / r.width * 2 - 1, -(cy - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, cam);
      var hits = ray.intersectObjects(pickList(), true); if (!hits.length) return null;
      var hit = hits[0], o = hit.object, res = { o: o, kind: o.userData.pick, house: null };
      if (o.userData.slot) {
        var want = o.userData.slot; res.kind = "house";
        res.house = want === "b" ? balList[hit.instanceId] || null : shown.filter(function (s) { return SLOT[s.idx] && SLOT[s.idx][0] === want && SLOT[s.idx][1] === hit.instanceId; })[0] || null;
        if (!res.house) return null;
      }
      return res;
    }
    function pick(e) {
      var r = canvas.getBoundingClientRect(), hr = hitAt(e.clientX, e.clientY), d = DAYS[current], title = "", text = "", img = null;
      if (!hr) { closeCard(); selectRing(null); return; }
      var o = hr.o, kind = hr.kind;
      if (kind === "house") {
        var h = hr.house; selectRing(h); hopAt[h.idx] = performance.now(); anim = true;
        var lit = litNow[h.idx], gsize = HOUSES.filter(function (q) { return q.g === h.g && standing(q, current); }).length; // the wallet's houses standing on this day
        if (h.day > current) { title = "A house on the old chain"; text = d.label + " ran on the network's old chain, which kept only the day's totals: " + nOf(d.signed_accounts, "account") + " signed. This house stands in for one of them; house records start on " + DAYS[FIRSTNEW].label + "."; }
        else {
        title = (h.dc ? "Data center" : "House") + " no. " + (h.idx + 1);
        text = (h.c === "not_reported" ? "Its place isn't shown, so the curtains are drawn. " : "In " + CLAB[h.c] + ". ") +
          (balOn && fresh[h.idx] ? "Moved in on " + d.label + ": the welcome flag is up for its first day." : "Here since " + DAYS[h.day].label + (h.day === FIRSTNEW && FIRSTNEW > 0 ? ", when house records start." : h.day === 0 ? ", day one: Old Town." : ".")) + " " +
          (lit ? (signedNow[h.idx] ? "Signed on " + d.label + " ✓." : notSigned(d)) : "Empty house: not taking part on " + d.label + ".") +
          (gsize > 1 ? " One of " + gsize + " houses of the same wallet." : "");
        }
      } else if (kind === "ferry") { var nf = nextNew(d); title = "The ferry"; text = nf == null ? "Arrivals for the day after " + d.label + " were not recorded." : nf ? "All aboard! " + (current === DAYS.length - 1 ? nOf(nf, "more validator") + (nf === 1 ? " has" : " have") + " registered for the day after " + d.label + "." : nOf(nf, "new validator") + " moved in the day after " + d.label + ".") : current === DAYS.length - 1 ? "Empty deck tonight: nobody new has registered for the day after " + d.label + " yet." : "Empty deck: nobody new moved in the day after " + d.label + "."; }
      else if (kind === "ministry") { burst(0, 0); setTimeout(function () { burst(); }, 300); title = "Ministry of Validation"; text = d.label + (d.name ? ": “" + d.name + "”. " : ". ") + (unkSay(d) || fmt(d.signed_accounts) + " of " + fmt(d.accounts) + " accounts signed the same result" + (d.signed_pct != null ? ", holding " + d.signed_pct + "% of the counted TDH." : ".")) + (sinceOpen(d.two_thirds_utc) ? " Two thirds reached " + sinceOpen(d.two_thirds_utc) + " after the day opened" + vfSay(d, true) : vfSay(d, false)) + (d.final ? " Final." : " Final at " + localClock("19:30", d.date) + ".") + (reduce ? "" : " The gold lights on the streets are signatures on their way here."); }
      else if (kind === "site") { var n = nextNew(d); title = "Building site"; text = n == null ? "Arrivals for the day after " + d.label + " were not recorded." : n ? "Hard hats on! " + (current === DAYS.length - 1 ? nOf(n, "more validator") + (n === 1 ? " has" : " have") + " registered for the day after " + d.label + "." : nOf(n, "new house") + " went up the day after " + d.label + ".") : current === DAYS.length - 1 ? "Tools down for now: nobody new has registered for the next day yet." : "Tools down: nobody new moved in the day after " + d.label + "."; }
      else if (kind === "factory") { var fcd = CARDS.filter(function (q) { return String(q.id) === "52"; })[0]; title = "Meme Factory"; text = "Seize the memes of production! The town's oldest slogan, from the first Meme Cards. The belt runs all night" + (fcd ? ", and the factory even has its own card: #" + fcd.id + " " + fcd.name + " by " + fcd.artist + "." : ": there is always one more meme to make."); img = fcd ? fcd.src : null; }
      else if (kind === "gas") { title = "Gas station"; text = "Closed. No gas on this network yet."; }
      else if (kind === "shop") { title = "Cheese & chocolate"; text = "Open late."; } // cc
      else if (kind === "museum") { var wk = o.userData.work != null ? hang[o.userData.work] : hang[0]; title = "Meme Museum"; text = workText(wk); img = CARDS[wk].src; }
      else if (kind === "meter") { title = "Agreement meter"; text = (d.signed_pct != null ? d.signed_pct + "% of the counted TDH signed on " + d.label + "." : "Not recorded.") + " The red ring is the two thirds a day needs to be agreed" + (sinceOpen(d.two_thirds_utc) ? "; it was passed " + sinceOpen(d.two_thirds_utc) + " after the day opened." : "."); }
      else if (kind === "flag") { var cc = o.userData.country; title = cc[0]; text = cc[1] + (cc[1] === 1 ? " validator names" : " validators name") + " this country. Most validators name only a continent, or nothing. The country flags fly on the town square, not on anyone's house."; }
      else if (kind === "frog") { title = "The pond frog"; text = "\u201cRibbit. GM.\u201d Lives in the pond on the town square, in front of the Ministry, and says GM to every new house. Best job in town."; }
      else if (kind === "citizen" && o.userData.who === "punk") { title = "punk6529"; text = "The punk the town is named after, out for a walk. Say GM! You'll spot this face on many Meme Cards."; }
      else if (kind === "citizen" && o.userData.who === "frog") { title = "A frog out for a hop"; text = "Hop, hop, hop: late for the pond again. Frogs hop through a lot of Meme Cards; this one is the town's own."; }
      else if (kind === "citizen" && o.userData.who === "bus") { title = "The night bus"; text = "Line 6529: round the town all night, one stop at the town square. No ticket needed, just say GM to the driver."; }
      else if (kind === "citizen") { title = "A citizen"; text = SAYS[sayN++ % SAYS.length] + " " + (d.old_chain ? "Citizens are the accounts that run the validators: " + nOf(d.signed_accounts, "account") + " signed on " + d.label + "." :
        "Citizens are the accounts behind the houses: " + nOf(d.accounts, "account") + " look after " + nOf(d.validators, "validator") + " on " + d.label + "."); }
      else if (kind === "relay") { title = "Relay · " + o.userData.relay; var vs = d.versions || []; text = "One of 6529's relays: radio towers that pass messages between validators that can't reach each other directly. The towers stand for the relays 6529 has named; rc.13 added more in other parts of the world."; }
      else if (kind === "news") { var nw = news.card(d); title = nw[0]; text = nw[1]; }
      else if (kind === "board") { title = o.userData.info.t; text = o.userData.info.p; img = o.userData.info.img || null; }
      else if (kind === "gate") { title = "Welcome to 6529 Town"; text = d.old_chain ? d.label + " ran on the old chain: " + nOf(d.signed_accounts, "account") + " signed." : "Population " + nOf(d.validators, "validator") + " from " + nOf(d.accounts, "account") + " on " + d.label + "." + (d.next_validators != null ? " " + fmt(d.next_validators) + " registered for the next day" + (d.final ? "." : " so far.") : ""); }
      else if (kind === "stage") { var sIt = STAGE.items[o.userData.stage] || STAGE.items[0]; title = "#" + sIt.rank + " \u00b7 " + sIt.title; img = sIt.img;
        text = "By " + sIt.artist + ". " + (sIt.rank === 1 ? "In the lead" : "No. " + sIt.rank) + " on The Memes Main Stage " + (stageOld() ? "at the last check: " : "right now: ") + stageNum(sIt.proj) + " TDH projected from " + nOf(sIt.voters, "voter") + ". Checked " + new Date(STAGE.asof).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + "."; }
      else { closeCard(); return; }
      var art = kind === "museum", stg = kind === "stage", bodyEl = $("t-card-body"); bodyEl.innerHTML = (img && !art && !stg ? "<img alt=''>" : "") + "<h3></h3><p></p>" + (art ? "<img class='art' alt=''><button type='button' class='next'>Next work \u2192</button>" : stg ? "<img class='art stg' alt=''><a class='next' target='_blank' rel='noopener'>Open on 6529.io \u2192</a>" : kind === "site" ? "<a class='next' target='_blank' rel='noopener' href='https://6529.io/validator'>Want a house? Run a validator \u2192</a>" : "");
      if (img) bodyEl.querySelector("img").src = img;
      bodyEl.querySelector("h3").textContent = title; bodyEl.querySelector("p").textContent = text;
      if (art) workNext(bodyEl, wk);
      if (stg) { var sa = bodyEl.querySelector("a.next"); if (/^https:\/\/6529\.io\/waves\/[0-9a-f-]{36}\?drop=[0-9a-f-]{36}$/.test(sIt.url)) sa.href = sIt.url; else sa.remove(); }
      if (kind === "house" && hr.house.day <= current && mine && mine.idx === hr.house.idx) mineRow(bodyEl, hr.house); // only your own house has the row: a random house cannot be made "mine"
      if (kind !== "house") selectRing(null); hideTip();
      var card = $("t-card"), W = stage.clientWidth, H = stage.clientHeight, cw = Math.min(290, W * 0.82), mx = e.clientX - r.left, my = e.clientY - r.top;
      card.style.left = Math.max(8, Math.min(W - cw - 8, mx - cw / 2)) + "px"; card.style.top = Math.max(8, Math.min(H - Math.max(190, card.offsetHeight + 10), my + 18)) + "px";
      card.classList.add("on"); snd.bell(); st.auto = false;
    }
    var foundGroup = null;
    function closeCard() { $("t-card").classList.remove("on"); if (foundGroup != null) { foundGroup = null; if (filter && filter.group != null) { filter = null; colourHouses(performance.now()); } } }

    /* find your house by wallet: the page holds only salted fingerprints, and the address never leaves this browser */
    var SHA_K = (function () { var k = [], n = 2; while (k.length < 64) { var p = true; for (var f = 2; f * f <= n; f++) if (n % f === 0) { p = false; break; } if (p) k.push((Math.pow(n, 1 / 3) % 1) * 4294967296 | 0); n++; } return k; })();
    function sha256(msg) { // fallback when crypto.subtle is missing; msg: Uint8Array -> Uint8Array(32)
      var P = [2, 3, 5, 7, 11, 13, 17, 19], H = P.map(function (p) { return (Math.sqrt(p) % 1) * 4294967296 | 0; }), l = msg.length, words = [], i, j;
      for (i = 0; i < l; i++) words[i >> 2] |= msg[i] << ((3 - i % 4) * 8);
      words[l >> 2] |= 0x80 << ((3 - l % 4) * 8);
      var nw = ((l + 8) >> 6) * 16 + 16; for (i = 0; i < nw; i++) words[i] = words[i] | 0;
      words[nw - 1] = l * 8; words[nw - 2] = Math.floor(l * 8 / 4294967296);
      var w = new Array(64);
      for (j = 0; j < nw; j += 16) {
        var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f2 = H[5], g = H[6], h = H[7];
        for (i = 0; i < 64; i++) {
          if (i < 16) w[i] = words[j + i] | 0;
          else { var x = w[i - 15], y = w[i - 2];
            w[i] = (w[i - 16] + (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0; }
          var t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f2) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
          var t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
          h = g; g = f2; f2 = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f2) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
      }
      var out = new Uint8Array(32); for (i = 0; i < 8; i++) for (j = 0; j < 4; j++) out[i * 4 + j] = (H[i] >>> (24 - j * 8)) & 255; return out;
    }
    function hexOf(b) { var t = ""; for (var i = 0; i < b.length; i++) t += (b[i] < 16 ? "0" : "") + b[i].toString(16); return t; }
    function digest(str) {
      var bytes = new Uint8Array(str.length); for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 255;
      try { if (window.crypto && crypto.subtle && crypto.subtle.digest) return crypto.subtle.digest("SHA-256", bytes).then(function (ab) { return new Uint8Array(ab); }, function () { return sha256(bytes); }); } catch (e) {}
      return Promise.resolve(sha256(bytes));
    }
    function findMsg(t, bad) { var m = $("t-find-msg"); m.textContent = t; m.className = "find-msg" + (bad ? " bad" : ""); }
    function findWallet(raw) {
      var addr = (raw || "").trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) { findMsg("That isn't a wallet address: it starts with 0x and has 40 letters and numbers after it. ENS names don't work here.", true); return; }
      if (!HOMES) { findMsg("Houses aren't linked to wallets on this page yet.", true); return; }
      findMsg("Looking…");
      Promise.all([digest("6529town:" + addr), digest("6529town-tdh:" + addr)]).then(function (r) {
        var fp = hexOf(r[0]).slice(0, 16), g = -1;
        HOMES.groups.forEach(function (gr, k) { if (gr[0] === fp) g = k; });
        if (g < 0) { findMsg("No validator found for this wallet. Use the wallet that signed your validator's authorization; a validator shows up from its first day in the network.", true); return; }
        var lock = HOMES.groups[g][1], key = hexOf(r[1]).slice(0, 12), tdhV = null;
        if (lock) tdhV = (parseInt(lock.slice(0, 6), 16) ^ parseInt(key.slice(0, 6), 16)) * 16777216 + (parseInt(lock.slice(6), 16) ^ parseInt(key.slice(6), 16));
        findMsg("Your address stays in your browser.");
        if (DAYS[current].old_chain && typeof setDay === "function") { stopPlay(); setDay(DAYS.length - 1); }
        showFound(g, addr, tdhV);
      });
    }
    function showFound(g, addr, tdhV) {
      var d = DAYS[current], all = HOUSES.filter(function (h) { return h.g === g; }), here = all.filter(function (h) { return h.day <= current && h.x != null; });
      $("t-find").hidden = true; if (tour) stopTour(true);
      if (chipFilter) { chipFilter = null; renderLegendChips(current); } keyActive = null; if (typeof clearKeyUI === "function") clearKeyUI();
      closeCard(); st.auto = false; hideTip();
      var short = addr.slice(0, 6) + "…" + addr.slice(-4), first = Math.min.apply(null, all.map(function (h) { return h.day; }));
      var bodyEl = $("t-card-body"); bodyEl.innerHTML = "<h3></h3><p></p>";
      bodyEl.querySelector("h3").textContent = here.length > 1 ? "Your " + here.length + " houses" : "Your validator's house";
      if (!here.length) {
        bodyEl.querySelector("p").textContent = short + " moves in on " + DAYS[first].label + ". Pick a later day to see the house.";
      } else {
        filter = { group: g }; foundGroup = g; colourHouses(performance.now());
        var cx = 0, cz = 0; here.forEach(function (h) { cx += h.x; cz += h.z; }); cx /= here.length; cz /= here.length;
        var spread = 0; here.forEach(function (h) { spread = Math.max(spread, Math.hypot(h.x - cx, h.z - cz)); }); // how far from their middle the houses stand
        var fx = spread > 3 ? here[0].x : cx, fz = spread > 3 ? here[0].z : cz; // far apart: the fireworks go up over the first house, not over the wood between two
        flyTo(cx, cz, Math.max(4.4, spread * 0.8 + 2.4), 0.55); here.forEach(function (h) { hopAt[h.idx] = performance.now() + 1500; }); anim = true;
        setTimeout(function () { burst(fx, fz); }, 1400);
        var sg = here.filter(function (h) { return signedNow[h.idx]; }).length, lit = here.filter(function (h) { return litNow[h.idx]; }).length;
        var places = []; here.forEach(function (h) { var p = h.c === "not_reported" ? "place not shown" : CLAB[h.c]; if (places.indexOf(p) < 0) places.push(p); });
        bodyEl.querySelector("p").textContent = short + " · " + places.join(", ") + " · here since " + DAYS[first].label + (first === FIRSTNEW && FIRSTNEW > 0 ? ", when house records start" : "") + ". " +
          (sg ? (lit > 1 ? sg + " of " + lit + " signed on " : "Signed on ") + d.label + " ✓." : lit ? notSigned(d) : "Not taking part on " + d.label + ".") + (lit && here.length > lit ? " " + nOf(here.length - lit, "house") + " empty." : "") +
          (tdhV != null ? " TDH " + tdh(tdhV) + "." : "") + (here.length > 1 ? " House numbers " + here.map(function (h) { return h.idx + 1; }).join(", ") + "." : " House no. " + (here[0].idx + 1) + ".");
        mineRow(bodyEl, here[0]); var inp = $("t-mine-input"); if (inp && !inp.value) inp.value = short;
      }
      var card = $("t-card"), W = stage.clientWidth, H = stage.clientHeight, cw = Math.min(290, W * 0.82);
      card.style.left = ((W - cw) / 2) + "px"; card.style.top = Math.max(8, H * 0.56) + "px"; card.classList.add("on"); snd.bell();
    }
    $("t-find-go").addEventListener("click", function () { var f = $("t-find"); f.hidden = !f.hidden; if (!f.hidden) { if (tour) stopTour(true); setTimeout(function () { $("t-find-in").focus(); }, 30); } });
    $("t-find-x").addEventListener("click", function () { $("t-find").hidden = true; });
    $("t-find-btn").addEventListener("click", function () { findWallet($("t-find-in").value); });
    $("t-find-in").addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") findWallet($("t-find-in").value); });
    ["pointerdown", "pointerup"].forEach(function (ev) { $("t-find").addEventListener(ev, function (e) { e.stopPropagation(); }); });
    /* a gold ring marks the house you point at or tapped */
    var ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.78, 32), basic(0xffcf6b, { transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false; ring.renderOrder = 5; scene.add(ring);
    var selected = null, hovered = null;
    function placeRing() { var h = hovered || selected; ring.visible = !!h; if (h) ring.position.set(h.x, 0.03, h.z); }
    function selectRing(h) { selected = h; placeRing(); }

    /* my house: the house found with your wallet can be kept and named; kept only in this browser */
    var MINE_KEY = "town6529-myhouse", mine = null;
    try { mine = JSON.parse(localStorage.getItem(MINE_KEY) || "null"); } catch (e) { mine = null; }
    if (mine && !(mine.idx >= 0 && mine.idx < HOUSES.length && typeof mine.name === "string")) mine = null;
    var star = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, map: (function () {
      var c = document.createElement("canvas"); c.width = c.height = 128; var x = c.getContext("2d"); x.translate(64, 66); x.beginPath();
      for (var k = 0; k < 10; k++) { var r = k % 2 ? 22 : 52, a = -Math.PI / 2 + k * Math.PI / 5; x.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      x.closePath(); x.fillStyle = "#ffcf6b"; x.fill(); x.lineWidth = 8; x.strokeStyle = "#0a0a0a"; x.lineJoin = "round"; x.stroke(); return new THREE.CanvasTexture(c); })() }));
    star.center.set(0.5, 0); star.scale.set(0.95, 0.95, 1); star.visible = false; star.renderOrder = 6; scene.add(star);
    function mineHouse() { return mine && !DAYS[current].old_chain ? shown.filter(function (h) { return h.idx === mine.idx && h.day <= current; })[0] || null : null; }
    function placeMine() {
      var h = mineHouse(), go = $("t-mine-go"); star.visible = !!h;
      if (h) { star.userData.y = h.dc ? 2.0 : (h.tall ? 1.55 : 1.2); star.position.set(h.x, star.userData.y, h.z); }
      go.hidden = !h; if (h) { $("t-mine-name-b").textContent = mine.name; $("t-lab-mine-name").textContent = mine.name; }
    }
    function setMine(m) { mine = m; try { if (m) localStorage.setItem(MINE_KEY, JSON.stringify(m)); else localStorage.removeItem(MINE_KEY); } catch (e) {} placeMine(); }
    function goMine(party) { var h = mineHouse(); if (!h) return; hopAt[h.idx] = performance.now(); anim = true; st.auto = false; flyTo(h.x, h.z, 4.2, 0.55); if (party) { burst(h.x, h.z); setTimeout(function () { burst(h.x, h.z); }, 450); } }
    function mineRow(el, h) {
      var row = document.createElement("div"); row.className = "mine-row";
      if (mine && mine.idx === h.idx) {
        var own = document.createElement("p"); own.className = "mine-own"; own.textContent = "★ Your house: " + mine.name; row.appendChild(own);
        var out = document.createElement("button"); out.className = "btn"; out.textContent = "Move out";
        out.addEventListener("click", function (e) { e.stopPropagation(); setMine(null); closeCard(); }); row.appendChild(out);
      } else {
        var inp = document.createElement("input"); inp.type = "text"; inp.maxLength = 24; inp.placeholder = "Name it"; inp.id = "t-mine-input"; inp.setAttribute("aria-label", "A name for your house");
        var go = document.createElement("button"); go.className = "btn solid"; go.textContent = mine ? "Move here" : "Make it mine";
        function save(e) { if (e) e.stopPropagation(); setMine({ idx: h.idx, name: (inp.value || "").trim().slice(0, 24) || "My house" }); closeCard(); goMine(true); }
        go.addEventListener("click", save); inp.addEventListener("keydown", function (e) { e.stopPropagation(); if (e.key === "Enter") save(e); });
        ["pointerdown", "pointerup", "click"].forEach(function (ev) { inp.addEventListener(ev, function (e) { e.stopPropagation(); }); });
        row.appendChild(inp); row.appendChild(go);
      }
      el.appendChild(row);
    }
    $("t-mine-go").addEventListener("click", function () { goMine(false); });

    /* weather follows the day: clear on strong days (shooting stars, moonlight on the sea), clouds when agreement is weak, rain under 2/3 */
    var weather = "clear";
    function sparkLayer(par) {
      var g = new THREE.BufferGeometry(), n = 130, P = new Float32Array(n * 3);
      for (var k = 0; k < n; k++) { var a = h2(k * 2 + par, 501) * 6.283, r0 = islandR(a) + 1.4, rr = r0 + h2(k * 2 + par, 502) * Math.max(1, EXT * 1.25 - r0); P[k * 3] = Math.cos(a) * rr; P[k * 3 + 1] = 0.06; P[k * 3 + 2] = Math.sin(a) * rr; }
      g.setAttribute("position", new THREE.BufferAttribute(P, 3));
      var m = new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, map: dotTex, color: 0xcfd8ff, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
      var pts = new THREE.Points(g, m); pts.frustumCulled = false; scene.add(pts); return pts;
    }
    var sparks = [sparkLayer(0), sparkLayer(1)];
    var shoot = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
    shoot.frustumCulled = false; scene.add(shoot); var shootSt = { next: 4, t0: -1, a: null, b: null };
    var cloudTex = (function () { var c = document.createElement("canvas"); c.width = c.height = 128; var x = c.getContext("2d"), g = x.createRadialGradient(64, 64, 6, 64, 64, 64);
      g.addColorStop(0, "rgba(14,14,20,.75)"); g.addColorStop(0.6, "rgba(14,14,20,.35)"); g.addColorStop(1, "rgba(14,14,20,0)"); x.fillStyle = g; x.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
    var clouds = []; for (var ck = 0; ck < 8; ck++) { var cs2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0 }));
      cs2.scale.set(9 + h2(ck, 77) * 6, 6 + h2(ck, 78) * 3, 1); cs2.position.set((h2(ck, 79) - 0.5) * 2 * EXT, 5.5 + h2(ck, 80), (h2(ck, 81) - 0.5) * 2 * EXT); cs2.renderOrder = 7; scene.add(cs2); clouds.push(cs2); }
    var RAIN = 420, rainPos = new Float32Array(RAIN * 6), rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
    for (var rk = 0; rk < RAIN; rk++) { var rx = (h2(rk, 91) - 0.5) * 2 * ISL, rz = (h2(rk, 92) - 0.5) * 2 * ISL, ry = h2(rk, 93) * 10; rainPos.set([rx, ry, rz, rx + 0.05, ry - 0.45, rz], rk * 6); }
    var rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0x9fb3ff, transparent: true, opacity: 0.45 })); rain.frustumCulled = false; rain.visible = false; scene.add(rain);
    function setWeather(d) {
      weather = d.signed_pct == null ? "clear" : d.signed_pct < 66.67 ? "storm" : (d.agreement !== "strong" || d.signed_pct < 80) ? "cloudy" : "clear";
      rain.visible = weather === "storm" && !reduce; sparks.forEach(function (p) { p.visible = weather === "clear"; });
    }
    function weatherFrame(t, dt) {
      if (weather === "clear") {
        sparks[0].material.opacity = 0.18 + 0.4 * Math.max(0, Math.sin(t * 1.3)); sparks[1].material.opacity = 0.18 + 0.4 * Math.max(0, Math.sin(t * 1.3 + 3.1));
        if (!reduce) {
          if (shootSt.t0 < 0 && t > shootSt.next) { var z0 = (Math.random() - 0.5) * EXT, x0 = -EXT * 1.1; shootSt = { t0: t, a: new THREE.Vector3(x0, 11, z0), b: new THREE.Vector3(EXT * 1.1, 7, z0 + (Math.random() - 0.5) * EXT), next: 0 }; }
          if (shootSt.t0 >= 0) {
            var p = (t - shootSt.t0) / 1.1, head = new THREE.Vector3().lerpVectors(shootSt.a, shootSt.b, Math.min(1, p)), tail = new THREE.Vector3().lerpVectors(shootSt.a, shootSt.b, Math.max(0, p - 0.16));
            shoot.geometry.setFromPoints([tail, head]); shoot.material.opacity = p < 1 ? 0.85 * Math.sin(Math.PI * Math.min(1, p)) : 0;
            if (p >= 1) shootSt = { t0: -1, next: t + 7 + Math.random() * 9 };
          }
        }
      } else shoot.material.opacity = 0;
      var cloudy = weather !== "clear";
      clouds.forEach(function (c, k) { c.material.opacity += ((cloudy ? 0.55 : 0) - c.material.opacity) * Math.min(1, dt * 1.5); if (c.material.opacity > 0.01 && !reduce) { c.position.x += dt * (0.5 + k * 0.06); if (c.position.x > EXT * 1.2) c.position.x = -EXT * 1.2; } });
      if (rain.visible) { for (var k = 0; k < RAIN; k++) { var o = k * 6; rainPos[o + 1] -= dt * 13; rainPos[o + 4] -= dt * 13; if (rainPos[o + 4] < 0) { rainPos[o + 1] += 10; rainPos[o + 4] += 10; } } rainGeo.attributes.position.needsUpdate = true; }
    }

    /* milestone parties when the town passes 100, 250, 500, 1,000 houses */
    var MILESTONES = [100, 250, 500, 750, 1000, 1500, 2000];
    function milestone(i) {
      if (reduce) return; var prev = i > 0 ? DAYS[i - 1].validators || 0 : 0, cur = DAYS[i].validators || 0;
      var m = MILESTONES.filter(function (x) { return prev < x && cur >= x; }).pop(); if (!m) return;
      var b = $("t-banner"); b.querySelector("b").textContent = fmt(m) + " houses!"; b.querySelector("span").textContent = DAYS[i].label + " · " + fmt(cur) + " validators in town";
      b.hidden = false; b.classList.remove("go"); void b.offsetWidth; b.classList.add("go");
      [0, 260, 520, 820, 1150, 1500].forEach(function (ms, k) { setTimeout(function () { if (k % 2) burst(); else burst((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6); }, 600 + ms); });
      clearTimeout(milestone.t); milestone.t = setTimeout(function () { b.hidden = true; }, 5200);
    }
    /* hover (mouse only): a small label follows the pointer */
    var tip = $("t-tip"), hoverQ = null;
    function hideTip() { tip.classList.remove("on"); hovered = null; placeRing(); canvas.style.cursor = ""; }
    function hoverLabel(hr) {
      if (hr.kind === "shop") return "Cheese & chocolate"; // cc
      if (hr.kind === "gas") return "Gas station";
      var d = DAYS[current];
      if (hr.kind === "house") { var h = hr.house; if (h.day > current) return "A house on the old chain · " + d.label; return (h.dc ? "Data center" : "House") + " no. " + (h.idx + 1) + " · " + CLAB[h.c] + " · since " + DAYS[h.day].label; }
      if (hr.kind === "citizen" && hr.o.userData.who) return hr.o.userData.who === "punk" ? "punk6529" : hr.o.userData.who === "bus" ? "The night bus" : "A frog out for a hop";
      return { ministry: "Ministry of Validation", meter: "Agreement meter · " + (d.signed_pct != null ? d.signed_pct + "% signed" : ""), site: "Building site" + (nextNew(d) == null ? "" : " · +" + nextNew(d) + " moving in"),
        stage: stageOK && hr.o.userData.stage != null ? "Main Stage \u00b7 #" + (hr.o.userData.stage + 1) + " " + STAGE.items[hr.o.userData.stage].title : "",
        factory: "Meme Factory", museum: "Meme Museum", frog: "The pond frog", citizen: "A citizen", news: news.label(),
        relay: "Relay · " + (hr.o.userData.relay || ""), flag: hr.o.userData.country ? hr.o.userData.country[0] + " · " + hr.o.userData.country[1] : "" }[hr.kind] || "";
    }
    canvas.addEventListener("pointermove", function (e) {
      if (e.pointerType !== "mouse" || st.drag || pinch || $("t-card").classList.contains("on")) return;
      var cx = e.clientX, cy = e.clientY; if (hoverQ) return;
      hoverQ = requestAnimationFrame(function () {
        hoverQ = null; var hr = hitAt(cx, cy);
        if (!hr) { hideTip(); return; }
        hovered = hr.kind === "house" ? hr.house : null; placeRing(); canvas.style.cursor = "pointer";
        var r = stage.getBoundingClientRect(); tip.textContent = hoverLabel(hr);
        tip.style.transform = "translate(" + Math.min(r.width - 20, cx - r.left + 14).toFixed(0) + "px," + (cy - r.top + 16).toFixed(0) + "px)"; tip.classList.add("on");
      });
    });
    canvas.addEventListener("pointerleave", hideTip);
    $("t-card-x").addEventListener("click", function (e) { e.stopPropagation(); closeCard(); });
    ["pointerdown", "pointerup"].forEach(function (ev) { $("t-card").addEventListener(ev, function (e) { e.stopPropagation(); }); });

    /* labels */
    var lv = new THREE.Vector3();
    var placed = [], nb = null; // nb: where the news plane and its banner are on the screen in this frame (five boxes), or null
    function lab(el, x, y, z, top, small) { // labels never sit on top of one another: a later one hides if it would (two small tags may stand closer; a small tag counts its dot's width). A label also hides while the news plane or its banner is on it
      lv.set(x, y, z).project(cam); var W = stage.clientWidth, H = stage.clientHeight, sx = (lv.x + 1) / 2 * W, sy = (1 - lv.y) / 2 * H;
      var free = placed.every(function (p) { var two = small && p[2]; return Math.abs(p[0] - sx) > (two ? 109 : small ? 177 : 170) || Math.abs(p[1] - sy) > (two ? 30 : 46); });
      el.style.transform = "translate(" + sx.toFixed(1) + "px," + sy.toFixed(1) + "px) translate(-50%,-100%)";
      var edge = small ? 47 : 40, on = free && sx > edge && sx < W - edge && sy > (top || 40) && sy < H; if (on) placed.push([sx, sy, small]); // it keeps its place while it hides for the banner: no other label takes it
      if (on && nb) {
        var w = 0, h = 0, pad = el.classList.contains("on") ? 4 : 12, now = performance.now(); // a hidden label comes back a little later than it left: no flicker at the cloth's edge
        if (nb.some(function (b) {
          if (sx < b[0] - 170 || sx > b[2] + 170 || sy < b[1] - 12 || sy > b[3] + 110) return false; // far from this part: the label need not be measured
          if (!w) { w = el.offsetWidth / 2 + pad; h = el.offsetHeight + pad; }
          return sx + w > b[0] && sx - w < b[2] && sy + pad > b[1] && sy - h < b[3]; // the label stands above its point, centred on it
        })) el._nbT = now;
        on = !(now - (el._nbT || -1e9) < 700); // and it stays hidden for 0.7 s after the cloth has left it: it does not pop in and out between the cloth's parts
      }
      el.classList.toggle("on", on);
    }

    /* loop */
    var visible = true, active = true, last = performance.now(), nextBurst = 1.5, tick = 0, prScale = 1, slowN = 0, slowT = 0;
    function resize() {
      var w = stage.clientWidth, h = stage.clientHeight, PR = Math.max(1, Math.min(window.devicePixelRatio || 1, 3, Math.sqrt(4.4e6 / Math.max(1, w * h))) * prScale);
      renderer.setPixelRatio(PR); renderer.setSize(w, h, false); placeCam();
    }
    window.addEventListener("resize", resize); resize();
    function frame(now) { requestAnimationFrame(frame); if (!visible || !active || document.hidden) { last = now; return; } step(now); }
    /* life in the streets: signatures run to the Ministry as gold lights, windows shimmer,
       a night bus goes round, fireflies by the pond and the woods, welding at the building site. None of it when reduced motion is asked for. */
    var life = (function () {
      if (reduce) return { frame: function () {}, day: function () {}, pick: [], state: function () { return null; } };
      var ADD = THREE.AdditiveBlending, rnd = Math.random, noRay = function () {};
      function glowDot(color) { var s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: color, transparent: true, opacity: 0, depthWrite: false, blending: ADD })); s.raycast = noRay; s.renderOrder = 6; scene.add(s); return s; }
      var sized = [];
      function dots(n, size, color) { // n small lights drawn as one object; color null = each point has its own. size = width in town units, so the lights grow with the zoom like everything else
        var pos = new Float32Array(n * 3), geo = new THREE.BufferGeometry(), col = null; for (var i = 0; i < n; i++) pos[i * 3 + 1] = -99;
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); if (color == null) { col = new Float32Array(n * 3); geo.setAttribute("color", new THREE.BufferAttribute(col, 3)); }
        var m = new THREE.Points(geo, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, map: dotTex, color: color == null ? 0xffffff : color, vertexColors: color == null, transparent: true, depthWrite: false, blending: ADD }));
        m.frustumCulled = false; m.renderOrder = 6; m.raycast = noRay; scene.add(m); sized.push([m.material, size]); return { m: m, pos: pos, col: col, geo: geo };
      }

      /* signatures: how many street cells from each street cell to the front of the Ministry. Nothing crosses the plaza or the pond,
         so every light comes in over the street between the two and ends at the foot of the notice board. */
      var G = 48, GN = 2 * G + 1, dist = new Int16Array(GN * GN), NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      function woodSt(x, z) { // a street cell with wood on every side; the lane to the data centers (x = 9) is not one
        if (x === 9 && z > -9 && z < -3) return false;
        var xs = street(x) ? [x / 3 - 1, x / 3] : [Math.floor(x / 3)], zs = street(z) ? [z / 3 - 1, z / 3] : [Math.floor(z / 3)];
        for (var a = 0; a < xs.length; a++) for (var b = 0; b < zs.length; b++) if (zoneOf(xs[a], zs[b]) !== null) return false;
        return true;
      }
      function open(x, z) { return Math.abs(x) <= G && Math.abs(z) <= G && (street(x) || street(z)) && !plaza(x, z) && Math.hypot(x - SQ[0], z - SQ[1]) > 1.05 && !woodSt(x, z); }
      function dAt(x, z) { return Math.abs(x) > G || Math.abs(z) > G ? -1 : dist[(z + G) * GN + x + G]; }
      (function () {
        for (var i = 0; i < dist.length; i++) dist[i] = -1;
        var q = [[0, 3]]; dist[(3 + G) * GN + G] = 0;
        for (var k = 0; k < q.length; k++) { var c = q[k], d0 = dAt(c[0], c[1]); for (var n = 0; n < 4; n++) { var x = c[0] + NB[n][0], z = c[1] + NB[n][1]; if (open(x, z) && dAt(x, z) < 0) { dist[(z + G) * GN + x + G] = d0 + 1; q.push([x, z]); } } }
      })();
      function pathFrom(h) { // out of the house to the street beside it, then the shortest way along the streets
        var best = null, bd = 1e9, n, x, z;
        for (n = 0; n < 4; n++) { var d = dAt(h.x + NB[n][0], h.z + NB[n][1]); if (d >= 0 && d < bd) { bd = d; best = [h.x + NB[n][0], h.z + NB[n][1]]; } }
        if (!best) return null;
        var pts = [[h.x, h.z], best], c = best, dir = [best[0] - h.x, best[1] - h.z], guard = 0;
        while (dAt(c[0], c[1]) > 0 && guard++ < 400) {
          var d0 = dAt(c[0], c[1]), nx = null;
          if (dAt(c[0] + dir[0], c[1] + dir[1]) === d0 - 1) nx = [c[0] + dir[0], c[1] + dir[1]]; // straight on while that leads closer, else turn
          else for (n = 0; n < 4 && !nx; n++) { x = c[0] + NB[n][0]; z = c[1] + NB[n][1]; if (dAt(x, z) === d0 - 1) nx = [x, z]; }
          if (!nx) break; dir = [nx[0] - c[0], nx[1] - c[1]]; pts.push(nx); c = nx;
        }
        pts.push([0, 2.4]); // the last steps, to the notice board
        return pts;
      }
      function at(pts, s, out, k) { var n = pts.length - 1; s = Math.max(0, Math.min(n, s)); var i = Math.min(n - 1, Math.floor(s)), f = s - i, a = pts[i], b = pts[i + 1]; out[k] = a[0] + (b[0] - a[0]) * f; out[k + 1] = 0.14; out[k + 2] = a[1] + (b[1] - a[1]) * f; }
      var NC = 10, TR = 7, heads = dots(NC, 0.36, 0xffd98a), trails = dots(NC * TR, 0.2, null), cour = [], sent = 0;
      for (var ci = 0; ci < NC; ci++) cour.push({ pts: null, s: 0, wait: 4 + ci * 0.5, fl: glowDot(0xffcf6b), ft: 9 });
      function couriers(dt) {
        for (var i = 0; i < NC; i++) {
          var c = cour[i], o = i * 3, k, j;
          if (c.ft < 1) { c.ft += dt / 0.5; var e = Math.min(1, c.ft); c.fl.scale.setScalar(0.3 + e * 1.0); c.fl.material.opacity = (1 - e) * 0.9; }
          if (!c.pts) {
            heads.pos[o + 1] = -99; for (k = 0; k < TR; k++) trails.pos[(i * TR + k) * 3 + 1] = -99;
            c.wait -= dt; if (c.wait > 0) continue; c.wait = 0.6 + rnd() * 2.2;
            var h = null; for (k = 0; k < 14 && !h; k++) { var q = shown[Math.floor(rnd() * shown.length)]; if (q && signedNow[q.idx] && matches(q) && !plaza(q.x, q.z)) h = q; }
            if (!h) continue; c.pts = pathFrom(h); if (!c.pts) continue;
            c.s = 0; c.fl.position.set(h.x, 0.5, h.z); c.ft = 0; sent++; continue; // a flash at the house: signed
          }
          c.s += dt * 3.2; var n = c.pts.length - 1; at(c.pts, c.s, heads.pos, o);
          for (k = 0; k < TR; k++) { j = (i * TR + k) * 3; var f = 1 - (k + 1) / (TR + 1); at(c.pts, c.s - (k + 1) * 0.15, trails.pos, j); trails.col[j] = f; trails.col[j + 1] = f * 0.8; trails.col[j + 2] = f * 0.42; }
          if (c.s >= n) { c.fl.position.set(c.pts[n][0], 0.5, c.pts[n][1]); c.ft = 0; c.pts = null; snd.chime(); } // a flash at the Ministry: counted
        }
        heads.geo.attributes.position.needsUpdate = true; trails.geo.attributes.position.needsUpdate = true; trails.geo.attributes.color.needsUpdate = true;
      }

      /* windows: a few houses change their brightness a little, all the time; the colour, and what it means, stays */
      var shT = 0, tc = new THREE.Color();
      function shimmer(dt, now) {
        shT += dt; if (shT < 0.14 || lighting || !shown.length) return; shT = 0;
        var n = Math.max(2, Math.round(shown.length * 0.03)), dirty = [false, false, false, false], tw = false;
        for (var k = 0; k < n; k++) {
          var h = shown[Math.floor(rnd() * shown.length)], sl = SLOT[h.idx];
          if (!sl || !litNow[h.idx] || !matches(h) || now < (lightAt[h.idx] || 0)) continue;
          var f = rnd() < 0.12 ? 1.12 : 0.8 + rnd() * 0.25;
          if (h.dc) { M.twin.setColorAt(sl[1], tc.copy(CYAN).multiplyScalar(f)); tw = true; }
          else { MV[h.v].win.setColorAt(sl[1], tc.copy(h.c === "not_reported" ? CURT : LITC).multiplyScalar(f)); dirty[h.v] = true; }
        }
        if (tw) M.twin.instanceColor.needsUpdate = true;
        MV.forEach(function (mv, i) { if (dirty[i]) mv.win.instanceColor.needsUpdate = true; });
      }

      /* the night bus: a red double-decker on the ring road (the second street out), in the lane across from the walkers */
      var bus = new THREE.Group(), busS = 0, busWait = 0, busR = 6, busQ = [0, 0, 0];
      (function () {
        function bx(w, h, d, mat, x, y, z) { var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.userData.pick = "citizen"; m.userData.who = "bus"; bus.add(m); return m; }
        var W = 0.34, Lb = 0.98, red = toon(0xc8291e), ink = toon(0x17110e), glass = basic(0xffdf9e);
        var hull = new THREE.Mesh(new THREE.BoxGeometry(W + 0.05, 0.56, Lb + 0.05), inkBack); hull.position.y = 0.33; hull.raycast = noRay; bus.add(hull); // the ink line round it, like the houses
        bx(W, 0.16, Lb, red, 0, 0.15, 0); bx(W - 0.02, 0.12, Lb - 0.02, glass, 0, 0.29, 0); bx(W, 0.07, Lb, red, 0, 0.385, 0); bx(W - 0.02, 0.12, Lb - 0.02, glass, 0, 0.48, 0); bx(W, 0.05, Lb, red, 0, 0.565, 0);
        bx(0.1, 0.012, Lb * 0.8, toon(0xefe5cf), 0, 0.596, 0); // a cream line along the roof
        [-0.475, -0.16, 0.16, 0.475].forEach(function (z) { bx(W + 0.004, 0.12, 0.035, red, 0, 0.29, z); bx(W + 0.004, 0.12, 0.035, red, 0, 0.48, z); });
        [-0.3, 0.3].forEach(function (z) { [-0.15, 0.15].forEach(function (x) { bx(0.06, 0.12, 0.17, ink, x, 0.06, z); }); });
        bx(0.2, 0.05, 0.02, basic(0xffb24a), 0, 0.385, Lb / 2 + 0.004); // where it goes, lit, on the front
        [-0.11, 0.11].forEach(function (x) { bx(0.07, 0.05, 0.02, basic(0xfff3c4), x, 0.13, Lb / 2 + 0.004); bx(0.06, 0.04, 0.02, basic(0xff3b2a), x, 0.13, -Lb / 2 - 0.004); });
        var beam = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6).rotateX(-Math.PI / 2), basic(0xffffff, { map: poolTex, transparent: true, opacity: 0.8, depthWrite: false, blending: ADD }));
        beam.position.set(0, 0.03, Lb / 2 + 0.55); beam.renderOrder = 2; beam.raycast = noRay; bus.add(beam);
        scene.add(bus);
      })();
      function busAt(s, out) { // side 0 goes +z, 1 goes -x, 2 goes -z, 3 goes +x; out = x, z, heading
        var R = busR, k = Math.min(3, Math.floor(s / (2 * R))), u = s - k * 2 * R - R, c = -0.23;
        if (k === 0) { out[0] = R + c; out[1] = u + c; out[2] = 0; } else if (k === 1) { out[0] = -u + c; out[1] = R + c; out[2] = -Math.PI / 2; }
        else if (k === 2) { out[0] = -R + c; out[1] = -u + c; out[2] = Math.PI; } else { out[0] = u + c; out[1] = -R + c; out[2] = Math.PI / 2; }
      }
      function busFrame(dt) {
        if (!bus.visible) return;
        var P = 8 * busR, prev = busS;
        if (busWait > 0) busWait -= dt;
        else { busS = (busS + dt * 1.5) % P; [3 * busR, 7 * busR].forEach(function (sp) { if (prev < sp && busS >= sp) { busS = sp; busWait = 2.6; } }); } // two stops; one is the town square
        busAt(busS, busQ); bus.position.set(busQ[0], 0, busQ[1]);
        var da = busQ[2] - bus.rotation.y; da = Math.atan2(Math.sin(da), Math.cos(da)); bus.rotation.y += da * Math.min(1, dt * 7);
      }

      /* fireflies: by the pond and at the edge of the woods; not in the rain */
      var NF = 44, ff = [], flies = dots(NF, 0.15, null);
      function seedFlies() {
        ff.length = 0;
        for (var i = 0; i < NF; i++) {
          var x, z;
          if (i < 14) { x = SQ[0] + (rnd() - 0.5) * 4.6; z = SQ[1] + (rnd() - 0.5) * 2; }
          else { var a = rnd() * 6.283, r = townR + 1.4 + rnd() * 2.6; if (r > islandR(a) - 1.4) r = islandR(a) - 1.4 - rnd(); x = Math.cos(a) * r; z = Math.sin(a) * r; }
          ff.push([x, 0.25 + rnd() * 0.7, z, rnd() * 6.283, 0.5 + rnd() * 0.9]);
        }
      }
      function fireflies(t) {
        for (var i = 0; i < ff.length; i++) {
          var f = ff[i], o = i * 3, b = Math.max(0, Math.sin(t * f[4] * 1.7 + f[3])); b = b * b * b;
          flies.pos[o] = f[0] + Math.sin(t * 0.45 * f[4] + f[3]) * 0.4; flies.pos[o + 1] = f[1] + Math.sin(t * 0.8 * f[4] + f[3] * 2) * 0.14; flies.pos[o + 2] = f[2] + Math.cos(t * 0.37 * f[4] + f[3] * 1.3) * 0.4;
          flies.col[o] = 0.82 * b; flies.col[o + 1] = b; flies.col[o + 2] = 0.45 * b;
        }
        flies.geo.attributes.position.needsUpdate = true; flies.geo.attributes.color.needsUpdate = true;
      }

      /* the building site: someone is welding tomorrow's houses */
      var weld = glowDot(0xcfe6ff), NS = 10, wsp = dots(NS, 0.1, 0xffb24a), wV = new Float32Array(NS * 3), wL = new Float32Array(NS), wOn = 0, wOff = 2.5, wp = [0, 0, 0];
      function welding(dt) {
        var i, o;
        if (!siteLots.length) { wOn = 0; weld.material.opacity = 0; }
        else if (wOn > 0) {
          wOn -= dt; weld.material.opacity = 0.35 + rnd() * 0.65; weld.scale.setScalar(0.35 + rnd() * 0.5);
          for (i = 0; i < NS; i++) if (wL[i] <= 0 && rnd() < 0.3) { o = i * 3; wsp.pos[o] = wp[0]; wsp.pos[o + 1] = wp[1]; wsp.pos[o + 2] = wp[2]; wV[o] = (rnd() - 0.5) * 1.4; wV[o + 1] = 0.6 + rnd() * 1.2; wV[o + 2] = (rnd() - 0.5) * 1.4; wL[i] = 0.35 + rnd() * 0.3; }
          if (wOn <= 0) { weld.material.opacity = 0; wOff = 1.6 + rnd() * 3.5; }
        } else {
          wOff -= dt;
          if (wOff <= 0) { var L = siteLots[Math.floor(rnd() * siteLots.length)]; wp = [L.x + (rnd() < 0.5 ? -0.3 : 0.3), 0.45 + rnd() * 0.45, L.z + (rnd() < 0.5 ? -0.3 : 0.3)]; weld.position.set(wp[0], wp[1], wp[2]); wOn = 0.8 + rnd() * 1.2; }
        }
        for (i = 0; i < NS; i++) { if (wL[i] <= 0) continue; o = i * 3; wL[i] -= dt; wV[o + 1] -= 5 * dt; wsp.pos[o] += wV[o] * dt; wsp.pos[o + 1] += wV[o + 1] * dt; wsp.pos[o + 2] += wV[o + 2] * dt; if (wL[i] <= 0 || wsp.pos[o + 1] < 0.02) { wL[i] = 0; wsp.pos[o + 1] = -99; } }
        wsp.geo.attributes.position.needsUpdate = true;
      }

      return {
        pick: [bus],
        frame: function (t, dt, now) {
          var k = renderer.domElement.height / renderer.getPixelRatio() / (cam.top - cam.bottom); // screen pixels per town unit
          for (var i = 0; i < sized.length; i++) sized[i][0].size = Math.max(sized[i][1] * 22, Math.min(sized[i][1] * k, sized[i][1] * 90));
          couriers(dt); shimmer(dt, now); busFrame(dt); if (flies.m.visible) fireflies(t); welding(dt); },
        day: function () { // a new day is shown: start again once the houses have their lights
          cour.forEach(function (c, i) { c.pts = null; c.wait = 3.6 + i * 0.5 + rnd(); c.fl.material.opacity = 0; c.ft = 9; });
          bus.visible = townR >= 7 && shown.length + siteLots.length > 16; /* a village too small for the ring road has no bus: it takes houses or frames on 17 lots as well */ seedFlies(); flies.m.visible = weather !== "storm"; wOn = 0; wOff = 2.5; weld.material.opacity = 0;
        },
        state: function () { return { sent: sent, running: cour.filter(function (c) { return c.pts; }).length, bus: [bus.position.x, bus.position.z], stopped: busWait > 0, busR: busR, welding: wOn > 0, lights: cour.map(function (c, i) { return c.pts ? [Math.round(heads.pos[i * 3] * 10) / 10, Math.round(heads.pos[i * 3 + 2] * 10) / 10] : 0; }), flies: ff.length, px: sized.map(function (q) { return Math.round(q[0].size * 10) / 10; }), weld: [weld.position.x, weld.position.z], far: dAt(G, G), alloc: [ALLOC_BAD, ALLOC_OVER, QGAP] }; }
      };
    })();

    function step(now) {
      var raw = now - last, dt = Math.min(0.05, raw / 1000); last = now; var t = (now - tStart) / 1000;
      if (t > 5 && raw < 400) { slowT += raw; if (++slowN >= 90) { if (slowT / slowN > 30 && prScale > 0.5) { prScale *= 0.8; resize(); } slowN = 0; slowT = 0; } }
      if (tween) {
        var p = Math.max(0, Math.min(1, (now - tween.t0) / tween.dur)), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        st.tx = tween.x0 + (tween.tx - tween.x0) * e; st.tz = tween.z0 + (tween.tz - tween.z0) * e; st.halfT = tween.h0 + (tween.h - tween.h0) * e; st.el = tween.e0 + (tween.e - tween.e0) * e; st.az = tween.a0 + tween.da * e;
        if (p >= 1) tween = null;
      }
      if (st.auto) st.az += dt * 0.05;
      else if (!st.drag && !pinch && st.idle && now - st.idle > 12000 && !reduce && !$("t-card").classList.contains("on")) st.auto = true;
      st.half += (st.halfT - st.half) * Math.min(1, dt * 6);
      placeCam();
      var px = (cap ? cap.h : stage.clientHeight) / (2 * (aspect() < 1 ? st.half / aspect() : st.half));
      var gme = cam.matrixWorld.elements, wpp = 1 / (px * renderer.getPixelRatio()), uh2 = gme[4] * gme[4] + gme[6] * gme[6] || 1;
      groundU.uFw.value.set((Math.abs(gme[0]) + Math.abs(gme[4]) / uh2) * wpp, (Math.abs(gme[2]) + Math.abs(gme[6]) / uh2) * wpp); groundU.uT.value = reduce ? 0 : t; sparks[0].material.size = sparks[1].material.size = Math.max(2.2, Math.min(6, 0.3 * px));
      var smN = 0; for (var smI = 0; smI < smokeSrc.length; smI++) { var smS = smokeSrc[smI]; for (var smK = 0; smK < SMK; smK++) { var smP = ((reduce ? 0.3 : t * 0.16) + smK / SMK + smS[3]) % 1;
        smokePos[smN * 3] = smS[0] + smP * smP * 0.45 + Math.sin(smP * 6 + smS[3] * 9) * 0.035; smokePos[smN * 3 + 1] = smS[1] + smP * 1.05; smokePos[smN * 3 + 2] = smS[2] + smP * smP * 0.15;
        smokeF[smN * 2] = Math.min(1, smP * 8) * Math.pow(1 - smP, 1.2) * 1.5; smokeF[smN * 2 + 1] = 0.5 + 1.3 * smP; smN++; } }
      smokeGeo.setDrawRange(0, smN); smokeGeo.attributes.position.needsUpdate = true; smokeGeo.attributes.aF.needsUpdate = true; smokeMat.uniforms.uSize.value = Math.max(6, 0.36 * px) * renderer.getPixelRatio(); groundU.uMd.value.set(Math.sin(st.az), Math.cos(st.az)); if (!reduce) mist.position.set(Math.sin(t * 0.06) * 0.7, 0, Math.cos(t * 0.045) * 0.6);
      glowMat.size = Math.max(9, 1.15 * px); fwMat.size = Math.max(6, 0.3 * px); lampGlowMat.size = Math.max(8, 0.8 * px); gtFrame(t, px);
      if (ferry.visible && ferryPath) {
        var ft = reduce ? 0.5 : (t / 28 + 0.2); ferryAt(ft, fP); ferryAt(ft, fQ, 0.02);
        ferry.position.set(fP.x, Math.sin(t * 2.1) * 0.03, fP.z);
        var dxf = fQ.x - fP.x, dzf = fQ.z - fP.z; if (Math.hypot(dxf, dzf) > 1e-4) ferry.rotation.y = -Math.atan2(dzf, dxf);
        ferry.rotation.z = Math.sin(t * 1.7) * 0.03;
        foam.forEach(function (f, k) { ferryAt(ft - (k + 1) * 0.006, fQ); f.position.set(fQ.x, 0.02, fQ.z); var moving = (ft % 1) < 0.42 || (ft % 1) > 0.58; f.material.opacity = moving ? 0.38 * (1 - k / foam.length) : 0; f.scale.setScalar(1 + k * 0.35); });
      }
      if (anim) anim = placeHouses(now);
      weatherFrame(t, dt);
      if (lighting) { colourHouses(now); lighting = now < lightEnd; }
      var mp = Math.min(1, (now - meterAnim.t0) / meterAnim.dur), me = 1 - Math.pow(1 - mp, 3), mv = meterAnim.from + (meterAnim.to - meterAnim.from) * me;
      meter.userData.fill.scale.y = Math.max(0.001, mv / 100);
      if (!meterAnim.crossed && mv >= 66.67) { meterAnim.crossed = true; burst(1.95, 1.95); setTimeout(function () { burst(); }, 350); setTimeout(function () { burst(); }, 800); }
      if (!reduce) flags.forEach(function (f) { f.fl.rotation.y = Math.sin(t * 2.4 + f.ph) * 0.35; });
      waveQuarters(t);
      if (balList.length && (!reduce || balAz !== st.az)) placeBalloons(now); // "reduce motion": only when the view turned
      vfFrame(now, t); // the vote flag on the Ministry (vf)
      // ministry flag, smoke, crane, frog, towers
      if (!reduce) {
        ministry.userData.flag.rotation.y = st.az + Math.sin(t * 2.2) * 0.22; // swings on its pole, faces you
        crane.userData.jib.rotation.y = Math.sin(t * 0.3) * 1.2;
        frog.position.y = Math.max(0, Math.sin(t * 2.6)) * 0.12 * (Math.sin(t * 0.7) > 0.6 ? 1 : 0);
      }
      factory.userData.line(reduce ? 0 : t);
      var fc = factory.position;
      smoke.forEach(function (s) {
        var ph = ((reduce ? 0.5 : t * 0.22) + s.ph) % 1, c = s.ch ? [-0.5, 0.45] : [0.55, -0.4];
        s.s.position.set(fc.x + c[0] + ph * 0.6, 2.0 + ph * 2.4, fc.z + c[1] - ph * 0.3); s.s.scale.setScalar(0.4 + ph * 1.1); s.s.material.opacity = (1 - ph) * 0.8;
      });
      towers.forEach(function (tw) {
        var ph = (t * 0.3 + tw.ph) % 1, ph2 = (ph + 0.5) % 1; tw.wave.scale.setScalar(0.3 + ph * 1.9); tw.wave.material.opacity = (1 - ph) * (1 - ph) * 0.5; tw.wave2.scale.setScalar(0.3 + ph2 * 1.9); tw.wave2.material.opacity = (1 - ph2) * (1 - ph2) * 0.5;
        tw.lamp.material.color.setHex(Math.sin(t * 3 + tw.ph * 9) > 0 ? 0xff3b2a : 0x5c130d);
      });
      people.forEach(function (p) {
        var L = Math.max(4, coreR - 1), lo = Math.max(-L, p.lo), W = Math.min(L, p.hi) - lo, s = ((t * p.sp + p.ph) % (2 * W)), q = lo + (s < W ? s : 2 * W - s), dir = s < W ? 1 : -1;
        if (p.axis) { p.g.position.set(p.line + 0.25, 0, q); p.g.rotation.y = dir > 0 ? 0 : Math.PI; } else { p.g.position.set(q, 0, p.line + 0.25); p.g.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
        if (p.hop) { var hp = reduce ? 0 : Math.abs(Math.sin(t * 5 * p.sp)); p.g.position.y = hp * 0.22; p.g.scale.set(0.5, 0.5 * (0.9 + hp * 0.15), 0.5); }
        else { var sw = reduce ? 0 : Math.sin(t * 8 * p.sp) * 0.5; p.legs[0].rotation.x = sw; p.legs[1].rotation.x = -sw; }
      });
      planes.forEach(function (pl) {
        if (!pl.a || pl.t >= 1) { route(pl); if (!pl.a || pl.t >= 1) { pl.m.visible = false; return; } snd.whoosh(); }
        pl.t = Math.min(1, pl.t + dt / pl.dur);
        var p1 = arcAt(pl, pl.t, new THREE.Vector3()), p2 = arcAt(pl, Math.min(1, pl.t + 0.01), new THREE.Vector3());
        pl.m.position.copy(p1); pl.m.lookAt(p2); pl.m.rotateZ(Math.sin(t * 1.6 + pl.ph) * 0.2); pl.m.visible = pl.t > 0.02 && pl.t < 0.98;
      });
      for (var i = 0; i < FW; i++) {
        if (fwLife[i] <= 0) { fwP[i * 3 + 1] = -99; continue; }
        fwLife[i] -= dt; fwV[i * 3 + 1] -= 2.6 * dt; fwP[i * 3] += fwV[i * 3] * dt; fwP[i * 3 + 1] += fwV[i * 3 + 1] * dt; fwP[i * 3 + 2] += fwV[i * 3 + 2] * dt;
        var f = Math.max(0, Math.min(1, fwLife[i] / 1.2)); fwC[i * 3] *= 0.985; fwC[i * 3 + 1] *= 0.985; fwC[i * 3 + 2] *= 0.985; if (!f) fwP[i * 3 + 1] = -99;
      }
      fwGeo.attributes.position.needsUpdate = true; fwGeo.attributes.color.needsUpdate = true;
      tick++; if (!reduce) { if (tick % 300 === 0) rehang(); if (tick % 24 === 0) drawFactorySign((tick / 24) & 1); }
      life.frame(t, dt, now); news.frame(t);
      renderer.render(scene, cam);
      if (!groundChecked) { groundChecked = true; // a device that cannot run the ground shader gets the painted map instead
        if (renderer.info.programs.some(function (g) { return g.name === "ShaderMaterial" && g.diagnostics && g.diagnostics.runnable === false; })) { scene.remove(ground); paintGround(); } }
      placed = []; nb = reduce ? null : news.box(); lab($("t-lab-ministry"), 0, 5.2, 0); // with reduced motion the plane stands still: a label under it would stay hidden for good, so no label hides for it
      if (star.visible) { star.position.y = star.userData.y + Math.sin(t * 2.2) * 0.08; star.material.rotation = Math.sin(t * 0.9) * 0.25; lab($("t-lab-mine"), star.position.x, star.position.y + 1.25, star.position.z); } else $("t-lab-mine").classList.remove("on");
      if (siteLots.length) lab($("t-lab-site"), crane.position.x, 3.6, crane.position.z); else $("t-lab-site").classList.remove("on");
      stageG.userData.tick(); var sTop = stageG.userData.top;
      if (stageG.userData.on) lab($("t-lab-stage"), sTop[0], sTop[1], sTop[2], 66); else $("t-lab-stage").classList.remove("on");
      qOrder.forEach(function (q) { lab(q.el, q.x, q.y, q.z, 0, true); }); // after the four labels: the quarters, largest first, the district last
    }
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }).observe(stage);
    requestAnimationFrame(frame);

    var townR = 6, lastShown = -1, oldX = -4.5, oldZ = -4.5;
    (function () { var d0 = HOUSES.filter(function (h) { return standing(h, OLDT); }), R = d0.reduce(function (m, h) { return Math.max(m, Math.hypot(h.x, h.z)); }, 0) || 6;
      var best = d0.reduce(function (b, h) { var sc = Math.abs(Math.atan2(h.z, h.x) + 2.356) * 3 + Math.abs(Math.hypot(h.x, h.z) / R - 0.55); return !b || sc < b.sc ? { h: h, sc: sc } : b; }, null);
      if (best) { oldX = best.h.x; oldZ = best.h.z; } })();
    var introTimer = null, opening = 0;
    ["pointerdown", "wheel"].forEach(function (ev) { canvas.addEventListener(ev, function () { opening = 0; }, { passive: true }); });
    function show(i) {
      clearTimeout(introTimer);
      if (lastShown < 0 && !reduce) {
        var a = aspect(), grow = i > FIRSTNEW; opening = 1; st.el = 0.74; st.tx = st.tz = 0;
        st.half = st.halfT = ISL * 1.1 * (a < 1 ? 1 : Math.max(Math.sin(st.el) + 0.1, 1 / a)); placeCam();
        if (grow) { showDay(FIRSTNEW); introTimer = setTimeout(function () { showDay(i); }, 2300); } else showDay(i);
        var n0 = flyN;
        setTimeout(function () { if (opening && flyN === n0) flyTo(0, 0, fitHalf * 0.96, 0.6, st.az + 0.5, 5600); opening = 0; }, grow ? 3500 : 1600);
        return;
      }
      var first = lastShown < 0; showDay(i); if (!first) milestone(i);
    }
    function showDay(i) {
      var d = DAYS[i], now = performance.now();
      var cnt = {}; litNow = {}; signedNow = {};
      var was = {}; shown.forEach(function (h) { was[h.idx] = 1; });
      shown = HOUSES.filter(function (h) { return standing(h, i); });
      fresh = {}; shown.forEach(function (h) { if (!standing(h, i - 1)) fresh[h.idx] = 1; });
      balOn = i > FIRSTNEW; // house records start on FIRSTNEW: that day every house is "new"
      if (HDAY) shown.forEach(function (h) {
        var v = d.old_chain ? 15 : (HDAY[i] || [])[h.idx] || 0; litNow[h.idx] = v > 0; signedNow[h.idx] = !!(v & 8);
        if (!v) for (var k = i - 1; k >= 0 && !v; k--) v = (HDAY[k] || [])[h.idx] || 0;   // an empty house keeps its last colours
        h.c = CBYTE[v & 7] || "not_reported"; h.dc = !!(v & 16);
      });
      else shown.forEach(function (h) { var c = h.c, lim = (d.continents || {})[c] || 0; cnt[c] = (cnt[c] || 0); litNow[h.idx] = cnt[c] < lim; signedNow[h.idx] = litNow[h.idx]; cnt[c]++; });
      var growing = lastShown >= 0 && i > lastShown;
      shown.forEach(function (h, k) { if (!(h.idx in born) || (growing && !was[h.idx]) || lastShown < 0) { born[h.idx] = now + (reduce ? -99999 : (fresh[h.idx] && growing ? k % 60 * 14 : (k % 120) * 5)); } });
      if (!growing && lastShown >= 0) shown.forEach(function (h) { if (born[h.idx] > now) born[h.idx] = now - 1000; });
      lastShown = i;
      var nSite = tomorrowCount(d); placeSites(i, nSite, now); if (!siteLots.length) nSite = 0;
      shown.forEach(function (h) { lightAt[h.idx] = reduce ? 0 : now + 450 + h2(h.idx, i + 91) * 2600; });
      lighting = !reduce; lightEnd = now + 3200;
      placeHouses(now); colourHouses(now); anim = true;
      meter.visible = d.signed_pct != null; // no meter when the share wasn't recorded (old chain Wed 4 / Thu 5)
      var cur = meter.userData.fill.scale.y * 100; meterAnim = { from: reduce ? (d.signed_pct || 0) : 0, to: d.signed_pct || 0, t0: now + 300, dur: 3000, crossed: reduce || !(d.signed_pct >= 66.67) };
      placeFlags(d); placeQuarters(d, i);
      placeLamps();
      ferry.visible = nSite > 0; foam.forEach(function (f) { f.visible = nSite > 0; });
      if (nSite) { var fa = Math.atan2(crane.position.z, crane.position.x), far = ISL + 7, near = islandR(fa) + 1.0;
        ferryPath = { S: polar(fa + 0.75, far), C1: polar(fa + 0.32, ISL + 4.2), D: polar(fa, near), C2: polar(fa - 0.32, ISL + 4.2), E: polar(fa - 0.75, far) }; drawFerrySign(nextNew(d)); }
      if (tour && !tourKeep) stopTour(true);
      towers.forEach(function (tw) { var s = towerSpot(tw.a, townR); tw.g.position.set(s[0], 0, s[1]); });
      drawBoard(d);
      $("t-lab-site-n").textContent = nextNew(d) == null ? "" : "+" + nextNew(d) + " moving in";
      fitHalf = aspect() < 1 ? Math.max(5.4, townR * 0.8 + 1) : Math.max(6, (townR * 0.6 + 2.2) * (stageOK ? 1.08 : 1) + 0.58 * (stageG.userData.back || 0));
      if (!st.drag && !opening) flyTo(0, 0, fitHalf);
      setWeather(d); placeMine(); life.day();

      renderLegendChips(i);
    }
    var fontsReady = document.fonts && document.fonts.load ? Promise.all(["900 40px 'Big Shoulders Stencil Display'", "600 20px 'Martian Mono'", "40px Anton"].map(function (f) { return document.fonts.load(f); })) : Promise.resolve();
    fontsReady.then(function () { drawBoard(DAYS[current]); drawFactorySign(); drawMuseumName(); stageG.userData.draw(); drawWelcome(); news.draw(); }, function () {});
    drawFactorySign(); drawMuseumName(); stageG.userData.draw();
    fontsReady.then(function () { gsDrawSign(); }, function () {}); // the gas station's sign, in the stencil letters
    fontsReady.then(ccSign, function () {}); // cc: the shop's sign, in the stencil letters
    /* the guided tour: the camera visits each landmark with a caption and the day's real numbers */
    var tour = null, tourTimer = null, tourKeep = false;
    function tourSteps() { // nine short stops at most
      var i = current, d = DAYS[i], cs = d.continents || {};
      var n0 = HOUSES.filter(function (h) { return standing(h, OLDT); }).length, nNew = shown.filter(function (h) { return fresh[h.idx]; }).length;
      var dcToday = (d.places || {}).data_center, cn = d.countries || [];
      var steps = [{ h: "Welcome to 6529 Town", p: (unkSay(d) || nOf(d.validators, "validator") + ", one house each.") + " Lights on means the house took part on " + d.label + ".", fit: true }];
      steps.push({ h: "The Ministry", p: "Once a day every validator signs one result. " + d.label + ": “" + (d.name || "not recorded") + "”" + (d.signed_pct != null ? ", " + d.signed_pct + "% signed. The red ring on the meter is the two thirds a day needs." : "."),
        tx: 0.9, tz: 0.9, half: 5, el: 0.48, az: 0.5, on: function () { var now = performance.now(); meterAnim = { from: 0, to: d.signed_pct || 0, t0: now + 500, dur: 2600, crossed: reduce || !(d.signed_pct >= 66.67) }; } });
      if (i > 0 && nNew && !unkSay(DAYS[i - 1])) steps.push({ h: "Outward from the plaza", p: nOf(nNew, "house") + " went up on " + d.label + ". Every quarter grows outward from the plaza." + (balOn ? " A gold welcome flag marks each new house for its first day." : ""), fit: true, filter: { fresh: true } });
      else if (n0 && n0 <= shown.length) steps.push({ h: "Outward from the plaza", p: "The first " + n0 + " houses stand around the plaza. Every quarter grows outward from there.", fit: true, filter: { old: true } });
      if (siteLots.length) steps.push({ h: "The building site", p: i === DAYS.length - 1 ? nextNew(d) + " more have registered for the next day. Gold frames mark where their houses go up." : nOf(nextNew(d), "new house") + " went up the next day. Gold frames mark the building lots.", tx: crane.position.x * 1.05, tz: crane.position.z * 1.05, half: 6.5, el: 0.58 });
      steps.push({ h: "The quarters", p: d.old_chain ? "Roof colour is the continent. The old chain didn't keep places, so every house here has a grey roof and the curtains drawn." :
        "Each continent has its own quarter; the flag shows the day's count. Roof colour is the continent." + (cs.not_reported ? " Grey roof and curtains drawn: place not shown (" + cs.not_reported + ")." : "") + (dcToday ? " Data centers stand apart, beyond the factory (" + dcToday + ")." : ""), fit: true, az: -0.6 });
      if (flags.length) steps.push({ h: "The town square", p: "One flag for each country validators name: " + cn.slice(0, 4).map(function (c) { return c[0]; }).join(", ") + (cn.length > 4 ? " and " + (cn.length - 4) + " more" : "") + ".", tx: 0, tz: 3.9, half: 4.6, el: 0.45 });
      if (stageOK) { var sp = stageG.userData.top, s1 = STAGE.items[0], tall = aspect() < 1, sHalf = tall ? 6.6 : 5.4, sHH = tall ? sHalf / aspect() : sHalf,
          // the camera stands on the town side and looks out at poster No. 1. Its name tag lands 16 % (phone) or 13.5 % (computer) below the
          // top edge of the picture, counting the shift the tour gives the picture (placeCam: 12 % / 9 % up), on any screen shape
          sk = 1 - (sHH * (1 - (tall ? 0.12 : 0.09) - 2 * (tall ? 0.16 : 0.135)) - sp[1] * Math.cos(0.62)) / Math.sin(0.62) / Math.hypot(sp[0], sp[2]);
        steps.push({ h: "The Main Stage", p: "Three posters in the woods: the cards that " + (stageOld() ? "led The Memes Main Stage vote at the last check. No. 1 was \u201c" : "lead The Memes Main Stage vote right now. No. 1 is \u201c") + s1.title + "\u201d by " + s1.artist + ". Tap a poster to open it on 6529.io.",
          tx: sp[0] * sk, tz: sp[2] * sk, half: sHalf, el: 0.62, azAbs: Math.atan2(-Math.cos(STAGE_A), -Math.sin(STAGE_A)) }); }
      var mh = mineHouse();
      if (mh) steps.push({ h: "Your house", p: "“" + mine.name + "”: house no. " + (mh.idx + 1) + ", here since " + DAYS[mh.day].label + ".", tx: mh.x, tz: mh.z, half: 4, el: 0.55, on: function () { hopAt[mh.idx] = performance.now(); anim = true; } });
      steps.push({ h: "That's 6529 Town", p: "It grows every day. New houses usually go up around " + localClock("00:45") + ".", fit: true, link: true, on: function () { burst(0, 0); setTimeout(function () { burst(); }, 400); setTimeout(function () { burst(); }, 900); } });
      return steps;
    }
    function tourShow(k) {
      if (!tour) return; k = Math.max(0, Math.min(tour.steps.length - 1, k)); tour.k = k; var s = tour.steps[k], last = k === tour.steps.length - 1;
      $("t-tour-n").textContent = "Tour · " + (k + 1) + " of " + tour.steps.length; $("t-tour-h").textContent = s.h; $("t-tour-p").textContent = s.p; $("t-tour-a").hidden = !s.link;
      $("t-tour-prev").disabled = k === 0; $("t-tour-next").textContent = last ? "Done" : "Next";
      var dots = $("t-tour-dots"); dots.innerHTML = ""; tour.steps.forEach(function (x, j) { var i = document.createElement("i"); if (j === k) i.className = "on"; dots.appendChild(i); });
      filter = s.filter == null ? null : s.filter; colourHouses(performance.now());
      flyTo(s.fit ? 0 : s.tx, s.fit ? 0 : s.tz, s.half || fitHalf, s.el == null ? 0.62 : s.el, s.azAbs != null ? s.azAbs : s.az == null ? null : st.az + s.az, 1700);
      if (s.on) s.on();
      clearTimeout(tourTimer); if (tour.auto && !last) tourTimer = setTimeout(function () { if (tour && tour.k === k) tourShow(k + 1); }, 8000);
    }
    /* the key under the town: each item shows where that thing is */
    var keyActive = null;
    function keyAction(k) {
      closeCard(); if (tour) stopTour(true);
      var on = keyActive !== k ? k : null; keyActive = on;
      if (chipFilter) { chipFilter = null; renderLegendChips(current); }
      filter = on === "lit" ? { lit: true } : on === "signed" ? { signed: true } : on === "dark" ? { lit: false } : on === "private" ? "not_reported" : on === "dc" ? "dc" : null;
      colourHouses(performance.now()); st.auto = false;
      if (on === "site" && siteLots.length) flyTo(crane.position.x * 1.3, crane.position.z * 1.3, 7.5, 0.6);
      else if (on === "ministry") flyTo(1.0, 1.0, 4.2, 0.42);
      else if (on === "radio") flyTo(0, 0, fitHalf * 1.3, 0.72);
      else if (on === "flags") flyTo(0, 3.9, 4.6, 0.45);
      else flyTo(0, 0, fitHalf, 0.62);
      return on;
    }
    function startTour() {
      keyActive = null; if (typeof clearKeyUI === "function") clearKeyUI();
      closeCard(); hideTip(); selectRing(null); st.auto = false; chipFilter = null; renderLegendChips(current);
      tour = { steps: tourSteps(), k: 0, auto: !reduce }; opening = 0; stage.classList.add("touring"); $("t-find").hidden = true; $("t-tour").hidden = false; $("t-tour-go").setAttribute("aria-pressed", "true"); tourShow(0);
      var r = stage.getBoundingClientRect(); if (r.top < 0 || r.bottom > window.innerHeight) stage.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    }
    function stopTour(quiet) {
      if (!tour) return; clearTimeout(tourTimer); tour = null; $("t-tour").hidden = true; stage.classList.remove("touring"); $("t-tour-go").setAttribute("aria-pressed", "false");
      filter = null; colourHouses(performance.now()); if (!quiet) { flyTo(0, 0, fitHalf, 0.62); st.auto = !reduce; }
    }
    $("t-tour-go").addEventListener("click", function () { if (tour) stopTour(); else startTour(); });
    $("t-tour-x").addEventListener("click", function () { stopTour(); });
    $("t-tour-prev").addEventListener("click", function () { if (tour) { tour.auto = false; tourShow(tour.k - 1); } });
    $("t-tour-next").addEventListener("click", function () { if (!tour) return; if (tour.k === tour.steps.length - 1) stopTour(); else { tour.auto = false; tourShow(tour.k + 1); } });
    canvas.addEventListener("pointerdown", function () { if (tour) { tour.auto = false; clearTimeout(tourTimer); } });
    window.addEventListener("keydown", function (e) {
      if (!tour) return;
      if (e.key === "Escape") stopTour(); else if (e.key === "ArrowRight") { tour.auto = false; $("t-tour-next").click(); } else if (e.key === "ArrowLeft") { tour.auto = false; tourShow(tour.k - 1); }
    });
    ["pointerdown", "pointerup"].forEach(function (ev) { $("t-tour").addEventListener(ev, function (e) { e.stopPropagation(); }); });

    /* postcard: the town as it looks now, drawn on a card to keep or post. No wallet and no address on it. */
    function postcard(kind) {
      if (opening) return null; // the opening fly-in is still on: the page asks again in a moment
      var CW = 2000, CH = 1400, M = 40, PW = CW - 2 * M, PH = 1140, yB = M + PH, d = DAYS[current], h = kind === "house" ? mineHouse() : null;
      var PAPER = "#efe5cf", INK = "#17171a", RED = "#c8291e", SOFT = "#5a5448";
      var c = document.createElement("canvas"), x = c.getContext("2d"), k; c.width = CW; c.height = CH;
      x.fillStyle = PAPER; x.fillRect(0, 0, CW, CH);
      for (k = 0; k < 2600; k++) { x.fillStyle = h2(k, 71) < 0.5 ? "rgba(60,40,10,.05)" : "rgba(255,255,255,.14)"; x.fillRect(h2(k, 72) * CW, h2(k, 73) * CH, 1 + h2(k, 74) * 2.5, 1 + h2(k, 75) * 2.5); } // paper grain
      // the picture: the same scene, drawn once at the card's own size, then everything is put back
      var keep = { tx: st.tx, tz: st.tz, half: st.half, halfT: st.halfT, el: st.el, tween: tween, sel: selected };
      var to = tween ? { tx: tween.tx, tz: tween.tz, half: tween.h, el: tween.e } : { tx: st.tx, tz: st.tz, half: st.halfT, el: st.el }; // a flight under way: take the picture where it lands
      var cardFit = Math.max(6, townR * 0.6 + 2.2); // the same view, reshaped for the card: the whole town fits when the screen shows the whole town
      try {
        tween = null; selectRing(null);
        if (h) { st.tx = h.x; st.tz = h.z; st.el = 0.55; st.half = st.halfT = 2.8; } else { st.tx = to.tx; st.tz = to.tz; st.el = to.el; st.half = st.halfT = cardFit * to.half / fitHalf; }
        cap = { w: PW, h: PH }; stageG.userData.tick(); renderer.setPixelRatio(1); renderer.setSize(PW, PH, false);
        last = performance.now(); step(last);
        x.fillStyle = "#050506"; x.fillRect(M, M, PW, PH); x.drawImage(renderer.domElement, M, M, PW, PH);
      } finally {
        cap = null; st.tx = keep.tx; st.tz = keep.tz; st.half = keep.half; st.halfT = keep.halfT; st.el = keep.el; tween = keep.tween; selectRing(keep.sel);
        resize(); last = performance.now(); step(last);
      }
      x.strokeStyle = "rgba(23,23,26,.6)"; x.lineWidth = 3; x.strokeRect(M + 1.5, M + 1.5, PW - 3, PH - 3);
      // the words
      function sp(v) { if ("letterSpacing" in x) x.letterSpacing = v + "px"; }
      function fit(size, font, parts, maxW) { var w; for (;;) { x.font = font.replace("%", size); w = 0; parts.forEach(function (q) { w += x.measureText(q[0]).width; }); if (w <= maxW || size <= 14) return; size -= 2; } }
      function line(parts, x0, y) { parts.forEach(function (q) { x.fillStyle = q[1]; x.fillText(q[0], x0, y); x0 += x.measureText(q[0]).width; }); }
      var MAXW = 1410, year = (d.date || "").slice(0, 4), dayNo = current >= FIRSTNEW && !d.old_chain ? current - FIRSTNEW + 1 : 0, site = (typeof SITE === "string" ? SITE : "").replace(/^https?:\/\//, "");
      var head = h ? [[mine.name.toUpperCase(), RED]] : [["GREETINGS FROM ", INK], ["6529 TOWN", RED]];
      var facts = (h ? ["House no. " + (h.idx + 1), "6529 Town", d.label + " " + year, d.name ? "“" + d.name + "”" : ""]
                     : [dayNo ? "Day " + dayNo : "", d.name ? "“" + d.name + "”" : "", d.label + " " + year, d.validators != null ? nOf(d.validators, "house") : ""]).concat([site])
        .filter(function (s) { return s; }).join("  ·  ").toUpperCase();
      /* resident card (rc): the "my house" card is set as a small souvenir permit of the town. Only the house card (h) runs this block. */
      if (h) {
        var rcPH = 980, rcPic = document.createElement("canvas"); rcPic.width = PW; rcPic.height = rcPH;
        rcPic.getContext("2d").drawImage(c, M, M + (PH - rcPH) / 2, PW, rcPH, 0, 0, PW, rcPH); // a lower picture, the house still in its middle
        x.fillStyle = PAPER; x.fillRect(M, M + rcPH, PW, PH - rcPH); // the paper grows up under it, with the same grain
        for (k = 0; k < 2600; k++) { var rcGx = h2(k, 72) * CW, rcGy = h2(k, 73) * CH; if (rcGx >= M && rcGx <= M + PW && rcGy >= M + rcPH && rcGy <= M + PH) { x.fillStyle = h2(k, 71) < 0.5 ? "rgba(60,40,10,.05)" : "rgba(255,255,255,.14)"; x.fillRect(rcGx, rcGy, 1 + h2(k, 74) * 2.5, 1 + h2(k, 75) * 2.5); } }
        x.drawImage(rcPic, M, M); x.fillStyle = "rgba(23,23,26,.6)"; x.fillRect(M + 3, M, PW - 6, 3); x.fillRect(M + 3, M + rcPH - 3, PW - 6, 3); // the frame's sides came along with the picture
        yB = M + rcPH; var rcDay = current - h.day + 1; // the words and the stamp move up with the paper; the house's own days (its first day is DAY 1), the postmark keeps the town's day
        head = [["RESIDENT OF ", INK], ["6529 TOWN", RED]]; facts = "";
        // three fields like a permit: a small label over a stamped value, a thin rule between them; the day count in red; the address small under the stamp
        var rcF = [["SINCE", (DAYS[h.day].label || "").toUpperCase(), INK], ["DAYS HERE", String(rcDay), RED], ["HOUSE NO.", String(h.idx + 1), INK]];
        var rcMono = 'px "Martian Mono", ui-monospace, Menlo, Consolas, monospace', rcBig = 'px "Big Shoulders Stencil Display", Anton, Impact, "Arial Narrow", sans-serif';
        var rcGap = 60, rcS = 92, rcX = M + 6, rcYl = yB + 222, rcYv = yB + 330, rcSite = site.toUpperCase(), rcSW;
        x.textAlign = "left"; x.textBaseline = "alphabetic"; sp(3); x.font = "500 22" + rcMono; rcSW = rcSite ? x.measureText(rcSite).width : 0;
        var rcW = function (f) { sp(6); x.font = "600 24" + rcMono; var rcA = x.measureText(f[0]).width; sp(2); x.font = "900 " + rcS + rcBig; return Math.max(rcA, x.measureText(f[1]).width); };
        while (rcS > 40 && rcF.reduce(function (s, f) { return s + rcW(f); }, 0) + 4 * rcGap > PW - 12 - rcSW - 90) rcS -= 4;
        rcF.forEach(function (f, i) {
          var rcFW = rcW(f);
          if (i) { x.fillStyle = "rgba(23,23,26,.3)"; x.fillRect(rcX - rcGap - 1, rcYl - 30, 2, rcYv - rcYl + 42); }
          sp(6); x.font = "600 24" + rcMono; x.fillStyle = SOFT; x.fillText(f[0], rcX + 3, rcYl);
          sp(2); x.font = "900 " + rcS + rcBig; x.fillStyle = f[2]; x.fillText(f[1], rcX, rcYv);
          rcX += rcFW + 2 * rcGap;
        });
        if (rcSite) { sp(3); x.font = "500 22" + rcMono; x.fillStyle = SOFT; x.textAlign = "right"; x.fillText(rcSite, CW - M - 6, rcYv); x.textAlign = "left"; }
      }
      x.textAlign = "left"; x.textBaseline = "alphabetic"; sp(1);
      fit(116, '900 %px "Big Shoulders Stencil Display", Anton, Impact, "Arial Narrow", sans-serif', head, MAXW); line(head, M + 6, yB + 124);
      sp(3); fit(27, '500 %px "Martian Mono", ui-monospace, Menlo, Consolas, monospace', [[facts, SOFT]], MAXW); line([[facts, SOFT]], M + 8, yB + 180);
      // the population: the day's number of houses, large in the picture's corner, so a row of cards shows the town growing
      if (!h && d.validators != null) {
        var more = nextNew(d) || 0, grow = more ? "+" + fmt(more) + (current === DAYS.length - 1 ? " REGISTERED FOR TOMORROW" : " MOVED IN THE NEXT DAY") : "";
        var num = fmt(d.validators), MONO = 'px "Martian Mono", ui-monospace, Menlo, Consolas, monospace', BIG = 'px "Big Shoulders Stencil Display", Anton, Impact, "Arial Narrow", sans-serif', asc;
        x.textAlign = "left"; x.textBaseline = "alphabetic";
        var px = M + 50, py = M + 78;
        x.save(); x.beginPath(); x.rect(M, M, PW, PH); x.clip(); // a soft shade in the corner: the words stay readable over houses too
        var sh = x.createRadialGradient(M, M, 0, M, M, 660); sh.addColorStop(0, "rgba(5,5,6,.84)"); sh.addColorStop(0.5, "rgba(5,5,6,.55)"); sh.addColorStop(1, "rgba(5,5,6,0)");
        x.fillStyle = sh; x.fillRect(M, M, 660, 660); x.restore();
        sp(8); x.font = "600 24" + MONO; x.fillStyle = "rgba(239,229,207,.82)"; x.fillText("POPULATION", px, py);
        sp(2); x.font = "900 160" + BIG; asc = x.measureText(num).actualBoundingBoxAscent || 114;
        x.fillStyle = RED; x.fillText(num, px + 6, py + 26 + asc + 6); x.fillStyle = PAPER; x.fillText(num, px, py + 26 + asc); // cream on a red shadow, like the town's name on the page
        if (grow) { sp(3); x.font = "600 21" + MONO; x.fillStyle = "#ffcf6b"; x.fillText(grow, px + 2, py + 26 + asc + 50); }
      }
      // the stamp: a little red house stamp with a perforated edge
      var SW = 150, SH = 170, sx = CW - M - SW - 6, sy = yB + 26;
      x.fillStyle = RED; x.fillRect(sx, sy, SW, SH); x.fillStyle = PAPER;
      for (k = 0; k <= 10; k++) { [[sx + k * SW / 10, sy], [sx + k * SW / 10, sy + SH], [sx, sy + k * SH / 10], [sx + SW, sy + k * SH / 10]].forEach(function (q) { x.beginPath(); x.arc(q[0], q[1], 5, 0, 6.2832); x.fill(); }); }
      x.strokeStyle = "rgba(239,229,207,.75)"; x.lineWidth = 2; x.strokeRect(sx + 13, sy + 13, SW - 26, SH - 26);
      var hx = sx + SW / 2, hy = sy + 62; x.beginPath(); x.moveTo(hx - 27, hy); x.lineTo(hx, hy - 25); x.lineTo(hx + 27, hy); x.closePath(); x.fill(); x.fillRect(hx - 19, hy + 3, 38, 26);
      x.fillStyle = RED; x.fillRect(hx - 5, hy + 12, 10, 17); x.fillStyle = PAPER; x.textAlign = "center"; sp(1);
      x.font = '400 40px Anton, Impact, "Arial Narrow", sans-serif'; x.fillText("6529", hx, sy + 136); sp(2); x.font = '600 11px "Martian Mono", ui-monospace, Menlo, monospace'; x.fillText("TOWN POST", hx + 1, sy + 153);
      // the postmark: the day's date, pressed a little crooked over the stamp's edge
      var R = 84, cx = sx - 52, cy = sy + SH / 2 + 2, INKP = "rgba(23,23,26,.8)";
      x.save(); x.translate(cx, cy); x.rotate(-0.14); x.strokeStyle = INKP; x.fillStyle = INKP; x.lineCap = "round";
      x.lineWidth = 4; x.beginPath(); x.arc(0, 0, R, 0, 6.2832); x.stroke(); x.lineWidth = 2.5; x.beginPath(); x.arc(0, 0, R - 27, 0, 6.2832); x.stroke();
      x.lineWidth = 3.5; for (k = 0; k < 4; k++) { var wy = (k - 1.5) * 27; x.beginPath(); for (var wx = -R - 14; wx >= -R - 170; wx -= 6) { var yy = wy + Math.sin(wx / 15) * 6; if (wx === -R - 14) x.moveTo(wx, yy); else x.lineTo(wx, yy); } x.stroke(); }
      x.textBaseline = "middle"; sp(0);
      function arc(str, r, mid, up) { // letters along the ring, centred on the angle mid; up = reading over the top
        var ws = [], tot = 0, i, dir = up ? 1 : -1; for (i = 0; i < str.length; i++) { ws[i] = x.measureText(str[i]).width + 3; tot += ws[i]; }
        var a = mid - dir * tot / r / 2;
        for (i = 0; i < str.length; i++) { var m = a + dir * ws[i] / r / 2; x.save(); x.translate(Math.cos(m) * r, Math.sin(m) * r); x.rotate(m + dir * Math.PI / 2); x.fillText(str[i], 0, 0); x.restore(); a += dir * ws[i] / r; }
      }
      x.font = '600 17px "Martian Mono", ui-monospace, Menlo, monospace'; arc("6529 TOWN", R - 13.5, -Math.PI / 2, true); arc(dayNo ? "DAY " + dayNo : "OLD CHAIN", R - 13.5, Math.PI / 2, false);
      x.font = '400 34px Anton, Impact, "Arial Narrow", sans-serif'; x.fillText((d.label || "").replace(/^\S+\s+/, "").toUpperCase(), 0, -8);
      x.font = '600 15px "Martian Mono", ui-monospace, Menlo, monospace'; x.fillText(year, 0, 24);
      x.restore();
      return c;
    }
    return { postcard: postcard, myHouse: function () { var mh = mineHouse(); return mh ? { no: mh.idx + 1, name: mine.name } : null; }, tour: startTour, enter: function () { st.half = st.halfT = fitHalf * 2.6; placeCam(); flyTo(0, 0, fitHalf, 0.62); st.auto = !reduce; },
             leave: function () { flyTo(st.tx, st.tz, fitHalf * 2.4); },
             setFilter: function (k) { if (tour) stopTour(true); keyActive = null; if (typeof clearKeyUI === "function") clearKeyUI(); filter = k || null; colourHouses(performance.now()); return filter; },
             keyAction: keyAction, keyNow: function () { return keyActive; },
             emptyCount: function () { return shown.filter(function (h) { return !litNow[h.idx]; }).length; },
             show: show, setActive: function (a) { active = a; if (a) { last = performance.now(); resize(); } }, visitMinistry: function () { flyTo(0, 0, 5.5, 0.55); closeCard(); }, fit: function () { flyTo(0, 0, fitHalf, 0.62); st.auto = !reduce; } };
  }
  function emptyChip(box) { // houses whose validator took part before but not on this day: one more chip in the roof line, only on days that have some
    if (!townView || !townView.emptyCount) return;
    var n = townView.emptyCount(), on = townView.keyNow() === "dark";
    if (!n) { if (on) townView.setFilter(null); return; }
    var el = document.createElement("button"); el.className = "chip"; el.type = "button"; el.dataset.key = "dark"; el.setAttribute("aria-pressed", on ? "true" : "false");
    el.innerHTML = "<i class='mt'></i><b></b><span></span>"; el.children[1].textContent = n; el.children[2].textContent = n === 1 ? "empty house" : "empty houses";
    box.appendChild(el);
  }
  var chipFilter = null;
  function renderLegendChips(i) {
    var d = DAYS[i], cs = d.continents || {}, box = $("t-legend"); box.innerHTML = "";
    function wire(el, key) {
      el.setAttribute("aria-pressed", chipFilter === key ? "true" : "false");
      el.addEventListener("click", function () {
        chipFilter = chipFilter === key ? null : key; if (townView) townView.setFilter(chipFilter);
        [].forEach.call(box.children, function (b) { b.setAttribute("aria-pressed", b.dataset.k === chipFilter ? "true" : "false"); });
        box.classList.toggle("filtering", !!chipFilter);
      });
    }
    box.classList.toggle("filtering", !!chipFilter);
    if (d.old_chain) { var oc = document.createElement("span"); oc.className = "chip"; oc.innerHTML = "<i></i><b></b><span>old chain · places not recorded</span>"; oc.firstChild.style.background = CCOL.not_reported; oc.children[1].textContent = fmt(d.validators); box.appendChild(oc); emptyChip(box); return; }
    CKEYS.forEach(function (c) {
      if (!cs[c]) return; var el = document.createElement("button"); el.className = "chip"; el.dataset.k = c; wire(el, c);
      el.innerHTML = "<i></i><b></b><span></span>"; el.firstChild.style.background = CCOL[c]; el.children[1].textContent = cs[c]; el.children[2].textContent = CLAB[c] + (c === "not_reported" ? " (curtains drawn)" : "");
      box.appendChild(el);
    });
    var dc = (d.places || {}).data_center; if (dc) { var el = document.createElement("button"); el.className = "chip"; el.dataset.k = "dc"; wire(el, "dc"); el.innerHTML = "<i class='dc'></i><b></b><span>data center towers</span>"; el.children[1].textContent = dc; box.appendChild(el); }
    emptyChip(box);
  }
