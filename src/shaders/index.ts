import type { ShaderDef } from '../types'
import { analogPrint } from './analog-print'
import { glassLogo } from './glass-logo'
import { amberBeam, emberRays, horizonFlare } from './light-presets'
import { bokeh, frostedGlass, motionPan } from './photo-blur'
import { silkFolds } from './silk-folds'
import { softFocus } from './soft-focus'

// Add new shaders here — they show up in the shader picker automatically,
// grouped by their `category` (in the order the categories first appear here).
export const shaders: ShaderDef[] = [
  // Photo effects (upload a photo)
  softFocus,
  frostedGlass,
  bokeh,
  motionPan,
  analogPrint,
  // Generative (no image)
  silkFolds,
  emberRays,
  horizonFlare,
  amberBeam,
  // Logo (upload a logo)
  glassLogo,
]
