import { newProject, normalizeProject } from './project.js';
import { api } from './api.js';
import { buildShapeWaypoints, SHAPE_TYPES, GENERATORS, fitToBox } from './shapes.js';
import { bearingDeg } from './geo.js';
import { sampleRoute, evaluateRoute } from './route.js';
import { buildKml, buildCues } from './kml.js';
import { buildDronelinkPlan, encodeDronelink } from './dronelink.js';

const C = Cesium;
const $ = (id) => document.getElementById(id);
const CFG_KEY = 'lightpaint.cfg';
const PRJ_KEY = 'lightpaint.project';
const ID_KEY = 'lightpaint.routeId';

const cfg = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
let project = loadSaved();
let tool = 'select';
let selected = -1;
let viewer;
let routeDS;
let previewDS;
let mapMode = 'flat';
let mapNote = '';
let mapWarn = false;
let checkTimer;
let checkRun = 0;

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(PRJ_KEY));
    if (s) return normalizeProject(s);
  } catch {}
  return newProject();
}

// Server-side storage. `remote.on` stays false when the page is served without
// the API (e.g. python -m http.server), and then the browser copy is all there is.
const remote = { on: false, id: Number(localStorage.getItem(ID_KEY)) || null };
let routes = [];
let saveTimer = null;

function setSync(text, warn = false) {
  const el = $('syncState');
  el.textContent = text;
  el.style.color = warn ? '#ffcc66' : '';
}

function save() {
  localStorage.setItem(PRJ_KEY, JSON.stringify(project));
  if (!remote.on || !remote.id) return;
  setSync('· unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushRemote, 1200);
}

async function flushRemote() {
  saveTimer = null;
  const id = remote.id;
  try {
    setSync('· saving…');
    const r = await api.save(id, project);
    const row = routes.find((x) => x.id === id);
    if (row) Object.assign(row, r);
    if (id === remote.id) {
      setSync('· saved');
      fillRouteSelect();
    }
  } catch (e) {
    console.error(e);
    setSync('· not saved to server (kept in this browser)', true);
  }
}

async function flushNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  await flushRemote();
}

function fillRouteSelect() {
  $('routeSelect').innerHTML = routes
    .map((r) => `<option value="${r.id}">${r.name.replace(/[<>&"]/g, '')} · ${r.waypoints} wp</option>`)
    .join('');
  $('routeSelect').value = remote.id ?? '';
}

async function refreshRoutes() {
  routes = await api.list();
  fillRouteSelect();
}

/** Make `p` the open project: either an existing server route, or a new one. */
async function openRoute(id) {
  await flushNow();
  const r = await api.get(id);
  remote.id = r.id;
  localStorage.setItem(ID_KEY, String(r.id));
  project = normalizeProject(r.project);
  localStorage.setItem(PRJ_KEY, JSON.stringify(project));
  selected = -1;
  $('revRow').hidden = $('revSelect').hidden = $('revRestore').hidden = true;
  fillRouteSelect();
  setSync('· saved');
  commit();
  if (project.home) flyTo(project.home);
}

async function createRoute(p) {
  await flushNow();
  const r = await api.create(p);
  await refreshRoutes();
  await openRoute(r.id);
}

async function initRemote() {
  try {
    await refreshRoutes();
  } catch {
    setSync('· server unavailable, saving to this browser only', true);
    return;
  }
  remote.on = true;
  if (remote.id && !routes.some((r) => r.id === remote.id)) remote.id = null;
  if (remote.id) return openRoute(remote.id);
  const haveLocalWork = project.waypoints.length || project.home;
  if (!haveLocalWork && routes.length) return openRoute(routes[0].id);
  return createRoute(project); // adopt whatever was in this browser
}

const h0 = () => project.home?.h0 ?? 0;
const pos = (p, alt) => C.Cartesian3.fromDegrees(p.lon, p.lat, h0() + alt);

function say(text, warn = false) {
  const el = $('status');
  el.textContent = text;
  el.className = warn ? 'warn' : '';
}

// ---------------------------------------------------------------- scene

async function initViewer() {
  const google = !!cfg.googleKey;
  const ion = !!cfg.ionToken;
  if (ion) C.Ion.defaultAccessToken = cfg.ionToken;
  viewer = new C.Viewer('cesium', {
    baseLayer: ion && !google ? C.ImageryLayer.fromWorldImagery() : false,
    terrain: ion && !google ? C.Terrain.fromWorldTerrain() : undefined,
    globe: google ? false : undefined,
    baseLayerPicker: false,
    geocoder: false,
    animation: false,
    timeline: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
  });
  if (viewer.scene.globe) viewer.scene.globe.depthTestAgainstTerrain = true;

  if (google) {
    try {
      const ts = await C.createGooglePhotorealistic3DTileset({ key: cfg.googleKey });
      viewer.scene.primitives.add(ts);
      mapMode = 'google';
    } catch (e) {
      console.error(e);
      say('Google 3D tiles failed to load — check the key and that the Map Tiles API is enabled.', true);
    }
  }
  if (mapMode !== 'google' && ion) mapMode = 'ion';
  if (mapMode === 'flat') {
    try {
      const esri = await C.ArcGisMapServerImageryProvider.fromUrl(
        'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
      );
      viewer.imageryLayers.addImageryProvider(esri);
    } catch (e) {
      console.error(e);
    }
  }
  routeDS = new C.CustomDataSource('route');
  previewDS = new C.CustomDataSource('preview');
  viewer.dataSources.add(routeDS);
  viewer.dataSources.add(previewDS);

  const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => onClick(click.position), C.ScreenSpaceEventType.LEFT_CLICK);

  if (project.home) flyTo(project.home);
  else viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(-86.16, 39.77, 3_000_000) });

  const label = {
    google: 'Google Photorealistic 3D Tiles (trees and buildings count as obstacles)',
    ion: 'Cesium World Terrain (bare earth only — trees and buildings are not checked)',
    flat: 'Flat Esri imagery — no terrain. Add a Google key under "Map keys" for real clearance checks.',
  }[mapMode];
  mapNote = label;
  mapWarn = mapMode === 'flat';
  say(mapNote, mapWarn);
}

function flyTo(p) {
  viewer.camera.flyToBoundingSphere(new C.BoundingSphere(pos(p, 0), 100), {
    offset: new C.HeadingPitchRange(0, C.Math.toRadians(-35), 350),
    duration: 1.5,
  });
}

function pick(windowPos) {
  const { scene, camera } = viewer;
  let cart = scene.pickPositionSupported ? scene.pickPosition(windowPos) : undefined;
  if (!cart && scene.globe) cart = scene.globe.pick(camera.getPickRay(windowPos), scene);
  if (!cart) return null;
  const c = C.Cartographic.fromCartesian(cart);
  return { lat: C.Math.toDegrees(c.latitude), lon: C.Math.toDegrees(c.longitude), h: c.height };
}

async function fetchMsl(p) {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${p.lat}&longitude=${p.lon}`);
    const j = await r.json();
    return j.elevation?.[0];
  } catch {
    return undefined;
  }
}

async function onClick(windowPos) {
  const hit = viewer.scene.pick(windowPos);
  const id = hit?.id?.id;
  if (tool === 'select') {
    if (typeof id === 'string' && id.startsWith('wp-')) select(Number(id.slice(3)));
    return;
  }
  const p = pick(windowPos);
  if (!p) return;
  if (tool === 'home') {
    project.home = { lat: p.lat, lon: p.lon, h0: p.h };
    setTool('select');
    commit();
    const msl = await fetchMsl(p);
    if (msl != null) {
      project.home.msl = msl;
      commit();
    }
    return;
  }
  if (!project.home) return say('Set the home point first.', true);
  if (tool === 'camera') {
    project.camera = { lat: p.lat, lon: p.lon };
    syncFacing();
    setTool('select');
  } else if (tool === 'center') {
    project.shapeCenter = { lat: p.lat, lon: p.lon };
    syncFacing();
    setTool('select');
  } else if (tool === 'add') {
    const last = project.waypoints.at(-1);
    project.waypoints.push({
      lat: p.lat,
      lon: p.lon,
      alt: last ? last.alt : project.shape.centerAlt,
      color: last ? last.color : project.shape.color,
      sync: true,
    });
    selected = project.waypoints.length - 1;
  } else if (tool === 'move' && project.waypoints[selected]) {
    Object.assign(project.waypoints[selected], { lat: p.lat, lon: p.lon });
  }
  commit();
}

function syncFacing() {
  const { shapeCenter, camera, shape } = project;
  if (shape.faceCamera && shapeCenter && camera) {
    shape.facing = Math.round(bearingDeg(shapeCenter, camera));
  }
}

// -------------------------------------------------------------- drawing

function dot(id, p, alt, color, size, label) {
  return {
    id,
    position: pos(p, alt),
    point: { pixelSize: size, color: C.Color.fromCssColorString(color), outlineColor: C.Color.WHITE, outlineWidth: 1 },
    label: label && {
      text: label,
      font: '12px sans-serif',
      pixelOffset: new C.Cartesian2(0, -16),
      fillColor: C.Color.WHITE,
      outlineColor: C.Color.BLACK,
      outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE,
      showBackground: false,
    },
  };
}

function draw(checkResult) {
  routeDS.entities.removeAll();
  previewDS.entities.removeAll();
  const { home, camera, shapeCenter, waypoints: wps } = project;
  if (home) routeDS.entities.add(dot('home', home, 0, '#00c853', 12, 'Home'));
  if (camera) routeDS.entities.add(dot('camera', camera, 1.5, '#ffffff', 10, 'Camera'));
  if (shapeCenter) routeDS.entities.add(dot('center', shapeCenter, project.shape.centerAlt, '#ffd600', 8, 'Shape centre'));
  const bad = checkResult?.badSegs ?? new Set();
  for (let i = 0; i < wps.length - 1; i++) {
    const positions = [pos(wps[i], wps[i].alt), pos(wps[i + 1], wps[i + 1].alt)];
    if (bad.has(i)) {
      routeDS.entities.add({ polyline: { positions, width: 10, arcType: C.ArcType.NONE, material: C.Color.RED.withAlpha(0.6) } });
    }
    routeDS.entities.add({
      polyline: { positions, width: 4, arcType: C.ArcType.NONE, material: C.Color.fromCssColorString(wps[i].color) },
    });
  }
  wps.forEach((w, i) => {
    routeDS.entities.add(dot(`wp-${i}`, w, w.alt, w.color, i === selected ? 14 : 8, i === selected || i === 0 ? String(i + 1) : undefined));
  });
  if (project.shapeCenter && project.home) {
    try {
      const pv = buildShapeWaypoints(project.shape, project.shapeCenter);
      previewDS.entities.add({
        polyline: {
          positions: pv.map((w) => pos(w, w.alt)),
          width: 2,
          arcType: C.ArcType.NONE,
          material: new C.PolylineDashMaterialProperty({ color: C.Color.YELLOW.withAlpha(0.8) }),
        },
      });
    } catch {}
  }
}

// ------------------------------------------------------------------ UI

function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  const hints = {
    home: 'Click the map to set the takeoff point.',
    camera: 'Click the map where the camera will stand.',
    center: 'Click the map where the shape should hang.',
    add: 'Click the map to add a waypoint.',
    move: 'Select a waypoint, then click the map to move it.',
  };
  if (hints[t]) say(hints[t]);
  else if (mapNote) say(mapNote, mapWarn);
  else say('');
  if (viewer) viewer.canvas.style.cursor = t === 'select' ? '' : 'crosshair';
}

function select(i) {
  selected = i;
  commit();
}

function commit(recheck = true) {
  save();
  syncInputs();
  draw(lastCheck);
  renderList();
  if (recheck) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runChecks, 600);
  }
}

function renderList() {
  const list = $('wpList');
  list.innerHTML = '';
  const bad = lastCheck?.badSegs ?? new Set();
  project.waypoints.forEach((w, i) => {
    const row = document.createElement('div');
    row.className = 'wp' + (i === selected ? ' sel' : '') + (bad.has(i) ? ' bad' : '');
    row.innerHTML = `<i style="background:${w.color}"></i>${i + 1} · ${w.alt.toFixed(1)} m${w.sync ? '' : ' · no sync'}`;
    row.onclick = () => select(i);
    list.appendChild(row);
  });
  $('wpCount').textContent = project.waypoints.length ? `· ${project.waypoints.length} waypoints` : '';
  const w = project.waypoints[selected];
  $('wpEdit').hidden = !w;
  if (w) {
    $('wpTitle').textContent = `Waypoint ${selected + 1}`;
    $('wpAlt').value = w.alt;
    $('wpColor').value = w.color;
    $('wpSync').checked = w.sync;
  }
}

const shapeFields = {
  shType: ['type', String],
  shWidth: ['width', Number],
  shHeight: ['height', Number],
  shDepth: ['depth', Number],
  shSamples: ['samples', Number],
  shAlt: ['centerAlt', Number],
  shFacing: ['facing', Number],
  shColorMode: ['colorMode', String],
  shColor: ['color', String],
  shColor2: ['color2', String],
};
const settingFields = {
  stClear: ['minClearance', Number],
  stAgl: ['maxAgl', Number],
  stRange: ['maxRange', Number],
  stSpeed: ['speed', Number],
  stHold: ['holdSec', Number],
  stArrival: ['arrivalCurve', Number],
  stAltMode: ['altitudeMode', String],
};

function syncInputs() {
  for (const [id, [k]] of Object.entries(shapeFields)) if (document.activeElement !== $(id)) $(id).value = project.shape[k];
  for (const [id, [k]] of Object.entries(settingFields)) if (document.activeElement !== $(id)) $(id).value = project.settings[k];
  $('shFaceCam').checked = project.shape.faceCamera;
  $('stAux').checked = project.settings.auxLight;
  $('projName').value = project.name;
  if (document.activeElement !== $('homeMsl')) $('homeMsl').value = project.home?.msl ?? '';
  for (const id of ['shType', 'shColorMode']) markMirror(id);
  renderSite();
}

function renderSite() {
  const fmt = (p) => (p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : 'not set');
  for (const [text, row, p] of [
    ['siteHome', 'rowHome', project.home],
    ['siteCamera', 'rowCamera', project.camera],
    ['siteCenter', 'rowCenter', project.shapeCenter],
  ]) {
    $(text).textContent = fmt(p);
    $(row).classList.toggle('set', !!p);
  }
}

/** Swap a <select> for a row of buttons; the select stays as the source of truth. */
function mirrorSelect(id, className, label) {
  const sel = $(id);
  sel.hidden = true;
  const box = document.createElement('div');
  box.className = className;
  for (const o of sel.options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = o.value;
    b.innerHTML = label(o);
    b.onclick = () => {
      sel.value = o.value;
      sel.oninput();
      markMirror(id);
    };
    box.appendChild(b);
  }
  sel.after(box);
}

function markMirror(id) {
  const box = $(id).nextElementSibling;
  if (!box) return;
  for (const b of box.children) b.classList.toggle('on', b.dataset.v === $(id).value);
}

/** Small line drawing of a shape, from the same generator that builds the route. */
function thumb(type) {
  const f = fitToBox(GENERATORS[type]().pts, 22, 18, 8);
  const step = Math.max(1, Math.floor(f.length / 90));
  const d = f
    .filter((_, i) => i % step === 0 || i === f.length - 1)
    .map(([u, v, w], i) => `${i ? 'L' : 'M'}${(16 + u + w * 0.5).toFixed(1)} ${(13 - v - w * 0.5).toFixed(1)}`)
    .join('');
  return `<svg viewBox="0 0 32 26"><path d="${d}"/></svg>`;
}

function bindUi() {
  $('shType').innerHTML = SHAPE_TYPES.map((t) => `<option>${t}</option>`).join('');
  mirrorSelect('shType', 'shapes', (o) => `${thumb(o.value)}${o.value}`);
  mirrorSelect('shColorMode', 'seg', (o) => o.textContent);
  document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  for (const [id, [k, cast]] of Object.entries(shapeFields)) {
    $(id).oninput = () => {
      const v = cast($(id).value);
      if (typeof v === 'number' && Number.isNaN(v)) return;
      project.shape[k] = v;
      if (k === 'facing') project.shape.faceCamera = false;
      commit(false);
    };
  }
  for (const [id, [k, cast]] of Object.entries(settingFields)) {
    $(id).oninput = () => {
      const v = cast($(id).value);
      if (typeof v === 'number' && Number.isNaN(v)) return;
      project.settings[k] = v;
      commit();
    };
  }
  $('stAux').onchange = () => {
    project.settings.auxLight = $('stAux').checked;
    commit(false);
  };
  $('shFaceCam').onchange = () => {
    project.shape.faceCamera = $('shFaceCam').checked;
    syncFacing();
    commit(false);
  };
  $('projName').oninput = () => {
    project.name = $('projName').value;
    save();
  };
  $('homeMsl').oninput = () => {
    if (!project.home) return;
    const v = parseFloat($('homeMsl').value);
    project.home.msl = Number.isNaN(v) ? undefined : v;
    save();
  };
  const place = (append) => () => {
    if (!project.home) return say('Set the home point first.', true);
    if (!project.shapeCenter) return say('Place the shape centre first.', true);
    const wps = buildShapeWaypoints(project.shape, project.shapeCenter);
    project.waypoints = append ? [...project.waypoints, ...wps] : wps;
    selected = -1;
    commit();
  };
  $('applyShape').onclick = place(false);
  $('appendShape').onclick = place(true);
  $('wpAlt').oninput = () => edit((w) => (w.alt = parseFloat($('wpAlt').value) || 0));
  $('wpColor').oninput = () => edit((w) => (w.color = $('wpColor').value), false);
  $('wpSync').onchange = () => edit((w) => (w.sync = $('wpSync').checked), false);
  $('wpDelete').onclick = () => {
    project.waypoints.splice(selected, 1);
    selected = Math.min(selected, project.waypoints.length - 1);
    commit();
  };
  $('wpInsert').onclick = () => {
    const a = project.waypoints[selected];
    const b = project.waypoints[selected + 1] ?? a;
    project.waypoints.splice(selected + 1, 0, {
      ...a,
      lat: (a.lat + b.lat) / 2,
      lon: (a.lon + b.lon) / 2,
      alt: (a.alt + b.alt) / 2 + (a === b ? 5 : 0),
    });
    selected++;
    commit();
  };
  $('clearRoute').onclick = () => {
    project.waypoints = [];
    selected = -1;
    commit();
  };
  $('exportKml').onclick = () => {
    try {
      download(
        `${slug()}.kml`,
        buildKml(project, { altitudeMode: project.settings.altitudeMode, segments: $('kmlSegments').checked }),
        'application/vnd.google-earth.kml+xml',
      );
    } catch (e) {
      say(e.message, true);
    }
  };
  $('exportDronelink').onclick = () => {
    try {
      download(`${slug()}.dronelink`, encodeDronelink(buildDronelinkPlan(project), LZUTF8), 'text/plain;charset=utf-8');
    } catch (e) {
      say(e.message, true);
    }
  };
  $('exportCues').onclick = () => download(`${slug()}-cues.json`, JSON.stringify(buildCues(project), null, 1), 'application/json');
  $('saveProject').onclick = () => download(`${slug()}.lightpaint.json`, JSON.stringify(project, null, 1), 'application/json');
  $('loadProject').onclick = () => $('loadFile').click();
  $('loadFile').onchange = async () => {
    const f = $('loadFile').files[0];
    $('loadFile').value = '';
    if (!f) return;
    try {
      const imported = normalizeProject(JSON.parse(await f.text()));
      if (remote.on) return await createRoute(imported);
      project = imported;
      selected = -1;
      commit();
      if (project.home) flyTo(project.home);
    } catch (e) {
      say(`Could not import that file: ${e.message}`, true);
    }
  };
  $('routeSelect').onchange = () => openRoute(Number($('routeSelect').value));
  $('routeNew').onclick = () => createRoute({ ...newProject(), name: `Route ${routes.length + 1}` });
  $('routeDup').onclick = () => createRoute({ ...project, name: `${project.name} copy` });
  $('routeDel').onclick = async () => {
    if (!remote.id || !confirm(`Delete "${project.name}"? Its history goes too.`)) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    await api.remove(remote.id);
    await refreshRoutes();
    if (routes.length) await openRoute(routes[0].id);
    else {
      remote.id = null;
      await createRoute(newProject());
    }
  };
  $('histBtn').onclick = async () => {
    if (!remote.id) return;
    await flushNow();
    const revs = await api.revisions(remote.id);
    $('revSelect').innerHTML = revs.length
      ? revs.map((r) => `<option value="${r.id}">${new Date(r.created_at).toLocaleString()} · ${r.waypoints} wp</option>`).join('')
      : '<option value="">No earlier versions yet</option>';
    $('revRow').hidden = $('revSelect').hidden = $('revRestore').hidden = false;
  };
  $('revRestore').onclick = async () => {
    const rev = $('revSelect').value;
    if (!rev) return;
    project = normalizeProject((await api.revision(remote.id, rev)).project);
    selected = -1;
    commit(); // autosaves, which snapshots the version being replaced
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushNow());
  $('keyGoogle').value = cfg.googleKey || '';
  $('keyIon').value = cfg.ionToken || '';
  $('keys').open = !cfg.googleKey && !cfg.ionToken;
  $('saveKeys').onclick = () => {
    localStorage.setItem(CFG_KEY, JSON.stringify({ googleKey: $('keyGoogle').value.trim(), ionToken: $('keyIon').value.trim() }));
    location.reload();
  };
  const go = async () => {
    const q = $('goto').value.trim();
    const m = q.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    let p = m && { lat: +m[1], lon: +m[2] };
    if (!p && q) {
      try {
        const r = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`)).json();
        if (r[0]) p = { lat: +r[0].lat, lon: +r[0].lon };
      } catch {}
    }
    if (!p) return say('Location not found.', true);
    flyTo(p);
  };
  $('gotoBtn').onclick = go;
  $('goto').onkeydown = (e) => e.key === 'Enter' && go();
}

function edit(fn, recheck = true) {
  const w = project.waypoints[selected];
  if (!w) return;
  fn(w);
  save();
  draw(lastCheck);
  const row = document.querySelectorAll('.wp')[selected];
  if (row) row.querySelector('i').style.background = w.color;
  if (recheck) {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runChecks, 600);
  }
}

const slug = () => (project.name || 'route').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'route';

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --------------------------------------------------------------- checks

let lastCheck = null;

async function runChecks() {
  const run = ++checkRun;
  const { waypoints: wps, home, settings } = project;
  const box = $('checks');
  if (!home || wps.length < 2) {
    lastCheck = null;
    box.innerHTML = '<div class="hint">Set home and build a route to see checks.</div>';
    return;
  }
  const samples = sampleRoute(wps, 5);
  let surface = null;
  if (viewer.scene.sampleHeightSupported) {
    try {
      const cartos = samples.map((s) => C.Cartographic.fromDegrees(s.lon, s.lat));
      const exclude = [...routeDS.entities.values, ...previewDS.entities.values];
      const res = await viewer.scene.sampleHeightMostDetailed(cartos, exclude);
      surface = res.map((c) => c.height);
    } catch (e) {
      console.warn('surface sampling failed', e);
    }
  }
  if (run !== checkRun) return; // a newer check superseded this one
  lastCheck = evaluateRoute({ wps, home, samples, surface, settings });
  const r = lastCheck;
  const rows = [
    `<div>${wps.length} waypoints · ${r.length.toFixed(0)} m path · ~${(r.durationSec / 60).toFixed(1)} min flying (${wps.filter((w) => w.sync).length} photo holds)</div>`,
    r.haveSurface
      ? `<div class="${r.badSegs.size ? 'err' : 'ok'}">Min clearance ${r.minClear.toFixed(1)} m · max ${r.maxAgl.toFixed(0)} m above surface</div>`
      : '<div class="warn">No surface data under the path, so terrain clearance was not checked.</div>',
    ...r.issues.map((i) => `<div class="${i.level === 'error' ? 'err' : 'warn'}">${i.text}</div>`),
  ];
  box.innerHTML = rows.join('');
  draw(r);
  renderList();
}

// ---------------------------------------------------------------- start

bindUi();
syncInputs();
renderList();
await initViewer();
draw();
await initRemote();
runChecks();
