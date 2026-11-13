import type { ShaderDef } from '../types'

// Analog Print — a photo printed in ink on old paper, then scanned:
// a warm, faded film grade, CMYK inks laid down on a halftone screen, ink misregistration,
// uneven ink, paper fibers, dust and grain.
// The "Print pattern" slider blends each ink between continuous tone (a clean, soft
// vintage photo) and halftone dots (a strongly patterned magazine print).
// Every size is relative to the output's short side, so the preview matches the export.

const wgsl = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct U {
  res    : vec4f, // width, height, cover scale x, cover scale y
  tone   : vec4f, // exposure (stops), contrast, saturation, fade
  grade  : vec4f, // warmth, softness, black ink amount, seed
  screen : vec4f, // pattern, lines per short side, screen angle (rad), dot roughness
  print  : vec4f, // misregistration, ink unevenness, paper texture, dust
  paper  : vec4f, // paper color (display rgb), unused
  film   : vec4f, // grain, grain size, unused x2
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

fn fbm(p : vec2f) -> f32 {
  var a = 0.5;
  var f = p;
  var s = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    s = s + a * vnoise(f);
    f = f * 2.03 + vec2f(7.1, 3.7);
    a = a * 0.5;
  }
  return s / 0.9375;
}

fn rot(v : vec2f, a : f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
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

// Slightly soft sample (5 taps on a matching mip), in linear light.
fn soft(uv : vec2f, radius : f32) -> vec3f {
  let n = unitToUV();
  let t = vec2f(textureDimensions(photo));
  let px = radius * max(n.x * t.x, n.y * t.y);
  let lod = log2(max(px, 1.0));
  let o = n * radius * 0.7;
  var c = textureSampleLevel(photo, samp, uv, lod).rgb * 2.0;
  c = c + textureSampleLevel(photo, samp, uv + vec2f(o.x, 0.0), lod).rgb;
  c = c + textureSampleLevel(photo, samp, uv - vec2f(o.x, 0.0), lod).rgb;
  c = c + textureSampleLevel(photo, samp, uv + vec2f(0.0, o.y), lod).rgb;
  c = c + textureSampleLevel(photo, samp, uv - vec2f(0.0, o.y), lod).rgb;
  return c / 6.0;
}

// Film grade in display space: exposure, warmth, contrast, saturation, faded blacks.
fn grade(lin : vec3f) -> vec3f {
  var s = srgbEncode(clamp(lin * exp2(u.tone.x), vec3f(0.0), vec3f(1.0)));
  let w = u.grade.x;
  // Warm the mids and highlights, keep a hint of teal in the deep shadows.
  let l = luma(s);
  s = s + w * vec3f(0.07, 0.015, -0.09) * smoothstep(0.05, 0.6, l);
  s = s + w * vec3f(-0.02, 0.0, 0.02) * (1.0 - smoothstep(0.0, 0.3, l));
  s = clamp(s, vec3f(0.0), vec3f(1.0));
  // Gentle S-curve contrast around mid grey.
  let k = u.tone.y;
  s = clamp((s - 0.5) * k + 0.5, vec3f(0.0), vec3f(1.0));
  s = mix(vec3f(luma(s)), s, u.tone.z);
  // Faded blacks: the darkest ink never quite reaches black.
  let lift = u.tone.w * vec3f(1.0, 0.93, 0.82);
  s = lift + s * (1.0 - lift);
  return clamp(s, vec3f(0.0), vec3f(1.0));
}

// Amplitude-modulated halftone: 1 where ink lands for coverage v.
// The threshold surface gives round dots in the lights that join into a checker at 50%
// and become round holes in the darks.
fn screenDot(p : vec2f, angle : f32, v : f32, rough : f32) -> f32 {
  let q = rot(p, angle);
  var t = 0.5 - 0.25 * (cos(2.0 * PI * q.x) + cos(2.0 * PI * q.y));
  // Rough paper: dots come out ragged and uneven in size.
  t = t + (vnoise(p * 9.0) - 0.5) * rough * 0.35 + (hash(floor(q)) - 0.5) * rough * 0.12;
  // Ink spreads into the paper and the scan softens it: dot edges are never razor sharp.
  let aa = fwidth(t) * 0.75 + 0.08 + 0.12 * u.grade.y;
  // The faintest tints are too small to hold a dot and drop out.
  let vv = max(v - 0.03, 0.0) / 0.97;
  return smoothstep(t - aa, t + aa, vv);
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let pattern = u.screen.x;
  let lines = u.screen.y;
  let angle = u.screen.z;
  let rough = u.screen.w;
  let misreg = u.print.x;
  let uneven = u.print.y;
  let paperTex = u.print.z;
  let dust = u.print.w;
  let seed = u.grade.w * 7.31;

  let mn = min(u.res.x, u.res.y);
  let pos = in.position.xy;
  let pn = (pos - 0.5 * u.res.xy) / mn; // short-side units, centered
  let uv = 0.5 + (in.uv - 0.5) * u.res.zw;
  let n = unitToUV();

  // Each ink plate is slightly off register: sample the photo once per plate.
  let mOff = vec2f(0.0018, -0.0011) * misreg;
  let blurR = u.grade.y * 0.004 + 0.0004;
  let sC = grade(soft(uv + mOff * n, blurR));
  let sM = grade(soft(uv - mOff * n, blurR));
  let sY = grade(soft(uv + vec2f(mOff.y, mOff.x) * n, blurR));
  let sK = grade(soft(uv, blurR));

  // Display rgb -> CMYK with partial black generation.
  let kAmt = u.grade.z;
  let k = (1.0 - max(max(sK.r, sK.g), sK.b)) * kAmt;
  let inv = 1.0 / max(1.0 - k, 1e-4);
  var cmyk = vec4f(
    clamp((1.0 - sC.r - k) * inv, 0.0, 1.0),
    clamp((1.0 - sM.g - k) * inv, 0.0, 1.0),
    clamp((1.0 - sY.b - k) * inv, 0.0, 1.0),
    k);

  // Uneven ink: blotchy density across the sheet, a little different per plate.
  let blot = vec4f(
    fbm(pn * 5.0 + seed),
    fbm(pn * 5.0 + seed + 11.0),
    fbm(pn * 5.0 + seed + 23.0),
    fbm(pn * 5.0 + seed + 37.0)) - 0.5;
  cmyk = clamp(cmyk * (1.0 + blot * uneven * 0.6), vec4f(0.0), vec4f(1.0));

  // Halftone screens at the classic plate angles (C 15°, M 75°, Y 0°, K 45°).
  let p = pn * lines;
  let dots = vec4f(
    screenDot(p, angle + 0.2618, cmyk.x, rough),
    screenDot(p + 0.31, angle + 1.309, cmyk.y, rough),
    screenDot(p + 0.57, angle, cmyk.z, rough),
    screenDot(p + 0.13, angle + 0.7854, cmyk.w, rough));
  let cov = mix(cmyk, dots, pattern);

  // Ink on paper (subtractive). With continuous coverage this reproduces the graded photo.
  let paperCol = u.paper.xyz;
  var col = paperCol
    * (vec3f(1.0) - vec3f(cov.x, 0.0, 0.0))
    * (vec3f(1.0) - vec3f(0.0, cov.y, 0.0))
    * (vec3f(1.0) - vec3f(0.0, 0.0, cov.z))
    * (1.0 - cov.w);

  // Paper texture: broad mottling, fibers and fine tooth. Shows most where there's little ink.
  let mottle = fbm(pn * 14.0 + seed) - 0.5;
  let fibA = vnoise(rot(pn, 0.6) * vec2f(420.0, 90.0) + seed) - 0.5;
  let fibB = vnoise(rot(pn, -0.9) * vec2f(380.0, 70.0) + seed * 1.7) - 0.5;
  let tooth = vnoise(pn * 900.0 + seed) - 0.5;
  let tex = mottle * 0.12 + (fibA + fibB) * 0.07 + tooth * 0.08;
  let bare = 1.0 - 0.5 * clamp(cov.x + cov.y + cov.z + cov.w, 0.0, 1.0);
  col = col * (1.0 + tex * paperTex * (0.6 + 0.8 * bare));

  // Dust: sparse light flecks (paper showing through) and dark specks.
  for (var layer = 0; layer < 2; layer = layer + 1) {
    let scale = select(70.0, 160.0, layer == 1);
    let g = pn * scale + seed * 3.0 + f32(layer) * 41.0;
    let cell = floor(g);
    let h = hash(cell + 3.1);
    if (h < dust * select(0.12, 0.06, layer == 1)) {
      let c = cell + 0.2 + 0.6 * hash2(cell + 9.7);
      let r = (0.03 + 0.07 * hash(cell + 5.3)) * select(1.0, 0.6, layer == 1);
      // Specks are a little irregular.
      let d = length((g - c) * vec2f(1.0, 0.6 + 0.8 * hash(cell + 1.1)));
      let px = scale / mn;
      let a = 1.0 - smoothstep(r - px, r + px, d);
      let light = hash(cell + 7.7) < 0.75;
      let tgt = select(paperCol * 0.12, paperCol * 1.05, light);
      col = mix(col, tgt, a * (0.55 + 0.45 * hash(cell + 2.2)));
    }
  }

  // Film grain, monochrome, sized relative to the image.
  let gp = pn * 1000.0 / max(u.film.y, 0.3) + seed;
  let gr = (vnoise(gp) + vnoise(gp * 1.7 + 37.1)) - 1.0;
  col = col + gr * u.film.x * 1.5;

  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`

export const analogPrint: ShaderDef = {
  id: 'analog-print',
  name: 'Analog Print',
  category: 'photo',
  description: 'Old printed-paper look: warm faded grade, halftone ink dots, paper texture, dust and grain.',
  wgsl,
  uniformBytes: 7 * 16,
  seedParam: 'seed',
  params: {
    photo: { type: 'image', label: 'Photo', matchOutputSize: true },
    pattern: { type: 'number', label: 'Print pattern', group: 'Print', defaultValue: 0.35, min: 0, max: 1, step: 0.01 },
    lines: { type: 'number', label: 'Dot size', group: 'Print', defaultValue: 0.45, min: 0, max: 1, step: 0.01 },
    angle: { type: 'number', label: 'Screen angle', group: 'Print', defaultValue: 0, min: -45, max: 45, step: 1, unit: '°' },
    roughness: { type: 'number', label: 'Dot roughness', group: 'Print', defaultValue: 0.4, min: 0, max: 1, step: 0.01 },
    black: { type: 'number', label: 'Black ink', group: 'Print', defaultValue: 0.8, min: 0, max: 1, step: 0.01 },
    misregistration: { type: 'number', label: 'Misregistration', group: 'Print', defaultValue: 0.25, min: 0, max: 1, step: 0.01 },
    uneven: { type: 'number', label: 'Uneven ink', group: 'Print', defaultValue: 0.3, min: 0, max: 1, step: 0.01 },
    paperColor: { type: 'color', label: 'Paper color', group: 'Paper', defaultValue: { r: 0.96, g: 0.93, b: 0.86 } },
    paperTexture: { type: 'number', label: 'Paper texture', group: 'Paper', defaultValue: 0.5, min: 0, max: 1, step: 0.01 },
    dust: { type: 'number', label: 'Dust & specks', group: 'Paper', defaultValue: 0.35, min: 0, max: 1, step: 0.01 },
    seed: { type: 'number', label: 'Seed', group: 'Paper', defaultValue: 1, min: 0, max: 100, step: 1 },
    exposure: { type: 'number', label: 'Exposure', group: 'Grade', defaultValue: 0, min: -2, max: 2, step: 0.01 },
    warmth: { type: 'number', label: 'Warmth', group: 'Grade', defaultValue: 0.5, min: -1, max: 1, step: 0.01 },
    contrast: { type: 'number', label: 'Contrast', group: 'Grade', defaultValue: 1.05, min: 0.3, max: 1.7, step: 0.01 },
    saturation: { type: 'number', label: 'Saturation', group: 'Grade', defaultValue: 0.9, min: 0, max: 2, step: 0.01 },
    fade: { type: 'number', label: 'Faded blacks', group: 'Grade', defaultValue: 0.08, min: 0, max: 0.4, step: 0.01 },
    softness: { type: 'number', label: 'Softness', group: 'Grade', defaultValue: 0.3, min: 0, max: 1, step: 0.01 },
    grain: { type: 'number', label: 'Grain', group: 'Grade', defaultValue: 0.04, min: 0, max: 0.3, step: 0.005 },
    grainSize: { type: 'number', label: 'Grain size', group: 'Grade', defaultValue: 1.2, min: 0.3, max: 5, step: 0.1 },
    zoom: { type: 'number', label: 'Zoom', group: 'Grade', defaultValue: 1, min: 1, max: 3, step: 0.01, unit: '×' },
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
    const paper = p.paperColor as { r: number; g: number; b: number }
    // Dot size 0..1 -> 400..80 screen lines across the short side (coarser = bigger dots).
    const lines = 400 * Math.pow(80 / 400, n('lines'))

    return new Float32Array([
      width, height, sx, sy,
      n('exposure'), n('contrast'), n('saturation'), n('fade'),
      n('warmth'), n('softness'), n('black'), n('seed'),
      n('pattern'), lines, (n('angle') * Math.PI) / 180, n('roughness'),
      n('misregistration'), n('uneven'), n('paperTexture'), n('dust'),
      paper.r, paper.g, paper.b, 0,
      n('grain'), n('grainSize'), 0, 0,
    ])
  },
}
