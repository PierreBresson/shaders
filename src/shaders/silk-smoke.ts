import type { Gradient, GradientStop, RGB, ShaderDef } from '../types'

// Silk Smoke — airy pastel flow: domain-warped, stretched noise drifting diagonally across a
// soft gradient, with two warped colour clouds (cool at the top, warm at the bottom) and
// thin silky light streaks.

const wgsl = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct U {
  res : vec4f,          // width, height, flow angle (rad), scale
  a   : vec4f,          // stretch, warp, turbulence, streaks
  b   : vec4f,          // seed, tone, gradient spread, stop count
  c   : vec4f,          // grain, accent A size, accent B size, softness
  d   : vec4f,          // detail, unused x3
  ac  : vec4f,          // accent A pos xy, accent B pos xy (uv, 0..1)
  ca  : vec4f,          // accent A colour, strength
  cb  : vec4f,          // accent B colour, strength
  pos : array<vec4f, 2>,
  col : array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> u : U;

struct VOut {
  @builtin(position) position : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs_main(@location(0) p : vec2f, @location(1) uv : vec2f) -> VOut {
  var o : VOut;
  o.position = vec4f(p, 0.0, 1.0);
  o.uv = uv;
  return o;
}

fn stopPos(i : i32) -> f32 {
  let v = u.pos[i / 4];
  let k = i % 4;
  if (k == 0) { return v.x; }
  if (k == 1) { return v.y; }
  if (k == 2) { return v.z; }
  return v.w;
}

fn ramp(t : f32) -> vec3f {
  let n = i32(u.b.w);
  var c = u.col[0].rgb;
  for (var i = 1; i < 8; i = i + 1) {
    if (i < n) {
      let p0 = stopPos(i - 1);
      let p1 = stopPos(i);
      let w = smoothstep(0.0, 1.0, clamp((t - p0) / max(p1 - p0, 0.0001), 0.0, 1.0));
      c = mix(c, u.col[i].rgb, w);
    }
  }
  return c;
}

fn hash2(p : vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q = q + dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn noise(p : vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

fn fbm(p0 : vec2f) -> f32 {
  var p = p0;
  var s = 0.0;
  var amp = 0.5;
  let m = mat2x2f(0.8, 0.6, -0.6, 0.8);
  for (var i = 0; i < 5; i = i + 1) {
    s = s + amp * noise(p);
    p = m * p * 2.02 + vec2f(1.7, 9.2);
    amp = amp * u.d.x;
  }
  return s;
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let w = u.res.x;
  let h = u.res.y;
  let aspect = w / max(h, 1.0);
  // Normalised by the short side so the pattern keeps its size at any aspect ratio.
  let sh = min(aspect, 1.0);
  let px = (in.uv.x - 0.5) * aspect / sh;
  let py = (in.uv.y - 0.5) / sh;

  // Flow frame: x along the streaks, y across them.
  let ang = u.res.z;
  let ca = cos(ang);
  let sa = sin(ang);
  let fx = ca * px - sa * py;
  let fy = sa * px + ca * py;

  let seed = u.b.x;
  let sc = u.res.w;
  let stretch = u.a.x;
  let warp = u.a.y;
  let turb = u.a.z;
  let off = vec2f(seed * 7.31, seed * 3.17);

  // Stretched domain: long along the flow, short across it.
  let p = vec2f(fx / stretch, fy) * sc + off;

  // Two levels of domain warping (smoke / silk look).
  let q = vec2f(fbm(p), fbm(p + vec2f(5.2, 1.3)));
  let r = vec2f(fbm(p + turb * 4.0 * q + vec2f(1.7, 9.2)),
                fbm(p + turb * 4.0 * q + vec2f(8.3, 2.8)));
  let f = fbm(p + turb * 4.0 * r);

  // Displacement applied to the base gradient and colour clouds, mostly across the flow.
  let disp = warp * (f - 0.5) * 1.6 + warp * 0.6 * (r.y - 0.5);
  let dvec = vec2f(-sa, ca) * disp + vec2f(ca, sa) * warp * 0.3 * (q.x - 0.5);

  // Base gradient runs top (0) → bottom (1), bent by the flow.
  let spread = u.b.z;
  var t = 0.5 + (py + dvec.y) * 0.5 / spread * sh + u.b.y;

  // Silky streaks: thin ridges in the warped field.
  let soft = u.c.w;
  let band = abs(fract(f * 6.0 + r.x * 2.0) - 0.5) * 2.0;
  let streak = pow(1.0 - band, mix(14.0, 3.0, soft)) * smoothstep(0.25, 0.75, r.y);
  t = t - u.a.w * 0.06 * streak;

  var col = ramp(clamp(t, 0.0, 1.0));

  // Colour clouds, warped by the same field so they ride the flow.
  let uvw = vec2f(in.uv.x * aspect / sh, in.uv.y / sh) + dvec * 0.6;
  let pa = vec2f(u.ac.x * aspect / sh, u.ac.y / sh);
  let pb = vec2f(u.ac.z * aspect / sh, u.ac.w / sh);
  let ma = u.ca.w * smoothstep(1.0, 0.0, length(uvw - pa) / max(u.c.y, 0.001));
  let mb = u.cb.w * smoothstep(1.0, 0.0, length(uvw - pb) / max(u.c.z, 0.001));
  col = mix(col, u.ca.rgb, clamp(ma * (0.75 + 0.5 * (q.y - 0.5)), 0.0, 1.0));
  col = mix(col, u.cb.rgb, clamp(mb * (0.75 + 0.5 * (q.x - 0.5)), 0.0, 1.0));

  // Light streaks lift towards white.
  col = mix(col, vec3f(1.0, 0.98, 0.97), clamp(u.a.w * 0.35 * streak, 0.0, 1.0));

  let g = hash2(floor(in.position.xy) + vec2f(seed * 17.0, 3.0)) - 0.5;
  col = clamp(col + g * u.c.x, vec3f(0.0), vec3f(1.0));

  return vec4f(col, 1.0);
}
`

const pastelPalette: Gradient = {
  stops: [
    { position: 0.0, color: { r: 0.93, g: 0.89, b: 0.94 } },
    { position: 0.3, color: { r: 0.99, g: 0.95, b: 0.94 } },
    { position: 0.55, color: { r: 0.99, g: 0.88, b: 0.89 } },
    { position: 0.75, color: { r: 0.98, g: 0.7, b: 0.72 } },
    { position: 0.9, color: { r: 0.97, g: 0.45, b: 0.45 } },
    { position: 1.0, color: { r: 0.93, g: 0.2, b: 0.26 } },
  ],
}

const lavender: RGB = { r: 0.82, g: 0.68, b: 0.88 }
const tangerine: RGB = { r: 0.98, g: 0.47, b: 0.18 }

export const silkSmoke: ShaderDef = {
  id: 'silk-smoke',
  name: 'Silk Smoke',
  category: 'generative',
  description: 'Airy pastel flow with drifting silky streaks.',
  wgsl,
  // 8 vec4 + 2 vec4 positions + 8 vec4 colours = 18 * 16 = 288 bytes
  uniformBytes: 288,
  seedParam: 'seed',
  params: {
    palette: { type: 'gradient', label: 'Gradient (top → bottom)', defaultValue: pastelPalette, maxStops: 8 },
    spread: { type: 'number', label: 'Gradient spread', defaultValue: 0.6, min: 0.3, max: 2, step: 0.01 },
    tone: { type: 'number', label: 'Gradient offset', defaultValue: 0, min: -0.5, max: 0.5, step: 0.01 },

    angle: { type: 'number', label: 'Flow angle', defaultValue: -28, min: -180, max: 180, step: 1, unit: '°', group: 'Flow' },
    scale: { type: 'number', label: 'Scale', defaultValue: 1.0, min: 0.3, max: 5, step: 0.01, group: 'Flow' },
    stretch: { type: 'number', label: 'Stretch', defaultValue: 2.6, min: 1, max: 6, step: 0.01, group: 'Flow' },
    warp: { type: 'number', label: 'Displacement', defaultValue: 1.0, min: 0, max: 1.5, step: 0.01, group: 'Flow' },
    detail: { type: 'number', label: 'Detail', defaultValue: 0.47, min: 0.1, max: 0.65, step: 0.01, group: 'Flow' },
    turbulence: { type: 'number', label: 'Turbulence', defaultValue: 1.0, min: 0, max: 2, step: 0.01, group: 'Flow' },
    streaks: { type: 'number', label: 'Silk streaks', defaultValue: 0.65, min: 0, max: 2, step: 0.01, group: 'Flow' },
    softness: { type: 'number', label: 'Streak softness', defaultValue: 0.95, min: 0, max: 1, step: 0.01, group: 'Flow' },

    accentA: { type: 'color', label: 'Cloud A colour', defaultValue: lavender, group: 'Colour clouds' },
    accentAStrength: { type: 'number', label: 'Cloud A strength', defaultValue: 0.7, min: 0, max: 1, step: 0.01, group: 'Colour clouds' },
    accentASize: { type: 'number', label: 'Cloud A size', defaultValue: 0.55, min: 0.05, max: 1.5, step: 0.01, group: 'Colour clouds' },
    accentAX: { type: 'number', label: 'Cloud A x', defaultValue: 0.0, min: -0.5, max: 1.5, step: 0.01, group: 'Colour clouds' },
    accentAY: { type: 'number', label: 'Cloud A y', defaultValue: 0.2, min: -0.5, max: 1.5, step: 0.01, group: 'Colour clouds' },
    accentB: { type: 'color', label: 'Cloud B colour', defaultValue: tangerine, group: 'Colour clouds' },
    accentBStrength: { type: 'number', label: 'Cloud B strength', defaultValue: 0.95, min: 0, max: 1, step: 0.01, group: 'Colour clouds' },
    accentBSize: { type: 'number', label: 'Cloud B size', defaultValue: 0.65, min: 0.05, max: 1.5, step: 0.01, group: 'Colour clouds' },
    accentBX: { type: 'number', label: 'Cloud B x', defaultValue: -0.05, min: -0.5, max: 1.5, step: 0.01, group: 'Colour clouds' },
    accentBY: { type: 'number', label: 'Cloud B y', defaultValue: 0.88, min: -0.5, max: 1.5, step: 0.01, group: 'Colour clouds' },

    grain: { type: 'number', label: 'Grain', defaultValue: 0.015, min: 0, max: 0.25, step: 0.005, group: 'Finish' },
    seed: { type: 'number', label: 'Variation', defaultValue: 7, min: 0, max: 20, step: 0.01, group: 'Finish' },
  },

  pack(p, width, height) {
    const n = (k: string) => Number(p[k])
    const c = (k: string) => p[k] as RGB
    const palette = p.palette as Gradient | undefined
    const given: GradientStop[] =
      palette && palette.stops && palette.stops.length >= 2 ? palette.stops : pastelPalette.stops
    const stops = [...given].sort((a, b) => a.position - b.position).slice(0, 8)

    const data = new Float32Array(72)
    data.set([width, height, (n('angle') * Math.PI) / 180, n('scale')], 0)
    data.set([n('stretch'), n('warp'), n('turbulence'), n('streaks')], 4)
    data.set([n('seed'), n('tone'), n('spread'), stops.length], 8)
    data.set([n('grain'), n('accentASize'), n('accentBSize'), n('softness')], 12)
    data.set([n('detail'), 0, 0, 0], 16)
    data.set([n('accentAX'), n('accentAY'), n('accentBX'), n('accentBY')], 20)
    const a = c('accentA')
    const b = c('accentB')
    data.set([a.r, a.g, a.b, n('accentAStrength')], 24)
    data.set([b.r, b.g, b.b, n('accentBStrength')], 28)

    for (let i = 0; i < 8; i++) {
      const st = stops[Math.min(i, stops.length - 1)]
      data[32 + i] = i < stops.length ? st.position : 1
      data[40 + i * 4] = st.color.r
      data[40 + i * 4 + 1] = st.color.g
      data[40 + i * 4 + 2] = st.color.b
      data[40 + i * 4 + 3] = 1
    }
    return data
  },
}
