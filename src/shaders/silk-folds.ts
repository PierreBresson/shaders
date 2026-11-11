import type { Gradient, GradientStop, ShaderDef } from '../types'

// Silk Folds — soft satin-like diagonal folds with film grain.
// Default palette: NobodyWho brand (deep maroon → ground → glow → amber → cream).

const wgsl = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct U {
  res : vec4f,          // width, height, fold angle (rad), fold scale
  a   : vec4f,          // warp, softness, grain, sheen
  b   : vec4f,          // seed, tone, contrast, stop count
  c   : vec4f,          // light angle (rad), unused x3
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
      let w = clamp((t - p0) / max(p1 - p0, 0.0001), 0.0, 1.0);
      c = mix(c, u.col[i].rgb, w);
    }
  }
  return c;
}

fn heightAt(x : f32, y : f32) -> f32 {
  let s = u.b.x;
  let warp = u.a.x;
  let yw = y + warp * (0.6 * sin(x * 1.1 + s) + 0.4 * sin(x * 2.3 - y * 0.7 + s * 1.7));
  let f = u.res.w * 3.14159265;
  return 0.55 * sin(yw * f + 0.5 * sin(x * 0.9 + s * 0.5))
       + 0.30 * sin(yw * f * 1.9 + 1.7 + x * 0.6)
       + 0.15 * sin(yw * f * 3.3 + s * 2.0 - x * 0.9);
}

fn hash(p : vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q = q + dot(q, q + 45.32);
  return fract(q.x * q.y);
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let w = u.res.x;
  let h = u.res.y;
  let aspect = w / max(h, 1.0);
  let px = (in.uv.x - 0.5) * aspect;
  let py = in.uv.y - 0.5;

  let ca = cos(u.res.z);
  let sa = sin(u.res.z);
  let x = 2.0 * (ca * px + sa * py);
  let y = 2.0 * (-sa * px + ca * py);

  // Height field and a fake normal from finite differences.
  let e = 0.002;
  let h0 = heightAt(x, y);
  let dx = (heightAt(x + e, y) - h0) / e;
  let dy = (heightAt(x, y + e) - h0) / e;
  let k = 0.12 / (0.3 + u.a.y);
  let n = normalize(vec3f(-dx * k, -dy * k, 1.0));

  let la = u.c.x;
  let L = normalize(vec3f(cos(la) * 0.65, sin(la) * 0.65, 0.75));
  let dif = clamp(dot(n, L), 0.0, 1.0);
  let H = normalize(vec3f(0.0, 0.0, 1.0) + L);
  let spec = pow(clamp(dot(n, H), 0.0, 1.0), 18.0);

  // Broad light falloff across the folds: brighter through the middle band.
  let across = -sa * px + ca * py;
  let glob = 0.5 - 0.9 * across * across;

  let contrast = u.b.z;
  var t = 0.5 + contrast * (0.7 * (dif - 0.6) + 0.125 * h0) + u.b.y + 0.3 * (glob - 0.5);
  t = t + u.a.w * 0.25 * spec;
  t = clamp(t, 0.0, 1.0);

  var col = ramp(t);

  // Film grain, in output pixels so it stays crisp at any size.
  let g = hash(floor(in.position.xy) + vec2f(u.b.x * 17.0, 3.0)) - 0.5;
  col = clamp(col + g * u.a.z, vec3f(0.0), vec3f(1.0));

  return vec4f(col, 1.0);
}
`

const brandPalette: Gradient = {
  stops: [
    { position: 0.0, color: { r: 0.102, g: 0.016, b: 0.02 } },
    { position: 0.22, color: { r: 0.165, g: 0.027, b: 0.035 } },
    { position: 0.45, color: { r: 0.306, g: 0.078, b: 0.067 } },
    { position: 0.68, color: { r: 0.447, g: 0.157, b: 0.102 } },
    { position: 0.88, color: { r: 0.949, g: 0.627, b: 0.18 } },
    { position: 1.0, color: { r: 0.957, g: 0.929, b: 0.902 } },
  ],
}

export const silkFolds: ShaderDef = {
  id: 'silk-folds',
  name: 'Silk Folds',
  description: 'Soft satin-like diagonal folds with film grain.',
  wgsl,
  // 4 vec4 + 2 vec4 positions + 8 vec4 colors = 14 * 16 = 224 bytes
  uniformBytes: 224,
  seedParam: 'seed',
  params: {
    palette: { type: 'gradient', label: 'Palette', defaultValue: brandPalette, maxStops: 8 },
    angle: { type: 'number', label: 'Fold angle', defaultValue: 33, min: -180, max: 180, step: 1, unit: '°' },
    scale: { type: 'number', label: 'Fold density', defaultValue: 1.15, min: 0.3, max: 3, step: 0.01 },
    warp: { type: 'number', label: 'Waviness', defaultValue: 0.4, min: 0, max: 1.5, step: 0.01 },
    softness: { type: 'number', label: 'Softness', defaultValue: 0.9, min: 0, max: 3, step: 0.01 },
    contrast: { type: 'number', label: 'Contrast', defaultValue: 0.95, min: 0, max: 2, step: 0.01 },
    tone: { type: 'number', label: 'Brightness', defaultValue: 0, min: -0.5, max: 0.5, step: 0.01 },
    sheen: { type: 'number', label: 'Sheen', defaultValue: 0.7, min: 0, max: 2, step: 0.01 },
    lightAngle: { type: 'number', label: 'Light angle', defaultValue: -122, min: -180, max: 180, step: 1, unit: '°' },
    grain: { type: 'number', label: 'Grain', defaultValue: 0.05, min: 0, max: 0.25, step: 0.005 },
    seed: { type: 'number', label: 'Variation', defaultValue: 3, min: 0, max: 20, step: 0.01 },
  },

  pack(p, width, height) {
    const n = (k: string) => Number(p[k])
    const palette = p.palette as Gradient | undefined
    const given: GradientStop[] =
      palette && palette.stops && palette.stops.length >= 2 ? palette.stops : brandPalette.stops
    const stops = [...given].sort((a, b) => a.position - b.position).slice(0, 8)

    const data = new Float32Array(56)
    data[0] = width
    data[1] = height
    data[2] = (n('angle') * Math.PI) / 180
    data[3] = n('scale')

    data[4] = n('warp')
    data[5] = n('softness')
    data[6] = n('grain')
    data[7] = n('sheen')

    data[8] = n('seed')
    data[9] = n('tone')
    data[10] = n('contrast')
    data[11] = stops.length

    data[12] = (n('lightAngle') * Math.PI) / 180

    for (let i = 0; i < 8; i++) {
      const st = stops[Math.min(i, stops.length - 1)]
      data[16 + i] = i < stops.length ? st.position : 1
      data[24 + i * 4] = st.color.r
      data[24 + i * 4 + 1] = st.color.g
      data[24 + i * 4 + 2] = st.color.b
      data[24 + i * 4 + 3] = 1
    }
    return data
  },
}
