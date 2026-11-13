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
- **Sections**: click a section title to fold or unfold it.
- **Parameters**: drag a slider or type a value. Double-click a label to reset that value. ⚄ picks a random variation.
- **Export PNG**: renders offscreen at the exact output size and downloads the file.
- **Save / Load preset**: saves the current shader, size and params as JSON, or loads one back.

Your current settings are also autosaved in the browser.

## Shaders

The picker groups shaders into three sections.

**Photo effects**: upload a photo (or drop it on the canvas). The output size switches to the photo's size.

- **Soft Focus**: a dreamy blur with a motion streak, haze and film grain.
- **Frosted Glass**: the photo seen through frosted glass. Dark shapes stay close and fairly crisp, lighter areas melt into a milky veil (color adjustable), with a fine frosted texture and grain.
- **Bokeh**: wide-open lens blur. Bright spots bloom into discs, with an optional bright rim and a polygon shape (aperture blades).
- **Motion Pan**: intentional camera movement. Long streaks in one direction, with cross blur, a bit of hand shake and fine streak texture.

**Generative**: no image needed.

- **Silk Folds**: satin-like folds in a gradient palette, with film grain.
- **Ember Rays**, **Horizon Flare**, **Amber Beam**: soft, out-of-focus beams of light over a dark gradient, with grain. They all use the same engine (`light-bands.ts`) with different defaults. Each has up to 4 bands, and each band has its own color, intensity, position, angle, bend, width, softness, asymmetry, taper, length and streaks. Set a band's intensity to 0 to turn it off.

**Logo**: upload an SVG or PNG logo.

- **Glass Logo**: upload an SVG or PNG logo (only its shape is used) to render it as a flat sheet of tinted glass. It has one smooth gradient across the whole shape, three color spots you can place anywhere on it (by default a purple one bottom left and a green-blue one bottom right), edges that turn clear on one side with a hairline of light and stay crisp on the other, a soft drop shadow and a glow underneath tinted by the glass above it. An optional bevel (shading, glints, rim refraction) is off by default. Every color and amount can be changed. Set the background opacity to 0 to export a transparent PNG.

Uploaded images are kept in the browser (IndexedDB), so they come back after a reload. Preset JSON files don't include them, only the settings.

Grain is drawn per output pixel, so it looks finer on large exports than in the preview. The preview never uses more pixels than the export.

## Adding a shader

1. Add a file to `src/shaders/`, using `silk-folds.ts` as a template. You need:
   - `wgsl`, returning straight (non-premultiplied) alpha, with `vs_main` and `fs_main` entry points and one uniform buffer at `@group(0) @binding(0)`. If it has `image` params, binding 1 is a sampler and bindings 2, 3, … are the images in declaration order. Images are mipmapped sRGB textures, so sampling them gives linear light.
   - `params`, which describes the controls (`number`, `color`, `gradient` or `image`). Add `group` to put a param in a named panel section. An `image` with `kind: 'sdf'` is bound as a signed distance field of its shape instead of the picture (see `src/sdf.ts`).
   - `pack()`, which writes the param values into the uniform buffer layout
   - `category` (`'photo'`, `'generative'` or `'logo'`), which picks its section in the shader picker
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
    light-bands.ts    Light Bands engine (soft beams of light), shared by the presets below
    light-presets.ts  Ember Rays, Horizon Flare, Amber Beam
    soft-focus.ts  Soft Focus (photo blur + haze + grain)
    photo-blur.ts  Frosted Glass, Bokeh, Motion Pan (photo blurs sharing one film finish)
    glass-logo.ts  Glass Logo (SDF-based glass material for a logo shape)
  sdf.ts           Image decoding + signed distance field from alpha
  imageStore.ts    IndexedDB storage for uploaded images
```
