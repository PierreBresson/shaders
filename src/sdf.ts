// Signed distance field from an image's alpha (exact Euclidean distance transform,
// Felzenszwalb & Huttenlocher, with sub-pixel edges from anti-aliased alpha).
//
// The shape is rasterized so its longest side is SDF_CORE_PX, with SDF_PAD_PX of empty
// space around it so shadows and glows have room. Distances are stored in units of the
// shape's longest side: negative inside, positive outside.
//
// The field is RGBA: r = signed distance, g = coverage (the anti-aliased alpha, 0..1),
// which the shader blurs via mipmaps for smooth, crease-free interior shading.

export const SDF_CORE_PX = 1024
export const SDF_PAD_PX = 256

const INF = 1e20

export type SdfField = { data: Float32Array; width: number; height: number } // RGBA, 4 floats per pixel

export function buildSdf(source: CanvasImageSource, srcWidth: number, srcHeight: number): SdfField {
  const scale = SDF_CORE_PX / Math.max(srcWidth, srcHeight)
  const w0 = Math.max(1, Math.round(srcWidth * scale))
  const h0 = Math.max(1, Math.round(srcHeight * scale))
  const width = w0 + SDF_PAD_PX * 2
  const height = h0 + SDF_PAD_PX * 2

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create a 2D canvas.')
  ctx.drawImage(source, SDF_PAD_PX, SDF_PAD_PX, w0, h0)
  const pixels = ctx.getImageData(0, 0, width, height).data

  const size = width * height
  const outer = new Float64Array(size).fill(INF) // squared distance to the shape
  const inner = new Float64Array(size) // squared distance to the outside
  let any = false
  for (let i = 0; i < size; i++) {
    const a = pixels[i * 4 + 3] / 255
    if (a === 0) continue
    any = true
    if (a === 1) {
      outer[i] = 0
      inner[i] = INF
    } else {
      const d = 0.5 - a
      outer[i] = d > 0 ? d * d : 0
      inner[i] = d < 0 ? d * d : 0
    }
  }
  if (!any) throw new Error('The image is fully transparent — the logo needs a visible shape.')

  const n = Math.max(width, height)
  const f = new Float64Array(n)
  const v = new Uint32Array(n)
  const z = new Float64Array(n + 1)
  edt(outer, width, height, f, v, z)
  edt(inner, width, height, f, v, z)

  const data = new Float32Array(size * 4)
  for (let i = 0; i < size; i++) {
    data[i * 4] = (Math.sqrt(outer[i]) - Math.sqrt(inner[i])) / SDF_CORE_PX
    data[i * 4 + 1] = pixels[i * 4 + 3] / 255
  }
  return { data, width, height }
}

function edt(grid: Float64Array, width: number, height: number, f: Float64Array, v: Uint32Array, z: Float64Array) {
  for (let x = 0; x < width; x++) edt1d(grid, x, width, height, f, v, z)
  for (let y = 0; y < height; y++) edt1d(grid, y * width, 1, width, f, v, z)
}

function edt1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
  f: Float64Array,
  v: Uint32Array,
  z: Float64Array,
) {
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  f[0] = grid[offset]
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride]
    const q2 = q * q
    do {
      const r = v[k]
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2
    } while (s <= z[k] && --k > -1)
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++
    const r = v[k]
    const qr = q - r
    grid[offset + q * stride] = f[r] + qr * qr
  }
}

/** Decode any image the browser can show (PNG, JPG, WebP, SVG…) into something drawable. */
export async function decodeImage(blob: Blob): Promise<{ image: HTMLImageElement; width: number; height: number; dispose(): void }> {
  const url = URL.createObjectURL(blob)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
  } catch {
    URL.revokeObjectURL(url)
    throw new Error('The browser couldn’t decode this image.')
  }
  let width = image.naturalWidth
  let height = image.naturalHeight
  // SVGs with only a viewBox may report no (or a default) size: use the viewBox aspect.
  if (blob.type.includes('svg')) {
    const text = await blob.text()
    const viewBox = text.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/)
    const hasSize = /<svg[^>]*\swidth\s*=/.test(text)
    if (viewBox && (!hasSize || !width || !height)) {
      width = Number(viewBox[1])
      height = Number(viewBox[2])
    }
  }
  if (!width || !height) width = height = SDF_CORE_PX
  return { image, width, height, dispose: () => URL.revokeObjectURL(url) }
}
