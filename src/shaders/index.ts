import type { ShaderDef } from '../types'
import { glassLogo } from './glass-logo'
import { silkFolds } from './silk-folds'
import { softFocus } from './soft-focus'

// Add new shaders here — they show up in the shader picker automatically.
export const shaders: ShaderDef[] = [silkFolds, softFocus, glassLogo]
