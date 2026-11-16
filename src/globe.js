  /* ================= "Where they are": just the globe, one house per validator on its continent ================= */
  function makeGlobe() {
    var canvas = $("g-canvas"), stage = $("g-stage"), renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true }); } catch (e) { return null; }
    var gl = renderer.getContext(); if (!gl) return null;
    var ptr = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE), MAXPT = ptr && ptr[1] ? ptr[1] : 64;
    renderer.setClearColor(0x000000, 0);
    var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
    var HOME = 5.4, dist = 18, distTarget = HOME, tStart = performance.now(), SF = 1, PR = 1;
    var world = new THREE.Group(); scene.add(world);
    scene.add(new THREE.HemisphereLight(0xfff1d6, 0x1a1a2a, 0.46));
    // real daylight: the sun stands over the place where it is noon now, so the night side is dark and its houses glow
    var sun = new THREE.DirectionalLight(0xfff6e6, 0.86); world.add(sun); world.add(sun.target);
    var SUNV = new THREE.Vector3(1, 0, 0);
    function placeSun() {
      var now = Date.now(), d = new Date(now), doy = (now - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
      var decl = -23.44 * Math.cos(2 * Math.PI / 365 * (doy + 10)), h = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
      var lon = ((-15 * (h - 12)) % 360 + 540) % 360 - 180;
      SUNV.copy(pos(decl, lon, 1)); sun.position.copy(SUNV).multiplyScalar(10);
      layers.forEach(function (L) { L.mat.uniforms.uSun.value.copy(SUNV); });
    }
    // a faint sky behind the planet
    (function () {
      var n = 520, P = new Float32Array(n * 3), g = new THREE.BufferGeometry();
      for (var k = 0; k < n; k++) { var u = 2 * hash0(k * 3 + 1) - 1, a = 6.2832 * hash0(k * 3 + 2), r = 34 + 8 * hash0(k * 3 + 3), q = Math.sqrt(1 - u * u);
        P[k * 3] = r * q * Math.cos(a); P[k * 3 + 1] = r * u; P[k * 3 + 2] = r * q * Math.sin(a) - 12; }
      g.setAttribute("position", new THREE.BufferAttribute(P, 3));
      var stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xd8dcff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false }));
      stars.frustumCulled = false; scene.add(stars);
    })();
    function hash0(n) { n = Math.imul(n ^ 1540483477, 668265261) ^ (n >>> 15); n = Math.imul(n ^ (n >>> 13), 374761393); return ((n ^ (n >>> 16)) >>> 0) / 4294967295; }
    var grad = new THREE.DataTexture(new Uint8Array([64, 64, 64, 112, 112, 112, 172, 172, 172, 226, 226, 226, 255, 255, 255]), 5, 1, THREE.RGBFormat);
    grad.minFilter = grad.magFilter = THREE.LinearFilter; grad.generateMipmaps = false; grad.needsUpdate = true; // soft day/night edge
    var TW = renderer.capabilities.maxTextureSize >= 4096 && window.innerWidth > 900 ? 4096 : 2048; // phones get the lighter map
    var tex = new THREE.CanvasTexture(drawLand(TW)); tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    world.add(new THREE.Mesh(new THREE.SphereGeometry(1, 128, 80), new THREE.MeshToonMaterial({ color: 0xffffff, map: tex, gradientMap: grad })));
    world.add(new THREE.Mesh(new THREE.SphereGeometry(1.016, 64, 48), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide })));

    var layers = [];
    function SpriteLayer(img, cols, rows, cap, o) {
      var g = new THREE.BufferGeometry(), P = new Float32Array(cap * 3), N = new Float32Array(cap * 3), CELL = new Float32Array(cap), SIZE = new Float32Array(cap), BORN = new Float32Array(cap);
      g.setAttribute("position", new THREE.BufferAttribute(P, 3)); g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
      g.setAttribute("cell", new THREE.BufferAttribute(CELL, 1)); g.setAttribute("size", new THREE.BufferAttribute(SIZE, 1)); g.setAttribute("born", new THREE.BufferAttribute(BORN, 1));
      g.setDrawRange(0, 0);
      var t = new THREE.CanvasTexture(img); t.anisotropy = 4;
      var m = new THREE.ShaderMaterial({ vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS,
        uniforms: { uAtlas: { value: t }, uCols: { value: cols }, uRows: { value: rows }, uTime: { value: 0 }, uBase: { value: o.base }, uMinPx: { value: o.min }, uMaxPx: { value: o.max }, uViewH: { value: 800 }, uShift: { value: o.shift == null ? 0.5 : o.shift }, uLean: { value: o.lean == null ? 1 : o.lean }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uNightK: { value: o.night ? 1 : 0 }, uMaxPt: { value: MAXPT }, uAdd: { value: o.add ? 1 : 0 } },
        transparent: !!o.add, depthWrite: !o.add, blending: o.add ? THREE.AdditiveBlending : THREE.NormalBlending });
      var pts = new THREE.Points(g, m); pts.frustumCulled = false; if (o.order) pts.renderOrder = o.order; world.add(pts);
      var L = { mat: m, tex: t, o: o, CELL: CELL,
        set: function (i, p, cell, size, born) { P[i * 3] = p.x; P[i * 3 + 1] = p.y; P[i * 3 + 2] = p.z; N[i * 3] = p.x; N[i * 3 + 1] = p.y; N[i * 3 + 2] = p.z; CELL[i] = cell; SIZE[i] = size; BORN[i] = born; },
        count: function (n) { g.setDrawRange(0, n); ["position", "normal", "cell", "size", "born"].forEach(function (a) { g.attributes[a].needsUpdate = true; }); },
        cellOnly: function () { g.attributes.cell.needsUpdate = true; } };
      layers.push(L); return L;
    }
    var housesL = SpriteLayer(houseAtlas(), 8, 4, 2600, { base: 0.034, min: 15, max: 42 });
    var orbitL = SpriteLayer(houseAtlas(), 8, 4, 2600, { base: 0.034, min: 13, max: 36 });
    var glowImg = (function () { var c = document.createElement("canvas"); c.width = c.height = 64; var x = c.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,207,107,.55)"); g.addColorStop(0.3, "rgba(255,170,70,.18)"); g.addColorStop(1, "rgba(255,140,40,0)"); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return c; })();
    var glowL = SpriteLayer(glowImg, 1, 1, 2600, { base: 0.055, min: 26, max: 78, shift: 0.2, add: true, order: 3, night: true });
    var towersL = SpriteLayer(towerAtlas(), 2, 1, 16, { base: 0.03, min: 12, max: 38, lean: 0.8 });
    RELAYS.forEach(function (r, i) { towersL.set(i, pos(r.lat, r.lon, 1), 0, 1.8, -99999); }); towersL.count(RELAYS.length);
    var waves = RELAYS.map(function (r, i) {
      var m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color: 0xff3b2a, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
      var n = pos(r.lat, r.lon, 1); m.position.copy(n).multiplyScalar(1.004); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n); world.add(m); return { m: m, ph: i * 0.37 };
    });
    var hash = function (n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 668265261); n = n ^ (n >>> 15); return (n >>> 0) / 4294967295; };
    function pick(s, k, spread) { var L = Math.max(1, s.length), b = s[k % L] || [0, 0], ring = Math.floor(k / L); if (!ring) return b; var a = k * 2.399, d = spread * ring; return [b[0] + Math.sin(a) * d, b[1] + Math.cos(a) * d]; }
    var CSITES = DATA.csites || {}, PLAN = (DATA.homes && DATA.homes.globe) || [];
    var shownKeys = {}, orbit = [], HP = [], RP = RELAYS.map(function (r) { return pos(r.lat, r.lon, 1); });
    function show(i) {
      var P = PLAN[i] || { c: [], k: {}, o: 0 }, now = performance.now() - tStart, n = 0, g = 0, seen = {}, lost = 0;
      function born(key, j) { var b = key in shownKeys ? shownKeys[key] : now + (reduce ? -99999 : (j % 50) * 16); seen[key] = b; return b; }
      function house(key, ll, kind, meta) { var p = pos(ll[0], ll[1], 1), b = born(key, n); housesL.set(n++, p, Math.floor(kind * 6), 0.85 + hash(n * 13 + 7) * 0.3, b); glowL.set(g++, p, 0, 1, b + 200); meta.p = p; HP.push(meta); }
      HP = [];
      (P.c || []).forEach(function (cc, ci) {
        var s = CSITES[cc[0]]; if (!s) { lost += cc[1]; return; }
        for (var k = 0; k < cc[1]; k++) house("c:" + cc[0] + ":" + k, pick(s, k, 0.25), hash(ci * 977 + k * 31 + 3), { country: cc[0] });
      });
      CONT.forEach(function (c, ci) { for (var k = 0; k < ((P.k || {})[c[0]] || 0); k++) house("k:" + c[0] + ":" + k, pick(SITES[c[0]] || [], k, 0.5), hash(ci * 7919 + k * 31 + 1), { cont: c[0] }); });
      housesL.count(n); glowL.count(g);
      var no = (P.o || 0) + lost; orbit = [];
      for (var k = 0; k < no; k++) orbit.push({ a: 6.2832 * hash(k * 7 + 11), w: 0.05 + 0.035 * hash(k * 7 + 12), r: 1.2 + 0.11 * hash(k * 7 + 13), h: (hash(k * 7 + 14) - 0.5) * 0.09,
        cell: 16 + Math.floor(hash(k * 7 + 15) * 6), size: 0.8 + 0.3 * hash(k * 7 + 16), born: born("o:" + k, k) });
      shownKeys = seen; placeOrbit(now); orbitL.count(no);
    }
    // validators that show no place circle the planet: curtained houses, like in town
    var TILT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42, 0, -0.22)), ov = new THREE.Vector3();
    function placeOrbit(tms) {
      var t = tms / 1000;
      orbit.forEach(function (o, k) { var a = o.a + (reduce ? 0 : t * o.w); ov.set(o.r * Math.cos(a), o.h, o.r * Math.sin(a)).applyQuaternion(TILT); orbitL.set(k, ov, o.cell, o.size, o.born); (o.p = o.p || new THREE.Vector3()).copy(ov); });
      orbitL.count(orbit.length);
    }

    var st = { yaw: 0, pitch: 0, auto: !reduce, drag: null, idle: 0 }, tween = null;
    function lookAt(lat, lon) { return { yaw: -Math.PI / 2 - lon * Math.PI / 180, pitch: lat * Math.PI / 180 }; }
    var s0 = lookAt(28, -30); st.yaw = s0.yaw; st.pitch = s0.pitch;
    function flyTo(lat, lon, d, dur) {
      var to = lookAt(lat, lon), dy = to.yaw - st.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      tween = { t0: performance.now(), y0: st.yaw, p0: st.pitch, d0: distTarget, dy: dy, dp: to.pitch - st.pitch, dd: d - distTarget, dur: reduce ? 1 : (dur || 1600) };
    }
    stage.addEventListener("pointerdown", function (e) { st.drag = { x: e.clientX, y: e.clientY, yaw: st.yaw, pitch: st.pitch, moved: 0, id: e.pointerId }; tween = null; });
    stage.addEventListener("pointermove", function (e) {
      if (!st.drag || e.pointerId !== st.drag.id) return;
      var dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y, k = 3.2 / Math.min(stage.clientWidth, stage.clientHeight) * (dist / HOME);
      st.drag.moved = Math.max(st.drag.moved, Math.abs(dx) + Math.abs(dy));
      if (st.drag.moved > 6) { if (!stage.classList.contains("drag")) { stage.classList.add("drag"); try { stage.setPointerCapture(e.pointerId); } catch (x) {} } st.auto = false; $("g-hint").style.opacity = 0; }
      st.yaw = st.drag.yaw + dx * k; st.pitch = Math.max(-1.3, Math.min(1.3, st.drag.pitch + dy * k));
    });
    var tipEl = $("g-tip"), tipTimer = null, hv = new THREE.Vector3(), hoverQ = null;
    function nearest(cx, cy) {
      var r = stage.getBoundingClientRect(), W = r.width, H = r.height, best = null, bd = 24 * 24, c = camera.position;
      world.updateMatrixWorld(); camera.updateMatrixWorld();
      function test(local, meta, onGlobe) {
        hv.copy(local).applyMatrix4(world.matrixWorld);
        if (onGlobe ? hv.dot(c) < 1.02 : hv.z < 0 && Math.hypot(hv.x, hv.y) < 1) return; // behind the planet
        hv.project(camera); var sx = (hv.x + 1) / 2 * W, sy = (1 - hv.y) / 2 * H, dx = sx - (cx - r.left), dy = sy - (cy - r.top), d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = { meta: meta, sx: sx, sy: sy }; }
      }
      HP.forEach(function (m) { test(m.p, m, true); });
      orbit.forEach(function (o) { if (o.p) test(o.p, { orbit: true }, false); });
      RP.forEach(function (p, i) { test(p, { relay: RELAYS[i].name }, true); });
      return best;
    }
    function tipText(m) {
      var d = DAYS[current] || {};
      if (m.relay) return "6529 relay · " + m.relay;
      if (m.orbit) return d.old_chain ? "The old chain kept no places, so this validator circles the planet" : "A validator that shows no place, so it circles the planet";
      if (m.country) return "A validator that names " + m.country;
      return "A validator that names only " + (CNAME[m.cont] || "its continent") + " · this spot is picked for the picture";
    }
    function showTip(hit, sticky) {
      clearTimeout(tipTimer);
      if (!hit) { tipEl.classList.remove("on"); stage.style.cursor = ""; return; }
      tipEl.textContent = tipText(hit.meta); stage.style.cursor = sticky ? "" : "pointer";
      var W = stage.clientWidth, w = tipEl.offsetWidth, h = tipEl.offsetHeight, x = Math.max(8, Math.min(W - w - 8, hit.sx - w / 2)), y = hit.sy - h - 14;
      if (y < 8) y = hit.sy + 18;
      tipEl.style.transform = "translate(" + x.toFixed(0) + "px," + y.toFixed(0) + "px)"; tipEl.classList.add("on");
      if (sticky) tipTimer = setTimeout(function () { tipEl.classList.remove("on"); }, 4500);
    }
    stage.addEventListener("pointermove", function (e) {
      if (st.drag || e.pointerType !== "mouse" || hoverQ) return; var cx = e.clientX, cy = e.clientY;
      hoverQ = requestAnimationFrame(function () { hoverQ = null; showTip(nearest(cx, cy), false); });
    });
    stage.addEventListener("pointerleave", function () { showTip(null); });
    function endDrag(e) {
      if (!st.drag) return; var tap = st.drag.moved < 6; st.drag = null; stage.classList.remove("drag"); st.idle = performance.now();
      if (tap && e && e.type === "pointerup") showTip(nearest(e.clientX, e.clientY), true);
    }
    stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", endDrag);
    stage.addEventListener("wheel", function (e) { e.preventDefault(); distTarget = Math.max(2.2, Math.min(8, distTarget * Math.exp(e.deltaY * 0.0012))); tween = null; }, { passive: false });
    var pinch = null;
    stage.addEventListener("touchstart", function (e) { if (e.touches.length === 2) { var a = e.touches[0], b = e.touches[1]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), z: distTarget }; } }, { passive: true });
    stage.addEventListener("touchmove", function (e) { if (pinch && e.touches.length === 2) { var a = e.touches[0], b = e.touches[1]; distTarget = Math.max(2.2, Math.min(8, pinch.z * pinch.d / Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY))); if (st.drag) st.drag.moved = 99; } }, { passive: true });
    stage.addEventListener("touchend", function () { pinch = null; }, { passive: true });

    var visible = true, active = false, last = performance.now();
    function resize() {
      var w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return; PR = Math.min(window.devicePixelRatio || 1, 1.75); SF = Math.max(0.8, Math.min(1, Math.min(w, h) / 640));
      renderer.setPixelRatio(PR); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
      layers.forEach(function (L) { L.mat.uniforms.uViewH.value = h * PR; L.mat.uniforms.uMinPx.value = L.o.min * PR * SF; L.mat.uniforms.uMaxPx.value = L.o.max * PR * SF; });
    }
    window.addEventListener("resize", resize); resize();
    function frame(now) {
      requestAnimationFrame(frame);
      if (!visible || !active || document.hidden) { last = now; return; }
      var raw = Math.min(1, (now - last) / 1000), dt = Math.min(0.05, raw); last = now; var t = (now - tStart) / 1000;
      if (tween) {
        var p = Math.min(1, (now - tween.t0) / tween.dur), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        st.yaw = tween.y0 + tween.dy * e; st.pitch = tween.p0 + tween.dp * e; distTarget = tween.d0 + tween.dd * e; if (p >= 1) tween = null;
      } else if (st.auto) st.yaw -= dt * 0.055;
      else if (!st.drag && st.idle && now - st.idle > 10000 && !reduce) st.auto = true;
      dist += (distTarget - dist) * (1 - Math.exp(-raw * 4));
      camera.position.set(0, 0, dist); camera.lookAt(0, 0, 0);
      world.rotation.set(st.pitch, st.yaw, 0, "XYZ");
      layers.forEach(function (L) { L.mat.uniforms.uTime.value = now - tStart; });
      if (orbit.length) placeOrbit(now - tStart);
      if (!frame.sunAt || now - frame.sunAt > 20000) { frame.sunAt = now; placeSun(); }
      for (var i = 0; i < RELAYS.length; i++) towersL.CELL[i] = Math.sin(t * 3 + i) > 0 ? 0 : 1; towersL.cellOnly();
      waves.forEach(function (w) { var ph = (t * 0.45 + w.ph) % 1; w.m.scale.setScalar(0.005 + ph * 0.07); w.m.material.opacity = (1 - ph) * 0.65; });
      renderer.render(scene, camera);
    }
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; }).observe(stage);
    requestAnimationFrame(frame);
    return { show: show,
      setActive: function (a) { active = a; if (a) { last = performance.now(); resize(); } },
      enter: function () { resize(); dist = 18; distTarget = 18; var to = lookAt(28, -30); st.yaw = to.yaw + 1.6; st.pitch = to.pitch; st.auto = !reduce; flyTo(28, -30, HOME, 2200); },
      visit: function () { flyTo(SWISS[0] - 3, SWISS[1], 2.6); st.auto = false; },
      whole: function () { flyTo(28, -30, HOME); setTimeout(function () { if (!st.drag) st.auto = !reduce; }, 1700); } };
  }
