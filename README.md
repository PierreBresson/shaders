# Shaders

A small local studio for tweaking WebGPU shaders and exporting them as PNGs.

```bash
npm install
npm run dev
```

This opens http://localhost:5173. You need a browser with WebGPU: Chrome, Edge, Arc or Safari 26+.

## Using it

- **Output**: pick a size preset or type a width and height. ⇄ swaps them. You can export at up to your GPU's max texture size (usually 16384 px).
- **Palette**: edit the gradient stops with the color picker or a hex value, and drag the position sliders. You can have 2 to 8 stops.
- **Parameters**: drag a slider or type a value. Double-click a label to reset that value. ⚄ picks a random variation.
- **Export PNG**: renders offscreen at the exact output size and downloads the file.
- **Save / Load preset**: saves the current shader, size and params as JSON, or loads one back.

Your current settings are also autosaved in the browser.

## Shaders

- **Silk Folds**: satin-like folds in a gradient palette, with film grain.
- **Glass Logo**: upload an SVG or PNG logo (only its shape is used) to render it as soft frosted glass. It has a gradient fill with a soft darker core, frosted lighter edges, colored edge light, a subtle bevel, an inner shadow, a drop shadow and a colored glow underneath. Every color and amount can be changed. Set the background opacity to 0 to export a transparent PNG.
- **Soft Focus**: upload a photo (or drop it on the canvas) to get a dreamy blur with a motion streak, haze and film grain. When you upload a photo, the output size switches to the photo's size.

Uploaded images are kept in the browser (IndexedDB), so they come back after a reload. Preset JSON files don't include them, only the settings.

Grain is drawn per output pixel, so it looks finer on large exports than in the preview. The preview never uses more pixels than the export.

## Adding a shader

1. Add a file to `src/shaders/`, using `silk-folds.ts` as a template. You need:
   - `wgsl`, returning straight (non-premultiplied) alpha, with `vs_main` and `fs_main` entry points and one uniform buffer at `@group(0) @binding(0)`. If it has `image` params, binding 1 is a sampler and bindings 2, 3, … are the images in declaration order. Images are mipmapped sRGB textures, so sampling them gives linear light.
   - `params`, which describes the controls (`number`, `color`, `gradient` or `image`). Add `group` to put a param in a named panel section. An `image` with `kind: 'sdf'` is bound as a signed distance field of its shape instead of the picture (see `src/sdf.ts`).
   - `pack()`, which writes the param values into the uniform buffer layout
2. Register it in `src/shaders/index.ts`. It then appears in the shader picker.

## Layout

```
src/
  main.ts          UI: controls, preview, export, presets
  renderer.ts      WebGPU setup, preview drawing, offscreen PNG render + readback
  types.ts         ShaderDef / param types
  shaders/
    index.ts       shader registry
    silk-folds.ts  Silk Folds shader + params
    soft-focus.ts  Soft Focus (photo blur + haze + grain)
    glass-logo.ts  Glass Logo (SDF-based glass material for a logo shape)
  sdf.ts           Image decoding + signed distance field from alpha
  imageStore.ts    IndexedDB storage for uploaded images
```
