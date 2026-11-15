import type { ShaderDef } from '../types'

// Film Scan — a sunny 35mm snapshot scanned from the negative: soft lens, highlights that
// bloom and wash out to cream, warm yellowed highlights against deep blue shadows,
// faded blacks and heavy, slightly colored film grain.
// Sizes are relative to the output's short side, so the preview matches the export.

const wgsl = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct U {
  res   : vec4f, // width, height, cover scale x, cover scale y
  tone  : vec4f, // exposure (stops), contrast, saturation, fade
  color : vec4f, // warmth, highlight cream, shadow blue, vignette
  glow  : vec4f, // bloom, bloom size, halation, softness
  grain : vec4f, // amount, size, color grain, seed
  extra : vec4f, // dust, chromatic aberration, highlight roll-off, unused
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var photo : texture_2d<f32>;

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

const PI = 3.14159265;
const GOLDEN = 2.39996323;

fn hash(p : vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q = q + dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn hash2(p : vec2f) -> vec2f {
  return vec2f(hash(p), hash(p + vec2f(17.13, 31.71)));
}

fn vnoise(p : vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2f(1.0, 0.0)), s.x),
    mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), s.x),
    s.y);
}

fn luma(c : vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn srgbEncode(c : vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

// Output short-side units -> photo uv.
fn unitToUV() -> vec2f {
  let mn = min(u.res.x, u.res.y);
  return vec2f(mn / u.res.x, mn / u.res.y) * u.res.zw;
}

fn texelsPerUnit() -> f32 {
  let n = unitToUV();
  let t = vec2f(textureDimensions(photo));
  return max(n.x * t.x, n.y * t.y);
}

fn tap(uv : vec2f, lod : f32) -> vec3f {
  return textureSampleLevel(photo, samp, uv, lod).rgb;
}

// Gaussian-ish golden-spiral blur, radius in short-side units (linear light).
fn spiral(uv : vec2f, radius : f32, n : i32, jitter : f32) -> vec3f {
  let norm = unitToUV();
  let lod = log2(max(radius * sqrt(PI / f32(n)) * texelsPerUnit(), 1.0));
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < n; i = i + 1) {
    let fi = f32(i) + 0.5;
    let rho = sqrt(fi / f32(n));
    let th = fi * GOLDEN + jitter;
    let w = exp(-2.5 * rho * rho);
    acc = acc + tap(uv + vec2f(cos(th), sin(th)) * rho * radius * norm, lod) * w;
    wsum = wsum + w;
  }
  return acc / wsum;
}

// Bright parts only, for bloom.
fn highlights(c : vec3f) -> vec3f {
  return c * smoothstep(0.35, 1.0, luma(c));
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let pos = in.position.xy;
  let mn = min(u.res.x, u.res.y);
  let pn = (pos - 0.5 * u.res.xy) / mn;
  let uv = 0.5 + (in.uv - 0.5) * u.res.zw;
  let norm = unitToUV();
  let jitter = hash(floor(pos)) * 6.2831853;
  let seed = u.grain.w * 7.31;

  // Soft lens, with a little color fringing that grows toward the corners.
  let soft = u.glow.w * 0.006 + 0.0006;
  let ca = pn * u.extra.y * 0.006;
  var col = vec3f(
    spiral(uv + ca * norm, soft, 12, jitter).r,
    spiral(uv, soft, 12, jitter).g,
    spiral(uv - ca * norm, soft, 12, jitter).b);

  // Bloom: light from the bright areas spreads over everything; halation adds a warm,
  // tighter red-orange rim (light bouncing off the film base).
  let bsize = u.glow.y * 0.08 + 0.01;
  let wide = highlights(spiral(uv, bsize, 24, jitter));
  let tight = highlights(spiral(uv, bsize * 0.3, 16, jitter + 1.0));
  col = col + wide * u.glow.x * 0.8;
  col = col + tight * vec3f(1.0, 0.45, 0.2) * u.glow.z * 0.6;

  // Exposure and a soft film shoulder: highlights roll off into cream instead of clipping.
  col = max(col, vec3f(0.0)) * exp2(u.tone.x);
  let k = mix(0.95, 0.45, u.extra.z);
  col = select(col, k + (1.0 - k) * (1.0 - exp(-(col - k) / (1.0 - k))), col > vec3f(k));

  var s = srgbEncode(clamp(col, vec3f(0.0), vec3f(1.0)));

  // Contrast, saturation.
  s = clamp((s - 0.5) * u.tone.y + 0.5, vec3f(0.0), vec3f(1.0));
  var l = luma(s);
  s = clamp(mix(vec3f(l), s, u.tone.z), vec3f(0.0), vec3f(1.0));

  // Split tone: highlights yellow toward cream, shadows sink into blue.
  l = luma(s);
  let hi = smoothstep(0.35, 0.95, l);
  let lo = 1.0 - smoothstep(0.0, 0.55, l);
  // Bright colors bleach out on film before they turn cream.
  s = mix(s, vec3f(l), hi * u.color.y * 0.35);
  s = mix(s, s * vec3f(1.04, 1.0, 0.72) + vec3f(0.03, 0.03, 0.0), hi * u.color.y);
  s = s + lo * u.color.z * vec3f(-0.05, -0.01, 0.09);
  s = s + u.color.x * vec3f(0.05, 0.015, -0.06);

  // Faded, slightly blue blacks.
  let lift = u.tone.w * vec3f(0.85, 0.9, 1.0);
  s = lift + clamp(s, vec3f(0.0), vec3f(1.0)) * (1.0 - lift);

  // Vignette.
  s = s * (1.0 - u.color.w * 0.6 * smoothstep(0.3, 1.0, length(pn) * 1.1));

  // Film grain: clumpy, strongest in the mid-tones, part monochrome and part per-channel.
  let gs = max(u.grain.y, 0.3);
  let gp = pn * 1000.0 / gs + seed;
  let mono = (vnoise(gp) * 0.55 + vnoise(gp * 2.13 + 17.0) * 0.3 + hash(floor(gp * 2.0)) * 0.15) - 0.5;
  let chroma = vec3f(
    vnoise(gp * 1.1 + 31.0),
    vnoise(gp * 1.1 + 57.0),
    vnoise(gp * 1.1 + 83.0)) - 0.5;
  // A coarser layer of density mottling.
  let mottle = vnoise(gp * 0.3 + 101.0) - 0.5;
  l = luma(s);
  let amt = u.grain.x * (0.45 + 2.2 * l * (1.0 - l));
  let g = vec3f(mono + mottle * 0.8) * (1.0 - u.grain.z) + (chroma + mono * 0.5) * u.grain.z * 1.3;
  s = s + g * amt * 2.0;

  // A few dust specks and fibers.
  let dust = u.extra.x;
  let dg = pn * 60.0 + seed * 3.0;
  let cell = floor(dg);
  if (hash(cell + 3.1) < dust * 0.1) {
    let c = cell + 0.2 + 0.6 * hash2(cell + 9.7);
    let rad = 0.03 + 0.06 * hash(cell + 5.3);
    let d = length(dg - c);
    let px = 60.0 / mn;
    let a = 1.0 - smoothstep(rad - px, rad + px, d);
    let light = hash(cell + 7.7) < 0.7;
    s = mix(s, select(vec3f(0.08), vec3f(0.97, 0.95, 0.9), light), a * 0.8);
  }

  return vec4f(clamp(s, vec3f(0.0), vec3f(1.0)), 1.0);
}
`

export const filmScan: ShaderDef = {
  id: 'film-scan',
  name: 'Film Scan',
  category: 'photo',
  description: 'Sunny 35mm snapshot: soft lens, creamy blooming highlights, deep blues and heavy film grain.',
  wgsl,
  uniformBytes: 6 * 16,
  seedParam: 'seed',
  params: {
    photo: { type: 'image', label: 'Photo', matchOutputSize: true },
    grain: { type: 'number', label: 'Grain', group: 'Film', defaultValue: 0.1, min: 0, max: 0.25, step: 0.005 },
    grainSize: { type: 'number', label: 'Grain size', group: 'Film', defaultValue: 2.6, min: 0.5, max: 6, step: 0.1 },
    grainColor: { type: 'number', label: 'Color grain', group: 'Film', defaultValue: 0.45, min: 0, max: 1, step: 0.01 },
    softness: { type: 'number', label: 'Softness', group: 'Film', defaultValue: 0.5, min: 0, max: 1, step: 0.01 },
    bloom: { type: 'number', label: 'Bloom', group: 'Film', defaultValue: 0.35, min: 0, max: 1, step: 0.01 },
    bloomSize: { type: 'number', label: 'Bloom size', group: 'Film', defaultValue: 0.4, min: 0, max: 1, step: 0.01 },
    halation: { type: 'number', label: 'Halation', group: 'Film', defaultValue: 0.2, min: 0, max: 1, step: 0.01 },
    aberration: { type: 'number', label: 'Color fringing', group: 'Film', defaultValue: 0.2, min: 0, max: 1, step: 0.01 },
    dust: { type: 'number', label: 'Dust', group: 'Film', defaultValue: 0.2, min: 0, max: 1, step: 0.01 },
    seed: { type: 'number', label: 'Seed', group: 'Film', defaultValue: 1, min: 0, max: 100, step: 1 },
    exposure: { type: 'number', label: 'Exposure', group: 'Color', defaultValue: 0.15, min: -2, max: 2, step: 0.01 },
    rolloff: { type: 'number', label: 'Highlight roll-off', group: 'Color', defaultValue: 0.6, min: 0, max: 1, step: 0.01 },
    contrast: { type: 'number', label: 'Contrast', group: 'Color', defaultValue: 0.95, min: 0.3, max: 1.7, step: 0.01 },
    saturation: { type: 'number', label: 'Saturation', group: 'Color', defaultValue: 1, min: 0, max: 2, step: 0.01 },
    warmth: { type: 'number', label: 'Warmth', group: 'Color', defaultValue: 0.3, min: -1, max: 1, step: 0.01 },
    cream: { type: 'number', label: 'Creamy highlights', group: 'Color', defaultValue: 0.5, min: 0, max: 1, step: 0.01 },
    blueShadows: { type: 'number', label: 'Blue shadows', group: 'Color', defaultValue: 0.4, min: 0, max: 1, step: 0.01 },
    fade: { type: 'number', label: 'Faded blacks', group: 'Color', defaultValue: 0.08, min: 0, max: 0.4, step: 0.01 },
    vignette: { type: 'number', label: 'Vignette', group: 'Color', defaultValue: 0.2, min: 0, max: 1, step: 0.01 },
    zoom: { type: 'number', label: 'Zoom', group: 'Color', defaultValue: 1, min: 1, max: 3, step: 0.01, unit: '×' },
  },

  pack(p, width, height, images) {
    const n = (k: string) => Number(p[k])
    const outAspect = width / height
    const photo = images.photo
    const imgAspect = photo ? photo.width / photo.height : outAspect
    // "Cover" fit: crop the photo to the output aspect, then zoom in.
    let sx = 1
    let sy = 1
    if (imgAspect > outAspect) sx = outAspect / imgAspect
    else sy = imgAspect / outAspect
    sx /= n('zoom')
    sy /= n('zoom')

    return new Float32Array([
      width, height, sx, sy,
      n('exposure'), n('contrast'), n('saturation'), n('fade'),
      n('warmth'), n('cream'), n('blueShadows'), n('vignette'),
      n('bloom'), n('bloomSize'), n('halation'), n('softness'),
      n('grain'), n('grainSize'), n('grainColor'), n('seed'),
      n('dust'), n('aberration'), n('rolloff'), 0,
    ])
  },
}
