import { SDF_CORE_PX } from '../sdf'
import type { Gradient, GradientStop, RGB, ShaderDef } from '../types'

// Glass Logo — renders a logo's shape (from its alpha) as a soft, frosted glass object:
// gradient fill with a darker core, inner glow and colored edge light, a bevel highlight,
// an inner shadow, a drop shadow and a colored light spill underneath.
// Everything is driven by a signed distance field, so it stays crisp at any size.
// Widths are in units of the logo's longest side, so the look doesn't change with output size.

const wgsl = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct U {
  res     : vec4f,  // width, height, logo size (px), stop count
  logo    : vec4f,  // tex scale x, tex scale y, has logo, edge softness
  fill    : vec4f,  // angle (rad), spread, core shade, core blur
  inner   : vec4f,  // frost (lifts along the gradient), frost blur, rim, rim width
  light   : vec4f,  // light angle (rad), bevel width, highlight, inner shadow
  light2  : vec4f,  // rim angle (rad), inner shadow offset, inner shadow blur, grain
  shadow  : vec4f,  // opacity, blur, offset y, background opacity
  glow    : vec4f,  // amount, size, offset y, bevel shading
  extra   : vec4f,  // frost tint, core start, unused x2
  innerGlowCol : vec4f,
  rimCol       : vec4f,
  highlightCol : vec4f,
  shadowCol    : vec4f,
  glowCol      : vec4f,
  bgCol        : vec4f,
  pos : array<vec4f, 2>,
  col : array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var sdfTex : texture_2d<f32>;

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
  let n = i32(u.res.w);
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

// Signed distance to the logo at q (logo units, origin at the logo center, y down).
// Negative inside. Beyond the padded texture, extend with the straight-line distance.
fn sdf(q : vec2f) -> f32 {
  if (u.logo.z < 0.5) { return 1.0; }
  let uv = q * u.logo.xy + 0.5;
  let cuv = clamp(uv, vec2f(0.0), vec2f(1.0));
  let d = textureSampleLevel(sdfTex, samp, cuv, 0.0).r;
  return d + length((uv - cuv) / u.logo.xy);
}

// Gaussian-ish blur of the shape's coverage (0 outside, 1 inside), radius in logo units.
// Unlike distance-to-edge, this has no creases at corners: thick parts read as smooth,
// round masses, thin parts stay low. Uses the mip chain so any radius costs the same.
fn maskBlur(q : vec2f, radius : f32) -> f32 {
  if (u.logo.z < 0.5) { return 0.0; }
  let texelsPerUnit = u.logo.x * f32(textureDimensions(sdfTex).x);
  let n = 32;
  let spacing = radius * sqrt(3.14159265 / f32(n)) * texelsPerUnit;
  let lod = log2(max(spacing, 1.0)) + 0.5;
  var acc = 0.0;
  var wsum = 0.0;
  for (var i = 0; i < n; i = i + 1) {
    let fi = f32(i) + 0.5;
    let rho = sqrt(fi / f32(n));
    let th = fi * 2.39996323;
    let o = vec2f(cos(th), sin(th)) * rho * radius;
    let w = exp(-2.5 * rho * rho);
    acc = acc + textureSampleLevel(sdfTex, samp, (q + o) * u.logo.xy + 0.5, lod).g * w;
    wsum = wsum + w;
  }
  return acc / wsum;
}

fn over(dst : vec4f, rgb : vec3f, a : f32) -> vec4f {
  // dst is premultiplied (rgb * a, a)
  return vec4f(rgb * a + dst.rgb * (1.0 - a), a + dst.a * (1.0 - a));
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let dims = vec2f(u.res.x, u.res.y);
  let logoPx = max(u.res.z, 1.0);
  let q = (in.position.xy - dims * 0.5) / logoPx;
  let px = 1.0 / logoPx;

  let d = sdf(q);
  // Normal from a slightly wide finite difference: smooth across corners, no creases.
  let e = max(0.004, u.light.y * 0.35);
  let grad = vec2f(sdf(q + vec2f(e, 0.0)) - sdf(q - vec2f(e, 0.0)),
                   sdf(q + vec2f(0.0, e)) - sdf(q - vec2f(0.0, e)));
  let g = grad / max(length(grad), 1e-6);   // outward normal
  let depth = max(-d, 0.0);

  // --- Background, drop shadow, colored spill ---
  var acc = vec4f(u.bgCol.rgb * u.shadow.w, u.shadow.w);

  let sb = max(u.shadow.y, px);
  let ds = sdf(q - vec2f(0.0, u.shadow.z));
  acc = over(acc, u.shadowCol.rgb, (1.0 - smoothstep(-sb * 0.5, sb, ds)) * u.shadow.x);

  let dg = sdf(q - vec2f(0.0, u.glow.z));
  acc = over(acc, u.glowCol.rgb, clamp(exp(-max(dg, 0.0) / max(u.glow.y, 1e-4)) * u.glow.x, 0.0, 1.0));

  // --- Fill: wide directional gradient; thick parts get a soft, smoky darker core ---
  let dir = vec2f(cos(u.fill.x), sin(u.fill.x));
  var t = 0.5 + dot(q, dir) / max(u.fill.y, 0.01);
  let core = smoothstep(u.extra.y, 1.0, maskBlur(q, max(u.fill.w, 1e-4)));
  t = t - u.fill.z * core;

  // --- Frosted edges: light scatters in near the surface, so edges read lighter ---
  // The blurred mask is ~0.5 at the edge and ~1 deep inside, so this fades smoothly inward.
  // Frost moves the color up the fill gradient (dark edges become steel, light edges go pale),
  // then an optional tint pulls it toward the frost color.
  let fr = smoothstep(0.0, 1.0, clamp((1.0 - maskBlur(q, max(u.inner.y, 1e-4))) * 2.0, 0.0, 1.0));
  t = t + u.inner.x * fr;
  var col = ramp(clamp(t, 0.0, 1.0));
  col = mix(col, u.innerGlowCol.rgb, clamp(fr * u.extra.x, 0.0, 1.0));

  // --- Inner shadow: edges facing the light are shaded by the rim ---
  let ld = vec2f(cos(u.light.x), sin(u.light.x));
  let isb = max(u.light2.z, px);
  let dsh = sdf(q + ld * u.light2.y);
  col = col * (1.0 - smoothstep(-isb, isb, dsh) * u.light.w);

  // --- Bevel: gently rounded edge, lit from the light angle ---
  let x = clamp(depth / max(u.light.y, 1e-4), 0.0, 1.0);
  let slope = (1.0 - x) * (1.0 - x) * 1.5;
  let n = normalize(vec3f(g * slope, 1.0));
  let L = normalize(vec3f(ld * 0.8, 0.6));
  col = col * (1.0 + (dot(n, L) - L.z) * u.glow.w);
  let H = normalize(L + vec3f(0.0, 0.0, 1.0));
  let spec = pow(max(dot(n, H), 0.0), 14.0) * (1.0 - x);
  col = col + u.highlightCol.rgb * spec * u.light.z;

  // --- Colored edge light ---
  let rd = vec2f(cos(u.light2.x), sin(u.light2.x));
  let facing = 0.5 + 0.5 * dot(g, rd);
  let rim = exp(-depth / max(u.inner.w, 1e-4)) * u.inner.z * facing * facing;
  col = mix(col, u.rimCol.rgb, clamp(rim, 0.0, 1.0));

  let aa = 0.75 * px + u.logo.w;
  let la = 1.0 - smoothstep(-aa, aa, d);
  acc = over(acc, clamp(col, vec3f(0.0), vec3f(1.0)), la);

  // --- Un-premultiply, add grain ---
  var rgb = acc.rgb / max(acc.a, 1e-5);
  let gp = in.position.xy / 1.3;
  let grain = (vnoise(gp) + vnoise(gp * 1.7 + 37.1)) - 1.0;
  rgb = clamp(rgb + grain * u.light2.w * 1.5, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, clamp(acc.a, 0.0, 1.0));
}
`

const hex = (h: string): RGB => ({
  r: parseInt(h.slice(1, 3), 16) / 255,
  g: parseInt(h.slice(3, 5), 16) / 255,
  b: parseInt(h.slice(5, 7), 16) / 255,
})

const deg = (v: unknown) => (Number(v) * Math.PI) / 180

const fillPalette: Gradient = {
  stops: [
    { position: 0, color: hex('#05070c') },
    { position: 0.18, color: hex('#1c2835') },
    { position: 0.38, color: hex('#4f6876') },
    { position: 0.58, color: hex('#8eaab4') },
    { position: 0.78, color: hex('#c3dcdc') },
    { position: 1, color: hex('#e7f4f1') },
  ],
}

export const glassLogo: ShaderDef = {
  id: 'glass-logo',
  name: 'Glass Logo',
  description: 'Your logo as soft frosted glass: gradient fill, frosted edges, edge light, bevel and shadows.',
  version: 4,
  wgsl,
  uniformBytes: 25 * 16,
  params: {
    logo: { type: 'image', kind: 'sdf', label: 'Logo', group: 'Logo', hint: 'Drop an SVG or PNG logo — only its shape is used' },
    logoSize: { type: 'number', group: 'Logo', label: 'Size', defaultValue: 0.62, min: 0.05, max: 1, step: 0.01 },
    softness: { type: 'number', group: 'Logo', label: 'Edge softness', defaultValue: 0.0025, min: 0, max: 0.03, step: 0.0005 },

    fill: { type: 'gradient', group: 'Fill', label: 'Fill', defaultValue: fillPalette, maxStops: 8 },
    fillAngle: { type: 'number', group: 'Fill', label: 'Gradient angle', defaultValue: 135, min: -180, max: 180, step: 1, unit: '°' },
    fillSpread: { type: 'number', group: 'Fill', label: 'Gradient spread', defaultValue: 1.15, min: 0.2, max: 3, step: 0.01 },
    coreShade: { type: 'number', group: 'Fill', label: 'Core shade', defaultValue: 0.16, min: 0, max: 1, step: 0.01 },
    coreWidth: { type: 'number', group: 'Fill', label: 'Core blur', defaultValue: 0.18, min: 0.01, max: 0.4, step: 0.005 },
    coreStart: { type: 'number', group: 'Fill', label: 'Core reach', defaultValue: 0.4, min: 0, max: 0.95, step: 0.01 },

    innerGlow: { type: 'number', group: 'Edges', label: 'Frost', defaultValue: 0.28, min: 0, max: 1, step: 0.01 },
    innerGlowWidth: { type: 'number', group: 'Edges', label: 'Frost blur', defaultValue: 0.07, min: 0.005, max: 0.3, step: 0.005 },
    innerGlowColor: { type: 'color', group: 'Edges', label: 'Frost tint color', defaultValue: hex('#d6ecea') },
    frostTint: { type: 'number', group: 'Edges', label: 'Frost tint', defaultValue: 0.12, min: 0, max: 1, step: 0.01 },
    rimColor: { type: 'color', group: 'Edges', label: 'Edge light color', defaultValue: hex('#b9b3f2') },
    rim: { type: 'number', group: 'Edges', label: 'Edge light', defaultValue: 0.4, min: 0, max: 1, step: 0.01 },
    rimWidth: { type: 'number', group: 'Edges', label: 'Edge light width', defaultValue: 0.006, min: 0.001, max: 0.06, step: 0.001 },
    rimAngle: { type: 'number', group: 'Edges', label: 'Edge light angle', defaultValue: 100, min: -180, max: 180, step: 1, unit: '°' },

    highlightColor: { type: 'color', group: 'Lighting', label: 'Highlight color', defaultValue: hex('#ffffff') },
    lightAngle: { type: 'number', group: 'Lighting', label: 'Light angle', defaultValue: 135, min: -180, max: 180, step: 1, unit: '°' },
    bevel: { type: 'number', group: 'Lighting', label: 'Bevel width', defaultValue: 0.018, min: 0, max: 0.15, step: 0.001 },
    bevelShade: { type: 'number', group: 'Lighting', label: 'Bevel shading', defaultValue: 0.15, min: 0, max: 1, step: 0.01 },
    highlight: { type: 'number', group: 'Lighting', label: 'Highlight', defaultValue: 0.18, min: 0, max: 2, step: 0.01 },
    innerShadow: { type: 'number', group: 'Lighting', label: 'Inner shadow', defaultValue: 0.08, min: 0, max: 1, step: 0.01 },
    innerShadowOffset: { type: 'number', group: 'Lighting', label: 'Inner shadow offset', defaultValue: 0.01, min: 0, max: 0.08, step: 0.001 },
    innerShadowBlur: { type: 'number', group: 'Lighting', label: 'Inner shadow blur', defaultValue: 0.02, min: 0.001, max: 0.08, step: 0.001 },

    shadowColor: { type: 'color', group: 'Shadow & glow', label: 'Shadow color', defaultValue: hex('#27323b') },
    shadow: { type: 'number', group: 'Shadow & glow', label: 'Shadow', defaultValue: 0.12, min: 0, max: 1, step: 0.01 },
    shadowBlur: { type: 'number', group: 'Shadow & glow', label: 'Shadow blur', defaultValue: 0.09, min: 0.005, max: 0.3, step: 0.005 },
    shadowOffset: { type: 'number', group: 'Shadow & glow', label: 'Shadow offset', defaultValue: 0.045, min: -0.2, max: 0.2, step: 0.005 },
    glowColor: { type: 'color', group: 'Shadow & glow', label: 'Glow color', defaultValue: hex('#b4f2e0') },
    glow: { type: 'number', group: 'Shadow & glow', label: 'Glow', defaultValue: 0.3, min: 0, max: 1, step: 0.01 },
    glowSize: { type: 'number', group: 'Shadow & glow', label: 'Glow size', defaultValue: 0.03, min: 0.005, max: 0.3, step: 0.005 },
    glowOffset: { type: 'number', group: 'Shadow & glow', label: 'Glow offset', defaultValue: 0.03, min: -0.2, max: 0.2, step: 0.005 },

    bgColor: { type: 'color', group: 'Background', label: 'Color', defaultValue: hex('#ececec') },
    bgOpacity: { type: 'number', group: 'Background', label: 'Opacity (0 = transparent PNG)', defaultValue: 1, min: 0, max: 1, step: 0.01 },
    grain: { type: 'number', group: 'Background', label: 'Grain', defaultValue: 0.012, min: 0, max: 0.1, step: 0.001 },
  },

  pack(p, width, height, images) {
    const n = (k: string) => Number(p[k])
    const c = (k: string) => {
      const v = p[k] as RGB
      return [v.r, v.g, v.b, 1]
    }
    const logo = images.logo
    const palette = p.fill as Gradient
    const stops: GradientStop[] = [...palette.stops].sort((a, b) => a.position - b.position).slice(0, 8)

    const data = new Float32Array(100)
    data.set([
      width, height, n('logoSize') * Math.min(width, height), stops.length,
      logo ? SDF_CORE_PX / logo.width : 1, logo ? SDF_CORE_PX / logo.height : 1, logo ? 1 : 0, n('softness'),
      deg(p.fillAngle), n('fillSpread'), n('coreShade'), n('coreWidth'),
      n('innerGlow'), n('innerGlowWidth'), n('rim'), n('rimWidth'),
      deg(p.lightAngle), n('bevel'), n('highlight'), n('innerShadow'),
      deg(p.rimAngle), n('innerShadowOffset'), n('innerShadowBlur'), n('grain'),
      n('shadow'), n('shadowBlur'), n('shadowOffset'), n('bgOpacity'),
      n('glow'), n('glowSize'), n('glowOffset'), n('bevelShade'),
      n('frostTint'), n('coreStart'), 0, 0,
      ...c('innerGlowColor'),
      ...c('rimColor'),
      ...c('highlightColor'),
      ...c('shadowColor'),
      ...c('glowColor'),
      ...c('bgColor'),
    ])
    for (let i = 0; i < 8; i++) {
      const st = stops[Math.min(i, stops.length - 1)]
      data[60 + i] = i < stops.length ? st.position : 1
      data.set([st.color.r, st.color.g, st.color.b, 1], 68 + i * 4)
    }
    return data
  },
}
