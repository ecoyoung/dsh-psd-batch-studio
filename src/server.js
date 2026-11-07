/**
 * Host-side batch renderer and the agent tools built on it.
 *
 * The same compositor (`psd.js`, `fit.js`) that powers the browser workbench
 * runs here on a native canvas, so the agent can inspect a PSD template and
 * render a whole SKU folder without opening the page.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { initializeCanvas } from 'ag-psd'
import { zipSync } from 'fflate'
import { setCanvasFactory } from './core/canvas.js'
import { parseTemplate, buildScene, suggestSlots, isEntryVisible, isLeafVisible } from './core/psd.js'
import { drawScene, measureContent, DEFAULT_SETTINGS, DEFAULT_ADJUST } from './core/fit.js'
import { sanitizeName, uniqueName } from './core/export.js'

setCanvasFactory((width, height) => createCanvas(width, height))
initializeCanvas((width, height) => createCanvas(width, height))

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])

const templateCache = new Map()

async function resolveInWorkspace(cwd, candidate, { mustExist = true } = {}) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error('A non-empty path is required')
  }
  const absolute = path.resolve(cwd, candidate)
  const relative = path.relative(cwd, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path must stay inside the session workspace: ${candidate}`)
  }
  if (mustExist) {
    let real
    try {
      real = await fs.realpath(absolute)
    } catch {
      throw new Error(`Path does not exist: ${candidate}`)
    }
    const realRelative = path.relative(cwd, real)
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error(`Path resolves outside the session workspace: ${candidate}`)
    }
    return real
  }
  return absolute
}

async function loadTemplateDoc(absolutePath) {
  const stat = await fs.stat(absolutePath)
  const cached = templateCache.get(absolutePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.doc

  const buffer = await fs.readFile(absolutePath)
  const doc = await parseTemplate({
    name: path.basename(absolutePath),
    size: stat.size,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  })
  if (templateCache.size >= 2) templateCache.delete(templateCache.keys().next().value)
  templateCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, doc })
  return doc
}

function resolveSlots(doc, specs) {
  const ids = []
  for (const spec of specs) {
    if (/^l\d+$/.test(spec) && doc.leaves.some((leaf) => leaf.id === spec)) {
      ids.push(spec)
      continue
    }
    const matches = doc.leaves.filter((leaf) => leaf.name === spec)
    if (matches.length === 0) {
      const names = doc.leaves.map((leaf) => leaf.name)
      throw new Error(`Layer not found: ${spec}. Pixel layers: ${names.join(' | ')}`)
    }
    if (matches.length > 1) {
      const visible = matches.filter((leaf) => isLeafVisible(doc, leaf))
      if (visible.length === 1) {
        ids.push(visible[0].id)
        continue
      }
      throw new Error(
        `Layer name is ambiguous (${matches.length} matches): ${spec}. Use one of the layer ids: ${matches
          .map((leaf) => leaf.id)
          .join(', ')}`,
      )
    }
    ids.push(matches[0].id)
  }
  return ids
}

function slotSummary(doc, ids) {
  return ids.map((id) => {
    const leaf = doc.leaves.find((item) => item.id === id)
    return {
      name: leaf.name,
      leafId: leaf.id,
      bounds: [leaf.left, leaf.top, leaf.left + leaf.width, leaf.top + leaf.height],
    }
  })
}

function toAdjustment(raw) {
  const adjust = { ...DEFAULT_ADJUST }
  if (!raw || typeof raw !== 'object') return adjust
  for (const key of ['dx', 'dy', 'scale', 'rotation']) {
    const value = Number(raw[key])
    if (Number.isFinite(value)) adjust[key] = value
  }
  return adjust
}

/** One line per text layer (first 12), so the agent sees copy before rendering. */
function describeTextLayers(layers) {
  const lines = layers
    .filter((layer) => layer.textContent != null)
    .slice(0, 12)
    .map((layer) => {
      const run = (layer.runs || [])[0]
      const font = run ? ` ${run.family || '?'} ${run.size}pt` : ''
      return `  ${layer.name}: ${JSON.stringify(layer.textContent)}${font}`
    })
  return lines.length ? `\nText layers:\n${lines.join('\n')}` : ''
}

async function listSkuFiles(cwd, { skus, skuDir }) {
  const files = []
  if (Array.isArray(skus)) {
    for (const entry of skus) files.push(await resolveInWorkspace(cwd, entry))
  }
  if (skuDir) {
    const directory = await resolveInWorkspace(cwd, skuDir)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))) {
      if (!entry.isFile()) continue
      if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      files.push(path.join(directory, entry.name))
    }
  }
  return files
}

/** Inspect a template: dimensions, layer tree, auto-detected product slots. */
export async function inspectTemplate({ cwd, template }) {
  const absolute = await resolveInWorkspace(cwd, template)
  const doc = await loadTemplateDoc(absolute)
  const layerLimit = 400
  const layers = doc.entries
    .filter((entry) => entry.kind === 'group' || entry.leafId)
    .slice(0, layerLimit)
    .map((entry) => {
      const layer = {
        name: entry.name,
        kind: entry.kind,
        depth: entry.depth,
        visible: isEntryVisible(doc, entry.id),
      }
      if (entry.leafId) layer.leafId = entry.leafId
      if (entry.kind === 'text') layer.text = true
      if (entry.text) {
        layer.textContent = entry.text.value
        layer.runCount = entry.text.runs.length
        if (entry.text.runs.length) {
          layer.runs = entry.text.runs
            .slice(0, 8)
            .map(({ family, ...run }) => (family ? { ...run, family } : run))
          layer.runsTruncated = entry.text.runs.length > 8
        }
      }
      if (entry.bounds) layer.bounds = entry.bounds
      return layer
    })

  const suggestedIds = suggestSlots(doc)
  return {
    name: doc.name,
    width: doc.width,
    height: doc.height,
    layers,
    truncated: doc.entries.length > layerLimit,
    suggestedSlots: slotSummary(doc, suggestedIds),
  }
}

/**
 * Render one template with many SKU images into an output directory.
 *
 * @returns {{count:number,outDir:string,files:string[],truncated:boolean,slots:object[],zip?:string}}
 */
export async function renderBatch({
  cwd,
  template,
  skus = [],
  skuDir,
  slots = [],
  outDir,
  format = 'jpg',
  quality = 92,
  fit = 'contain',
  anchor = 'center',
  fill = 1,
  adjustments = {},
  zip = false,
}) {
  const absolute = await resolveInWorkspace(cwd, template)
  const doc = await loadTemplateDoc(absolute)

  const slotIds = slots.length > 0 ? resolveSlots(doc, slots) : suggestSlots(doc)
  if (slotIds.length === 0) {
    throw new Error(
      'No product slot was detected. Inspect the layer tree and pass one or more slot layer names.',
    )
  }
  doc.slots = new Set(slotIds)
  doc.scene = buildScene(doc)

  const skuFiles = await listSkuFiles(cwd, { skus, skuDir })
  if (skuFiles.length === 0) {
    throw new Error('No SKU images were found. Pass `skus` paths or a `skuDir` folder.')
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relativeOut = outDir || path.join('out', 'psd-batch', `${sanitizeName(doc.name)}-${stamp}`)
  const absoluteOut = await resolveInWorkspace(cwd, relativeOut, { mustExist: false })
  await fs.mkdir(absoluteOut, { recursive: true })

  const isPng = format === 'png'
  const mime = isPng ? 'image/png' : 'image/jpeg'
  const extension = isPng ? 'png' : 'jpg'
  const settings = {
    mode: fit || DEFAULT_SETTINGS.mode,
    anchor: anchor || DEFAULT_SETTINGS.anchor,
    fill: Number.isFinite(Number(fill)) ? Number(fill) : DEFAULT_SETTINGS.fill,
  }

  const used = new Set()
  const files = []
  const zipEntries = {}

  for (const file of skuFiles) {
    const image = await loadImage(file)
    const content = measureContent(image)
    const base = path.basename(file, path.extname(file))
    const adjust = toAdjustment(adjustments[path.basename(file)] ?? adjustments[base])

    const canvas = createCanvas(doc.width, doc.height)
    const ctx = canvas.getContext('2d')
    if (!isPng) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, doc.width, doc.height)
    }
    drawScene(ctx, doc.scene, image, content, settings, adjust)

    const buffer = canvas.toBuffer(mime, isPng ? undefined : Math.round(quality))
    const name = uniqueName(used, sanitizeName(base), extension)
    await fs.writeFile(path.join(absoluteOut, name), buffer)
    files.push(name)
    if (zip) zipEntries[name] = new Uint8Array(buffer)
  }

  let zipPath
  if (zip) {
    const data = zipSync(zipEntries, { level: 0 })
    zipPath = path.join(absoluteOut, `${sanitizeName(doc.name)}-${files.length}.zip`)
    await fs.writeFile(zipPath, data)
  }

  return {
    count: files.length,
    outDir: path.relative(cwd, absoluteOut) || '.',
    files: files.slice(0, 50),
    truncated: files.length > 50,
    slots: doc.scene.slots.map((slot) => ({
      name: slot.name,
      leafId: slot.leafId,
      bounds: [slot.rect.x, slot.rect.y, slot.rect.x + slot.rect.w, slot.rect.y + slot.rect.h],
    })),
    suppressed: doc.scene.suppressed.slice(0, 50),
    suppressedCount: doc.scene.suppressed.length,
    suppressedTruncated: doc.scene.suppressed.length > 50,
    ...(zipPath ? { zip: path.relative(cwd, zipPath) } : {}),
  }
}

/**
 * The calling session's workspace, which every relative path is anchored at.
 *
 * dsh >= 0.2.1 provides a `workingDirectory` service (what its own fs tools
 * use); dsh 0.2.0 does not, and its fs tools read the session header instead.
 * The service is read through `ctx.reflect.get`, which returns undefined when
 * nothing provides it, because touching an undeclared service on `ctx` throws.
 */
async function resolveSessionCwd(ctx, exec) {
  const service = ctx.reflect?.get?.('workingDirectory')
  if (service && typeof service.ensure === 'function') {
    return service.ensure(exec.agent, exec.signal)
  }
  const cwd = exec.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return cwd
  throw new Error('This session has no workspace directory; open a workspace and try again')
}

/**
 * Register the agent tools for this Host plugin.
 *
 * @param ctx - Host context providing `tools` (and, on dsh >= 0.2.1, a
 *   `workingDirectory` service looked up per call, see `resolveSessionCwd`).
 * @returns disposer removing every tool registration.
 */
export function registerTools(ctx) {
  const disposers = []

  disposers.push(
    ctx.tools.register({
      name: 'psd_inspect',
      description:
        'Inspect a PSD/PSB main-image template inside the session workspace. Returns its size, the layer tree (names, depth, visibility, bounds, ids), product slots the studio would auto-detect, and — for text layers — the copy plus per-run font styles (family, weight, size, color). Use this before psd_batch_render when you need to choose slot layers or check what a text layer says.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template'],
        properties: {
          template: {
            type: 'string',
            description: 'PSD or PSB path relative to the session working directory.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'width', 'height', 'layers', 'suggestedSlots'],
          properties: {
            name: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            truncated: { type: 'boolean' },
            layers: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'kind', 'depth', 'visible'],
                properties: {
                  name: { type: 'string' },
                  kind: { type: 'string' },
                  depth: { type: 'integer' },
                  visible: { type: 'boolean' },
                  text: { type: 'boolean' },
                  leafId: { type: 'string' },
                  bounds: { type: 'array', items: { type: 'integer' } },
                  textContent: { type: 'string' },
                  runs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['len'],
                      properties: {
                        len: { type: 'integer' },
                        // dsh only accepts one type per schema node; a run
                        // without a font name simply omits `family`.
                        family: { type: 'string' },
                        weight: { type: 'integer' },
                        size: { type: 'number' },
                        color: { type: 'array', items: { type: 'integer' } },
                        tracking: { type: 'number' },
                      },
                    },
                  },
                  runCount: { type: 'integer' },
                  runsTruncated: { type: 'boolean' },
                },
              },
            },
            suggestedSlots: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'leafId', 'bounds'],
                properties: {
                  name: { type: 'string' },
                  leafId: { type: 'string' },
                  bounds: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `${value.name}: ${value.width}×${value.height}, ${value.layers.length} listed layers.\nAuto slots: ${
              value.suggestedSlots.map((slot) => `${slot.name} [${slot.bounds.join(',')}]`).join(' | ') ||
              'none'
            }${describeTextLayers(value.layers)}`,
          },
        ],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_inspect requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        return inspectTemplate({ cwd, template: args.template })
      },
      isConcurrencySafe: () => false,
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'psd_batch_render',
      description:
        'Render a PSD/PSB main-image template with many SKU images at once. Each SKU image is trimmed to its visible content, fitted into the product slots, composited between the template layers, and written as JPG/PNG into a workspace folder. Visible sibling layers that overlap a slot are suppressed together with the slot (reported as `suppressed`) so stale product art cannot show through. Returns the output folder and file names; optionally packs a ZIP.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template'],
        properties: {
          template: {
            type: 'string',
            description: 'PSD or PSB path relative to the session working directory.',
          },
          skus: {
            type: 'array',
            items: { type: 'string' },
            description: 'SKU image paths (PNG/JPG/WebP) relative to the working directory.',
          },
          skuDir: {
            type: 'string',
            description: 'Directory of SKU images to use instead of listing every file.',
          },
          slots: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Product slot layer names or leaf ids. Omit to use the auto-detected slots reported by psd_inspect.',
          },
          outDir: {
            type: 'string',
            description: 'Output folder relative to the working directory. Defaults to out/psd-batch/<template>-<time>.',
          },
          format: { type: 'string', enum: ['jpg', 'png'], description: 'Output format. Default jpg.' },
          quality: { type: 'integer', description: 'JPEG quality 1-100. Default 92.' },
          fit: {
            type: 'string',
            enum: ['contain', 'height', 'width', 'cover'],
            description: 'How the SKU content is fitted into a slot. Default contain.',
          },
          anchor: {
            type: 'string',
            enum: ['bottom', 'center', 'top'],
            description: 'Vertical anchor inside the slot. Default center.',
          },
          fill: { type: 'number', description: 'Scale multiplier applied after fitting, e.g. 0.9. Default 1.' },
          adjustments: {
            type: 'object',
            additionalProperties: true,
            description:
              'Optional per-SKU tweaks keyed by file name with or without extension: {"01-a.png":{"dx":12,"dy":-8,"scale":1.05,"rotation":0}}.',
          },
          zip: { type: 'boolean', description: 'Also pack every output into a ZIP. Default false.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'outDir', 'files', 'slots', 'suppressed', 'suppressedCount', 'suppressedTruncated'],
          properties: {
            count: { type: 'integer' },
            outDir: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            truncated: { type: 'boolean' },
            zip: { type: 'string' },
            slots: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'leafId', 'bounds'],
                properties: {
                  name: { type: 'string' },
                  leafId: { type: 'string' },
                  bounds: { type: 'array', items: { type: 'integer' } },
                },
              },
            },
            suppressed: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'leafId'],
                properties: {
                  name: { type: 'string' },
                  leafId: { type: 'string' },
                },
              },
            },
            suppressedCount: { type: 'integer' },
            suppressedTruncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Rendered ${value.count} image(s) into ${value.outDir} using ${value.slots
              .map((slot) => slot.name)
              .join(', ')}${
              value.suppressed && value.suppressed.length
                ? `\nSuppressed overlapping slot siblings (hidden with the slot): ${value.suppressed
                    .map((layer) => layer.name)
                    .join(', ')}${
                    value.suppressedTruncated ? ` (+${value.suppressedCount - value.suppressed.length} more)` : ''
                  }`
                : ''
            }${value.zip ? `\nZIP: ${value.zip}` : ''}`,
          },
        ],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_batch_render requires an agent session')
        const cwd = await resolveSessionCwd(ctx, exec)
        return renderBatch({
          cwd,
          template: args.template,
          skus: args.skus,
          skuDir: args.skuDir,
          slots: args.slots,
          outDir: args.outDir,
          format: args.format,
          quality: args.quality,
          fit: args.fit,
          anchor: args.anchor,
          fill: args.fill,
          adjustments: args.adjustments,
          zip: args.zip,
        })
      },
      timeoutMs: 20 * 60 * 1000,
      isConcurrencySafe: () => false,
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}
