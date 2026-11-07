# DSH PSD Batch Studio

**[中文](README.md) | English**

> Open-sourced by the **VinkWork team** at **Genca** (缙嘉集团, 上海缙嘉科技有限公司).
> VinkWork's core product is [VinkClaw.com](https://vinkclaw.com).

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin for producing e-commerce
main images at scale: load a PSD/PSB template, mark the product slots, drop in a
batch of SKU cut-outs, fine-tune on a canvas, and export every image.

The same compositor also powers two agent tools, so the agent can inspect a
template and render a whole SKU folder headlessly.

> **License:** modified Apache License 2.0 with additional conditions.
> Commercial use is allowed; operating a multi-tenant service or removing the
> branding requires a written license. See [LICENSE](LICENSE) and
> [LICENSING.md](LICENSING.md).

## Who it is for

E-commerce design and operations teams that already build main images as PSD
templates — and need to produce many variants without repeating the same
Photoshop steps. The PSD stays the source of truth; the studio only replaces the
product pixels, keeps every decoration layer in place, and exports the result.

It is **not** a Photoshop replacement: it does not edit text, retouch photos, or
manage a DAM. It takes a template plus cut-outs and turns them into finished
main-image variants.

## Use cases

- **Campaign batches** — one template × hundreds of SKUs for 618, Double 11, Black
  Friday, or a store-wide sale; or one SKU set × several campaign templates. Switch
  the template and keep the SKU queue.
- **New product launches** — one template, many color / size / pack variants;
  re-fit each SKU in the same slots without opening Photoshop.
- **Multi-platform and multi-size sets** — square, portrait, or long-image
  templates for Tmall, JD, Douyin, Pinduoduo, or an internal catalog; switch
  templates without rebuilding the workflow.
- **Design-to-operations handoff** — designers publish the approved PSD and slot
  rules; operations, agencies, or store managers run the batch themselves.
- **Agent-driven production** — `psd_batch_render` runs unattended batches in the
  workspace for nightly jobs, catalog integrations, or “produce these 200 images
  before tomorrow” requests.
- **Template governance** — keep copy, badges, price bars, and campaign props on
  separate layers, then toggle them per campaign while the product slot stays
  stable.

A typical run:

```text
templates/summer-main.psd + skus/0715/*.png
        ↓  product-slot replacement
out/0715-main/*.jpg  (+ optional ZIP)
```

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

- DeepSeek Harness with the plugin manager, dsh `0.2.0-rc.2` or later
  (`dsh.engines.dsh >= 0.2.0-rc.2`).
  - Verified end to end on the desktop app 0.2.0-rc.2 (bundled dsh 0.2.0-rc.2,
    pnpm 11.7.0): GitHub install, cold-start activation, the workbench panel,
    both agent tools registered, and a real PSD batch.
  - dsh `0.2.1-rc.5` and `0.2.2-rc.1`: tool registration and schemas checked
    with the matching `@deepseek-ai/dsh-tools`. These releases provide the
    `workingDirectory` service, which the tools prefer for the session
    workspace; 0.2.0 has no such service, so they use the session's own
    working directory there.
  - Version 0.2.5's agent tools register on no dsh release
    ([#7](https://github.com/vinkwork/dsh-psd-batch-studio/issues/7)); do not
    use it.
- Node.js 20+ for building and for the agent tools.
- npm registry access on install: the agent tools depend on `@napi-rs/canvas`,
  which ships platform-specific prebuilt binaries.
- No Photoshop installation is required.

## Install

### From npm (recommended)

```text
plugin_manager install_bundle, target = dsh-psd-batch-studio
```

Pin a version with `dsh-psd-batch-studio@0.2.6` if you need a stable snapshot.

### From the repository

```text
plugin_manager install_bundle, target = github:vinkwork/dsh-psd-batch-studio
```

pnpm pins a GitHub dependency to the commit it installed; reinstall to pick up
later changes. Append `#branch` or `#commit` to install a specific one.

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

Run the tests:

```bash
npm test
```

`npm test` runs the self-contained smoke test (fixture PSDs in a temp folder:
compositing, slots, export), then the Host contract test. The contract test
registers every agent tool through dsh's own `@deepseek-ai/dsh-tools` checks,
pinned to 0.2.0-rc.2 (the desktop app's runtime): schemas must stay inside
dsh's supported subset, `output.render` must exist, real results must match
their output schema, and the workspace must resolve with and without the
`workingDirectory` service. Run it after touching tool parameters or results:
dsh rejects an unsupported schema at registration, which takes every tool down.

## Troubleshooting

**`ERR_PNPM_UNEXPECTED_STORE` on install.** A local environment issue, not the
plugin: the profile's `node_modules` was installed by a different pnpm major
(for example a terminal pnpm 10), while the desktop app uses its bundled pnpm 11
and the two stores cannot be mixed. Move
`~/.dsh/profiles/<profile>/node_modules` aside and reinstall from Harness. Do
not install into a profile directory with a terminal pnpm.

**The plugin installed, but the agent has no `psd_inspect` / `psd_batch_render`.**
Make sure it is not version 0.2.5, whose tool schemas dsh rejects on every
release ([#7](https://github.com/vinkwork/dsh-psd-batch-studio/issues/7)), and
upgrade. Do not keep two copies of this plugin in one profile (an old local
install plus the GitHub one, say): they share the `psd-batch-studio` entry.

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
| `psd_inspect` | Template size, layer tree (name, depth, visibility, bounds, leaf id), and auto-detected slots. Text layers also report their copy plus per-run styles (family, weight, size, color). |
| `psd_batch_render` | Render many SKUs into one template and write JPG/PNG files (optionally a ZIP) inside the workspace. The `suppressed` result lists slot siblings hidden together with the slot. |

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

Visible siblings inside a slot's group that overlap the slot by at least 25% are
hidden together with the slot (stale product art and misaligned shadow copies
are the usual offenders); otherwise the new SKU would stack on top of the old
product's pixels. Suppressed layers are reported in the `suppressed` result, and
decorations that intentionally sit on top of the product should live in another
group. Near-identical stacked copies (shadow/highlight) keep using the existing
slot-cluster logic, and the slot fit rect is never inflated by suppression.

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

## Project

- Maintained by the VinkWork team at Genca (缙嘉集团, 上海缙嘉科技有限公司).
- VinkWork's core product: <https://vinkclaw.com>
- Issues and feature requests: <https://github.com/vinkwork/dsh-psd-batch-studio/issues>
- Source: <https://github.com/vinkwork/dsh-psd-batch-studio>

## License

Copyright (c) 2026 上海缙嘉科技有限公司 (Genca). Open-sourced by the VinkWork team.

Released under a **modified Apache License 2.0** with additional conditions:

- commercial use is permitted, including internal enterprise use and use as a
  backend or application platform;
- a commercial license from 上海缙嘉科技有限公司 (Genca) is required to operate a
  multi-tenant service, or to remove/modify the copyright, project name, or
  attribution in the frontend;
- contributors agree that the producer may adjust the license and use
  contributions commercially.

The full terms are in [LICENSE](LICENSE); the unmodified Apache 2.0 text is in
[LICENSE-APACHE](LICENSE-APACHE). Versions up to v0.1.2 were released under the
PolyForm Noncommercial License 1.0.0; those releases remain under their original
terms. Third-party MIT notices are in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
