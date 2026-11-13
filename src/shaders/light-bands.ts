import type { ParamDef, RGB, ShaderDef } from '../types'

// Light Bands — soft, out-of-focus beams of light over a dark gradient, with film grain.
// Shared engine: each preset (see light-presets.ts) is the same shader with its own defaults.
//
// Each band is a soft stripe through an anchor point at an angle. It can bend, taper,
// glow wider on one side, fade out along its length and carry fine streaks. Bands are
// screen-blended over the background, so they only ever add light.

export const BAND_COUNT = 4

const wgsl = /* wgsl */ `diagnostic(off,derivative_uniformity);

struct Band {
  a : vec4f,  // color rgb, intensity
  b : vec4f,  // anchor x, anchor y, angle (rad), bend
  c : vec4f,  // width, softness, asymmetry, taper
  d : vec4f,  // length, fade-out, streaks, streak density
};

struct U {
  res   : vec4f,  // width, height, grain, grain size (px)
  bg0   : vec4f,  // color A rgb, gradient angle (rad)
  bg1   : vec4f,  // color B rgb, gradient offset
  bands : array<Band, 4>,
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

fn hash1(x : f32) -> f32 {
  return fract(sin(x * 127.1) * 43758.5453);
}

fn noise1(x : f32) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(hash1(i), hash1(i + 1.0), s);
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

// p and the anchor are in units of the output height, origin at the center, y down.
fn band(p : vec2f, bd : Band, idx : f32) -> vec3f {
  let intensity = bd.a.w;
  if (intensity <= 0.0) { return vec3f(0.0); }

  let d = p - bd.b.xy;
  let ca = cos(bd.b.z);
  let sa = sin(bd.b.z);
  let x = ca * d.x + sa * d.y;            // along the band
  let y = (-sa * d.x + ca * d.y) - bd.b.w * x * x;  // across, after bending

  // Width, tapering along the band and wider on one side when asymmetric.
  let w = max(bd.c.x * max(1.0 + bd.c.w * x, 0.05), 0.001);
  let side = select(1.0 - bd.c.z, 1.0 + bd.c.z, y > 0.0);
  let yn = y / (w * max(side, 0.05));

  // Profile: from a flat-topped stripe (softness 0) to a pure gaussian glow (softness 1).
  let gauss = exp(-yn * yn * 2.0);
  let flatTop = 1.0 - smoothstep(0.5, 1.0, abs(yn));
  let prof = mix(flatTop, gauss, bd.c.y);

  // Fade out past "length" along the band direction.
  let fade = max(bd.d.y, 0.01);
  let along = 1.0 - smoothstep(bd.d.x - fade, bd.d.x + fade, x);

  // Fine streaks running along the band.
  let sy = y * bd.d.w + idx * 17.3;
  let n = noise1(sy) * 0.65 + noise1(sy * 2.3 + 5.1) * 0.35;
  let streak = max(1.0 + bd.d.z * (n * 2.0 - 1.0) * 1.6, 0.0);

  return bd.a.rgb * intensity * prof * along * streak;
}

@fragment
fn fs_main(in : VOut) -> @location(0) vec4f {
  let aspect = u.res.x / max(u.res.y, 1.0);
  let p = vec2f((in.uv.x - 0.5) * aspect, in.uv.y - 0.5);

  let dir = vec2f(cos(u.bg0.w), sin(u.bg0.w));
  let tb = smoothstep(0.0, 1.0, clamp(0.5 + dot(p, dir) + u.bg1.w, 0.0, 1.0));
  var col = mix(u.bg0.rgb, u.bg1.rgb, tb);

  for (var i = 0; i < 4; i = i + 1) {
    let b = clamp(band(p, u.bands[i], f32(i)), vec3f(0.0), vec3f(1.0));
    col = 1.0 - (1.0 - col) * (1.0 - b);   // screen
  }

  // Film grain (soft monochrome clumps) plus a tiny dither against banding in dark gradients.
  let gp = in.position.xy / max(u.res.w, 0.5);
  let g = (vnoise(gp) + vnoise(gp * 1.7 + 37.1)) - 1.0;
  let dither = (hash(in.position.xy + 7.0) - 0.5) / 255.0;
  col = clamp(col + g * u.res.z * 1.5 + dither, vec3f(0.0), vec3f(1.0));

  return vec4f(col, 1.0);
}
`

export const hex = (h: string): RGB => ({
  r: parseInt(h.slice(1, 3), 16) / 255,
  g: parseInt(h.slice(3, 5), 16) / 255,
  b: parseInt(h.slice(5, 7), 16) / 255,
})

export type BandSpec = {
  color: string
  intensity: number
  /** Anchor, 0..1 across the frame (0,0 = top-left). */
  x: number
  y: number
  /** Degrees, 0 = left→right, positive tilts down to the right. */
  angle: number
  bend?: number
  width: number
  softness?: number
  asymmetry?: number
  taper?: number
  length?: number
  fade?: number
  streaks?: number
  streakDensity?: number
}

export type LightBandsSpec = {
  id: string
  name: string
  description: string
  version?: number
  background: { a: string; b: string; angle: number; offset?: number }
  grain: number
  grainSize?: number
  bands: BandSpec[] // up to BAND_COUNT; missing bands start switched off (intensity 0)
}

const OFF: BandSpec = { color: '#ffffff', intensity: 0, x: 0.5, y: 0.5, angle: 0, width: 0.1 }

function bandParams(i: number, b: BandSpec): Record<string, ParamDef> {
  const group = `Band ${i + 1}`
  const k = (name: string) => `band${i + 1}${name}`
  return {
    [k('Color')]: { type: 'color', group, label: 'Color', defaultValue: hex(b.color) },
    [k('Intensity')]: { type: 'number', group, label: 'Intensity (0 = off)', defaultValue: b.intensity, min: 0, max: 2, step: 0.01 },
    [k('X')]: { type: 'number', group, label: 'Position X', defaultValue: b.x, min: -0.5, max: 1.5, step: 0.005 },
    [k('Y')]: { type: 'number', group, label: 'Position Y', defaultValue: b.y, min: -0.5, max: 1.5, step: 0.005 },
    [k('Angle')]: { type: 'number', group, label: 'Angle', defaultValue: b.angle, min: -180, max: 180, step: 1, unit: '°' },
    [k('Bend')]: { type: 'number', group, label: 'Bend', defaultValue: b.bend ?? 0, min: -1, max: 1, step: 0.01 },
    [k('Width')]: { type: 'number', group, label: 'Width', defaultValue: b.width, min: 0.005, max: 0.8, step: 0.005 },
    [k('Softness')]: { type: 'number', group, label: 'Softness', defaultValue: b.softness ?? 1, min: 0, max: 1, step: 0.01 },
    [k('Asymmetry')]: { type: 'number', group, label: 'Asymmetry (glow above ↔ below)', defaultValue: b.asymmetry ?? 0, min: -0.95, max: 0.95, step: 0.01 },
    [k('Taper')]: { type: 'number', group, label: 'Taper', defaultValue: b.taper ?? 0, min: -1, max: 1, step: 0.01 },
    [k('Length')]: { type: 'number', group, label: 'Length', defaultValue: b.length ?? 5, min: 0, max: 5, step: 0.01 },
    [k('Fade')]: { type: 'number', group, label: 'Fade-out', defaultValue: b.fade ?? 0.2, min: 0.01, max: 1.5, step: 0.01 },
    [k('Streaks')]: { type: 'number', group, label: 'Streaks', defaultValue: b.streaks ?? 0, min: 0, max: 1, step: 0.01 },
    [k('StreakDensity')]: { type: 'number', group, label: 'Streak density', defaultValue: b.streakDensity ?? 14, min: 2, max: 60, step: 0.5 },
  }
}

export function lightBands(spec: LightBandsSpec): ShaderDef {
  const params: Record<string, ParamDef> = {
    bgA: { type: 'color', group: 'Background', label: 'Color A', defaultValue: hex(spec.background.a) },
    bgB: { type: 'color', group: 'Background', label: 'Color B', defaultValue: hex(spec.background.b) },
    bgAngle: { type: 'number', group: 'Background', label: 'Gradient angle (A → B)', defaultValue: spec.background.angle, min: -180, max: 180, step: 1, unit: '°' },
    bgOffset: { type: 'number', group: 'Background', label: 'Gradient offset', defaultValue: spec.background.offset ?? 0, min: -1, max: 1, step: 0.01 },
  }
  for (let i = 0; i < BAND_COUNT; i++) Object.assign(params, bandParams(i, spec.bands[i] ?? OFF))
  params.grain = { type: 'number', group: 'Finish', label: 'Grain', defaultValue: spec.grain, min: 0, max: 0.2, step: 0.001 }
  params.grainSize = { type: 'number', group: 'Finish', label: 'Grain size', defaultValue: spec.grainSize ?? 1.4, min: 0.5, max: 5, step: 0.1, unit: 'px' }

  return {
    id: spec.id,
    name: spec.name,
    category: 'generative',
    description: spec.description,
    version: spec.version,
    wgsl,
    uniformBytes: (3 + BAND_COUNT * 4) * 16,
    params,

    pack(p, width, height) {
      const n = (key: string) => Number(p[key])
      const c = (key: string) => {
        const v = p[key] as RGB
        return [v.r, v.g, v.b]
      }
      const rad = (key: string) => (n(key) * Math.PI) / 180
      const aspect = width / height

      const data = new Float32Array((3 + BAND_COUNT * 4) * 4)
      data.set([
        width, height, n('grain'), n('grainSize'),
        ...c('bgA'), rad('bgAngle'),
        ...c('bgB'), n('bgOffset'),
      ])
      for (let i = 0; i < BAND_COUNT; i++) {
        const k = (name: string) => `band${i + 1}${name}`
        data.set(
          [
            ...c(k('Color')), n(k('Intensity')),
            (n(k('X')) - 0.5) * aspect, n(k('Y')) - 0.5, rad(k('Angle')), n(k('Bend')),
            n(k('Width')), n(k('Softness')), n(k('Asymmetry')), n(k('Taper')),
            n(k('Length')), n(k('Fade')), n(k('Streaks')), n(k('StreakDensity')),
          ],
          12 + i * 16,
        )
      }
      return data
    },
  }
}
