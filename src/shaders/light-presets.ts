import { lightBands } from './light-bands'

// Presets built on the Light Bands engine. Positions are 0..1 across the frame,
// angles in degrees (positive tilts down to the right), widths in units of the frame height.

/** Red and pink rays rising from the bottom-left into a near-black corner. */
export const emberRays = lightBands({
  id: 'ember-rays',
  name: 'Ember Rays',
  description: 'Coral and pale pink light rays sweeping up from the bottom-left into black.',
  background: { a: '#0e0b0b', b: '#1c0f10', angle: 135 },
  grain: 0.008,
  grainSize: 1.5,
  bands: [
    // pale pink glow along the bottom
    { color: '#f6c3c8', intensity: 1, x: 0.5, y: 0.97, angle: 24, width: 0.3, asymmetry: -0.3 },
    // coral body, lightly streaked
    { color: '#d9555b', intensity: 0.85, x: 0.5, y: 0.72, angle: 25, width: 0.2, streaks: 0.3, streakDensity: 14 },
    // darker red rays reaching into the black
    { color: '#8a3236', intensity: 0.7, x: 0.45, y: 0.55, angle: 32, width: 0.18, streaks: 0.7, streakDensity: 9 },
    // hot red glow on the left edge
    { color: '#e0484d', intensity: 0.7, x: 0, y: 0.48, angle: 25, width: 0.1, length: 0.45, fade: 0.35 },
  ],
})

/** A pale blue horizon glow over deep navy, with a thin red streak below. */
export const horizonFlare = lightBands({
  id: 'horizon-flare',
  name: 'Horizon Flare',
  description: 'A steel-blue horizon of light over deep navy, crossed by a short red streak.',
  background: { a: '#0b1424', b: '#02040a', angle: 90 },
  grain: 0.006,
  bands: [
    // wide blue haze above the horizon
    { color: '#233a57', intensity: 0.7, x: 0.5, y: 0.2, angle: 9, width: 0.3 },
    // the horizon: soft glow on top, crisper lower edge, slightly arched
    { color: '#a7bed2', intensity: 0.95, x: 0.5, y: 0.37, angle: 9, bend: 0.12, width: 0.08, softness: 0.55, asymmetry: -0.55 },
    // red streak entering from the left and fading out
    { color: '#e2321f', intensity: 1, x: 0, y: 0.565, angle: 15, width: 0.04, softness: 0.6, taper: -0.5, length: 0.55, fade: 0.2 },
    // faint navy lift low on the right
    { color: '#1b2a3d', intensity: 0.5, x: 0.8, y: 0.62, angle: 15, width: 0.1 },
  ],
})

/** A grainy orange beam cutting up across a dark frame, with a teal hint in the corner. */
export const amberBeam = lightBands({
  id: 'amber-beam',
  name: 'Amber Beam',
  description: 'A soft orange beam rising across a dark, heavily grained frame.',
  background: { a: '#141418', b: '#111114', angle: 90 },
  grain: 0.075,
  grainSize: 1.2,
  bands: [
    // the beam: wide on the left, narrowing and dimming to the right
    { color: '#d55a29', intensity: 0.95, x: 0, y: 0.66, angle: -20, bend: -0.05, width: 0.12, taper: -0.45, asymmetry: 0.25, length: 1.25, fade: 0.45 },
    // reddish haze above it
    { color: '#5a2016', intensity: 0.6, x: 0, y: 0.5, angle: -17, width: 0.22, length: 1, fade: 0.5 },
    // teal glow in the top-left corner
    { color: '#2c5444', intensity: 0.6, x: 0, y: 0.03, angle: 55, width: 0.2, length: 0.25, fade: 0.25 },
    // hotter core where the beam enters
    { color: '#e98a3a', intensity: 0.35, x: 0, y: 0.67, angle: -20, width: 0.05, length: 0.4, fade: 0.3 },
  ],
})
