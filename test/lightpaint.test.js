import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetLatLon, toEnu, bearingDeg, distanceM } from '../public/src/geo.js';
import { buildShapeWaypoints, GENERATORS, resample, fitToBox } from '../public/src/shapes.js';
import { sampleRoute, evaluateRoute } from '../public/src/route.js';
import { buildKml, buildCues } from '../public/src/kml.js';
import { newProject } from '../public/src/project.js';
import { hexToKmlColor } from '../public/src/colors.js';

const C = { lat: 39.77, lon: -86.16 };

test('geo round trip and bearing', () => {
  const p = offsetLatLon(C, 100, -50);
  const { e, n } = toEnu(C, p);
  assert.ok(Math.abs(e - 100) < 1e-6 && Math.abs(n + 50) < 1e-6);
  assert.ok(Math.abs(bearingDeg(C, offsetLatLon(C, 0, 100))) < 1e-6);
  assert.ok(Math.abs(bearingDeg(C, offsetLatLon(C, 100, 0)) - 90) < 1e-6);
  assert.ok(Math.abs(distanceM(C, offsetLatLon(C, 30, 40)) - 50) < 0.01);
});

const spec = (over = {}) => ({
  type: 'heart', width: 40, height: 40, depth: 20, samples: 40,
  centerAlt: 40, facing: 180, colorMode: 'solid', color: '#ff0000', color2: '#0000ff', ...over,
});

test('every shape builds and stays near requested sample count', () => {
  for (const type of Object.keys(GENERATORS)) {
    const w = buildShapeWaypoints(spec({ type }), C);
    assert.ok(w.length >= 20 && w.length <= 60, `${type}: ${w.length}`);
  }
});

test('heart is closed, centred on centerAlt and keeps its corners', () => {
  const w = buildShapeWaypoints(spec(), C);
  assert.ok(distanceM(w[0], w.at(-1)) < 0.01);
  const alts = w.map((p) => p.alt);
  assert.ok(Math.abs(Math.min(...alts) - 20) < 1e-6 && Math.abs(Math.max(...alts) - 60) < 0.5);
  // bottom tip is the first waypoint and the lowest point
  assert.ok(Math.abs(w[0].alt - 20) < 1e-6);
});

test('shape reads correctly from the camera (facing south => right is east)', () => {
  const w = buildShapeWaypoints(spec({ type: 'line', samples: 2, height: 0.0001 }), C);
  const { e, n } = toEnu(w[0], w.at(-1));
  assert.ok(e > 39.9 && Math.abs(n) < 0.01, `e=${e} n=${n}`);
  // facing east (camera looks west) => right is north
  const w2 = buildShapeWaypoints(spec({ type: 'line', samples: 2, height: 0.0001, facing: 90 }), C);
  const d = toEnu(w2[0], w2.at(-1));
  assert.ok(d.n > 39.9 && Math.abs(d.e) < 0.01);
});

test('helix uses depth toward the camera', () => {
  const w = buildShapeWaypoints(spec({ type: 'helix', facing: 0, depth: 30 }), C);
  const norths = w.map((p) => toEnu(C, p).n);
  assert.ok(Math.max(...norths) - Math.min(...norths) > 29);
});

test('resample keeps corners exactly', () => {
  const pts = fitToBox([[0, 0, 0], [1, 0, 0], [1, 1, 0]], 10, 10, 0);
  const { points: out, cornerIdx } = resample(pts, [0, 1, 2], 10);
  assert.equal(cornerIdx.length, 3);
  assert.ok(out.some((p) => Math.abs(p[0] - 5) < 1e-9 && Math.abs(p[1] + 5) < 1e-9));
});

test('heart flags its tip and cusp as corners, and nothing else', () => {
  const w = buildShapeWaypoints(spec(), C);
  const idx = w.map((p, i) => (p.corner ? i : -1)).filter((i) => i >= 0);
  assert.equal(idx.length, 3);
  assert.deepEqual([idx[0], idx[2]], [0, w.length - 1]);
});

test('colour modes', () => {
  const w = buildShapeWaypoints(spec({ colorMode: 'gradient' }), C);
  assert.equal(w[0].color, '#ff0000');
  assert.equal(w.at(-1).color, '#0000ff');
});

test('clearance flags low segments only', () => {
  const wps = [
    { lat: C.lat, lon: C.lon, alt: 30, color: '#fff', sync: true },
    offsetLatLon(C, 50, 0) && { ...offsetLatLon(C, 50, 0), alt: 30, color: '#fff', sync: true },
    { ...offsetLatLon(C, 100, 0), alt: 30, color: '#fff', sync: true },
  ];
  const samples = sampleRoute(wps, 5);
  assert.ok(samples.length >= 20);
  // a 25 m tree under the second segment only
  const surface = samples.map((s) => 100 + (s.seg === 1 ? 25 : 0));
  const r = evaluateRoute({
    wps, home: { ...C, h0: 100 }, samples, surface,
    settings: { minClearance: 8, maxAgl: 121.9, maxRange: 500, speed: 4, holdSec: 4 },
  });
  assert.deepEqual([...r.badSegs], [1]);
  assert.ok(Math.abs(r.minClear - 5) < 1e-6);
  assert.ok(r.durationSec > 12);
});

test('kml: modes, colours, escaping, validation', () => {
  const p = newProject();
  p.name = 'a<b>&c';
  p.home = { ...C, h0: 250, msl: 220.5 };
  p.camera = { lat: C.lat, lon: C.lon + 0.001 };
  p.waypoints = buildShapeWaypoints(spec({ samples: 10 }), C);
  const ell = buildKml(p);
  assert.match(ell, /<altitudeMode>absolute<\/altitudeMode>/);
  assert.match(ell, /,270\.00<\/coordinates>/); // h0 250 + 20 (heart bottom tip)
  assert.doesNotMatch(ell, /<LineString>/, 'segments are off by default so importers do not duplicate waypoints');
  assert.match(buildKml(p, { segments: true }), /<LineString>/);
  const rel = buildKml(p, { altitudeMode: 'relativeToGround' });
  assert.match(rel, /<altitudeMode>relativeToGround<\/altitudeMode>/);
  assert.match(rel, /a&lt;b&gt;&amp;c/);
  assert.match(rel, /<color>ff0000ff<\/color>/); // red, aabbggrr
  const abs = buildKml(p, { altitudeMode: 'absolute' });
  assert.match(abs, /,240\.50<\/coordinates>/); // 220.5 + 20 (heart bottom tip)
  p.home.msl = undefined;
  assert.throws(() => buildKml(p, { altitudeMode: 'absolute' }));
  assert.throws(() => buildKml(p, { altitudeMode: 'bogus' }));
  assert.equal(hexToKmlColor('#112233'), 'ff332211');
  assert.equal(buildCues(p).cues[0].rgb.length, 3);
});
