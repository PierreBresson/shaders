import './style.css'
import { deleteImage, getImage, putImage } from './imageStore'
import { imageKeys, Renderer, type ImageSet } from './renderer'
import { buildSdf, decodeImage } from './sdf'
import { shaders } from './shaders'
import { CATEGORY_LABELS } from './types'
import type { ColorParam, Gradient, GradientParam, GradientStop, ImageParam, NumberParam, ParamValues, RGB, ShaderDef } from './types'

// ---------- helpers ----------

type Props = Record<string, unknown> & { class?: string }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag)
  const { class: cls, ...rest } = props
  if (cls) node.className = cls
  Object.assign(node, rest)
  node.append(...children)
  return node
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clone = <T>(v: T): T => structuredClone(v)
const decimals = (step: number) => (String(step).split('.')[1] ?? '').length
const toHex = (c: RGB) =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('')
const fromHex = (hex: string): RGB => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
})
/** Parse "#abc123" / "abc123" into a color, or null. */
const parseHex = (text: string): RGB | null => {
  const v = text.trim().replace(/^#?/, '#')
  return /^#[0-9a-f]{6}$/i.test(v) ? fromHex(v) : null
}
const isRGB = (v: unknown): v is RGB =>
  typeof v === 'object' && v !== null && ['r', 'g', 'b'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number')
const mixRGB = (a: RGB, b: RGB, t: number): RGB => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
})

function isGradient(v: unknown): v is Gradient {
  const stops = (v as Gradient | null)?.stops
  return (
    Array.isArray(stops) &&
    stops.length >= 2 &&
    stops.every((s) => typeof s?.position === 'number' && typeof s?.color?.r === 'number')
  )
}

function normalize(shader: ShaderDef, raw: unknown): ParamValues {
  const src = (raw ?? {}) as Record<string, unknown>
  const out: ParamValues = {}
  for (const [key, def] of Object.entries(shader.params)) {
    const v = src[key]
    if (def.type === 'image') continue // images live outside the JSON state
    if (def.type === 'number') {
      out[key] = typeof v === 'number' && Number.isFinite(v) ? clamp(v, def.min, def.max) : def.defaultValue
    } else if (def.type === 'color') {
      out[key] = isRGB(v) ? { r: v.r, g: v.g, b: v.b } : clone(def.defaultValue)
    } else {
      out[key] = isGradient(v) ? { stops: clone(v.stops).slice(0, def.maxStops) } : clone(def.defaultValue)
    }
  }
  return out
}

// ---------- state ----------

const SIZE_PRESETS = [
  { label: 'Square — 2048 × 2048', w: 2048, h: 2048 },
  { label: 'iPhone wallpaper — 1290 × 2796', w: 1290, h: 2796 },
  { label: 'Story — 1080 × 1920', w: 1080, h: 1920 },
  { label: 'Full HD — 1920 × 1080', w: 1920, h: 1080 },
  { label: 'QHD — 2560 × 1440', w: 2560, h: 1440 },
  { label: '4K — 3840 × 2160', w: 3840, h: 2160 },
  { label: 'Open Graph — 1200 × 630', w: 1200, h: 630 },
]

type State = {
  shaderId: string
  width: number
  height: number
  values: Record<string, ParamValues> // per shader
  versions: Record<string, number> // per shader, see ShaderDef.version
}

const STORAGE_KEY = 'shader-studio:v1'

function loadState(): State {
  let saved: Partial<State> | null = null
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
  } catch {
    saved = null
  }
  const shaderId = shaders.some((s) => s.id === saved?.shaderId) ? saved!.shaderId! : shaders[0].id
  const values: Record<string, ParamValues> = {}
  const versions: Record<string, number> = {}
  for (const s of shaders) {
    versions[s.id] = s.version ?? 1
    // Values saved under an older version of the shader fall back to the new defaults.
    const current = (saved?.versions?.[s.id] ?? 1) === versions[s.id]
    values[s.id] = normalize(s, current ? saved?.values?.[s.id] : null)
  }
  return {
    shaderId,
    width: Number.isInteger(saved?.width) ? saved!.width! : 2048,
    height: Number.isInteger(saved?.height) ? saved!.height! : 2048,
    values,
    versions,
  }
}

const state = loadState()
let saveTimer = 0
function persist() {
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable — fine */
    }
  }, 250)
}

const currentShader = () => shaders.find((s) => s.id === state.shaderId)!
const currentValues = () => state.values[state.shaderId]

// ---------- layout ----------

const app = document.querySelector<HTMLDivElement>('#app')!
const panel = el('aside', { class: 'panel' })
const canvas = el('canvas', { class: 'preview' })
const caption = el('div', { class: 'caption' })
const dropHint = el('div', { class: 'drop-hint' })
const stage = el('main', { class: 'stage' }, el('div', { class: 'frame' }, canvas, caption), dropHint)
app.append(panel, stage)

function showFatal(message: string) {
  stage.replaceChildren(el('div', { class: 'fatal' }, el('h2', { textContent: 'Can’t render' }), el('p', { textContent: message })))
}

// ---------- controls ----------

// Collapsible panel sections; which ones are folded is remembered by title.
const collapsedSections = new Set<string>()
function section(title: string, ...children: Node[]) {
  const details = el(
    'details',
    { class: 'section', open: !collapsedSections.has(title) },
    el('summary', {}, el('h3', { textContent: title })),
    ...children,
  )
  details.addEventListener('toggle', () => {
    if (details.open) collapsedSections.delete(title)
    else collapsedSections.add(title)
  })
  return details
}

function numberControl(key: string, def: NumberParam, values: ParamValues, onChange: () => void, extra?: HTMLElement) {
  const fmt = (v: number) => v.toFixed(decimals(def.step))
  const range = el('input', { type: 'range', min: String(def.min), max: String(def.max), step: String(def.step) })
  const num = el('input', { type: 'number', class: 'num', min: String(def.min), max: String(def.max), step: String(def.step) })
  const sync = () => {
    const v = values[key] as number
    range.value = String(v)
    num.value = fmt(v)
  }
  const set = (v: number) => {
    values[key] = clamp(v, def.min, def.max)
    sync()
    onChange()
  }
  range.addEventListener('input', () => set(Number(range.value)))
  num.addEventListener('change', () => (Number.isFinite(Number(num.value)) ? set(Number(num.value)) : sync()))
  const label = el('label', { textContent: def.label, title: 'Double-click to reset' })
  label.addEventListener('dblclick', () => set(def.defaultValue))
  sync()

  const row = el(
    'div',
    { class: 'control' },
    el('div', { class: 'control-head' }, label, el('span', { class: 'value' }, num, def.unit ? el('span', { class: 'unit', textContent: def.unit }) : '', extra ?? '')),
    range,
  )
  return Object.assign(row, { sync })
}

function colorControl(key: string, def: ColorParam, values: ParamValues, onChange: () => void) {
  const color = el('input', { type: 'color', class: 'swatch' })
  const hex = el('input', { type: 'text', class: 'hex', spellcheck: false, maxLength: 7 })
  const sync = () => {
    color.value = hex.value = toHex(values[key] as RGB)
  }
  const set = (c: RGB) => {
    values[key] = c
    sync()
    onChange()
  }
  color.addEventListener('input', () => set(fromHex(color.value)))
  hex.addEventListener('change', () => {
    const c = parseHex(hex.value)
    if (c) set(c)
    else sync()
  })
  const label = el('label', { textContent: def.label, title: 'Double-click to reset' })
  label.addEventListener('dblclick', () => set(clone(def.defaultValue)))
  sync()
  return el('div', { class: 'control color-control' }, label, el('span', { class: 'value' }, color, hex))
}

function gradientControl(key: string, def: GradientParam, values: ParamValues, onChange: () => void) {
  const gradient = () => values[key] as Gradient
  const bar = el('div', { class: 'gradient-bar' })
  const list = el('div', { class: 'stops' })
  const addBtn = el('button', { type: 'button', class: 'btn ghost small', textContent: '+ Add stop' })
  const resetBtn = el('button', { type: 'button', class: 'btn ghost small', textContent: 'Reset palette' })

  const sorted = () => [...gradient().stops].sort((a, b) => a.position - b.position)
  const paintBar = () => {
    const css = sorted().map((s) => `${toHex(s.color)} ${(s.position * 100).toFixed(1)}%`).join(', ')
    bar.style.background = `linear-gradient(90deg, ${css})`
  }
  const changed = () => {
    paintBar()
    onChange()
  }

  const rebuild = () => {
    gradient().stops = sorted()
    const stops = gradient().stops
    list.replaceChildren(
      ...stops.map((stop: GradientStop) => {
        const color = el('input', { type: 'color', value: toHex(stop.color), class: 'swatch' })
        color.addEventListener('input', () => {
          stop.color = fromHex(color.value)
          changed()
        })
        const pos = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(stop.position) })
        const posNum = el('input', { type: 'number', class: 'num', min: '0', max: '100', step: '1', value: String(Math.round(stop.position * 100)) })
        pos.addEventListener('input', () => {
          stop.position = Number(pos.value)
          posNum.value = String(Math.round(stop.position * 100))
          changed()
        })
        pos.addEventListener('change', rebuild) // re-sort once the drag ends
        posNum.addEventListener('change', () => {
          stop.position = clamp(Number(posNum.value) / 100 || 0, 0, 1)
          changed()
          rebuild()
        })
        const hex = el('input', { type: 'text', class: 'hex', value: toHex(stop.color), spellcheck: false, maxLength: 7 })
        color.addEventListener('input', () => (hex.value = color.value))
        hex.addEventListener('change', () => {
          const c = parseHex(hex.value)
          if (c) {
            stop.color = c
            color.value = toHex(c)
            changed()
          }
          hex.value = toHex(stop.color)
        })
        const remove = el('button', { type: 'button', class: 'icon-btn', textContent: '×', title: 'Remove stop', disabled: stops.length <= 2 })
        remove.addEventListener('click', () => {
          gradient().stops = stops.filter((s) => s !== stop)
          changed()
          rebuild()
        })
        return el('div', { class: 'stop' }, color, hex, pos, el('span', { class: 'value' }, posNum, el('span', { class: 'unit', textContent: '%' })), remove)
      }),
    )
    addBtn.disabled = stops.length >= def.maxStops
    paintBar()
  }

  addBtn.addEventListener('click', () => {
    const stops = sorted()
    // Insert in the middle of the widest gap, with the interpolated color.
    let best = 0
    for (let i = 1; i < stops.length - 1; i++) {
      if (stops[i + 1].position - stops[i].position > stops[best + 1].position - stops[best].position) best = i
    }
    const a = stops[best]
    const b = stops[best + 1]
    stops.splice(best + 1, 0, { position: (a.position + b.position) / 2, color: mixRGB(a.color, b.color, 0.5) })
    gradient().stops = stops
    changed()
    rebuild()
  })
  resetBtn.addEventListener('click', () => {
    values[key] = clone(def.defaultValue)
    changed()
    rebuild()
  })

  rebuild()
  return el('div', { class: 'control' }, bar, list, el('div', { class: 'row-actions' }, addBtn, resetBtn))
}

// ---------- app ----------

async function main() {
  let renderer: Renderer
  try {
    renderer = await Renderer.create()
  } catch (err) {
    showFatal((err as Error).message)
    return
  }
  renderer.device.lost.then((info) => showFatal(`The GPU device was lost (${info.message || info.reason}). Reload the page.`))

  const ctx = canvas.getContext('webgpu')!
  ctx.configure({ device: renderer.device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied' })

  let raf = 0
  const scheduleRender = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      renderer.drawToCanvas(ctx, currentShader(), currentValues(), currentImages())
    })
  }
  const onParamChange = () => {
    scheduleRender()
    persist()
  }

  // --- Images (kept on the GPU, persisted in IndexedDB, not in presets) ---
  type LoadedImage = { texture: GPUTexture; name: string; url: string }
  const images = new Map<string, LoadedImage>()
  const imageId = (shaderId: string, key: string) => `${shaderId}:${key}`
  const currentImages = (): ImageSet => {
    const out: ImageSet = {}
    for (const k of imageKeys(currentShader())) out[k] = images.get(imageId(state.shaderId, k))?.texture
    return out
  }
  /** The first required image of the current shader that's still missing, if any. */
  const missingImage = () =>
    imageKeys(currentShader()).find(
      (k) => !(currentShader().params[k] as ImageParam).optional && !images.has(imageId(state.shaderId, k)),
    )

  const fitToMax = (w: number, h: number) => {
    const k = Math.min(1, renderer.maxSize / Math.max(w, h))
    return [Math.round(w * k), Math.round(h * k)] as const
  }

  async function makeTexture(def: ImageParam, blob: Blob): Promise<GPUTexture> {
    if (def.kind === 'sdf') {
      // Only the shape (alpha) matters: rasterize it and build a distance field.
      const decoded = await decodeImage(blob)
      try {
        const field = buildSdf(decoded.image, decoded.width, decoded.height)
        return renderer.createSdfTexture(field.data, field.width, field.height)
      } finally {
        decoded.dispose()
      }
    }
    let bitmap = await createImageBitmap(blob)
    if (Math.max(bitmap.width, bitmap.height) > renderer.maxSize) {
      const [w, h] = fitToMax(bitmap.width, bitmap.height)
      bitmap.close()
      bitmap = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    }
    const texture = renderer.createImageTexture(bitmap)
    bitmap.close()
    return texture
  }

  async function setImage(shaderId: string, key: string, blob: Blob, name: string, fromUpload: boolean) {
    const def = shaders.find((s) => s.id === shaderId)?.params[key] as ImageParam | undefined
    if (!def) return
    const texture = await makeTexture(def, blob)
    clearImage(shaderId, key, false)
    images.set(imageId(shaderId, key), { texture, name, url: URL.createObjectURL(blob) })
    if (fromUpload) {
      void putImage(imageId(shaderId, key), { blob, name })
      if (def.matchOutputSize && shaderId === state.shaderId) matchImageSize(key)
    }
    if (shaderId === state.shaderId) {
      buildParams()
      scheduleRender()
    }
  }

  function clearImage(shaderId: string, key: string, forget: boolean) {
    const id = imageId(shaderId, key)
    const old = images.get(id)
    if (old) {
      old.texture.destroy()
      URL.revokeObjectURL(old.url)
      images.delete(id)
    }
    if (forget) void deleteImage(id)
  }

  function matchImageSize(key: string) {
    const img = images.get(imageId(state.shaderId, key))
    if (!img) return
    const [w, h] = fitToMax(img.texture.width, img.texture.height)
    setSize(w, h)
  }

  async function uploadFile(key: string, file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      status.textContent = `${file.name} isn’t an image.`
      return
    }
    status.textContent = `Loading ${file.name}…`
    try {
      await setImage(state.shaderId, key, file, file.name, true)
      status.textContent = ''
    } catch (err) {
      console.error(err)
      status.textContent = `Couldn’t load ${file.name}: ${(err as Error).message}`
    }
  }

  function imageControl(key: string, def: ImageParam) {
    const img = images.get(imageId(state.shaderId, key))
    const input = el('input', { type: 'file', accept: 'image/*', hidden: true })
    input.addEventListener('change', () => {
      void uploadFile(key, input.files?.[0])
      input.value = ''
    })
    const pick = el('button', { type: 'button', class: 'btn ghost small', textContent: img ? 'Replace' : 'Upload…' })
    pick.addEventListener('click', () => input.click())
    const actions = el('div', { class: 'row-actions' }, pick)
    if (img && def.matchOutputSize) {
      const match = el('button', {
        type: 'button',
        class: 'btn ghost small',
        textContent: `Use its size (${img.texture.width} × ${img.texture.height})`,
      })
      match.addEventListener('click', () => matchImageSize(key))
      actions.append(match)
    }
    if (img && def.optional) {
      const remove = el('button', { type: 'button', class: 'btn ghost small', textContent: 'Remove' })
      remove.addEventListener('click', () => {
        clearImage(state.shaderId, key, true)
        buildParams()
        scheduleRender()
      })
      actions.append(remove)
    }
    const box = el(
      'div',
      { class: 'image-drop' + (img ? ' has-image' : '') },
      img
        ? el('img', { src: img.url, alt: '' })
        : el('span', { textContent: def.hint ?? 'Drop an image here' }),
    )
    box.addEventListener('click', () => input.click())
    box.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.stopPropagation()
      box.classList.add('dragging')
    })
    box.addEventListener('dragleave', () => box.classList.remove('dragging'))
    box.addEventListener('drop', (e) => {
      e.preventDefault()
      e.stopPropagation()
      box.classList.remove('dragging')
      void uploadFile(key, e.dataTransfer?.files[0])
    })
    return el(
      'div',
      { class: 'control' },
      box,
      img ? el('p', { class: 'muted file-name', textContent: img.name }) : '',
      actions,
      input,
    )
  }

  // Dropping anywhere on the canvas area fills the main (first required) image.
  const updateDropHint = () => {
    const key = missingImage()
    stage.classList.toggle('needs-image', !!key)
    dropHint.textContent = key ? `Drop an image here, or use “${currentShader().params[key].label}” in the panel` : ''
  }
  stage.addEventListener('dragover', (e) => {
    if (!imageKeys(currentShader()).length) return
    e.preventDefault()
    stage.classList.add('dragging')
    if (!missingImage()) dropHint.textContent = `Drop to replace “${currentShader().params[imageKeys(currentShader())[0]].label}”`
  })
  stage.addEventListener('dragleave', (e) => {
    if (e.target !== stage) return
    stage.classList.remove('dragging')
    updateDropHint()
  })
  stage.addEventListener('drop', (e) => {
    e.preventDefault()
    stage.classList.remove('dragging')
    updateDropHint()
    const key = missingImage() ?? imageKeys(currentShader())[0]
    if (key) void uploadFile(key, e.dataTransfer?.files[0])
  })

  // Fit the preview canvas into the stage at the export aspect ratio.
  const layoutCanvas = () => {
    const rect = stage.getBoundingClientRect()
    const pad = rect.width < 700 ? 16 : 40
    const availW = Math.max(50, rect.width - pad * 2)
    const availH = Math.max(50, rect.height - pad * 2 - 32)
    const aspect = state.width / state.height
    let cw = availW
    let ch = cw / aspect
    if (ch > availH) {
      ch = availH
      cw = ch * aspect
    }
    canvas.style.width = `${Math.round(cw)}px`
    canvas.style.height = `${Math.round(ch)}px`
    // Never preview at more pixels than the export, so grain density stays representative.
    const pw = Math.max(1, Math.min(Math.round(cw * devicePixelRatio), state.width))
    canvas.width = pw
    canvas.height = Math.max(1, Math.round(pw / aspect))
    caption.textContent = `Export ${state.width} × ${state.height} px · preview ${canvas.width} × ${canvas.height}`
    scheduleRender()
  }
  new ResizeObserver(layoutCanvas).observe(stage)

  // --- Shader picker ---
  const categories = [...new Set(shaders.map((s) => s.category))]
  const shaderSelect = el(
    'select',
    {},
    ...categories.map((c) =>
      el(
        'optgroup',
        { label: CATEGORY_LABELS[c] },
        ...shaders.filter((s) => s.category === c).map((s) => el('option', { value: s.id, textContent: s.name })),
      ),
    ),
  )
  shaderSelect.value = state.shaderId
  const shaderDesc = el('p', { class: 'muted' })
  shaderSelect.addEventListener('change', () => {
    state.shaderId = shaderSelect.value
    buildParams()
    onParamChange()
  })

  // --- Output size ---
  const maxSize = renderer.maxSize
  const presetSelect = el(
    'select',
    {},
    ...SIZE_PRESETS.map((p, i) => el('option', { value: String(i), textContent: p.label })),
    el('option', { value: 'custom', textContent: 'Custom' }),
  )
  const wInput = el('input', { type: 'number', class: 'num wide', min: '16', max: String(maxSize), step: '1' })
  const hInput = el('input', { type: 'number', class: 'num wide', min: '16', max: String(maxSize), step: '1' })
  const swapBtn = el('button', { type: 'button', class: 'icon-btn', textContent: '⇄', title: 'Swap width and height' })

  const syncSize = () => {
    wInput.value = String(state.width)
    hInput.value = String(state.height)
    const i = SIZE_PRESETS.findIndex((p) => p.w === state.width && p.h === state.height)
    presetSelect.value = i >= 0 ? String(i) : 'custom'
    layoutCanvas()
    persist()
  }
  const setSize = (w: number, h: number) => {
    state.width = clamp(Math.round(w) || 16, 16, maxSize)
    state.height = clamp(Math.round(h) || 16, 16, maxSize)
    syncSize()
  }
  presetSelect.addEventListener('change', () => {
    const p = SIZE_PRESETS[Number(presetSelect.value)]
    if (p) setSize(p.w, p.h)
  })
  wInput.addEventListener('change', () => setSize(Number(wInput.value), state.height))
  hInput.addEventListener('change', () => setSize(state.width, Number(hInput.value)))
  swapBtn.addEventListener('click', () => setSize(state.height, state.width))

  // --- Params ---
  const paramsHost = el('div')
  const buildParams = () => {
    const shader = currentShader()
    const values = currentValues()
    shaderDesc.textContent = shader.description
    // Params with a `group` go in that section; others go under the preceding image
    // (or a "Parameters" section). Sections appear in order of first use.
    const sections: Node[] = []
    const named = new Map<string, HTMLElement>()
    const sectionFor = (name: string) => {
      let sec = named.get(name)
      if (!sec) {
        sec = section(name)
        named.set(name, sec)
        sections.push(sec)
      }
      return sec
    }
    let group: HTMLElement | null = null
    for (const [key, def] of Object.entries(shader.params)) {
      if (def.type === 'gradient') {
        sectionFor(def.group ?? def.label).append(gradientControl(key, def, values, onParamChange))
        group = null
      } else if (def.type === 'image') {
        group = sectionFor(def.group ?? def.label)
        group.append(imageControl(key, def))
      } else if (def.type === 'color') {
        ;(def.group ? sectionFor(def.group) : (group ??= sectionFor('Parameters'))).append(
          colorControl(key, def, values, onParamChange),
        )
      } else {
        let extra: HTMLElement | undefined
        if (key === shader.seedParam) {
          extra = el('button', { type: 'button', class: 'icon-btn', textContent: '⚄', title: 'Random variation' })
        }
        const row = numberControl(key, def, values, onParamChange, extra)
        extra?.addEventListener('click', () => {
          values[key] = Math.round((def.min + Math.random() * (def.max - def.min)) / def.step) * def.step
          row.sync()
          onParamChange()
        })
        ;(def.group ? sectionFor(def.group) : (group ??= sectionFor('Parameters'))).append(row)
      }
    }
    paramsHost.replaceChildren(...sections)
    updateDropHint()
  }

  // --- Actions ---
  const exportBtn = el('button', { type: 'button', class: 'btn primary', textContent: 'Export PNG' })
  const status = el('p', { class: 'muted status' })
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true
    exportBtn.textContent = 'Rendering…'
    status.textContent = ''
    const t0 = performance.now()
    try {
      const blob = await renderer.renderPng(currentShader(), currentValues(), currentImages(), state.width, state.height)
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      download(blob, `${state.shaderId}-${state.width}x${state.height}-${stamp}.png`)
      status.textContent = `Saved ${(blob.size / 1024 / 1024).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s`
    } catch (err) {
      console.error(err)
      status.textContent = `Export failed: ${(err as Error).message}`
    } finally {
      exportBtn.disabled = false
      exportBtn.textContent = 'Export PNG'
    }
  })

  const savePresetBtn = el('button', { type: 'button', class: 'btn ghost', textContent: 'Save preset' })
  const loadPresetBtn = el('button', { type: 'button', class: 'btn ghost', textContent: 'Load preset' })
  const resetBtn = el('button', { type: 'button', class: 'btn ghost', textContent: 'Reset all' })
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: true })

  savePresetBtn.addEventListener('click', () => {
    const preset = { shader: state.shaderId, width: state.width, height: state.height, params: currentValues() }
    download(new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }), `${state.shaderId}-preset.json`)
  })
  loadPresetBtn.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    try {
      const preset = JSON.parse(await file.text())
      const shader = shaders.find((s) => s.id === preset.shader)
      if (!shader) throw new Error(`Unknown shader "${preset.shader}"`)
      state.shaderId = shader.id
      state.values[shader.id] = normalize(shader, preset.params)
      shaderSelect.value = shader.id
      buildParams()
      if (preset.width && preset.height) setSize(preset.width, preset.height)
      onParamChange()
      status.textContent = `Loaded ${file.name}`
    } catch (err) {
      status.textContent = `Couldn’t load preset: ${(err as Error).message}`
    }
  })
  resetBtn.addEventListener('click', () => {
    state.values[state.shaderId] = normalize(currentShader(), null)
    buildParams()
    onParamChange()
  })

  panel.append(
    el('header', { class: 'brand' }, el('h1', { textContent: 'Shader Studio' }), shaderSelect, shaderDesc),
    section(
      'Output',
      presetSelect,
      el('div', { class: 'size-row' }, el('label', { textContent: 'W' }), wInput, swapBtn, el('label', { textContent: 'H' }), hInput),
      el('p', { class: 'muted', textContent: `Max ${maxSize} px per side on this GPU.` }),
    ),
    paramsHost,
    el(
      'footer',
      { class: 'actions' },
      exportBtn,
      el('div', { class: 'row-actions' }, savePresetBtn, loadPresetBtn, resetBtn),
      status,
      fileInput,
    ),
  )

  buildParams()
  syncSize()

  // Restore previously uploaded images.
  for (const shader of shaders) {
    for (const key of imageKeys(shader)) {
      const stored = await getImage(imageId(shader.id, key))
      if (stored) await setImage(shader.id, key, stored.blob, stored.name, false).catch((err) => console.warn(err))
    }
  }
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: filename })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

main()
