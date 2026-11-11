import type { ImageSizes, ParamValues, ShaderDef } from './types'

export type ImageSet = Record<string, GPUTexture | undefined>

export const IMAGE_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb'

export const imageKeys = (shader: ShaderDef) =>
  Object.keys(shader.params).filter((k) => shader.params[k].type === 'image')

// Downsamples one mip level into the next (fullscreen triangle, bilinear 2×2 average).
const MIP_WGSL = /* wgsl */ `
struct V { @builtin(position) p : vec4f, @location(0) uv : vec2f };
@vertex fn vs(@builtin(vertex_index) i : u32) -> V {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o : V;
  o.p = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(xy.x, 1.0 - xy.y);
  return o;
}
@group(0) @binding(0) var s : sampler;
@group(0) @binding(1) var t : texture_2d<f32>;
@fragment fn fs(v : V) -> @location(0) vec4f { return textureSampleLevel(t, s, v.uv, 0.0); }
`

// Full-screen quad: position.xy, uv.xy (uv origin top-left).
const QUAD = new Float32Array([
  -1, -1, 0, 1,  1, -1, 1, 1,  -1, 1, 0, 0,
  -1, 1, 0, 0,   1, -1, 1, 1,   1, 1, 1, 0,
])

type Entry = { pipeline: GPURenderPipeline; bindGroup?: GPUBindGroup; uniforms: GPUBuffer }

export class Renderer {
  private entries = new Map<string, Entry>()
  private modules = new Map<string, GPUShaderModule>()
  private mipPipelines = new Map<GPUTextureFormat, GPURenderPipeline>()
  private sampler: GPUSampler
  private placeholder: GPUTexture

  private constructor(
    readonly device: GPUDevice,
    private quad: GPUBuffer,
  ) {
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    // Bound in place of images that haven't been uploaded yet.
    this.placeholder = device.createTexture({
      size: [1, 1],
      format: IMAGE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture({ texture: this.placeholder }, new Uint8Array([40, 40, 40, 255]), {}, [1, 1])
  }

  /** Upload an RGBA signed distance field (see sdf.ts) as a mipmapped half-float texture. */
  createSdfTexture(field: Float32Array, width: number, height: number): GPUTexture {
    const texture = this.device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      mipLevelCount: Math.floor(Math.log2(Math.max(width, height))) + 1,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const half = new Uint16Array(field.length)
    for (let i = 0; i < field.length; i++) half[i] = toHalf(field[i])
    this.device.queue.writeTexture({ texture }, half, { bytesPerRow: width * 8 }, [width, height])
    this.generateMips(texture)
    return texture
  }

  /** Upload an image as a premultiplied sRGB texture with a full mip chain (used for blur). */
  createImageTexture(source: ImageBitmap): GPUTexture {
    const { width, height } = source
    const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1
    const texture = this.device.createTexture({
      size: [width, height],
      format: IMAGE_FORMAT,
      mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.device.queue.copyExternalImageToTexture({ source }, { texture, premultipliedAlpha: true }, [width, height])
    this.generateMips(texture)
    return texture
  }

  private generateMips(texture: GPUTexture) {
    let pipeline = this.mipPipelines.get(texture.format)
    if (!pipeline) {
      const module = this.device.createShaderModule({ code: MIP_WGSL, label: 'mipmaps' })
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: texture.format }] },
        primitive: { topology: 'triangle-list' },
      })
      this.mipPipelines.set(texture.format, pipeline)
    }
    const encoder = this.device.createCommandEncoder()
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
        ],
      })
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
    }
    this.device.queue.submit([encoder.finish()])
  }

  static async create(): Promise<Renderer> {
    if (!('gpu' in navigator)) {
      throw new Error('WebGPU is not available in this browser. Use a recent Chrome, Edge, Arc or Safari.')
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('No WebGPU adapter found.')
    // Ask for the biggest textures the GPU supports so large exports work.
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    })
    const quad = device.createBuffer({
      size: QUAD.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    })
    new Float32Array(quad.getMappedRange()).set(QUAD)
    quad.unmap()
    return new Renderer(device, quad)
  }

  get maxSize(): number {
    return this.device.limits.maxTextureDimension2D
  }

  /**
   * Shaders output straight alpha. The preview canvas is premultiplied, so its pipeline
   * blends onto a transparent clear to premultiply; the PNG export keeps straight alpha.
   */
  private entry(shader: ShaderDef, format: GPUTextureFormat, premultiply: boolean): Entry {
    const key = `${shader.id}|${format}|${premultiply}`
    const cached = this.entries.get(key)
    if (cached) return cached

    let module = this.modules.get(shader.id)
    if (!module) {
      module = this.device.createShaderModule({ code: shader.wgsl, label: shader.id })
      module.getCompilationInfo().then((info) => {
        for (const m of info.messages) console[m.type === 'error' ? 'error' : 'warn'](`[${shader.id}] ${m.lineNum}:${m.linePos} ${m.message}`)
      })
      this.modules.set(shader.id, module)
    }

    const pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 16,
            attributes: [
              { shaderLocation: 0, format: 'float32x2', offset: 0 },
              { shaderLocation: 1, format: 'float32x2', offset: 8 },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [
          {
            format,
            blend: premultiply
              ? {
                  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                }
              : undefined,
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
    const uniforms = this.device.createBuffer({
      size: shader.uniformBytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    // Shaders without images can reuse one bind group; image shaders get one per draw.
    const bindGroup = imageKeys(shader).length
      ? undefined
      : this.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniforms } }],
        })
    const entry = { pipeline, bindGroup, uniforms }
    this.entries.set(key, entry)
    return entry
  }

  private draw(
    shader: ShaderDef,
    values: ParamValues,
    images: ImageSet,
    texture: GPUTexture,
    premultiply: boolean,
  ): GPUCommandEncoder {
    const e = this.entry(shader, texture.format, premultiply)
    const keys = imageKeys(shader)
    const sizes: ImageSizes = {}
    for (const k of keys) sizes[k] = images[k] ? { width: images[k].width, height: images[k].height } : null
    this.device.queue.writeBuffer(e.uniforms, 0, shader.pack(values, texture.width, texture.height, sizes))
    const bindGroup =
      e.bindGroup ??
      this.device.createBindGroup({
        layout: e.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: e.uniforms } },
          { binding: 1, resource: this.sampler },
          ...keys.map((k, i) => ({ binding: 2 + i, resource: (images[k] ?? this.placeholder).createView() })),
        ],
      })
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(e.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.setVertexBuffer(0, this.quad)
    pass.draw(6)
    pass.end()
    return encoder
  }

  /** Draw into a configured canvas context (live preview). */
  drawToCanvas(ctx: GPUCanvasContext, shader: ShaderDef, values: ParamValues, images: ImageSet): void {
    const encoder = this.draw(shader, values, images, ctx.getCurrentTexture(), true)
    this.device.queue.submit([encoder.finish()])
  }

  /** Render offscreen at an exact size and read the pixels back into a PNG. */
  async renderPng(shader: ShaderDef, values: ParamValues, images: ImageSet, width: number, height: number): Promise<Blob> {
    const texture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    this.device.queue.submit([this.draw(shader, values, images, texture, false).finish()])

    // Read back in horizontal bands so huge images don't need one giant staging buffer.
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256
    const maxBand = Math.min(this.device.limits.maxBufferSize, 64 * 1024 * 1024)
    const rowsPerBand = Math.max(1, Math.min(height, Math.floor(maxBand / bytesPerRow)))
    const staging = this.device.createBuffer({
      size: bytesPerRow * rowsPerBand,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const pixels = new Uint8ClampedArray(width * height * 4)
    const rowBytes = width * 4

    try {
      for (let y0 = 0; y0 < height; y0 += rowsPerBand) {
        const rows = Math.min(rowsPerBand, height - y0)
        const encoder = this.device.createCommandEncoder()
        encoder.copyTextureToBuffer(
          { texture, origin: [0, y0] },
          { buffer: staging, bytesPerRow, rowsPerImage: rows },
          [width, rows],
        )
        this.device.queue.submit([encoder.finish()])
        await staging.mapAsync(GPUMapMode.READ, 0, bytesPerRow * rows)
        const src = new Uint8Array(staging.getMappedRange(0, bytesPerRow * rows))
        for (let r = 0; r < rows; r++) {
          pixels.set(src.subarray(r * bytesPerRow, r * bytesPerRow + rowBytes), (y0 + r) * rowBytes)
        }
        staging.unmap()
      }
    } finally {
      staging.destroy()
      texture.destroy()
    }

    const canvas = new OffscreenCanvas(width, height)
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) throw new Error('Could not create a 2D canvas for PNG encoding.')
    ctx2d.putImageData(new ImageData(pixels, width, height), 0, 0)
    return canvas.convertToBlob({ type: 'image/png' })
  }
}

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** float32 -> IEEE half bits (round to nearest). */
function toHalf(v: number): number {
  f32[0] = v
  const x = u32[0]
  const sign = (x >>> 16) & 0x8000
  const exp = ((x >>> 23) & 0xff) - 127 + 15
  let mant = x & 0x7fffff
  if (exp <= 0) {
    if (exp < -10) return sign
    mant = (mant | 0x800000) >> (1 - exp)
    return sign | ((mant + 0x1000) >> 13)
  }
  if (exp >= 31) return sign | 0x7c00
  return sign | ((exp << 10) + ((mant + 0x1000) >> 13))
}
