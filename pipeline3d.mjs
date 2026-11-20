// 派工「流水線」3D 視圖（three.js）。dashboard.html 用 import('/pipeline3d.mjs') 載入，傳進整理好的 model。
// model = { pods:[{key,label,kind,state,map,rate,members:[{id,name,lv,ava}]}], stations:[{id,name,lane,n,rate,sell,goals}], sinks:{exp,shop,bag}, flows:[{from,to,rate,color,label}] }
// 只負責畫：點擊、套用都回呼給 dashboard。
import { THREE, OrbitControls, EffectComposer, RenderPass, UnrealBloomPass, OutputPass, CSS2DRenderer, CSS2DObject } from './three-bundle.mjs?v=r187';

const LANE_HEX = { train: 0x4ade80, scroll: 0xa78bfa, gear: 0xf08a5d, boss: 0xf43f5e };
const STATE_HEX = { ok: 0x38bdf8, moving: 0xfacc15, away: 0xfb923c, boss: 0xf43f5e, idle: 0x64748b };
const X = { pod: -16, st: 0, sink: 15 };

export function webglOk() {
  try { const c = document.createElement('canvas'); return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl'))); } catch (_) { return false; }
}

let glowTex = null;
function glow() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.25, 'rgba(255,255,255,.8)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c); glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
const short = n => { n = Number(n) || 0; const a = Math.abs(n); return a >= 1e8 ? (n / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '億' : a >= 1e4 ? (n / 1e4).toFixed(a >= 1e5 ? 0 : 1) + '萬' : String(Math.round(n)); };
const escH = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mount(el, opts = {}) {
  if (!webglOk()) throw new Error('這台電腦的瀏覽器不支援 WebGL');
  el.innerHTML = '';
  el.classList.add('p3d');
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  el.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer(); labels.domElement.className = 'p3d-labels'; el.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b14);
  scene.fog = new THREE.FogExp2(0x070b14, 0.012);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  camera.position.set(0, 26, 34);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 10; controls.maxDistance = 120;
  controls.target.set(0, 0, 0);
  let userCam = false;
  try { const v = JSON.parse(localStorage.getItem('p3dCam') || 'null'); if (v) { camera.position.fromArray(v.p); controls.target.fromArray(v.t); userCam = true; } } catch (_) {}
  controls.addEventListener('start', () => { userCam = true; });
  controls.addEventListener('end', () => { try { localStorage.setItem('p3dCam', JSON.stringify({ p: camera.position.toArray(), t: controls.target.toArray() })); } catch (_) {} });

  scene.add(new THREE.AmbientLight(0x8899bb, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(10, 30, 20); scene.add(key);
  // 地板格線＋星塵
  const grid = new THREE.GridHelper(160, 80, 0x1e3a5f, 0x0f1d33); grid.position.y = -0.6; grid.material.transparent = true; grid.material.opacity = 0.55; scene.add(grid);
  { const n = 600, p = new Float32Array(n * 3); for (let i = 0; i < n; i++) { p[i * 3] = (Math.random() - .5) * 160; p[i * 3 + 1] = Math.random() * 40 + 2; p[i * 3 + 2] = (Math.random() - .5) * 160; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.35, map: glow(), color: 0x6b8cff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }))); }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1.0, 0.45, 0.5);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const world = new THREE.Group(); scene.add(world);
  const texCache = new Map(), loader = new THREE.TextureLoader();
  const avaTex = url => { if (!texCache.has(url)) { const t = loader.load(url); t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; texCache.set(url, t); } return texCache.get(url); };

  let nodes = {}, flows = [], spinners = [], clickables = [], orbs = [], sig = '', model = null;

  function label(html, cls, y) {
    const d = document.createElement('div'); d.className = 'p3d-lbl ' + (cls || ''); d.innerHTML = html;
    const o = new CSS2DObject(d); o.position.set(0, y, 0); return o;
  }
  function clearWorld() {
    world.traverse(o => { if (o.isCSS2DObject && o.element) o.element.remove(); if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach(m => m.dispose()); });
    world.clear(); nodes = {}; flows = []; spinners = []; clickables = [];
    for (const o of orbs) o.el.remove(); orbs = [];
  }
  const zs = (n, gap) => Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * gap);

  function buildPod(p, z) {
    const g = new THREE.Group(); g.position.set(X.pod, 0, z);
    const col = STATE_HEX[p.state] || STATE_HEX.ok;
    const w = Math.max(2.2, p.members.length * 1.5 + 0.6);
    const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.35, 2.4), new THREE.MeshStandardMaterial({ color: 0x15213a, metalness: 0.6, roughness: 0.35 }));
    base.position.y = -0.3; g.add(base);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.08, 2.52), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(0.55) }));
    rim.position.y = -0.1; g.add(rim); g.userData.rim = rim;
    p.members.forEach((m, i) => {
      const x = (i - (p.members.length - 1) / 2) * 1.5;
      let s;
      if (m.ava) { s = new THREE.Sprite(new THREE.SpriteMaterial({ map: avaTex(m.ava), color: 0xb8b8b8, transparent: true, alphaTest: 0.1 })); s.scale.set(2.2, 2.2, 1); s.position.set(x, 1.0, 0.2); }
      else { s = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.8, 4, 10), new THREE.MeshStandardMaterial({ color: 0x334155, emissive: col, emissiveIntensity: 0.25 })); s.position.set(x, 0.65, 0.2); }
      g.add(s);
      const h = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: col, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
      h.scale.set(1.6, 0.5, 1); h.position.set(x, -0.05, 0.2); g.add(h);
      if (i === 0 && p.kind === 'party' && p.members.length > 1) { const c = label('👑', 'crown', 2.35); c.position.x = x; g.add(c); } // 隊長
    });
    const lb = label('', 'pod', -1.25); g.add(lb); g.userData.lbl = lb.element;
    const hit = new THREE.Mesh(new THREE.BoxGeometry(w, 3, 2.6), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 1; hit.userData.pick = { type: 'pod', key: p.key }; g.add(hit); clickables.push(hit);
    world.add(g);
    return { g, out: new THREE.Vector3(X.pod + w / 2 + 0.2, 0.2, z), w };
  }
  function buildStation(s, z) {
    const g = new THREE.Group(); g.position.set(X.st, 0, z);
    const col = LANE_HEX[s.lane] || LANE_HEX.train;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.09, 12, 64), new THREE.MeshBasicMaterial({ color: col }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.9; g.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.05, 8, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7 }));
    ring2.position.y = 0.9; g.add(ring2);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 1), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: s.n ? 1.6 : 0.3, flatShading: true }));
    core.position.y = 0.9; g.add(core);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.1, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0x121a2e, metalness: 0.7, roughness: 0.3 }));
    pad.position.y = -0.35; g.add(pad);
    spinners.push({ o: ring, ax: 'z', v: 0.6 }, { o: ring2, ax: 'y', v: -0.9 }, { o: core, ax: 'y', v: 0.8, bob: true, y0: 0.9 });
    const lb = label('', 'st', -1.4); g.add(lb); g.userData.lbl = lb.element; g.userData.core = core;
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 3, 8), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 0.6; hit.userData.pick = { type: 'station', key: s.id }; g.add(hit); clickables.push(hit);
    world.add(g);
    return { g, in: new THREE.Vector3(X.st - 2, 0.6, z), out: new THREE.Vector3(X.st + 2, 0.6, z) };
  }
  function buildSink(k, z) {
    const g = new THREE.Group(); g.position.set(X.sink, 0, z);
    const conf = { exp: [0x4ade80, new THREE.OctahedronGeometry(1.3, 0)], shop: [0xfacc15, new THREE.CylinderGeometry(1.2, 1.2, 0.35, 40)], bag: [0x60a5fa, new THREE.BoxGeometry(1.5, 1.2, 1.1)] }[k];
    const m = new THREE.Mesh(conf[1], new THREE.MeshStandardMaterial({ color: conf[0], emissive: conf[0], emissiveIntensity: 0.9, metalness: 0.5, roughness: 0.25, flatShading: k === 'exp' }));
    m.position.y = 1.3; if (k === 'shop') m.rotation.x = Math.PI / 2; g.add(m);
    spinners.push({ o: m, ax: k === 'shop' ? 'z' : 'y', v: k === 'bag' ? 0.25 : 0.7, bob: true, y0: 1.3 });
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: conf[0], transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.scale.set(6, 6, 1); halo.position.y = 1.3; g.add(halo);
    const lb = label('', 'sink', -0.9); g.add(lb); g.userData.lbl = lb.element; g.userData.mesh = m;
    const hit = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 1.2; hit.userData.pick = { type: 'sink', key: k }; g.add(hit); clickables.push(hit);
    world.add(g);
    return { g, in: new THREE.Vector3(X.sink - 1.9, 1.0, z) };
  }
  function buildFlow(f, a, b) {
    const mid = a.clone().lerp(b, 0.5); mid.y += 1.2 + a.distanceTo(b) * 0.06;
    const curve = new THREE.CatmullRomCurve3([a, a.clone().lerp(mid, 0.5).setY(mid.y * 0.8), mid, b.clone().lerp(mid, 0.5).setY(mid.y * 0.8), b]);
    const col = new THREE.Color(f.color);
    const on = f.rate > 0;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, on ? 0.07 : 0.035, 8, false), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: on ? 0.35 : 0.12, depthWrite: false, blending: THREE.AdditiveBlending }));
    world.add(tube);
    const n = on ? Math.round(Math.min(26, 6 + Math.log10(1 + f.rate) * 2.6)) : 0;
    const pos = new Float32Array(Math.max(1, n) * 3), ts = Array.from({ length: n }, (_, i) => i / n);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.55, map: glow(), color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    if (n) world.add(pts);
    // 速度：每小時經驗越高流越快（對數，避免差太多）
    const speed = on ? 0.05 + Math.min(0.35, Math.log10(1 + f.rate) * 0.035) : 0;
    const fl = { f, curve, tube, pts, ts, speed, key: f.from + '>' + f.to };
    if (f.label) { const lb = label(escH(f.label), 'flow', 0); lb.position.copy(curve.getPointAt(0.5)).add(new THREE.Vector3(0, 0.45, 0)); world.add(lb); fl.lbl = lb.element; }
    flows.push(fl);
    return fl;
  }

  function build(m) {
    clearWorld();
    const podZ = zs(m.pods.length, 4.2), stZ = zs(m.stations.length, 5.2), sinkKeys = ['exp', 'shop', 'bag'], sinkZ = zs(3, 7);
    m.pods.forEach((p, i) => nodes['p:' + p.key] = buildPod(p, podZ[i]));
    m.stations.forEach((s, i) => nodes['s:' + s.id] = buildStation(s, stZ[i]));
    sinkKeys.forEach((k, i) => nodes['k:' + k] = buildSink(k, sinkZ[i]));
    for (const f of m.flows) {
      const a = nodes[f.from], b = nodes[f.to]; if (!a || !b) continue;
      buildFlow(f, a.out, b.in);
    }
    const span = Math.max(m.pods.length * 4.2, m.stations.length * 5.2, 16);
    grid.scale.setScalar(Math.max(1, span / 60));
    fitSpan = span; if (!userCam) fit();
  }
  let fitSpan = 16;
  // 依內容大小擺鏡頭：整條流水線（左右約 36 格）和最高的一欄都要看得到
  function fit() { const w = Math.max(fitSpan, 30); camera.position.set(0, w * 0.45 + 3, w * 0.5 + 6); controls.target.set(0, 0, 0); camera.lookAt(0, 0, 0); }
  function refreshLabels(m) {
    for (const p of m.pods) { const n = nodes['p:' + p.key]; if (!n) continue;
      n.g.userData.lbl.innerHTML = `<b>${escH(p.label)}</b>${p.badge ? ` <span class="bd ${p.state}">${escH(p.badge)}</span>` : ''}<br><span class="rt">${p.rate != null ? short(p.rate) + '/時' : '—'}</span>`;
      n.g.userData.rim.material.color.setHex(STATE_HEX[p.state] || STATE_HEX.ok).multiplyScalar(0.55); }
    for (const s of m.stations) { const n = nodes['s:' + s.id]; if (!n) continue;
      n.g.userData.lbl.innerHTML = `<b>${escH(s.name)}</b><br><span class="dim">${s.n} 隻${s.sell ? '・💰' : ''}${s.goals ? '・🎯' + s.goals : ''}</span>${s.rate ? `<br><span class="rt">${short(s.rate)}/時</span>` : ''}`; }
    const K = m.sinks || {};
    const put = (k, h) => { const n = nodes['k:' + k]; if (n) n.g.userData.lbl.innerHTML = h; };
    put('exp', `<b>經驗</b><br><span class="rt big">${short(K.exp || 0)}</span><span class="dim">/時</span>`);
    put('shop', `<b>商店</b><br><span class="dim">${K.shopMaps || 0} 張圖自動販售</span>${K.shopRecent ? `<br><span class="rt">+${short(K.shopRecent)} 楓幣</span>` : ''}`);
    put('bag', `<b>背包</b><br><span class="dim">${K.bagRecent ? `最近撿到 ${K.bagRecent} 件` : '撿到的東西'}</span>`);
  }

  function update(m) {
    model = m;
    const s = JSON.stringify([m.pods.map(p => [p.key, p.map, p.members.map(x => x.id + (x.ava || ''))]), m.stations.map(x => [x.id, x.lane, x.n > 0]), m.flows.map(f => [f.from, f.to, f.color, f.label, f.rate > 0, Math.round(Math.log10(1 + f.rate) * 2)])]);
    if (s !== sig) { sig = s; build(m); }
    refreshLabels(m);
  }

  // 掉落：從地圖站飛到背包或商店的光球（圖示用 CSS2D 疊在上面，外部圖片不能當 WebGL 貼圖）
  function loot(ev) {
    if (orbs.length > 24 || document.hidden) return false;
    const fl = flows.find(x => x.f.from === 's:' + ev.map && x.f.to === 'k:' + (ev.sold ? 'shop' : 'bag')) || flows.find(x => x.f.from === 's:' + ev.map);
    if (!fl) return false;
    const d = document.createElement('div'); d.className = 'p3d-loot' + (ev.goal ? ' goal' : '') + (ev.sold ? ' sold' : '');
    d.innerHTML = (ev.img ? `<img src="${escH(ev.img)}" alt="${escH(String(ev.name || '').slice(0, 2))}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:this.alt}))">` : `<span>${escH(String(ev.name || '').slice(0, 2))}</span>`) + (ev.qty > 1 ? `<b>${ev.qty}</b>` : '');
    const o = new CSS2DObject(d); world.add(o);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow(), color: ev.goal ? 0xfacc15 : ev.sold ? 0xfde68a : 0x93c5fd, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.scale.setScalar(ev.goal ? 1.6 : 1.0); world.add(sp);
    orbs.push({ o, sp, el: d, fl, t0: performance.now(), dur: ev.goal ? 2600 : 1800, sink: fl.f.to });
    return true;
  }

  // 點擊／滑過
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let down = null, hover = null;
  const pick = e => { const r = renderer.domElement.getBoundingClientRect(); ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ptr, camera); const h = ray.intersectObjects(clickables, false)[0]; return h ? h.object.userData.pick : null; };
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => { if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return; const p = pick(e); if (p && opts.onPick) opts.onPick(p); });
  renderer.domElement.addEventListener('pointermove', e => { const p = pick(e); const k = p ? p.type + p.key : null; if (k !== hover) { hover = k; renderer.domElement.style.cursor = p ? 'pointer' : ''; } });

  function resize() {
    const w = el.clientWidth || 800, h = el.clientHeight || 500;
    renderer.setSize(w, h, false); renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
    labels.setSize(w, h); composer.setSize(w, h); bloom.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(el); resize();

  const clock = new THREE.Clock();
  let raf = 0, alive = true, frames = 0;
  function tick() {
    if (!alive) return;
    raf = requestAnimationFrame(tick);
    if (document.hidden || !el.offsetParent) return; // 看不到就不畫，省電
    const dt = Math.min(0.05, clock.getDelta()), t = clock.elapsedTime;
    for (const s of spinners) { s.o.rotation[s.ax] += s.v * dt; if (s.bob) s.o.position.y = s.y0 + Math.sin(t * 1.6 + s.o.id) * 0.12; }
    for (const f of flows) {
      if (!f.ts.length) continue;
      const a = f.pts.geometry.attributes.position;
      for (let i = 0; i < f.ts.length; i++) { f.ts[i] = (f.ts[i] + f.speed * dt) % 1; const p = f.curve.getPointAt(f.ts[i]); a.setXYZ(i, p.x, p.y, p.z); }
      a.needsUpdate = true;
    }
    const now = performance.now();
    for (let i = orbs.length - 1; i >= 0; i--) {
      const o = orbs[i], k = Math.min(1, (now - o.t0) / o.dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const p = o.fl.curve.getPointAt(e); o.o.position.copy(p).add(new THREE.Vector3(0, 0.5, 0)); o.sp.position.copy(p);
      if (k >= 1) {
        world.remove(o.o); world.remove(o.sp); o.el.remove(); o.sp.material.dispose(); orbs.splice(i, 1);
        const n = nodes[o.sink]; if (n && n.g.userData.mesh) { n.g.userData.mesh.scale.setScalar(1.35); n.g.userData.pulse = now; }
      }
    }
    for (const k of ['exp', 'shop', 'bag']) { const n = nodes['k:' + k]; if (n && n.g.userData.pulse) { const q = Math.min(1, (now - n.g.userData.pulse) / 400); n.g.userData.mesh.scale.setScalar(1.35 - 0.35 * q); if (q >= 1) n.g.userData.pulse = 0; } }
    controls.update();
    composer.render();
    labels.render(scene, camera);
    frames++;
  }
  tick();

  return {
    update, loot,
    get frames() { return frames; }, get orbs() { return orbs.length; },
    resetView() { userCam = false; fit(); try { localStorage.removeItem('p3dCam'); } catch (_) {} },
    dispose() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); clearWorld(); controls.dispose(); composer.dispose && composer.dispose(); renderer.dispose(); for (const t of texCache.values()) t.dispose(); el.innerHTML = ''; el.classList.remove('p3d'); },
  };
}
