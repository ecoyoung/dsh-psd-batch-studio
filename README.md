# DSH PSD Batch Studio

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin for producing e-commerce
main images at scale: load a PSD/PSB template, mark the product slots, drop in a
batch of SKU cut-outs, fine-tune on a canvas, and export every image.

The same compositor also powers two agent tools, so the agent can inspect a
template and render a whole SKU folder headlessly.

> **License:** source-available, noncommercial (PolyForm Noncommercial 1.0.0).
> Personal use is free; commercial use needs a separate license. See
> [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md).

## Features

- **Template workbench** — open a `.psd` / `.psb`, browse the layer tree, toggle
  layers, and see the composite on an interactive canvas.
- **Product slots** — auto-detects likely product layers by size, position,
  aspect ratio, and naming; mark or unmark slots manually. Stacked copies of the
  same product (the artwork plus a shadow/highlight copy) form one slot cluster
  and are hidden together.
- **Batch SKU fitting** — import many PNG/JPG/WebP cut-outs; each is trimmed to
  its visible alpha bounds and fitted into every slot with contain / height /
  width / cover, plus anchor and fill controls.
- **Canvas fine-tune** — drag the product, scale with corner handles, set
  offset/scale/rotation numerically, and copy one adjustment to the whole batch.
- **Export** — JPG or PNG at the template resolution, one file per SKU, packed
  into a ZIP when requested.
- **Agent tools** — `psd_inspect` and `psd_batch_render` expose the same pipeline
  to the agent for unattended batches.
- **Local-first** — PSD parsing and compositing happen in the browser (or in the
  Host process for agent batches). No network calls, no telemetry, no upload.

## Requirements

- DeepSeek Harness with the plugin manager. The plugin declares
  `dsh.engines.dsh >= 0.2.1-rc.5` and was tested on `0.2.1-rc.5` and
  `0.2.2-rc.1`.
- Node.js 20+ for building and for the agent tools.
- npm registry access on install: the agent tools depend on `@napi-rs/canvas`,
  which ships platform-specific prebuilt binaries.
- No Photoshop installation is required.

## Install

### From the repository

```text
plugin_manager install_bundle, target = github:vinkwork/dsh-psd-batch-studio
```

If the plugin manager cannot resolve a GitHub spec, clone and install the local
directory instead:

```bash
git clone https://github.com/vinkwork/dsh-psd-batch-studio.git
cd dsh-psd-batch-studio
npm install
```

```text
plugin_manager install_bundle, target = /absolute/path/to/dsh-psd-batch-studio
```

After installation, refresh the Harness page. A **PSD Batch Studio** icon
appears in the sidebar, and the agent gains the two tools below.

### Build artifacts

`client.js` and `server.js` are committed so an install does not need a build
step. After changing source, rebuild them:

```bash
npm install
npm run build
```

## Using the workbench

1. Open the **PSD Batch Studio** panel from the sidebar.
2. Load a `.psd` / `.psb` template. The studio lists its layers and marks the
   detected product slots with a dashed outline.
3. Confirm the slots in the layer tree: the target button toggles a slot, the eye
   button toggles whether the layer is composited. Use the search box for large
   templates.
4. Import SKU cut-outs. Select one in the queue to preview it in every slot.
5. Tune fit mode, anchor, fill, offset, scale, and rotation. **Apply to all**
   copies the current adjustment to every SKU.
6. Export the batch as JPG or PNG, with or without a ZIP.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `psd_inspect` | Template size, layer tree (name, depth, visibility, bounds, leaf id), and auto-detected slots. |
| `psd_batch_render` | Render many SKUs into one template and write JPG/PNG files (optionally a ZIP) inside the workspace. |

Example request:

```json
{
  "template": "templates/summer-main.psd",
  "skuDir": "skus/0715",
  "outDir": "out/0715-main",
  "format": "jpg",
  "fit": "contain",
  "anchor": "center",
  "adjustments": {
    "sku-001": { "dy": -14, "scale": 1.03 }
  },
  "zip": true
}
```

Both tools resolve paths relative to the session working directory and refuse
paths outside it. `psd_batch_render` defaults to JPG at quality 92 and returns
the output folder plus the first 50 file names.

## How it works

- PSD/PSB parsing uses [`ag-psd`](https://github.com/Agamnentzar/ag-psd): layer
  canvases, bounds, opacity, blend modes, masks, clipping, and layer styles.
- The compositor maps Photoshop blend modes to Canvas 2D operations and supports
  layer masks (luminance → alpha), clipping chains, solid and gradient overlays,
  drop shadows, outer glows, and an approximate stroke.
- A template is split into background runs and product slots, so a SKU image
  lands between the layers below it and the decorations above it.
- Slot clusters hide stacked copies of the same product and draw the SKU once.
- The browser and the Host renderer share `src/core/`; the Host swaps the canvas
  implementation for `@napi-rs/canvas`.

```text
src/
  core/        canvas factory, PSD parsing/compositing, fitting, export
  client/      Harness Client UI (React)
  server.js    Host batch renderer + agent tools
index.js       Host plugin entry (registers the tools)
client.js      built browser artifact
server.js      built Host artifact
```

## Compatibility and limits

- Text layers are used as rasterized PSD pixels; editing copy/fonts inside the
  studio is not supported yet.
- Bevel/emboss and inner-shadow layer styles are approximated or skipped;
  stroke/shadow/glow are approximations. The compositor is tuned for typical
  e-commerce main-image templates.
- One template is processed at a time. Multi-template × multi-SKU matrices are
  not built in; the SKU queue is kept when switching templates.
- Very large PSB files (hundreds of MB) need hundreds of MB of memory; prefer
  the desktop app or the Host batch path.
- The Host tools require `@napi-rs/canvas`; if the native package cannot load on
  a platform, the browser workbench still works but the agent tools do not.

## License and commercial use

The source is released under the **PolyForm Noncommercial License 1.0.0**. It
permits personal and other noncommercial use, modification, and noncommercial
redistribution under the same terms. Commercial use requires a separate written
license from Vinkwork.

Third-party MIT notices are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
