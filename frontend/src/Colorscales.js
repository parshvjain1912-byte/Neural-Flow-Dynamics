// Single source of truth for the color scales. The layer shader and the legend both read this.
// stops: [value, color, optionalAlpha]. Spacing is deliberately uneven, like Windy's scales,
// so the interesting range gets most of the colors. Tune the numbers freely.
export const COLOR_SCALES = {
  temperature: {
    min: -45, max: 50, gamma: 1, unit: "°C", ticks: [-30, -10, 10, 30],
    stops: [[-45, "#3d0a6b"], [-30, "#5b2a9c"], [-20, "#3f4fd8"], [-10, "#2f8fe8"], [0, "#5fd0f0"],
      [5, "#5fd69b"], [12, "#7fdc4a"], [20, "#f2e63a"], [28, "#f59a1f"], [35, "#e8341c"],
      [42, "#b0061f"], [50, "#6e0030"]],
  },
  wind: {
    min: 0, max: 30, gamma: 1, unit: "m/s", ticks: [5, 10, 20, 25],
    stops: [[0, "#2c3fa0"], [1.5, "#2f7fd6"], [3, "#35c4d9"], [5, "#3fd47a"], [7.5, "#b5e63a"],
      [10, "#f7d92a"], [13, "#f79a1e"], [16, "#e8381a"], [20, "#b3126e"], [25, "#6a1b9a"], [30, "#3b0f6b"]],
  },
  pressure: {
    min: 950, max: 1050, gamma: 1, unit: "hPa", ticks: [970, 990, 1010, 1030],
    stops: [[950, "#4b1d91"], [980, "#2f5fd0"], [995, "#35b6e8"], [1005, "#62d68f"], [1013, "#f2e63a"],
      [1022, "#f59a1f"], [1035, "#e8341c"], [1050, "#8a0a2a"]],
  },
  rainfall: {
    // gamma < 1 spreads out the light-rain end, where most values live
    min: 0, max: 50, gamma: 0.5, unit: "mm", ticks: [1, 5, 10, 25],
    stops: [[0, "#3a6fe0", 0], [0.1, "#3a8ff0", 0.55], [0.5, "#35c4e9", 0.8], [1, "#3fd47a"], [2, "#b5e63a"],
      [4, "#f7d92a"], [8, "#f79a1e"], [15, "#e8341c"], [25, "#b3126e"], [40, "#6a1b9a"], [50, "#3b0f6b"]],
  },
};

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgba = ([, h, a = 1]) => [...hex(h), a * 255];

// value -> 0..1 position on the bar. This is what the texture stores and what the legend uses.
export const encode = (v, s) =>
  Math.pow(Math.max(0, Math.min(1, (v - s.min) / (s.max - s.min))), s.gamma);
const decode = (t, s) => s.min + Math.pow(t, 1 / s.gamma) * (s.max - s.min);

function colorAt(v, stops) {
  const n = stops.length;
  if (v <= stops[0][0]) return rgba(stops[0]);
  if (v >= stops[n - 1][0]) return rgba(stops[n - 1]);
  let i = 0;
  while (stops[i + 1][0] < v) i++;
  const f = (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
  const a = rgba(stops[i]), b = rgba(stops[i + 1]);
  return a.map((x, k) => x + (b[k] - x) * f);
}

// 256x1 RGBA lookup table for the shader.
export function buildLut(s) {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) out.set(colorAt(decode(i / 255, s), s.stops).map(Math.round), i * 4);
  return out;
}

export function legendGradient(s) {
  const parts = s.stops.map(st => {
    const [r, g, b, a] = rgba(st);
    return `rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${(encode(st[0], s) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}