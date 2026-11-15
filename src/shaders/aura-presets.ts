import { auraCard } from './aura-card'

// Presets built on the Aura Card engine. Margins, reach and radius are in units of the
// frame's short side.

/** A blurred card of deep indigo on pale paper, glowing cyan and blue at its rim. */
export const midnightAura = auraCard({
  id: 'midnight-aura',
  name: 'Midnight Aura',
  description: 'A soft-edged card of indigo fading to blue and cyan at its rim, on grainy paper.',
  paper: '#e9ecee',
  palette: [
    [0, '#4f8fc0'],
    [0.2, '#2f78b0'],
    [0.42, '#1f4a88'],
    [0.66, '#1c2a62'],
    [1, '#211139'],
  ],
  margin: { left: 0.015, right: 0.025, top: 0.047, bottom: 0.022 },
  radius: 0.05,
  blur: 0.035,
  reach: { left: 0.12, right: 0.34, top: 0.27, bottom: 0.1 },
  // cyan in the top-right, slate-lavender along the bottom and left
  tintA: { color: '#7fd3d1', angle: -60, amount: 0.95, spread: 0.8 },
  tintB: { color: '#5a5880', angle: 112, amount: 1, spread: 1.1 },
  warp: 0.3,
  seed: 3,
  grain: 0.05,
  grainSize: 1.2,
})
