import type { ShaderDef } from '../types'

// Soft Focus — dreamy out-of-focus photo: wide soft blur with optional motion streak,
// a hazy glow, film-style tone tweaks and grain.
// Blur happens in linear light on a mipmapped texture, so highlights bloom like a real lens.

const wgsl = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct U {
  res : vec4f,   // width, height, blur radius, motion
  a   : vec4f,   // motion angle (rad), glow, exposure (stops), contrast
  b   : vec4f,   // saturation, fade, grain, grain size (px)
  c   : vec4f,   // cover scale x, cover scale y, unused x2
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

// Golden-angle spiral blur with gaussian weights, sampling a mip level that
// matches the tap spacing so the result is smooth with few taps.
// radius is in units of the output's short side.
fn blur(uv : vec2f, radius : f32, n : i32, jitter : f32) -> vec3f {
  let mn = min(u.res.x, u.res.y);
  let norm = vec2f(mn / u.res.x, mn / u.res.y) * u.c.xy; // output short-side units -> photo uv
  let texSize = vec2f(textureDimensions(photo));
  let stretch = 1.0 + u.res.w * 4.0;
  let spacing = radius * stretch * sqrt(3.14159265 / f32(n));
  let spacingPx = spacing * max(norm.x * texSize.x, norm.y * texSize.y);
  let lod = log2(max(spacingPx, 1.0));

  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < n; i = i + 1) {
    let fi = f32(i) + 0.5;
    let rho = sqrt(fi / f32(n));
    let th = fi * 2.39996323 + jitter;
    var o = vec2f(cos(th), sin(th)) * rho;
    o = rot(vec2f(o.x * stretch, o.y), u.a.x);
    let w = exp(-2.5 * rho * rho);
    acc = acc + textureSampleLevel(photo, samp, uv + o * radius * norm, lod).rgb * w;
    wsum = wsum + w;
  }
  return acc / wsum;
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let uv = 0.5 + (in.uv - 0.5) * u.c.xy;
  let jitter = hash(floor(in.position.xy)) * 6.2831853;
  let r = u.res.z;

  // Linear-light blur + a wider haze screened on top.
  var col = blur(uv, r, 64, jitter);
  let haze = blur(uv, r * 2.5 + 0.03, 24, jitter);
  col = 1.0 - (1.0 - col) * (1.0 - haze * u.a.y * 0.8);
  col = col * exp2(u.a.z);

  // Tone in display space.
  var s = srgbEncode(clamp(col, vec3f(0.0), vec3f(1.0)));
  s = (s - 0.5) * u.a.w + 0.5;
  let l = dot(s, vec3f(0.2126, 0.7152, 0.0722));
  s = mix(vec3f(l), s, u.b.x);
  s = u.b.y + s * (1.0 - u.b.y);

  // Film grain: soft monochrome clumps, sized in output pixels.
  let gp = in.position.xy / max(u.b.w, 0.5);
  let g = (vnoise(gp) + vnoise(gp * 1.7 + 37.1)) - 1.0;
  s = clamp(s + g * u.b.z * 1.5, vec3f(0.0), vec3f(1.0));

  return vec4f(s, 1.0);
}
`

export const softFocus: ShaderDef = {
  id: 'soft-focus',
  name: 'Soft Focus',
  category: 'photo',
  description: 'Dreamy blur, haze and film grain over your photo.',
  wgsl,
  uniformBytes: 4 * 16,
  params: {
    photo: { type: 'image', label: 'Photo', matchOutputSize: true },
    blur: { type: 'number', label: 'Blur', defaultValue: 0.45, min: 0, max: 1, step: 0.01 },
    motion: { type: 'number', label: 'Motion streak', defaultValue: 0.3, min: 0, max: 1, step: 0.01 },
    motionAngle: { type: 'number', label: 'Motion angle', defaultValue: 75, min: -180, max: 180, step: 1, unit: '°' },
    glow: { type: 'number', label: 'Haze', defaultValue: 0.35, min: 0, max: 1, step: 0.01 },
    exposure: { type: 'number', label: 'Exposure', defaultValue: 0.15, min: -2, max: 2, step: 0.01 },
    contrast: { type: 'number', label: 'Contrast', defaultValue: 0.9, min: 0.3, max: 1.7, step: 0.01 },
    saturation: { type: 'number', label: 'Saturation', defaultValue: 1, min: 0, max: 2, step: 0.01 },
    fade: { type: 'number', label: 'Fade', defaultValue: 0.04, min: 0, max: 0.5, step: 0.01 },
    grain: { type: 'number', label: 'Grain', defaultValue: 0.07, min: 0, max: 0.3, step: 0.005 },
    grainSize: { type: 'number', label: 'Grain size', defaultValue: 1.6, min: 0.5, max: 5, step: 0.1, unit: 'px' },
    zoom: { type: 'number', label: 'Zoom', defaultValue: 1.05, min: 1, max: 3, step: 0.01, unit: '×' },
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
      width, height, n('blur') * 0.1, n('motion'),
      (n('motionAngle') * Math.PI) / 180, n('glow'), n('exposure'), n('contrast'),
      n('saturation'), n('fade'), n('grain'), n('grainSize'),
      sx, sy, 0, 0,
    ])
  },
}
