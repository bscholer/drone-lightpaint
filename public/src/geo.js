// Local-tangent-plane helpers. Accurate to well under a metre over the few
// hundred metres a light painting spans.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function metersPerDegree(latDeg) {
  const p = rad(latDeg);
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

export function offsetLatLon(origin, east, north) {
  const m = metersPerDegree(origin.lat);
  return { lat: origin.lat + north / m.lat, lon: origin.lon + east / m.lon };
}

export function toEnu(origin, p) {
  const m = metersPerDegree(origin.lat);
  return { e: (p.lon - origin.lon) * m.lon, n: (p.lat - origin.lat) * m.lat };
}

export function distanceM(a, b) {
  const { e, n } = toEnu(a, b);
  return Math.hypot(e, n);
}

/** Compass bearing in degrees [0,360) from a to b. */
export function bearingDeg(a, b) {
  const { e, n } = toEnu(a, b);
  return (deg(Math.atan2(e, n)) + 360) % 360;
}

export const toRad = rad;
