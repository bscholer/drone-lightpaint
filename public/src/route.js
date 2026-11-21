import { distanceM } from './geo.js';

export function segmentLength(a, b) {
  return Math.hypot(distanceM(a, b), b.alt - a.alt);
}

export function routeLength(wps) {
  let len = 0;
  for (let i = 1; i < wps.length; i++) len += segmentLength(wps[i - 1], wps[i]);
  return len;
}

/** Points along the route (including every waypoint) at <= `spacing` metres. */
export function sampleRoute(wps, spacing = 5) {
  const out = [];
  for (let i = 0; i < wps.length - 1; i++) {
    const a = wps[i];
    const b = wps[i + 1];
    const n = Math.max(1, Math.ceil(segmentLength(a, b) / spacing));
    for (let s = 0; s < n; s++) {
      const f = s / n;
      out.push({
        lat: a.lat + (b.lat - a.lat) * f,
        lon: a.lon + (b.lon - a.lon) * f,
        alt: a.alt + (b.alt - a.alt) * f,
        seg: i,
      });
    }
  }
  if (wps.length) {
    const l = wps[wps.length - 1];
    out.push({ lat: l.lat, lon: l.lon, alt: l.alt, seg: Math.max(0, wps.length - 2) });
  }
  return out;
}

/**
 * surface[i] is the ellipsoid height of the terrain/trees/buildings under
 * samples[i] (null if unknown). home.h0 is the ellipsoid height at takeoff.
 */
export function evaluateRoute({ wps, home, samples, surface, settings }) {
  const issues = [];
  let minClear = Infinity;
  let maxAgl = -Infinity;
  const worstBySeg = new Map();
  samples.forEach((s, i) => {
    const h = surface?.[i];
    if (h == null || Number.isNaN(h)) return;
    const clear = home.h0 + s.alt - h;
    minClear = Math.min(minClear, clear);
    maxAgl = Math.max(maxAgl, clear);
    if (!worstBySeg.has(s.seg) || clear < worstBySeg.get(s.seg)) worstBySeg.set(s.seg, clear);
  });
  const badSegs = new Set();
  for (const [seg, clear] of worstBySeg) {
    if (clear < settings.minClearance) {
      badSegs.add(seg);
      issues.push({
        level: 'error',
        seg,
        text: `Segment ${seg + 1}→${seg + 2}: only ${clear.toFixed(1)} m above terrain/obstacles (min ${settings.minClearance} m).`,
      });
    }
  }
  if (maxAgl > settings.maxAgl) {
    issues.push({ level: 'warn', text: `Highest point is ${maxAgl.toFixed(0)} m above the surface; limit is ${settings.maxAgl} m.` });
  }
  wps.forEach((w, i) => {
    const d = distanceM(home, w);
    if (d > settings.maxRange) {
      issues.push({ level: 'warn', seg: i, text: `Waypoint ${i + 1} is ${d.toFixed(0)} m from home (max ${settings.maxRange} m).` });
    }
    if (w.alt < 0) issues.push({ level: 'warn', seg: i, text: `Waypoint ${i + 1} is below the takeoff point.` });
  });
  const length = routeLength(wps);
  const holds = wps.filter((w) => w.sync).length;
  return {
    issues,
    badSegs,
    minClear: Number.isFinite(minClear) ? minClear : null,
    maxAgl: Number.isFinite(maxAgl) ? maxAgl : null,
    length,
    durationSec: length / settings.speed + holds * settings.holdSec,
    haveSurface: Number.isFinite(minClear),
  };
}
