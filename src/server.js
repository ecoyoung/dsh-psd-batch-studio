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
import { parseTemplate, buildScene, disposeScene, suggestSlots, isEntryVisible, isLeafVisible } from './core/psd.js'
import {
  applyTextOverrides,
  cloneDoc,
  mergeOverrideLists,
  mergeTextOverride,
  pxPerPtOf,
  fontFamilyOf,
  readFontPostScriptName,
} from './core/text.js'
import { drawScene, measureContent, DEFAULT_SETTINGS, DEFAULT_ADJUST } from './core/fit.js'
import { sanitizeName, uniqueName } from './core/export.js'

setCanvasFactory((width, height) => createCanvas(width, height))
initializeCanvas((width, height) => createCanvas(width, height))

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2'])

const templateCache = new Map()

/** Every family name this process registered, for status and project files. */
const registeredFamilies = new Set()

/**
 * Register font files under every name a text layer may ask for: the file
 * stem, the PostScript name from the font's name table (what PSD styles
 * carry), and the mapped system family ("SourceHanSansCN-Bold" → "Noto Sans
 * SC"). `dir` may be a folder or a single file; `paths` lists files.
 */
async function registerFonts(cwd, { dir, paths } = {}) {
  const files = []
  if (dir) {
    const absolute = await resolveInWorkspace(cwd, dir)
    const stat = await fs.stat(absolute)
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolute, { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile()) files.push(path.join(absolute, entry.name))
      }
    } else {
      files.push(absolute)
    }
  }
  for (const item of paths || []) files.push(await resolveInWorkspace(cwd, item))

  const registered = []
  const skipped = []
  for (const full of files) {
    const extension = path.extname(full).toLowerCase()
    if (!FONT_EXTENSIONS.has(extension)) {
      skipped.push(path.basename(full))
      continue
    }
    const stem = path.basename(full, extension).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'font'
    const aliases = [stem]
    try {
      const postScript = readFontPostScriptName(await fs.readFile(full))
      if (postScript) aliases.push(postScript)
    } catch {
      /* unreadable name table: the file stem still works */
    }
    for (const alias of [...aliases]) {
      const mapped = fontFamilyOf(alias)
      if (mapped && !aliases.includes(mapped) && !GlobalFonts.has(mapped)) aliases.push(mapped)
    }
    let ok = false
    for (const alias of new Set(aliases)) {
      try {
        if (GlobalFonts.registerFromPath(full, alias) !== false) {
          registered.push(alias)
          registeredFamilies.add(alias)
          ok = true
        }
      } catch {
        /* this alias is taken by another face */
      }
    }
    if (!ok) skipped.push(path.basename(full))
  }
  return { registered: [...new Set(registered)], skipped }
}

/** Families a template's text layers (and its text edits) ask for. */
function templateFamilies(doc) {
  const families = new Set()
  for (const entry of doc.entries) {
    for (const run of entry.text?.runs || []) if (run.family) families.add(run.family)
  }
  for (const edit of doc.textEdits?.values() || []) {
    if (edit.font) families.add(String(edit.font))
    for (const run of edit.runs || []) if (run.family) families.add(String(run.family))
  }
  return [...families].sort()
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolve a workspace path. Reads follow symlinks and must land inside the
 * workspace. Writes (`mustExist: false`) check the real path of the target
 * when it exists (a symlink must not lead out) and of its nearest existing
 * ancestor, so a linked folder cannot redirect output elsewhere either.
 */
async function resolveInWorkspace(cwd, candidate, { mustExist = true } = {}) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error('A non-empty path is required')
  }
  const absolute = path.resolve(cwd, candidate)
  if (!isInside(cwd, absolute)) {
    throw new Error(`Path must stay inside the session workspace: ${candidate}`)
  }
  const realCwd = await fs.realpath(cwd).catch(() => cwd)
  const insideWorkspace = (real) => isInside(cwd, real) || isInside(realCwd, real)
  const outside = () => new Error(`Path resolves outside the session workspace: ${candidate}`)

  if (mustExist) {
    let real
    try {
      real = await fs.realpath(absolute)
    } catch {
      throw new Error(`Path does not exist: ${candidate}`)
    }
    if (!insideWorkspace(real)) throw outside()
    return real
  }

  const link = await fs.lstat(absolute).catch(() => null)
  if (link) {
    // A dangling link would make the write create its target, wherever it is.
    const real = await fs.realpath(absolute).catch(() => null)
    if (!real || !insideWorkspace(real)) throw outside()
  }
  let ancestor = path.dirname(absolute)
  for (;;) {
    const real = await fs.realpath(ancestor).catch(() => null)
    if (real) {
      if (!insideWorkspace(real)) throw outside()
      break
    }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  return absolute
}

/**
 * psd_edit state per template path. It lives outside the parse cache, which
 * only keeps two documents: looking at other templates must not throw away
 * unsaved edits. The state is dropped only when the PSD itself changes on
 * disk, because its layer ids may no longer mean the same layers.
 */
const editStates = new Map()

function editStateFor(absolutePath, stat) {
  let state = editStates.get(absolutePath)
  if (state && (state.mtimeMs !== stat.mtimeMs || state.size !== stat.size)) {
    const hadEdits = state.textEdits.size > 0 || state.elements.length > 0 || !!state.pinnedSlots
    state = { ...freshEditState(stat), dropped: hadEdits ? 'template changed on disk since the edits were made' : undefined }
    editStates.set(absolutePath, state)
  }
  if (!state) {
    state = freshEditState(stat)
    editStates.set(absolutePath, state)
  }
  return state
}

function freshEditState(stat) {
  return { mtimeMs: stat.mtimeMs, size: stat.size, textEdits: new Map(), elements: [], pinnedSlots: null }
}

/** Expose the path's edit state as doc.textEdits / elements / pinnedSlots. */
function attachEditState(doc, absolutePath) {
  if (doc.__editPath === absolutePath) return
  Object.defineProperty(doc, '__editPath', { value: absolutePath, enumerable: false })
  for (const key of ['textEdits', 'elements', 'pinnedSlots']) {
    // Enumerable, so cloneDoc's spread carries the current values along.
    Object.defineProperty(doc, key, {
      enumerable: true,
      configurable: true,
      get: () => editStates.get(absolutePath)[key],
      set: (value) => {
        editStates.get(absolutePath)[key] = value
      },
    })
  }
}

async function loadTemplateDoc(absolutePath) {
  const stat = await fs.stat(absolutePath)
  editStateFor(absolutePath, stat)
  const cached = templateCache.get(absolutePath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    attachEditState(cached.doc, absolutePath)
    return cached.doc
  }

  const buffer = await fs.readFile(absolutePath)
  const doc = await parseTemplate({
    name: path.basename(absolutePath),
    size: stat.size,
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  })
  if (templateCache.size >= 2) templateCache.delete(templateCache.keys().next().value)
  templateCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, doc })
  attachEditState(doc, absolutePath)
  return doc
}

/**
 * Point every override at its layer's entry id, so the same layer named by
 * name in one list and by id in another still merges as one layer and the
 * priority order (psd_edit < text < textBySku) holds.
 */
function canonicalOverrides(doc, list) {
  if (!Array.isArray(list) || list.length === 0) return list
  return list.map((override) => {
    const target = String(override.layer ?? '')
    const entry =
      doc.entries.find((item) => item.id === target || item.leafId === target) ||
      doc.entries.find((item) => item.name === target && item.text) ||
      doc.entries.find((item) => item.name === target)
    return entry ? { ...override, layer: entry.id } : override
  })
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
        layer.textAlign = entry.text.align
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
  text,
  textBySku,
  fontDir,
  zip = false,
}) {
  const absolute = await resolveInWorkspace(cwd, template)
  const doc = await loadTemplateDoc(absolute)

  // Explicit slots win; otherwise slots restored by load_project; otherwise
  // the auto-detected ones.
  const slotIds =
    slots && slots.length > 0
      ? resolveSlots(doc, slots)
      : doc.pinnedSlots && doc.pinnedSlots.size
        ? [...doc.pinnedSlots]
        : suggestSlots(doc)
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

  let fontsRegistered
  let fontsSkipped
  if (fontDir) {
    const registration = await registerFonts(cwd, { dir: fontDir })
    fontsRegistered = registration.registered
    fontsSkipped = registration.skipped
  }

  // SKUs are grouped by their merged override set. Each group builds its
  // scene once, renders all its SKUs, then frees the canvases before the next
  // group starts, so 500 distinct prices hold one variant scene at a time
  // instead of 500. Output names are still assigned in the input order.
  const textWarnings = []
  const savedEdits = doc.textEdits && doc.textEdits.size ? canonicalOverrides(doc, [...doc.textEdits.values()]) : null
  const batchText = canonicalOverrides(doc, text)
  const groups = new Map()
  const used = new Set()
  const extensionFor = format === 'png' ? 'png' : 'jpg'
  const jobs = skuFiles.map((file, index) => {
    const base = path.basename(file, path.extname(file))
    // psd_edit edits < batch `text` < `textBySku`, each winning per layer.
    const overrides = mergeOverrideLists(
      mergeOverrideLists(savedEdits, batchText),
      canonicalOverrides(doc, textBySku ? (textBySku[path.basename(file)] ?? textBySku[base]) : undefined),
    )
    const signature = overrides ? JSON.stringify(overrides) : ''
    let group = groups.get(signature)
    if (!group) {
      group = { overrides, jobs: [] }
      groups.set(signature, group)
    }
    const job = { index, file, base, name: uniqueName(used, sanitizeName(base), extensionFor) }
    group.jobs.push(job)
    return job
  })
  const textVariants = [...groups.values()].filter((group) => group.overrides).length

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relativeOut = outDir || path.join('out', 'psd-batch', `${sanitizeName(doc.name)}-${stamp}`)
  const absoluteOut = await resolveInWorkspace(cwd, relativeOut, { mustExist: false })
  await fs.mkdir(absoluteOut, { recursive: true })

  const isPng = format === 'png'
  const mime = isPng ? 'image/png' : 'image/jpeg'
  const settings = {
    mode: fit || DEFAULT_SETTINGS.mode,
    anchor: anchor || DEFAULT_SETTINGS.anchor,
    fill: Number.isFinite(Number(fill)) ? Number(fill) : DEFAULT_SETTINGS.fill,
  }

  const zipBuffers = zip ? new Array(jobs.length) : null
  const zipPath = zip ? path.join(absoluteOut, `${sanitizeName(doc.name)}-${jobs.length}.zip`) : null

  // Check every file the batch will write before rendering anything: a
  // symlink planted at an output name inside a workspace folder must not
  // redirect the write outside the workspace.
  for (const target of [...jobs.map((job) => path.join(absoluteOut, job.name)), ...(zipPath ? [zipPath] : [])]) {
    await resolveInWorkspace(cwd, path.relative(cwd, target), { mustExist: false })
  }

  for (const group of groups.values()) {
    let scene = doc.scene
    if (group.overrides) {
      const clone = cloneDoc(doc)
      textWarnings.push(...applyTextOverrides(clone, group.overrides, (family) => GlobalFonts.has(family)))
      scene = buildScene(clone)
    }
    try {
      for (const job of group.jobs) {
        const image = await loadImage(job.file)
        const content = measureContent(image)
        const adjust = toAdjustment(adjustments[path.basename(job.file)] ?? adjustments[job.base])

        const canvas = createCanvas(doc.width, doc.height)
        const ctx = canvas.getContext('2d')
        if (!isPng) {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, doc.width, doc.height)
        }
        drawScene(ctx, scene, image, content, settings, adjust)

        const buffer = canvas.toBuffer(mime, isPng ? undefined : Math.round(quality))
        await fs.writeFile(path.join(absoluteOut, job.name), buffer)
        if (zipBuffers) zipBuffers[job.index] = new Uint8Array(buffer)
      }
    } finally {
      if (scene !== doc.scene) disposeScene(scene)
    }
  }

  const files = jobs.map((job) => job.name)
  const zipEntries = {}
  if (zipBuffers) jobs.forEach((job) => { zipEntries[job.name] = zipBuffers[job.index] })

  if (zipPath) await fs.writeFile(zipPath, zipSync(zipEntries, { level: 0 }))

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
    textVariants,
    ...(fontsRegistered ? { fontsRegistered } : {}),
    ...(fontsSkipped && fontsSkipped.length ? { fontsSkipped } : {}),
    ...(textWarnings.length ? { textWarnings: [...new Set(textWarnings)] } : {}),
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

/** Fields a text override may carry; psd_edit and psd_batch_render share them. */
const TEXT_OVERRIDE_FIELDS = [
  'value',
  'runs',
  'font',
  'weight',
  'size',
  'sizePx',
  'color',
  'tracking',
  'align',
  'leading',
  'dx',
  'dy',
]

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

async function loadElement(cwd, spec) {
  const file = await resolveInWorkspace(cwd, spec.source)
  const image = await loadImage(file)
  const scale = Number(spec.scale) > 0 ? Number(spec.scale) : 1
  const rotation = Number(spec.rotation) || 0
  return {
    name: spec.name ? String(spec.name) : path.basename(file, path.extname(file)),
    source: path.relative(cwd, file),
    canvas: composeElement(image, { scale, rotation }),
    left: Number(spec.left) || 0,
    top: Number(spec.top) || 0,
    scale,
    rotation,
    opacity: spec.opacity == null ? 1 : Math.max(0, Math.min(1, Number(spec.opacity))),
    blend: spec.blend || 'normal',
    aboveSlots: spec.aboveSlots !== false,
  }
}

function currentSlots(doc) {
  return [...(doc.pinnedSlots && doc.pinnedSlots.size ? doc.pinnedSlots : doc.slots || [])]
}

function serializeProject(doc, template) {
  return {
    version: 2,
    template,
    slots: currentSlots(doc),
    textEdits: Object.fromEntries(doc.textEdits),
    elements: doc.elements.map(({ canvas: _canvas, ...element }) => element),
    fonts: [...registeredFamilies].sort(),
  }
}

/**
 * Read a project into a fresh state without touching the document. Every
 * slot, text layer and element source is validated and loaded first, so a
 * missing asset fails the load instead of leaving half a project applied.
 */
async function readProject(doc, cwd, project) {
  if (!project || typeof project !== 'object') throw new Error('Project file is not a JSON object')
  const slots = Array.isArray(project.slots) ? project.slots.map(String) : []
  for (const id of slots) {
    if (!doc.leaves.some((leaf) => leaf.id === id)) throw new Error(`Project slot not in this template: ${id}`)
  }
  const textEdits = new Map()
  for (const [key, raw] of Object.entries(project.textEdits || {})) {
    const entry = findTextEntry(doc, key)
    textEdits.set(entry.id, { ...pickOverride(raw), layer: entry.id })
  }
  const elements = []
  for (const spec of project.elements || []) {
    if (!spec || !spec.source) throw new Error('Project element without a `source` image')
    try {
      elements.push(await loadElement(cwd, spec))
    } catch (error) {
      throw new Error(`Project element ${spec.name || spec.source}: ${error.message || error}`)
    }
  }
  return { slots, textEdits, elements }
}

function pickOverride(raw) {
  const out = {}
  for (const key of TEXT_OVERRIDE_FIELDS) if (raw && raw[key] != null) out[key] = raw[key]
  return out
}

function missingFamilies(doc) {
  return templateFamilies(doc).filter((family) => !GlobalFonts.has(family))
}

/**
 * Edit a template in place: copy, per-run styles, placed elements, fonts and
 * the project file. Text edits are stored as overrides in the same shape as
 * psd_batch_render's `text`, on the cached document, so the next render picks
 * them up (its own `text`/`textBySku` still win per layer).
 */
export async function editTemplate(options) {
  const { cwd, template, action } = options
  if (!action) throw new Error('An action is required')
  const absolute = await resolveInWorkspace(cwd, template)
  const doc = await loadTemplateDoc(absolute)
  if (!doc.textEdits) doc.textEdits = new Map()
  if (!doc.elements) doc.elements = []

  if (action === 'status') {
    return {
      template: path.relative(cwd, absolute) || template,
      slots: currentSlots(doc),
      slotsPinned: !!(doc.pinnedSlots && doc.pinnedSlots.size),
      ...(editStates.get(absolute)?.dropped ? { editsDropped: editStates.get(absolute).dropped } : {}),
      textEdits: [...doc.textEdits.keys()],
      elements: doc.elements.map((element) => element.name),
      fonts: [...registeredFamilies].sort(),
      neededFonts: templateFamilies(doc),
      missingFonts: missingFamilies(doc),
    }
  }

  if (action === 'text') {
    const entry = findTextEntry(doc, options.layer)
    const patch = pickOverride(options)
    if (!Object.keys(patch).length) {
      throw new Error(`Pass at least one of: ${TEXT_OVERRIDE_FIELDS.join(', ')}`)
    }
    const edit = { ...(doc.textEdits.get(entry.id) || {}), ...patch, layer: entry.id }
    // Dry run against the original geometry, so the reply shows what renders.
    const leaf = doc.leaves.find((item) => item.id === entry.leafId)
    const pxPerPt = leaf ? pxPerPtOf(entry.text, (leaf.__raster || leaf).height) : 0
    const effective = mergeTextOverride(entry.text, edit, pxPerPt) || entry.text
    doc.textEdits.set(entry.id, edit)
    const missing = [...new Set(effective.runs.map((run) => run.family).filter(Boolean))].filter(
      (family) => !GlobalFonts.has(family),
    )
    return {
      layer: entry.name,
      entryId: entry.id,
      value: effective.value,
      runs: effective.runs.map((run) => ({
        len: run.len,
        family: run.family,
        weight: run.weight,
        size: run.size,
        sizePx: Math.round(run.size * pxPerPt * 100) / 100,
        color: run.color,
      })),
      ...(missing.length
        ? { warning: `Font not registered, the canvas will fall back: ${missing.join(', ')}` }
        : {}),
    }
  }

  if (action === 'element') {
    if (!Array.isArray(options.paths) || options.paths.length === 0) {
      throw new Error('Pass `paths` with one or more images')
    }
    const loaded = []
    for (const source of options.paths) {
      loaded.push(
        await loadElement(cwd, {
          source,
          name: options.paths.length === 1 ? options.name : undefined,
          left: options.dx,
          top: options.dy,
          scale: options.scale,
          rotation: options.rotation,
          opacity: options.opacity,
          blend: options.blend,
          aboveSlots: options.aboveSlots,
        }),
      )
    }
    doc.elements.push(...loaded)
    return {
      placed: loaded.map((element) => ({
        name: element.name,
        left: element.left,
        top: element.top,
        w: element.canvas.width,
        h: element.canvas.height,
        aboveSlots: element.aboveSlots,
      })),
      total: doc.elements.length,
    }
  }

  if (action === 'remelement') {
    const names = (options.names || []).map(String)
    if (names.length === 0) throw new Error('Pass `names` with the elements to remove')
    const before = doc.elements.length
    doc.elements = doc.elements.filter((element) => !names.includes(element.name))
    return {
      removed: before - doc.elements.length,
      total: doc.elements.length,
      names: doc.elements.map((element) => element.name),
    }
  }

  if (action === 'fonts') {
    const paths = options.fonts || options.paths
    if (!options.dir && !(paths && paths.length)) throw new Error('Pass `dir` or `fonts` with font files to register')
    const result = await registerFonts(cwd, { dir: options.dir, paths })
    return {
      loaded: result.registered,
      skipped: result.skipped,
      registered: [...registeredFamilies].sort(),
      missingFonts: missingFamilies(doc),
    }
  }

  if (action === 'save_project') {
    if (!options.project) throw new Error('Pass `project` with the JSON path to write')
    const projectPath = await resolveInWorkspace(cwd, options.project, { mustExist: false })
    await fs.mkdir(path.dirname(projectPath), { recursive: true })
    // Re-check after mkdir: the folder that now exists must still be ours.
    await resolveInWorkspace(cwd, path.relative(cwd, projectPath), { mustExist: false })
    const data = serializeProject(doc, path.relative(cwd, absolute))
    await fs.writeFile(projectPath, JSON.stringify(data, null, 2))
    return {
      project: path.relative(cwd, projectPath),
      textEdits: Object.keys(data.textEdits).length,
      elements: data.elements.length,
      slots: data.slots,
    }
  }

  if (action === 'load_project') {
    if (!options.project) throw new Error('Pass `project` with the JSON path to read')
    const projectPath = await resolveInWorkspace(cwd, options.project)
    let project
    try {
      project = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    } catch (error) {
      throw new Error(`Project file is not valid JSON: ${error.message || error}`)
    }
    const next = await readProject(doc, cwd, project)
    // Everything loaded: swap the whole state in one step.
    doc.textEdits = next.textEdits
    doc.elements = next.elements
    doc.pinnedSlots = next.slots.length ? new Set(next.slots) : null
    editStates.get(absolute).dropped = undefined
    if (next.slots.length) doc.slots = new Set(next.slots)
    return {
      project: path.relative(cwd, projectPath),
      textEdits: doc.textEdits.size,
      elements: doc.elements.length,
      slots: currentSlots(doc),
      missingFonts: missingFamilies(doc),
    }
  }

  if (action === 'reset') {
    doc.textEdits = new Map()
    doc.elements = []
    doc.pinnedSlots = null
    editStates.get(absolute).dropped = undefined
    return { ok: true, textEdits: 0, elements: 0 }
  }

  throw new Error(
    `Unknown action: ${action}. Use status / text / element / remelement / fonts / save_project / load_project / reset`,
  )
}

const TEXT_RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['len'],
  properties: {
    len: { type: 'integer', description: 'Character count of this run.' },
    family: { type: 'string', description: 'Font family or PostScript name.' },
    weight: { type: 'number', description: 'Font weight, 100-900.' },
    size: { type: 'number', description: 'Font size in PSD points.' },
    sizePx: { type: 'number', description: 'Font size in canvas pixels; wins over `size`.' },
    color: { type: 'string', description: 'Fill colour as #rrggbb.' },
    tracking: { type: 'number', description: 'Letter spacing in 1/1000 em, as in Photoshop.' },
  },
}

/** One text override; psd_batch_render `text`/`textBySku` and psd_edit share it. */
const TEXT_OVERRIDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['layer'],
  properties: {
    layer: { type: 'string', description: 'Text layer name, entry id (e12) or leaf id (l3).' },
    value: { type: 'string', description: 'New copy; characters keep their original styles.' },
    runs: { type: 'array', items: TEXT_RUN_SCHEMA },
    ...Object.fromEntries(
      ['family', 'weight', 'size', 'sizePx', 'color', 'tracking'].map((key) => [
        key === 'family' ? 'font' : key,
        TEXT_RUN_SCHEMA.properties[key],
      ]),
    ),
    align: { type: 'string', enum: ['left', 'center', 'right'], description: 'Paragraph alignment.' },
    leading: { type: 'number', description: 'Fixed line height in PSD points.' },
    dx: { type: 'number', description: 'Horizontal nudge in canvas pixels.' },
    dy: { type: 'number', description: 'Vertical nudge in canvas pixels.' },
  },
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
                  textAlign: { type: 'string', enum: ['left', 'center', 'right'] },
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
        'Render a PSD/PSB main-image template with many SKU images at once. Each SKU image is trimmed to its visible content, fitted into the product slots, composited between the template layers, and written as JPG/PNG into a workspace folder. Visible sibling layers that overlap a slot are suppressed together with the slot (reported as `suppressed`) so stale product art cannot show through. Text layers can be rewritten per batch (`text`) or per SKU (`textBySku`) — re-rendered with real glyphs, not pasted pixels; register brand fonts first with `fontDir`. Returns the output folder and file names; optionally packs a ZIP.',
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
          text: {
            type: 'array',
            description:
              'Rewrite text layers in every render: [{layer, value, runs, font, weight, size, sizePx, color, tracking, align, leading, dx, dy}]. `layer` is a layer name or leaf id; `value` replaces the copy (styles follow their characters); `runs` [{len, family?, weight?, size?, sizePx?, color?, tracking?}] restyle consecutive segments from the first character; flat font/weight/size/sizePx/color/tracking restyle all runs. `size` is in pt, exactly what psd_inspect reports; `sizePx` is in canvas pixels; color is #rrggbb. Wins over psd_edit text edits for the same layer.',
            items: TEXT_OVERRIDE_SCHEMA,
          },
          textBySku: {
            type: 'object',
            additionalProperties: { type: 'array', items: TEXT_OVERRIDE_SCHEMA },
            description:
              'Per-SKU text overrides keyed by SKU file name (with or without extension), same shape as `text`; entries win over `text` per layer. Use it to give every SKU its own price.',
          },
          fontDir: {
            type: 'string',
            description:
              'Directory of .ttf/.otf font files to register before rendering. Registered family names (file stems) are returned in `fontsRegistered`.',
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
          required: ['count', 'outDir', 'files', 'slots', 'suppressed', 'suppressedCount', 'suppressedTruncated', 'textVariants'],
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
            textVariants: { type: 'integer' },
            textWarnings: { type: 'array', items: { type: 'string' } },
            fontsRegistered: { type: 'array', items: { type: 'string' } },
            fontsSkipped: { type: 'array', items: { type: 'string' } },
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
            }${value.textVariants ? `\nText rewritten in ${value.textVariants} variant(s).` : ''}${
              value.fontsRegistered && value.fontsRegistered.length
                ? `\nFonts registered: ${value.fontsRegistered.join(', ')}`
                : ''
            }${
              value.textWarnings && value.textWarnings.length
                ? `\nText warnings: ${value.textWarnings.slice(0, 8).join('；')}`
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
          text: args.text,
          textBySku: args.textBySku,
          fontDir: args.fontDir,
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
        'Edit a loaded PSD/PSB template before rendering: rewrite a text layer (same fields as one psd_batch_render `text` item, so a price line can mix two fonts, sizes and colours), place extra image layers above the product slot or between the background and the slot, register font files, and save or load the project so edits survive between sessions. Edits land on the cached document, so a following psd_batch_render uses them (its own `text`/`textBySku` still win per layer) and, after load_project, the project\'s slots when `slots` is omitted.',
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
          // action=text: the same fields as one psd_batch_render `text` item.
          ...TEXT_OVERRIDE_SCHEMA.properties,
          layer: {
            type: 'string',
            description: 'Text layer name, entry id (e12) or leaf id (l3). Required for action=text.',
          },
          dx: { type: 'number', description: 'Horizontal offset in canvas pixels (text nudge, or element left).' },
          dy: { type: 'number', description: 'Vertical offset in canvas pixels (text nudge, or element top).' },
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
            description:
              'Draw the element above everything (default true). Set false to place it directly under the lowest product slot, above the background.',
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
