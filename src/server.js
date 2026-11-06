/**
 * Host-side batch renderer and the agent tools built on it.
 *
 * The same compositor (`psd.js`, `fit.js`) that powers the browser workbench
 * runs here on a native canvas, so the agent can inspect a PSD template and
 * render a whole SKU folder without opening the page.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import { initializeCanvas } from 'ag-psd'
import { zipSync } from 'fflate'
import { setCanvasFactory } from './core/canvas.js'
import { parseTemplate, buildScene, suggestSlots, isEntryVisible, isLeafVisible } from './core/psd.js'
import { drawScene, measureContent, DEFAULT_SETTINGS, DEFAULT_ADJUST } from './core/fit.js'
import { sanitizeName, uniqueName } from './core/export.js'
import {
  setFontFaceInstaller,
  markFontRegistered,
  registeredFonts,
  templateFamilies,
  unregisteredFamilies,
  readFontPostScriptName,
} from './core/text.js'

setCanvasFactory((width, height) => createCanvas(width, height))
initializeCanvas((width, height) => createCanvas(width, height))

// Host-side fonts come from files; the browser installer lives in the page.
setFontFaceInstaller((family, filePath) => GlobalFonts.registerFromPath(filePath, family))

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
          layer.runs = entry.text.runs.slice(0, 8)
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

/** Resolve a text layer by entry id, leaf id or layer name. */
function findTextEntry(doc, spec) {
  const wanted = String(spec || '').trim()
  if (!wanted) throw new Error('A text layer name or id is required')
  const byId = doc.entries.find((entry) => entry.id === wanted || entry.leafId === wanted)
  if (byId && byId.text) return byId
  const matches = doc.entries.filter((entry) => entry.name === wanted && entry.text)
  if (matches.length === 0) {
    const names = doc.entries.filter((entry) => entry.text).map((entry) => entry.name)
    throw new Error(`Text layer not found: ${wanted}. Text layers: ${names.join(' | ')}`)
  }
  if (matches.length > 1) {
    throw new Error(
      `Text layer name is ambiguous (${matches.length} matches): ${wanted}. Use one of: ${matches
        .map((entry) => entry.id)
        .join(', ')}`,
    )
  }
  return matches[0]
}

function normalizeColor(raw) {
  if (Array.isArray(raw) && raw.length >= 3) {
    return raw.slice(0, 3).map((value) => Math.max(0, Math.min(255, Math.round(Number(value) || 0))))
  }
  if (typeof raw === 'string') {
    const hex = raw.replace('#', '')
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
    }
  }
  return null
}

/**
 * Normalise per-run styles.
 *
 * Callers speak pixels (`sizePx`), because that is what a design spec carries;
 * the repaint kernel converts back to points through the layer box.
 */
function normalizeRuns(raw, fallback) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const runs = []
  for (const item of raw) {
    const length = Math.max(0, Math.round(Number(item && item.len)))
    if (!length) continue
    const run = { len: length }
    if (item.family) run.family = String(item.family)
    if (item.weight) run.weight = Number(item.weight)
    if (item.sizePx) run.size = Number(item.sizePx)
    else if (item.size) run.size = Number(item.size)
    const color = normalizeColor(item.color)
    if (color) run.color = color
    if (item.tracking != null) run.tracking = Number(item.tracking)
    runs.push({ ...fallback, ...run })
  }
  return runs.length ? runs : null
}

/** Scale, rotate and return a canvas for a placed element. */
function composeElement(image, { scale = 1, rotation = 0 } = {}) {
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  if (!rotation) {
    const canvas = createCanvas(width, height)
    canvas.getContext('2d').drawImage(image, 0, 0, width, height)
    return canvas
  }
  const radians = (rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  const canvas = createCanvas(Math.ceil(width * cos + height * sin), Math.ceil(width * sin + height * cos))
  const ctx = canvas.getContext('2d')
  ctx.translate(canvas.width / 2, canvas.height / 2)
  ctx.rotate(radians)
  ctx.drawImage(image, -width / 2, -height / 2, width, height)
  return canvas
}

async function registerFontFiles(cwd, { dir, paths }) {
  const files = []
  if (dir) {
    const directory = await resolveInWorkspace(cwd, dir)
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile()) continue
      if (!/\.(ttf|otf|ttc|otc|woff2?)$/i.test(entry.name)) continue
      files.push(path.join(directory, entry.name))
    }
  }
  for (const item of paths || []) files.push(await resolveInWorkspace(cwd, item))
  if (files.length === 0) throw new Error('Pass `dir` or `paths` with font files to register')

  const loaded = []
  const failed = []
  for (const file of files) {
    const stem = path.basename(file, path.extname(file)).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
    const aliases = new Set([stem])
    try {
      const buffer = await fs.readFile(file)
      const postScript = readFontPostScriptName(buffer)
      if (postScript) aliases.add(postScript)
    } catch { /* 读不到 name 表就只用文件名 */ }
    let ok = false
    for (const alias of aliases) {
      try {
        if (GlobalFonts.registerFromPath(file, alias)) {
          markFontRegistered(alias)
          ok = true
        }
      } catch (error) {
        if (alias === stem) failed.push(`${alias}: ${String((error && error.message) || error).slice(0, 80)}`)
      }
    }
    if (ok) loaded.push(...aliases)
  }
  return { loaded: [...new Set(loaded)], failed }
}

function serializeProject(doc, template) {
  const textEdits = {}
  for (const [entryId, edit] of doc.textEdits || []) textEdits[entryId] = edit
  return {
    version: 1,
    template,
    slots: [...(doc.slots || [])],
    textEdits,
    elements: (doc.elements || []).map((element) => ({
      name: element.name,
      source: element.source,
      left: element.left,
      top: element.top,
      scale: element.scale,
      rotation: element.rotation,
      opacity: element.opacity,
      blend: element.blend,
      aboveSlots: element.aboveSlots,
    })),
    fonts: registeredFonts(),
  }
}

async function applyProject(doc, cwd, project) {
  doc.textEdits = new Map(Object.entries(project.textEdits || {}))
  doc.elements = []
  for (const element of project.elements || []) {
    if (!element.source) continue
    const file = await resolveInWorkspace(cwd, element.source)
    const image = await loadImage(file)
    doc.elements.push({
      ...element,
      canvas: composeElement(image, { scale: element.scale || 1, rotation: element.rotation || 0 }),
    })
  }
  if (Array.isArray(project.slots)) doc.slots = new Set(project.slots)
  return doc
}

/**
 * Edit a template in place: copy, per-run styles, placed elements, fonts and
 * the project file. Everything lands on the cached document, so a following
 * psd_batch_render picks it up without re-parsing the PSD.
 */
export async function editTemplate(options) {
  const { cwd, template, action } = options
  if (!action) throw new Error('An action is required')
  const absolute = await resolveInWorkspace(cwd, template)
  const doc = await loadTemplateDoc(absolute)

  if (action === 'status') {
    return {
      template: path.relative(cwd, absolute) || template,
      slots: [...(doc.slots || [])],
      textEdits: [...(doc.textEdits || new Map()).keys()],
      elements: (doc.elements || []).map((element) => element.name),
      fonts: registeredFonts(),
      neededFonts: templateFamilies(doc),
      missingFonts: unregisteredFamilies(doc),
    }
  }

  if (action === 'text') {
    const entry = findTextEntry(doc, options.layer)
    const edit = { ...(doc.textEdits.get(entry.id) || {}) }
    if (options.text !== undefined) edit.value = String(options.text)
    if (options.align) edit.align = String(options.align)
    if (options.leading != null) edit.leading = Number(options.leading)
    if (options.dx != null) edit.dx = Number(options.dx)
    if (options.dy != null) edit.dy = Number(options.dy)
    if (options.tracking != null) edit.tracking = Number(options.tracking)

    const baseRun = {
      family: options.family || entry.text.runs[0].family,
      weight: Number(options.weight) || entry.text.runs[0].weight,
      size: Number(options.sizePx) || entry.text.runs[0].size,
      color: normalizeColor(options.color) || entry.text.runs[0].color,
      tracking: options.tracking != null ? Number(options.tracking) : entry.text.runs[0].tracking,
    }
    const runs = normalizeRuns(options.runs, baseRun)
    if (runs) {
      edit.runs = runs
    } else if (options.family || options.sizePx || options.weight || options.color) {
      // Whole-layer restyle keeps the original run split, so per-character
      // colour or size differences survive a font swap.
      edit.runs = entry.text.runs.map((run) => ({ ...run, ...baseRun }))
    }
    if (options.value !== undefined && !edit.runs) {
      edit.runs = [{ len: String(options.text).length, ...baseRun }]
    }

    const missing = (edit.runs || entry.text.runs)
      .map((run) => run.family)
      .filter((family) => family && !registeredFonts().includes(family))
    doc.textEdits.set(entry.id, edit)
    return {
      layer: entry.name,
      entryId: entry.id,
      value: edit.value !== undefined ? edit.value : entry.text.value,
      runs: (edit.runs || entry.text.runs).length,
      warning: missing.length
        ? `Font not registered, the canvas will fall back: ${[...new Set(missing)].join(', ')}`
        : undefined,
    }
  }

  if (action === 'element') {
    const files = []
    for (const item of options.paths || []) files.push(await resolveInWorkspace(cwd, item))
    if (files.length === 0) throw new Error('Pass `paths` with one or more images')
    const placed = []
    for (const file of files) {
      const image = await loadImage(file)
      const scale = Number(options.scale) > 0 ? Number(options.scale) : 1
      const rotation = Number(options.rotation) || 0
      const canvas = composeElement(image, { scale, rotation })
      const element = {
        name: options.name ? String(options.name) : path.basename(file, path.extname(file)),
        source: path.relative(cwd, file),
        canvas,
        left: Number(options.dx) || 0,
        top: Number(options.dy) || 0,
        scale,
        rotation,
        opacity: options.opacity == null ? 1 : Math.max(0, Math.min(1, Number(options.opacity))),
        blend: options.blend || 'normal',
        aboveSlots: options.aboveSlots !== false,
      }
      doc.elements.push(element)
      placed.push({ name: element.name, left: element.left, top: element.top, w: canvas.width, h: canvas.height })
    }
    return { placed, total: doc.elements.length }
  }

  if (action === 'remelement') {
    const names = (options.names || []).map(String)
    if (names.length === 0) throw new Error('Pass `names` with the elements to remove')
    const before = doc.elements.length
    doc.elements = doc.elements.filter((element) => !names.includes(element.name))
    const removed = before - doc.elements.length
    return { removed, total: doc.elements.length, names: doc.elements.map((element) => element.name) }
  }

  if (action === 'fonts') {
    // `paths` is what every other action uses; `fonts` reads better on its own.
    const result = await registerFontFiles(cwd, { dir: options.dir, paths: options.paths || options.fonts })
    return {
      ...result,
      registered: registeredFonts(),
      missingFonts: unregisteredFamilies(doc),
    }
  }

  if (action === 'save_project') {
    if (!options.project) throw new Error('Pass `project` with the JSON path to write')
    const projectPath = await resolveInWorkspace(cwd, options.project, { mustExist: false })
    await fs.mkdir(path.dirname(projectPath), { recursive: true })
    const data = serializeProject(doc, path.relative(cwd, absolute))
    await fs.writeFile(projectPath, JSON.stringify(data, null, 2))
    return { project: path.relative(cwd, projectPath), textEdits: Object.keys(data.textEdits).length, elements: data.elements.length }
  }

  if (action === 'load_project') {
    if (!options.project) throw new Error('Pass `project` with the JSON path to read')
    const projectPath = await resolveInWorkspace(cwd, options.project)
    const project = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    await applyProject(doc, cwd, project)
    return {
      project: path.relative(cwd, projectPath),
      textEdits: doc.textEdits.size,
      elements: doc.elements.length,
      slots: [...doc.slots],
    }
  }

  if (action === 'reset') {
    doc.textEdits = new Map()
    doc.elements = []
    return { ok: true, textEdits: 0, elements: 0 }
  }

  throw new Error(`Unknown action: ${action}. Use status / text / element / remelement / fonts / save_project / load_project / reset`)
}

/**
 * Register the agent tools for this Host plugin.
 *
 * @param ctx - Host context providing `tools` and `workingDirectory`.
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
                        family: { type: ['string', 'null'] },
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
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
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
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
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

  disposers.push(
    ctx.tools.register({
      name: 'psd_edit',
      description:
        'Edit a loaded PSD/PSB template before rendering: rewrite a text layer (whole layer or per-run styles, so a price line can mix two fonts and colours), place extra image layers on top of or below the product slot, register font files, and save or load the project so edits survive between sessions. Edits land on the cached document, so a following psd_batch_render uses them without re-parsing the PSD.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['template', 'action'],
        properties: {
          template: {
            type: 'string',
            description: 'PSD or PSB path relative to the session working directory.',
          },
          action: {
            type: 'string',
            enum: [
              'status',
              'text',
              'element',
              'remelement',
              'fonts',
              'save_project',
              'load_project',
              'reset',
            ],
            description:
              'status: current edits, fonts and missing fonts. text: rewrite a text layer. element / remelement: add or remove placed images. fonts: register font files. save_project / load_project: persist edits. reset: drop every edit.',
          },
          layer: {
            type: 'string',
            description: 'Text layer name, entry id (e12) or leaf id (l3). Required for action=text.',
          },
          text: {
            type: 'string',
            description: 'New copy. Keep the run lengths in step when you also pass `runs`.',
          },
          runs: {
            type: 'array',
            description:
              'Per-run styles, one entry per contiguous character group with its `len`. Use it when one line mixes fonts, sizes or colours, e.g. [{len:1},{len:1,sizePx:138,color:"#CC3046"},{len:2}]. Omitted fields inherit the layer base style.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                len: { type: 'number', description: 'Character count of this run.' },
                family: { type: 'string', description: 'Font family to use for the run.' },
                weight: { type: 'number', description: 'Font weight, 100-900.' },
                sizePx: { type: 'number', description: 'Font size in canvas pixels.' },
                color: { type: 'string', description: 'Fill colour as #rrggbb.' },
                tracking: { type: 'number', description: 'Letter spacing in points.' },
              },
            },
          },
          family: { type: 'string', description: 'Restyle the whole layer with this font family.' },
          weight: { type: 'number', description: 'Restyle the whole layer with this weight.' },
          sizePx: { type: 'number', description: 'Restyle the whole layer with this size in canvas pixels.' },
          color: { type: 'string', description: 'Restyle the whole layer with this fill colour (#rrggbb).' },
          tracking: { type: 'number', description: 'Letter spacing, points.' },
          align: {
            type: 'string',
            enum: ['left', 'center', 'right'],
            description: 'Paragraph alignment for the repainted layer.',
          },
          leading: { type: 'number', description: 'Line height in points. Omit to keep the PSD value.' },
          dx: { type: 'number', description: 'Horizontal nudge in canvas pixels.' },
          dy: { type: 'number', description: 'Vertical nudge in canvas pixels.' },
          paths: {
            type: 'array',
            description: 'Images to place (relative paths). Required for action=element.',
            items: { type: 'string' },
          },
          name: { type: 'string', description: 'Element name. Defaults to the file name.' },
          scale: { type: 'number', description: 'Element scale, 1 = original size.' },
          rotation: { type: 'number', description: 'Element rotation in degrees.' },
          opacity: { type: 'number', description: 'Element opacity, 0-1.' },
          blend: { type: 'string', description: 'Blend mode, e.g. multiply / screen / overlay.' },
          aboveSlots: {
            type: 'boolean',
            description: 'Draw the element above the product slot (default true). Set false to sit under it.',
          },
          names: {
            type: 'array',
            description: 'Element names to remove (action=remelement).',
            items: { type: 'string' },
          },
          dir: { type: 'string', description: 'Folder of font files to register (action=fonts).' },
          fonts: {
            type: 'array',
            description: 'Font files to register (action=fonts).',
            items: { type: 'string' },
          },
          project: {
            type: 'string',
            description: 'Project JSON path for action=save_project / load_project.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
        },
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('psd_edit requires an agent session')
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        return editTemplate({ cwd, ...args })
      },
      timeoutMs: 5 * 60 * 1000,
      isConcurrencySafe: () => false,
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}
