export type RGB = { r: number; g: number; b: number }
export type GradientStop = { position: number; color: RGB }
export type Gradient = { stops: GradientStop[] }

type Base = {
  label: string
  /** Section in the panel. Params without one go under the preceding image, or "Parameters". */
  group?: string
}

export type NumberParam = Base & {
  type: 'number'
  defaultValue: number
  min: number
  max: number
  step: number
  unit?: string
}

export type ColorParam = Base & {
  type: 'color'
  defaultValue: RGB
}

export type GradientParam = Base & {
  type: 'gradient'
  defaultValue: Gradient
  maxStops: number
}

export type ImageParam = Base & {
  type: 'image'
  /**
   * 'color' (default): the image itself, as a premultiplied sRGB texture with mipmaps.
   * 'sdf': a mipmapped rgba16float texture of the image's shape: r = signed distance in units
   * of the shape's longest side (negative inside), g = coverage 0..1. SDF_PAD_PX of padding
   * surrounds a SDF_CORE_PX-long shape — see sdf.ts.
   */
  kind?: 'color' | 'sdf'
  /** Text shown in the empty upload box. */
  hint?: string
  /** Optional images can be removed; required ones show an upload prompt on the canvas. */
  optional?: boolean
  /** Set the output size to the image size when it's uploaded. */
  matchOutputSize?: boolean
}

export type ParamDef = NumberParam | ColorParam | GradientParam | ImageParam
/** JSON-serializable values (numbers, colors and gradients). Images are passed separately. */
export type ParamValues = Record<string, number | RGB | Gradient>
/** Sizes of the bound images, keyed by image param, or null when none is loaded. */
export type ImageSizes = Record<string, { width: number; height: number } | null>

/**
 * A full-screen fragment shader. The WGSL must expose `vs_main(@location(0) pos, @location(1) uv)`
 * and `fs_main`, and read a uniform buffer at group 0 / binding 0.
 * If the shader has image params, binding 1 is a linear mipmapped sampler and bindings 2, 3, …
 * are the images as `texture_2d<f32>`, in param declaration order.
 *
 * fs_main returns straight (non-premultiplied) alpha; alpha < 1 gives a transparent PNG.
 */
/** Picker section: effects on an uploaded photo, generated images, or effects on a logo. */
export type ShaderCategory = 'photo' | 'generative' | 'logo'

export const CATEGORY_LABELS: Record<ShaderCategory, string> = {
  photo: 'Photo effects',
  generative: 'Generative',
  logo: 'Logo',
}

export interface ShaderDef {
  id: string
  name: string
  category: ShaderCategory
  description: string
  /** Bump when defaults change, so autosaved values from older versions are reset. */
  version?: number
  wgsl: string
  /** Size of the uniform buffer in bytes. */
  uniformBytes: number
  params: Record<string, ParamDef>
  /** Optional numeric param that the "shuffle" button randomizes. */
  seedParam?: string
  /** Pack the param values into the uniform buffer layout. */
  pack(values: ParamValues, width: number, height: number, images: ImageSizes): Float32Array
}
