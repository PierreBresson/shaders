import { SDF_CORE_PX } from '../sdf'
import type { Gradient, GradientStop, RGB, ShaderDef } from '../types'

// Glass Logo — renders a logo's shape (from its alpha) as a flat sheet of tinted glass:
// one smooth gradient across the whole shape, color spots you can place anywhere on it,
// edges that turn clear toward one side (with a hairline of light on the cut) and stay crisp
// on the other, a soft drop shadow and a spill of light underneath, tinted by the glass.
// An optional bevel (shading, glints, rim refraction) is off by default: it reads as 3D
// plastic rather than glass.
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
  extra   : vec4f,  // frost tint, core start, edge line, edge line width
  extra2  : vec4f,  // frost angle (rad), frost direction, gradient bend, refraction
  innerGlowCol : vec4f,
  rimCol       : vec4f,
  highlightCol : vec4f,
  shadowCol    : vec4f,
  glowCol      : vec4f,
  bgCol        : vec4f,
  edgeCol      : vec4f,
  spot    : array<vec4f, 3>,  // x, y (logo units from the center), size, amount
  spotCol : array<vec4f, 3>,
  extra3  : vec4f,  // edge transparency, glow tinted by the glass, unused x2
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

// The glass color at p (logo units): the gradient, shifted along the ramp by lift, then the
// color spots: soft pools of color placed anywhere on the shape.
fn fillAt(p : vec2f, lift : f32) -> vec3f {
  let dir = vec2f(cos(u.fill.x), sin(u.fill.x));
  let side = dot(p, vec2f(-dir.y, dir.x));
  let t = 0.5 + (dot(p, dir) + u.extra2.z * side * side) / max(u.fill.y, 0.01) + lift;
  var col = ramp(clamp(t, 0.0, 1.0));
  for (var i = 0; i < 3; i = i + 1) {
    let sp = u.spot[i];
    let dv = (p - sp.xy) / max(sp.z, 1e-3);
    col = mix(col, u.spotCol[i].rgb, clamp(exp(-dot(dv, dv)) * sp.w, 0.0, 1.0));
  }
  return col;
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

  // Blurred coverage rather than distance: a true soft shadow, no creases at concave corners.
  let sh = maskBlur(q - vec2f(0.0, u.shadow.z), max(u.shadow.y, px) * 1.6);
  acc = over(acc, u.shadowCol.rgb, clamp(sh * u.shadow.x, 0.0, 1.0));

  // The spill only shows on the side it is offset toward (under the shape by default),
  // so the other edges stay clean against the background. Light that went through tinted
  // glass comes out tinted: the spill takes the color of the glass right above it.
  let dg = sdf(q - vec2f(0.0, u.glow.z));
  var under = 1.0;
  if (abs(u.glow.z) > 1e-4) { under = smoothstep(-0.2, 1.0, (d - dg) / u.glow.z); }
  let above = q - vec2f(0.0, u.glow.z + sign(u.glow.z) * max(dg, 0.0));
  let spill = mix(u.glowCol.rgb, fillAt(above, 0.55), u.extra3.y);
  acc = over(acc, spill, clamp(exp(-max(dg, 0.0) / max(u.glow.y, 1e-4)) * u.glow.x * under, 0.0, 1.0));

  // --- Fill: one wide gradient across the whole shape. The bend curves it around the dark
  // end, so the dark reads as a pool rather than a straight band. Thick parts can get a
  // soft, smoky darker core. ---
  // Inside the bevel the fill can be looked up further into the shape, like a lens.
  let x = clamp(depth / max(u.light.y, 1e-4), 0.0, 1.0);
  let qf = q - g * (1.0 - x) * (1.0 - x) * u.extra2.w;
  let core = smoothstep(u.extra.y, 1.0, maskBlur(q, max(u.fill.w, 1e-4)));

  // --- Soft edges: the blurred mask is ~0.5 at the edge and ~1 deep inside, so 1 - mask
  // fades smoothly inward with no plateau (a flat band along an edge reads as the side of
  // a box, not as glass). Sampling it shifted toward the frost angle makes it directional:
  // edges facing that way go soft, the opposite edges stay crisp.
  // Soft edges do three things: move the color up the fill gradient (frost), pull it toward
  // the frost color (tint), and let the background show through (transparency).
  let fw = max(u.inner.y, 1e-4);
  let fo = vec2f(cos(u.extra2.x), sin(u.extra2.x)) * fw * u.extra2.y;
  let fr = clamp(1.0 - maskBlur(q + fo, fw), 0.0, 1.0);
  var col = fillAt(qf, u.inner.x * fr - u.fill.z * core);
  col = mix(col, u.innerGlowCol.rgb, clamp(fr * u.extra.x, 0.0, 1.0));

  // --- Inner shadow: edges facing the light are shaded by the rim ---
  let ld = vec2f(cos(u.light.x), sin(u.light.x));
  let isb = max(u.light2.z, px);
  let dsh = sdf(q + ld * u.light2.y);
  col = col * (1.0 - smoothstep(-isb, isb, dsh) * u.light.w);

  // --- Bevel: rounded glass rim. Shaded from the light angle, with a tight glint on the
  // edges facing the light and a fainter one on the far rim, where light exits the glass. ---
  let slope = (1.0 - x) * (1.0 - x) * 1.5;
  let n = normalize(vec3f(g * slope, 1.0));
  let L = normalize(vec3f(ld * 0.8, 0.6));
  col = col * (1.0 + (dot(n, L) - L.z) * u.glow.w);
  let H = normalize(L + vec3f(0.0, 0.0, 1.0));
  let Hb = normalize(vec3f(-L.xy, L.z) + vec3f(0.0, 0.0, 1.0));
  let spec = (pow(max(dot(n, H), 0.0), 40.0) + 0.35 * pow(max(dot(n, Hb), 0.0), 40.0)) * (1.0 - x);
  col = col + u.highlightCol.rgb * spec * u.light.z;

  // --- Edge line: a thin line where the glass is cut, on the edges that stay crisp. Pulls
  // toward a mid tone, so it reads lighter on dark glass and slightly darker on pale glass. ---
  let edgeLine = exp(-depth / max(u.extra.w, 1e-4)) * u.extra.z * (1.0 - fr);
  col = mix(col, u.edgeCol.rgb, clamp(edgeLine, 0.0, 1.0));

  // --- Colored edge light ---
  let rd = vec2f(cos(u.light2.x), sin(u.light2.x));
  let facing = 0.5 + 0.5 * dot(g, rd);
  let rim = exp(-depth / max(u.inner.w, 1e-4)) * u.inner.z * facing * facing;
  col = mix(col, u.rimCol.rgb, clamp(rim, 0.0, 1.0));

  let aa = 0.75 * px + u.logo.w;
  // Soft edges fade out, but the cut edge of the glass still catches a hairline of light.
  let see = clamp(smoothstep(0.25, 0.85, fr) * u.extra3.x, 0.0, 1.0);
  let glint = exp(-depth / max(u.extra.w, 1e-4)) * see * 0.6;
  col = mix(col, u.highlightCol.rgb, glint);
  let la = (1.0 - smoothstep(-aa, aa, d)) * max(1.0 - see, glint);
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
    { position: 0, color: hex('#04060b') },
    { position: 0.22, color: hex('#101c2b') },
    { position: 0.45, color: hex('#35607c') },
    { position: 0.66, color: hex('#75a8c8') },
    { position: 0.85, color: hex('#a6d2e8') },
    { position: 1, color: hex('#bdeee8') },
  ],
}

export const glassLogo: ShaderDef = {
  id: 'glass-logo',
  name: 'Glass Logo',
  category: 'logo',
  description: 'Your logo as a sheet of tinted glass: one smooth gradient, color spots you place, edges that turn clear on one side and stay crisp on the other, and light that comes out tinted underneath.',
  version: 9,
  wgsl,
  uniformBytes: 34 * 16,
  params: {
    logo: { type: 'image', kind: 'sdf', label: 'Logo', group: 'Logo', hint: 'Drop an SVG or PNG logo — only its shape is used' },
    logoSize: { type: 'number', group: 'Logo', label: 'Size', defaultValue: 0.62, min: 0.05, max: 1, step: 0.01 },
    softness: { type: 'number', group: 'Logo', label: 'Edge softness', defaultValue: 0.0008, min: 0, max: 0.03, step: 0.0005 },

    fill: { type: 'gradient', group: 'Fill', label: 'Fill', defaultValue: fillPalette, maxStops: 8 },
    fillAngle: { type: 'number', group: 'Fill', label: 'Gradient angle', defaultValue: 135, min: -180, max: 180, step: 1, unit: '°' },
    fillSpread: { type: 'number', group: 'Fill', label: 'Gradient spread', defaultValue: 1, min: 0.2, max: 3, step: 0.01 },
    fillBend: { type: 'number', group: 'Fill', label: 'Gradient bend', defaultValue: 0.2, min: 0, max: 2, step: 0.01 },
    coreShade: { type: 'number', group: 'Fill', label: 'Core shade', defaultValue: 0.05, min: 0, max: 1, step: 0.01 },
    coreWidth: { type: 'number', group: 'Fill', label: 'Core blur', defaultValue: 0.18, min: 0.01, max: 0.4, step: 0.005 },
    coreStart: { type: 'number', group: 'Fill', label: 'Core reach', defaultValue: 0.4, min: 0, max: 0.95, step: 0.01 },

    spot1Color: { type: 'color', group: 'Color spot 1', label: 'Color', defaultValue: hex('#a39cf6') },
    spot1Amount: { type: 'number', group: 'Color spot 1', label: 'Amount (0 = off)', defaultValue: 0.65, min: 0, max: 1, step: 0.01 },
    spot1X: { type: 'number', group: 'Color spot 1', label: 'X (0 = left, 1 = right)', defaultValue: 0.1, min: -0.3, max: 1.3, step: 0.01 },
    spot1Y: { type: 'number', group: 'Color spot 1', label: 'Y (0 = top, 1 = bottom)', defaultValue: 0.9, min: -0.3, max: 1.3, step: 0.01 },
    spot1Size: { type: 'number', group: 'Color spot 1', label: 'Size', defaultValue: 0.3, min: 0.02, max: 1.5, step: 0.01 },
    spot2Color: { type: 'color', group: 'Color spot 2', label: 'Color', defaultValue: hex('#8fe6cf') },
    spot2Amount: { type: 'number', group: 'Color spot 2', label: 'Amount (0 = off)', defaultValue: 0.55, min: 0, max: 1, step: 0.01 },
    spot2X: { type: 'number', group: 'Color spot 2', label: 'X (0 = left, 1 = right)', defaultValue: 0.8, min: -0.3, max: 1.3, step: 0.01 },
    spot2Y: { type: 'number', group: 'Color spot 2', label: 'Y (0 = top, 1 = bottom)', defaultValue: 0.92, min: -0.3, max: 1.3, step: 0.01 },
    spot2Size: { type: 'number', group: 'Color spot 2', label: 'Size', defaultValue: 0.32, min: 0.02, max: 1.5, step: 0.01 },
    spot3Color: { type: 'color', group: 'Color spot 3', label: 'Color', defaultValue: hex('#ffffff') },
    spot3Amount: { type: 'number', group: 'Color spot 3', label: 'Amount (0 = off)', defaultValue: 0, min: 0, max: 1, step: 0.01 },
    spot3X: { type: 'number', group: 'Color spot 3', label: 'X (0 = left, 1 = right)', defaultValue: 0.15, min: -0.3, max: 1.3, step: 0.01 },
    spot3Y: { type: 'number', group: 'Color spot 3', label: 'Y (0 = top, 1 = bottom)', defaultValue: 0.15, min: -0.3, max: 1.3, step: 0.01 },
    spot3Size: { type: 'number', group: 'Color spot 3', label: 'Size', defaultValue: 0.3, min: 0.02, max: 1.5, step: 0.01 },

    innerGlow: { type: 'number', group: 'Edges', label: 'Frost', defaultValue: 0.3, min: 0, max: 1, step: 0.01 },
    innerGlowWidth: { type: 'number', group: 'Edges', label: 'Soft edge width', defaultValue: 0.02, min: 0.005, max: 0.3, step: 0.005 },
    frostDirection: { type: 'number', group: 'Edges', label: 'Soft edge direction (0 = all edges)', defaultValue: 0.8, min: 0, max: 1.5, step: 0.01 },
    frostAngle: { type: 'number', group: 'Edges', label: 'Soft edge angle', defaultValue: -45, min: -180, max: 180, step: 1, unit: '°' },
    edgeFade: { type: 'number', group: 'Edges', label: 'Soft edge transparency', defaultValue: 0.92, min: 0, max: 1, step: 0.01 },
    innerGlowColor: { type: 'color', group: 'Edges', label: 'Frost tint color', defaultValue: hex('#f0f6f9')},
    frostTint: { type: 'number', group: 'Edges', label: 'Frost tint', defaultValue: 0.1, min: 0, max: 1, step: 0.01 },
    edgeLineColor: { type: 'color', group: 'Edges', label: 'Edge line color', defaultValue: hex('#93b3da') },
    edgeLine: { type: 'number', group: 'Edges', label: 'Edge line', defaultValue: 0.55, min: 0, max: 1, step: 0.01 },
    edgeLineWidth: { type: 'number', group: 'Edges', label: 'Edge line width', defaultValue: 0.0022, min: 0.0005, max: 0.03, step: 0.0005 },
    rimColor: { type: 'color', group: 'Edges', label: 'Edge light color', defaultValue: hex('#a9a4f4')},
    rim: { type: 'number', group: 'Edges', label: 'Edge light', defaultValue: 0.2, min: 0, max: 1, step: 0.01 },
    rimWidth: { type: 'number', group: 'Edges', label: 'Edge light width', defaultValue: 0.01, min: 0.001, max: 0.06, step: 0.001 },
    rimAngle: { type: 'number', group: 'Edges', label: 'Edge light angle', defaultValue: 120, min: -180, max: 180, step: 1, unit: '°' },

    highlightColor: { type: 'color', group: 'Lighting', label: 'Highlight color', defaultValue: hex('#ffffff') },
    lightAngle: { type: 'number', group: 'Lighting', label: 'Light angle', defaultValue: 135, min: -180, max: 180, step: 1, unit: '°' },
    bevel: { type: 'number', group: 'Lighting', label: 'Bevel width', defaultValue: 0.022, min: 0, max: 0.15, step: 0.001 },
    refraction: { type: 'number', group: 'Lighting', label: 'Rim refraction', defaultValue: 0, min: 0, max: 0.5, step: 0.005 },
    bevelShade: { type: 'number', group: 'Lighting', label: 'Bevel shading', defaultValue: 0, min: 0, max: 1, step: 0.01 },
    highlight: { type: 'number', group: 'Lighting', label: 'Highlight', defaultValue: 0.08, min: 0, max: 2, step: 0.01 },
    innerShadow: { type: 'number', group: 'Lighting', label: 'Inner shadow', defaultValue: 0.04, min: 0, max: 1, step: 0.01 },
    innerShadowOffset: { type: 'number', group: 'Lighting', label: 'Inner shadow offset', defaultValue: 0.01, min: 0, max: 0.08, step: 0.001 },
    innerShadowBlur: { type: 'number', group: 'Lighting', label: 'Inner shadow blur', defaultValue: 0.02, min: 0.001, max: 0.08, step: 0.001 },

    shadowColor: { type: 'color', group: 'Shadow & glow', label: 'Shadow color', defaultValue: hex('#2a3540')},
    shadow: { type: 'number', group: 'Shadow & glow', label: 'Shadow', defaultValue: 0.16, min: 0, max: 1, step: 0.01 },
    shadowBlur: { type: 'number', group: 'Shadow & glow', label: 'Shadow blur', defaultValue: 0.12, min: 0.005, max: 0.3, step: 0.005 },
    shadowOffset: { type: 'number', group: 'Shadow & glow', label: 'Shadow offset', defaultValue: 0.05, min: -0.2, max: 0.2, step: 0.005 },
    glowColor: { type: 'color', group: 'Shadow & glow', label: 'Glow color', defaultValue: hex('#b6efe6')},
    glow: { type: 'number', group: 'Shadow & glow', label: 'Glow', defaultValue: 0.45, min: 0, max: 1, step: 0.01 },
    glowTint: { type: 'number', group: 'Shadow & glow', label: 'Glow takes glass color', defaultValue: 0.8, min: 0, max: 1, step: 0.01 },
    glowSize: { type: 'number', group: 'Shadow & glow', label: 'Glow size', defaultValue: 0.02, min: 0.005, max: 0.3, step: 0.005 },
    glowOffset: { type: 'number', group: 'Shadow & glow', label: 'Glow offset', defaultValue: 0.035, min: -0.2, max: 0.2, step: 0.005 },

    bgColor: { type: 'color', group: 'Background', label: 'Color', defaultValue: hex('#f2f2f3')},
    bgOpacity: { type: 'number', group: 'Background', label: 'Opacity (0 = transparent PNG)', defaultValue: 1, min: 0, max: 1, step: 0.01 },
    grain: { type: 'number', group: 'Background', label: 'Grain', defaultValue: 0.008, min: 0, max: 0.1, step: 0.001 },
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

    const data = new Float32Array(136)
    data.set([
      width, height, n('logoSize') * Math.min(width, height), stops.length,
      logo ? SDF_CORE_PX / logo.width : 1, logo ? SDF_CORE_PX / logo.height : 1, logo ? 1 : 0, n('softness'),
      deg(p.fillAngle), n('fillSpread'), n('coreShade'), n('coreWidth'),
      n('innerGlow'), n('innerGlowWidth'), n('rim'), n('rimWidth'),
      deg(p.lightAngle), n('bevel'), n('highlight'), n('innerShadow'),
      deg(p.rimAngle), n('innerShadowOffset'), n('innerShadowBlur'), n('grain'),
      n('shadow'), n('shadowBlur'), n('shadowOffset'), n('bgOpacity'),
      n('glow'), n('glowSize'), n('glowOffset'), n('bevelShade'),
      n('frostTint'), n('coreStart'), n('edgeLine'), n('edgeLineWidth'),
      deg(p.frostAngle), n('frostDirection'), n('fillBend'), n('refraction'),
      ...c('innerGlowColor'),
      ...c('rimColor'),
      ...c('highlightColor'),
      ...c('shadowColor'),
      ...c('glowColor'),
      ...c('bgColor'),
      ...c('edgeLineColor'),
    ])
    // Spot positions are 0..1 across the logo's box; the shader wants logo units from the center.
    for (let i = 0; i < 3; i++) {
      const k = `spot${i + 1}`
      data.set([n(`${k}X`) - 0.5, n(`${k}Y`) - 0.5, n(`${k}Size`), n(`${k}Amount`)], 68 + i * 4)
      data.set(c(`${k}Color`), 80 + i * 4)
    }
    data.set([n('edgeFade'), n('glowTint'), 0, 0], 92)
    for (let i = 0; i < 8; i++) {
      const st = stops[Math.min(i, stops.length - 1)]
      data[96 + i] = i < stops.length ? st.position : 1
      data.set([st.color.r, st.color.g, st.color.b, 1], 104 + i * 4)
    }
    return data
  },
}
