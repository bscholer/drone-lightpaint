export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return rgbToHex([f(5) * 255, f(3) * 255, f(1) * 255]);
}

export function mixHex(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** KML wants aabbggrr. */
export function hexToKmlColor(hex, alpha = 255) {
  const [r, g, b] = hexToRgb(hex);
  return [alpha, b, g, r].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Colour for waypoint i of n: 'solid' | 'rainbow' | 'gradient'. */
export function colorAt(mode, i, n, c1, c2) {
  const t = n > 1 ? i / (n - 1) : 0;
  if (mode === 'rainbow') return hsvToHex(t * 300, 1, 1);
  if (mode === 'gradient') return mixHex(c1, c2, t);
  return c1;
}
