import type { Gradient, GradientStop, ParamDef, RGB, ShaderDef } from '../types'
import { hex } from './light-bands'

// Aura Card — a soft-edged, out-of-focus card of colour on grainy paper. Inside the card a
// gradient runs from its bright rim to a deep core; how far each side's rim colour reaches
// in is set per side, so the core can sit off-centre. A second rim colour tints one side,
// low-frequency noise keeps the gradient organic, and grain covers card and paper alike.
// Shared engine: each preset (see aura-presets.ts) is the same shader with its own defaults.

const wgsl = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct U {
  res    : vec4f,  // width, height, grain, grain size (px)
  margin : vec4f,  // card left, right, top, bottom (in units of the short side)
  shape  : vec4f,  // corner radius, edge blur, warp, seed
  reach  : vec4f,  // rim depth from the left, right, top, bottom
  paper  : vec4f,  // paper rgb, stop count
  tintA  : vec4f,  // side tint A rgb, direction (rad)
  tintB  : vec4f,  // side tint B rgb, direction (rad)
  tints  : vec4f,  // amount A, spread A, amount B, spread B
  pos    : array<vec4f, 2>,
  col    : array<vec4f, 8>,
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

fn stopPos(i : i32) -> f32 {
  let v = u.pos[i / 4];
  let k = i % 4;
  if (k == 0) { return v.x; }
  if (k == 1) { return v.y; }
  if (k == 2) { return v.z; }
  return v.w;
}

fn ramp(t : f32) -> vec3f {
  let n = i32(u.paper.w);
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

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let s = max(min(u.res.x, u.res.y), 1.0);
  let size = u.res.xy / s;
  var p = in.position.xy / s;   // short side = 1, origin top-left, y down

  // Organic wobble of the gradient inside the card (the card's own edges stay straight).
  let seed = u.shape.w;
  let wp = p * 1.6 + vec2f(seed * 3.1, seed * 1.7);
  let warp = vec2f(vnoise(wp), vnoise(wp + vec2f(41.3, 17.9))) - 0.5;
  let q = p + warp * u.shape.z * 0.3;

  // The card: a rounded rectangle.
  let lo = vec2f(u.margin.x, u.margin.z);
  let hi = size - vec2f(u.margin.y, u.margin.w);
  let c = (lo + hi) * 0.5;
  let he = max((hi - lo) * 0.5, vec2f(0.01));
  let r = min(u.shape.x, min(he.x, he.y));
  let d = abs(p - c) - he + r;
  let sd = length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;

  // Depth into the card: 0 at the rim, 1 in the core, reaching in by a different amount
  // from each side (a soft minimum over the four sides, rounded in the corners).
  let ds = vec4f(q.x - lo.x, hi.x - q.x, q.y - lo.y, hi.y - q.y);
  let nd = max(ds / max(u.reach, vec4f(0.001)), vec4f(0.0005));
  let inv = 1.0 / (nd * nd);
  let depth = clamp(inverseSqrt(inv.x + inv.y + inv.z + inv.w), 0.0, 1.0);

  var col = ramp(depth);

  // Two tints recolour the rim around a point on it (in the given direction from the centre;
  // the corners are at distance 1), fading out towards the core.
  let rim = pow(1.0 - depth, 1.5);
  let rel = (q - c) / max(length(he), 0.01);
  let dA = rel - vec2f(cos(u.tintA.w), sin(u.tintA.w));
  let dB = rel - vec2f(cos(u.tintB.w), sin(u.tintB.w));
  let sideA = exp(-dot(dA, dA) / max(u.tints.y * u.tints.y, 0.0001));
  let sideB = exp(-dot(dB, dB) / max(u.tints.w * u.tints.w, 0.0001));
  col = mix(col, u.tintA.rgb, clamp(sideA * rim * u.tints.x, 0.0, 1.0));
  col = mix(col, u.tintB.rgb, clamp(sideB * rim * u.tints.z, 0.0, 1.0));

  // Soft edge onto the paper.
  let blur = max(u.shape.y, 0.001);
  let a = 1.0 - smoothstep(-blur, blur, sd);
  col = mix(u.paper.rgb, col, a);

  // Film grain (fine, slightly clumped), plus a tiny dither against banding.
  let gp = in.position.xy / max(u.res.w, 0.5);
  let g = (hash(floor(gp) + seed) - 0.5) * 0.7 + (vnoise(gp * 0.8 + 11.3) - 0.5) * 0.9;
  let dither = (hash(in.position.xy + 7.0) - 0.5) / 255.0;
  col = clamp(col + g * u.res.z + dither, vec3f(0.0), vec3f(1.0));

  return vec4f(col, 1.0);
}
`

type Tint = { color: string; angle: number; amount: number; spread: number }

export type AuraCardSpec = {
  id: string
  name: string
  description: string
  version?: number
  paper: string
  /** Rim → core colours, positions 0..1 (0 = card edge, 1 = core). */
  palette: [number, string][]
  /** Card inset from each edge, in units of the frame's short side. */
  margin: { left: number; right: number; top: number; bottom: number }
  radius: number
  blur: number
  /** How far the rim colours reach in from each side, in units of the short side. */
  reach: { left: number; right: number; top: number; bottom: number }
  /** Rim colours around a point on the rim; angle in degrees from the centre (0 = right, 90 = down). */
  tintA: Tint
  tintB: Tint
  warp: number
  seed: number
  grain: number
  grainSize: number
}

export function auraCard(spec: AuraCardSpec): ShaderDef {
  const fallback: Gradient = {
    stops: spec.palette.map(([position, color]) => ({ position, color: hex(color) })),
  }
  const num = (group: string, label: string, defaultValue: number, min: number, max: number, step: number, unit?: string): ParamDef =>
    ({ type: 'number', group, label, defaultValue, min, max, step, unit })

  const tintParams = (id: 'A' | 'B', t: Tint): Record<string, ParamDef> => {
    const group = `Side tint ${id}`
    return {
      [`tint${id}Color`]: { type: 'color', group, label: 'Color', defaultValue: hex(t.color) },
      [`tint${id}Angle`]: num(group, 'Direction', t.angle, -180, 180, 1, '°'),
      [`tint${id}Amount`]: num(group, 'Amount (0 = off)', t.amount, 0, 1, 0.01),
      [`tint${id}Spread`]: num(group, 'Spread', t.spread, 0.05, 3, 0.01),
    }
  }

  const params: Record<string, ParamDef> = {
    palette: { type: 'gradient', group: 'Colour', label: 'Rim → core', defaultValue: fallback, maxStops: 8 },
    paper: { type: 'color', group: 'Colour', label: 'Paper', defaultValue: hex(spec.paper) },
    ...tintParams('A', spec.tintA),
    ...tintParams('B', spec.tintB),

    marginLeft: num('Card', 'Margin left', spec.margin.left, -0.2, 0.5, 0.005),
    marginRight: num('Card', 'Margin right', spec.margin.right, -0.2, 0.5, 0.005),
    marginTop: num('Card', 'Margin top', spec.margin.top, -0.2, 0.5, 0.005),
    marginBottom: num('Card', 'Margin bottom', spec.margin.bottom, -0.2, 0.5, 0.005),
    radius: num('Card', 'Corner radius', spec.radius, 0, 0.5, 0.005),
    blur: num('Card', 'Edge blur', spec.blur, 0.001, 0.2, 0.001),

    reachLeft: num('Glow depth', 'From left', spec.reach.left, 0.01, 1.5, 0.01),
    reachRight: num('Glow depth', 'From right', spec.reach.right, 0.01, 1.5, 0.01),
    reachTop: num('Glow depth', 'From top', spec.reach.top, 0.01, 1.5, 0.01),
    reachBottom: num('Glow depth', 'From bottom', spec.reach.bottom, 0.01, 1.5, 0.01),
    warp: num('Glow depth', 'Waviness', spec.warp, 0, 1, 0.01),
    seed: num('Glow depth', 'Variation', spec.seed, 0, 20, 0.01),

    grain: num('Finish', 'Grain', spec.grain, 0, 0.25, 0.001),
    grainSize: num('Finish', 'Grain size', spec.grainSize, 0.5, 5, 0.1, 'px'),
  }

  return {
    id: spec.id,
    name: spec.name,
    category: 'generative',
    description: spec.description,
    version: spec.version,
    wgsl,
    // 8 vec4 + 2 vec4 positions + 8 vec4 colours = 18 * 16 bytes
    uniformBytes: 18 * 16,
    params,
    seedParam: 'seed',

    pack(p, width, height) {
      const n = (k: string) => Number(p[k])
      const c = (k: string) => {
        const v = p[k] as RGB
        return [v.r, v.g, v.b]
      }
      const palette = p.palette as Gradient | undefined
      const given: GradientStop[] =
        palette && palette.stops && palette.stops.length >= 2 ? palette.stops : fallback.stops
      const stops = [...given].sort((a, b) => a.position - b.position).slice(0, 8)

      const data = new Float32Array(18 * 4)
      data.set([
        width, height, n('grain'), n('grainSize'),
        n('marginLeft'), n('marginRight'), n('marginTop'), n('marginBottom'),
        n('radius'), n('blur'), n('warp'), n('seed'),
        n('reachLeft'), n('reachRight'), n('reachTop'), n('reachBottom'),
        ...c('paper'), stops.length,
        ...c('tintAColor'), (n('tintAAngle') * Math.PI) / 180,
        ...c('tintBColor'), (n('tintBAngle') * Math.PI) / 180,
        n('tintAAmount'), n('tintASpread'), n('tintBAmount'), n('tintBSpread'),
      ])
      for (let i = 0; i < 8; i++) {
        const st = stops[Math.min(i, stops.length - 1)]
        data[32 + i] = i < stops.length ? st.position : 1
        data.set([st.color.r, st.color.g, st.color.b, 1], 40 + i * 4)
      }
      return data
    },
  }
}
