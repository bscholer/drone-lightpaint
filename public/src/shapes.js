import { offsetLatLon, toRad } from './geo.js';
import { colorAt } from './colors.js';

// Each generator returns { pts: [[u, v, w], ...], corners: [indices] }.
// u = right, v = up, w = toward the camera (metres, unit-box scaled later).
// Corners are kept exactly when the path is resampled so cusps stay sharp.

const DENSE = 720;

function param(fn, n = DENSE, closed = true) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(fn((i / n) * (closed ? 2 * Math.PI : 1)));
  return pts;
}

export const GENERATORS = {
  heart() {
    const pts = param((t) => [
      16 * Math.sin(t) ** 3,
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      0,
    ]);
    // Start at the bottom tip so the path begins and ends on the sharp corner.
    const half = DENSE / 2;
    const rotated = [...pts.slice(half, DENSE), ...pts.slice(0, half + 1)];
    return { pts: rotated, corners: [0, half, DENSE] };
  },
  circle() {
    return { pts: param((t) => [Math.cos(t), Math.sin(t), 0]), corners: [0, DENSE] };
  },
  infinity() {
    return {
      pts: param((t) => {
        const d = 1 + Math.sin(t) ** 2;
        return [Math.cos(t) / d, (Math.sin(t) * Math.cos(t)) / d, 0];
      }),
      corners: [0, DENSE],
    };
  },
  star() {
    // Pentagram drawn in one stroke: every second vertex of a pentagon.
    const v = (k) => {
      const a = Math.PI / 2 + (k * 4 * Math.PI) / 5;
      return [Math.cos(a), Math.sin(a), 0];
    };
    const pts = [];
    const corners = [];
    for (let k = 0; k < 5; k++) {
      const a = v(k);
      const b = v(k + 1);
      corners.push(pts.length);
      for (let s = 0; s < 40; s++) {
        const f = s / 40;
        pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0]);
      }
    }
    corners.push(pts.length);
    pts.push(v(0));
    return { pts, corners };
  },
  square() {
    const c = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
    const pts = [];
    const corners = [];
    for (let k = 0; k < 4; k++) {
      corners.push(pts.length);
      for (let s = 0; s < 40; s++) {
        const f = s / 40;
        pts.push([c[k][0] + (c[k + 1][0] - c[k][0]) * f, c[k][1] + (c[k + 1][1] - c[k][1]) * f, 0]);
      }
    }
    corners.push(pts.length);
    pts.push([-1, -1, 0]);
    return { pts, corners };
  },
  spiral() {
    const turns = 3;
    return {
      pts: param((f) => {
        const a = f * turns * 2 * Math.PI;
        const r = f;
        return [r * Math.cos(a), r * Math.sin(a), 0];
      }, DENSE, false),
      corners: [0, DENSE],
    };
  },
  helix() {
    const turns = 3;
    return {
      pts: param((f) => {
        const a = f * turns * 2 * Math.PI;
        return [Math.cos(a), Math.sin(a), f * 2 - 1];
      }, DENSE, false),
      corners: [0, DENSE],
    };
  },
  line() {
    return { pts: [[-1, 0, 0], [1, 0, 0]], corners: [0, 1] };
  },
};

export const SHAPE_TYPES = Object.keys(GENERATORS);

/** Scale so the shape's bounding box is width x height (x depth for w), centred. */
export function fitToBox(pts, width, height, depth) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  const size = [width, height, depth];
  return pts.map((p) =>
    p.map((x, k) => {
      const span = hi[k] - lo[k];
      return span < 1e-9 ? 0 : ((x - lo[k]) / span - 0.5) * size[k];
    }),
  );
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Resample a dense polyline to roughly `count` points, evenly spaced by arc
 * length between corners, always keeping the corner points themselves.
 */
export function resample(pts, corners, count) {
  const segs = [];
  let total = 0;
  for (let c = 0; c < corners.length - 1; c++) {
    let len = 0;
    for (let i = corners[c]; i < corners[c + 1]; i++) len += dist3(pts[i], pts[i + 1]);
    segs.push(len);
    total += len;
  }
  const out = [];
  for (let c = 0; c < segs.length; c++) {
    const steps = Math.max(1, Math.round((count * segs[c]) / total));
    const a = corners[c];
    const b = corners[c + 1];
    const cum = [0];
    for (let i = a; i < b; i++) cum.push(cum[cum.length - 1] + dist3(pts[i], pts[i + 1]));
    let j = 0;
    for (let s = 0; s < steps; s++) {
      const target = (cum[cum.length - 1] * s) / steps;
      while (j < cum.length - 2 && cum[j + 1] < target) j++;
      const span = cum[j + 1] - cum[j] || 1;
      const f = (target - cum[j]) / span;
      const p = pts[a + j];
      const q = pts[a + j + 1];
      out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f]);
    }
  }
  out.push(pts[corners[corners.length - 1]]);
  return out;
}

/**
 * Turn a shape spec into waypoints. `facing` is the compass bearing from the
 * shape toward the camera, so the shape reads correctly from the camera.
 */
export function buildShapeWaypoints(spec, center) {
  const gen = GENERATORS[spec.type];
  if (!gen) throw new Error(`unknown shape ${spec.type}`);
  const { pts, corners } = gen();
  const fitted = fitToBox(pts, spec.width, spec.height, spec.depth);
  const sampled = resample(fitted, corners, spec.samples);
  // Looking from the camera toward the shape, "right" is facing - 90 degrees.
  const right = toRad(spec.facing - 90);
  const toward = toRad(spec.facing);
  return sampled.map(([u, v, w], i) => {
    const east = u * Math.sin(right) + w * Math.sin(toward);
    const north = u * Math.cos(right) + w * Math.cos(toward);
    const { lat, lon } = offsetLatLon(center, east, north);
    return {
      lat,
      lon,
      alt: spec.centerAlt + v,
      color: colorAt(spec.colorMode, i, sampled.length, spec.color, spec.color2),
      sync: true,
    };
  });
}
