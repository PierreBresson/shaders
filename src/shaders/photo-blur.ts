import type { ParamDef, ParamValues, ShaderDef } from '../types'

// Photo blur presets — three in-camera blur looks applied to an uploaded photo:
//   Frosted Glass: the scene seen through frosted glass; dark shapes stay crisper, light dissolves into milk.
//   Bokeh: wide-aperture lens blur; highlights bloom into bright discs (or polygons).
//   Motion Pan: intentional camera movement; long streaks along one direction.
// All blurring happens in linear light on the mipmapped photo, then a shared film finish
// (exposure, soft highlight shoulder, contrast, saturation, fade, grain).

const prelude = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct U {
  res  : vec4f, // width, height, cover scale x, cover scale y
  tone : vec4f, // exposure (stops), contrast, saturation, fade
  film : vec4f, // grain, grain size (px), unused x2
  p0   : vec4f, // effect params
  p1   : vec4f,
  p2   : vec4f,
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

fn rot(v : vec2f, a : f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

// Output uv -> photo uv, with a "cover" crop and zoom.
fn photoUV(uv : vec2f) -> vec2f {
  return 0.5 + (uv - 0.5) * u.res.zw;
}

// Offsets are in units of the output's short side; this converts them to photo uv.
fn unitToUV() -> vec2f {
  let mn = min(u.res.x, u.res.y);
  return vec2f(mn / u.res.x, mn / u.res.y) * u.res.zw;
}

// Photo texels per output short-side unit (for picking a mip level).
fn texelsPerUnit() -> f32 {
  let n = unitToUV();
  let t = vec2f(textureDimensions(photo));
  return max(n.x * t.x, n.y * t.y);
}

fn tap(uv : vec2f, lod : f32) -> vec3f {
  return textureSampleLevel(photo, samp, uv, lod).rgb;
}

// Linear color -> final display color: exposure, soft highlight shoulder,
// contrast, saturation, fade and film grain.
fn finish(colIn : vec3f, pos : vec2f) -> vec4f {
  var col = max(colIn, vec3f(0.0)) * exp2(u.tone.x);
  let k = 0.8;
  col = select(col, k + (1.0 - k) * (1.0 - exp(-(col - k) / (1.0 - k))), col > vec3f(k));

  var s = srgbEncode(clamp(col, vec3f(0.0), vec3f(1.0)));
  s = (s - 0.5) * u.tone.y + 0.5;
  s = mix(vec3f(luma(s)), s, u.tone.z);
  s = u.tone.w + s * (1.0 - u.tone.w);

  let gp = pos / max(u.film.y, 0.5);
  let g = (vnoise(gp) + vnoise(gp * 1.7 + 37.1)) - 1.0;
  s = clamp(s + g * u.film.x * 1.5, vec3f(0.0), vec3f(1.0));
  return vec4f(s, 1.0);
}
`

// ---------- Frosted Glass ----------
// p0: far blur radius, depth (how much darker areas stay sharp), milk amount, glass texture
// p1: milk color (linear rgb), unused

const frostedWgsl =
  prelude +
  /* wgsl */ `
// Golden-angle spiral with gaussian weights at a per-pixel radius.
fn spiral(uv : vec2f, radius : f32, n : i32, jitter : f32) -> vec3f {
  let norm = unitToUV();
  let spacingPx = radius * sqrt(PI / f32(n)) * texelsPerUnit();
  let lod = log2(max(spacingPx, 1.0));
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

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let rFar = u.p0.x;
  let depth = u.p0.y;
  let milk = u.p0.z;
  let texAmt = u.p0.w;
  let milkColor = u.p1.xyz;

  let pos = in.position.xy;
  let jitter = hash(floor(pos)) * 6.2831853;
  // Frosted surface: each pixel looks through a slightly different bit of glass.
  let wob = vec2f(hash(pos + 11.3), hash(pos + 71.9)) - 0.5;
  let uv = photoUV(in.uv) + wob * texAmt * 0.012 * unitToUV();

  // How close is this part of the scene to the glass? Darker regions read as nearer.
  let coarse = tap(uv, log2(max(rFar * 0.6 * texelsPerUnit(), 1.0)));
  let local = tap(uv, log2(max(rFar * 0.15 * texelsPerUnit(), 1.0)));
  let near = 1.0 - smoothstep(0.04, 0.45, luma(local));
  let nearness = near * depth;

  let radius = mix(rFar, rFar * 0.12, nearness);
  var col = spiral(uv, radius, 56, jitter);

  // Light scattered by the glass veils whatever is far from it.
  let veil = milk * mix(1.0, 0.25, nearness);
  col = mix(col, milkColor * max(luma(coarse) * 1.3, 0.55), veil * 0.75);

  return finish(col, pos);
}
`

// ---------- Bokeh ----------
// p0: disc radius, highlight boost, highlight threshold, rim brightness
// p1: blades (0 = round), blade rotation (rad), unused x2

const bokehWgsl =
  prelude +
  /* wgsl */ `
@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let radius = u.p0.x;
  let boost = u.p0.y;
  let thresh = u.p0.z;
  let rim = u.p0.w;
  let blades = u.p1.x;
  let bladeRot = u.p1.y;

  let pos = in.position.xy;
  let uv = photoUV(in.uv);
  let jitter = hash(floor(pos)) * 6.2831853;
  let norm = unitToUV();

  let n = 128;
  let spacingPx = radius * sqrt(PI / f32(n)) * texelsPerUnit();
  let lod = max(log2(max(spacingPx, 1.0)) - 0.5, 0.0);
  let seg = 2.0 * PI / max(blades, 3.0);

  // Uniform disc (the aperture shape). Bright samples are pushed above 1 so they
  // read as clipped highlights and spread into solid discs.
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < n; i = i + 1) {
    let fi = f32(i) + 0.5;
    var rho = sqrt(fi / f32(n));
    let th = fi * GOLDEN + jitter;
    if (blades >= 3.0) {
      let a = th - bladeRot;
      let x = a - seg * floor(a / seg) - seg * 0.5;
      rho = rho * cos(seg * 0.5) / cos(x);
    }
    let c = tap(uv + vec2f(cos(th), sin(th)) * rho * radius * norm, lod);
    let hl = smoothstep(thresh, mix(thresh, 1.0, 0.5) + 0.02, sqrt(luma(c)));
    let w = 1.0 + rim * 2.5 * smoothstep(0.7, 1.0, rho);
    acc = acc + c * (1.0 + boost * 14.0 * hl * hl) * w;
    wsum = wsum + w;
  }
  return finish(acc / wsum, pos);
}
`

// ---------- Motion Pan ----------
// p0: streak length, angle (rad), wobble amount, wobble frequency
// p1: cross blur, streak texture, streak density, unused

const motionWgsl =
  prelude +
  /* wgsl */ `
@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let len = u.p0.x;
  let ang = u.p0.y;
  let wobble = u.p0.z;
  let wfreq = u.p0.w;
  let crossAmt = u.p1.x;
  let streaks = u.p1.y;
  let density = u.p1.z;

  let pos = in.position.xy;
  let uv = photoUV(in.uv);
  let norm = unitToUV();
  let dir = vec2f(cos(ang), sin(ang));
  let perp = vec2f(-dir.y, dir.x);
  let tpu = texelsPerUnit();

  let n = 96;
  let jitter = hash(floor(pos)) - 0.5;
  let jitter2 = hash(floor(pos) + 5.7);
  let spacingPx = len / f32(n) * tpu;
  let lod = max(max(log2(max(spacingPx, 1.0)) - 1.0, log2(max(crossAmt * 0.03 * tpu, 1.0))), 0.0);

  // A soft-ended box along the path of the camera, which sways a little (wobble).
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < n; i = i + 1) {
    let t = (f32(i) + 0.5 + jitter) / f32(n) - 0.5;
    let sway = wobble * 0.04 * sin(t * wfreq * 6.2831853 + 1.3);
    let spread = (fract(f32(i) * 0.618 + jitter2) - 0.5) * crossAmt * 0.03;
    let o = dir * t * len + perp * (sway + spread);
    let w = 1.0 - 0.75 * smoothstep(0.3, 0.5, abs(t));
    acc = acc + tap(uv + o * norm, lod) * w;
    wsum = wsum + w;
  }
  var col = acc / wsum;

  // Fine streaks running along the motion, fading in and out along their length.
  let mn = min(u.res.x, u.res.y);
  let p = (pos - 0.5 * u.res.xy) / mn;
  let across = dot(p, perp) * density;
  let along = dot(p, dir) * 1.5;
  let s = vnoise(vec2f(across, along)) * 0.6 + vnoise(vec2f(across * 2.7 + 13.0, along * 2.0)) * 0.4;
  col = col * (1.0 + (s - 0.5) * streaks * 0.7);

  return finish(col, pos);
}
`

// ---------- shared params / packing ----------

const photoParam: ParamDef = { type: 'image', label: 'Photo', matchOutputSize: true }

const finishParams = (d: { exposure: number; contrast: number; saturation: number; fade: number; grain: number; grainSize: number }) =>
  ({
    exposure: { type: 'number', label: 'Exposure', group: 'Finish', defaultValue: d.exposure, min: -2, max: 2, step: 0.01 },
    contrast: { type: 'number', label: 'Contrast', group: 'Finish', defaultValue: d.contrast, min: 0.3, max: 1.7, step: 0.01 },
    saturation: { type: 'number', label: 'Saturation', group: 'Finish', defaultValue: d.saturation, min: 0, max: 2, step: 0.01 },
    fade: { type: 'number', label: 'Fade', group: 'Finish', defaultValue: d.fade, min: 0, max: 0.5, step: 0.01 },
    grain: { type: 'number', label: 'Grain', group: 'Finish', defaultValue: d.grain, min: 0, max: 0.3, step: 0.005 },
    grainSize: { type: 'number', label: 'Grain size', group: 'Finish', defaultValue: d.grainSize, min: 0.5, max: 5, step: 0.1, unit: 'px' },
    zoom: { type: 'number', label: 'Zoom', group: 'Finish', defaultValue: 1.04, min: 1, max: 3, step: 0.01, unit: '×' },
  }) satisfies Record<string, ParamDef>

/** Pack the shared header (size, cover fit, finish) followed by 12 effect floats. */
function packWith(p: ParamValues, width: number, height: number, photo: { width: number; height: number } | null, effect: number[]) {
  const n = (k: string) => Number(p[k])
  const outAspect = width / height
  const imgAspect = photo ? photo.width / photo.height : outAspect
  let sx = 1
  let sy = 1
  if (imgAspect > outAspect) sx = outAspect / imgAspect
  else sy = imgAspect / outAspect
  sx /= n('zoom')
  sy /= n('zoom')
  const out = new Float32Array(24)
  out.set([width, height, sx, sy, n('exposure'), n('contrast'), n('saturation'), n('fade'), n('grain'), n('grainSize'), 0, 0])
  out.set(effect.slice(0, 12), 12)
  return out
}

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const rad = (deg: number) => (deg * Math.PI) / 180

export const frostedGlass: ShaderDef = {
  id: 'frosted-glass',
  name: 'Frosted Glass',
  category: 'photo',
  description: 'Your photo seen through frosted glass: dark shapes stay close and crisp, the rest melts into milky light.',
  wgsl: frostedWgsl,
  uniformBytes: 24 * 4,
  params: {
    photo: photoParam,
    frost: { type: 'number', label: 'Frost', defaultValue: 0.6, min: 0, max: 1, step: 0.01 },
    depth: { type: 'number', label: 'Dark shapes stay sharp', defaultValue: 0.75, min: 0, max: 1, step: 0.01 },
    milk: { type: 'number', label: 'Milkiness', defaultValue: 0.3, min: 0, max: 1, step: 0.01 },
    milkColor: { type: 'color', label: 'Milk color', defaultValue: { r: 0.86, g: 0.91, b: 0.95 } },
    texture: { type: 'number', label: 'Glass texture', defaultValue: 0.35, min: 0, max: 1, step: 0.01 },
    ...finishParams({ exposure: 0.1, contrast: 1.05, saturation: 1.1, fade: 0.02, grain: 0.06, grainSize: 1 }),
  },
  pack(p, width, height, images) {
    const n = (k: string) => Number(p[k])
    const c = p.milkColor as { r: number; g: number; b: number }
    return packWith(p, width, height, images.photo, [
      n('frost') * 0.14, n('depth'), n('milk'), n('texture'),
      srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b), 0,
    ])
  },
}

export const bokeh: ShaderDef = {
  id: 'bokeh',
  name: 'Bokeh',
  category: 'photo',
  description: 'Wide-open lens blur: highlights bloom into soft discs over a creamy background.',
  wgsl: bokehWgsl,
  uniformBytes: 24 * 4,
  params: {
    photo: photoParam,
    size: { type: 'number', label: 'Blur size', defaultValue: 0.45, min: 0, max: 1, step: 0.01 },
    boost: { type: 'number', label: 'Highlight bloom', defaultValue: 0.65, min: 0, max: 1, step: 0.01 },
    threshold: { type: 'number', label: 'Highlight threshold', defaultValue: 0.8, min: 0, max: 1, step: 0.01 },
    rim: { type: 'number', label: 'Bright rim', defaultValue: 0.25, min: 0, max: 1, step: 0.01 },
    blades: { type: 'number', label: 'Aperture blades', defaultValue: 0, min: 0, max: 9, step: 1 },
    bladeAngle: { type: 'number', label: 'Blade rotation', defaultValue: 0, min: 0, max: 120, step: 1, unit: '°' },
    ...finishParams({ exposure: 0, contrast: 1.05, saturation: 1.15, fade: 0, grain: 0.03, grainSize: 1.2 }),
  },
  pack(p, width, height, images) {
    const n = (k: string) => Number(p[k])
    return packWith(p, width, height, images.photo, [
      n('size') * 0.12, n('boost'), n('threshold'), n('rim'),
      n('blades'), rad(n('bladeAngle')), 0, 0,
    ])
  },
}

export const motionPan: ShaderDef = {
  id: 'motion-pan',
  name: 'Motion Pan',
  category: 'photo',
  description: 'Intentional camera movement: the scene smeared into long, painterly streaks.',
  wgsl: motionWgsl,
  uniformBytes: 24 * 4,
  params: {
    photo: photoParam,
    length: { type: 'number', label: 'Streak length', defaultValue: 0.6, min: 0, max: 1, step: 0.01 },
    angle: { type: 'number', label: 'Direction', defaultValue: 0, min: -90, max: 90, step: 1, unit: '°' },
    cross: { type: 'number', label: 'Cross blur', defaultValue: 0.25, min: 0, max: 1, step: 0.01 },
    wobble: { type: 'number', label: 'Hand shake', defaultValue: 0.15, min: 0, max: 1, step: 0.01 },
    wobbleFreq: { type: 'number', label: 'Shake frequency', defaultValue: 1.5, min: 0.5, max: 6, step: 0.1 },
    streaks: { type: 'number', label: 'Streak texture', defaultValue: 0.3, min: 0, max: 1, step: 0.01 },
    density: { type: 'number', label: 'Streak density', defaultValue: 60, min: 10, max: 200, step: 1 },
    ...finishParams({ exposure: 0.1, contrast: 1, saturation: 1.15, fade: 0.03, grain: 0.02, grainSize: 1.2 }),
  },
  pack(p, width, height, images) {
    const n = (k: string) => Number(p[k])
    return packWith(p, width, height, images.photo, [
      n('length') * 0.9, rad(n('angle')), n('wobble'), n('wobbleFreq'),
      n('cross'), n('streaks'), n('density'), 0,
    ])
  },
}
