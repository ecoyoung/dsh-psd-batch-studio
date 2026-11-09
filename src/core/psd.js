/**
 * PSD template parsing and layer compositing.
 *
 * The template is kept as a flat list of pixel layers plus the layer tree used
 * by the UI. Rendering splits the stack into "parts": background runs and
 * product slots, so a SKU image can sit exactly between the template layers
 * below it and the decorations above it without a Photoshop round trip.
 */
import { readPsd } from 'ag-psd'
import { createCanvas } from './canvas.js'
import { describeTextLayer } from './text.js'

const makeCanvas = createCanvas

const BLEND_MODES = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  'linear dodge': 'lighter',
  'linear burn': 'multiply',
  'vivid light': 'hard-light',
  'linear light': 'hard-light',
  'pin light': 'lighten',
  'hard mix': 'hard-light',
  'subtract': 'difference',
  'divide': 'screen',
  'pass through': 'source-over',
}

const SLOT_NAME_HINT = /商品|产品|主图|sku|product|替换|瓶|管|盒|罐|主体|puff|粉扑/i
const SLOT_NAME_NOISE = /文字|txt|logo|icon|价格|price|券|包邮|top|时间|time|背景|background|台|光|气球|亮片|彩带|形状|矩形|椭圆|阴影|shadow/i

export { makeCanvas }

/**
 * Parse a PSD/PSB file into the studio's template model.
 *
 * @param {File} file the dropped template file.
 * @param {(stage: string) => void} [onStage] called with human-readable stages.
 * @returns {Promise<object>} template document.
 */
export async function parseTemplate(file, onStage = () => {}) {
  onStage('读取文件…')
  const buffer = await file.arrayBuffer()

  onStage('解析图层…')
  // Let the busy state paint before the synchronous decoder takes the thread.
  await new Promise((resolve) => setTimeout(resolve, 30))

  const psd = readPsd(buffer, {
    skipThumbnail: true,
    skipLinkedFilesData: true,
    skipCompositeImageData: true,
    logLevel: 'error',
  })

  onStage('整理图层树…')
  const { entries, leaves } = buildTree(psd)
  if (leaves.length === 0) throw new Error('这个文件里没有可用的像素图层')

  // The decoder's canvases are the only thing worth keeping; drop the rest of
  // the document so a large PSB does not stay referenced twice.
  psd.children = []
  psd.imageData = undefined
  psd.canvas = undefined

  const hidden = new Set()
  for (const entry of entries) if (entry.psdHidden) hidden.add(entry.id)

  return {
    name: file.name,
    fileName: file.name,
    width: psd.width,
    height: psd.height,
    entries,
    leaves,
    hidden,
    slots: new Set(),
    size: file.size,
    // Images placed by psd_edit; drawn through the same layer compositor.
    elements: [],
  }
}

function buildTree(psd) {
  const entries = []
  const leaves = []
  let leafIndex = 0

  const walk = (nodes, depth, ancestorIds, inheritedOpacity, parentId) => {
    for (const node of nodes || []) {
      const isGroup = Array.isArray(node.children) && node.children.length > 0
      const id = `e${entries.length}`
      const entry = {
        id,
        name: node.name || (isGroup ? '组' : '图层'),
        depth,
        kind: isGroup ? 'group' : node.text ? 'text' : 'layer',
        psdHidden: !!node.hidden,
        parentId,
        path: [...ancestorIds, id],
      }
      if (!isGroup && node.text) entry.text = describeTextLayer(node.text)
      entries.push(entry)

      if (isGroup) {
        walk(node.children, depth + 1, entry.path, inheritedOpacity * (node.opacity ?? 1), id)
        continue
      }

      if (!node.canvas) {
        entry.empty = true
        continue
      }

      const width = node.canvas.width
      const height = node.canvas.height
      if (width <= 0 || height <= 0) {
        entry.empty = true
        continue
      }

      const leaf = {
        id: `l${leafIndex++}`,
        entryId: id,
        name: entry.name,
        left: node.left ?? 0,
        top: node.top ?? 0,
        width,
        height,
        canvas: node.canvas,
        mask:
          node.mask && node.mask.canvas
            ? {
                canvas: node.mask.canvas,
                left: node.mask.left ?? node.left ?? 0,
                top: node.mask.top ?? node.top ?? 0,
              }
            : null,
        opacity: inheritedOpacity * (node.opacity ?? 1),
        blendMode: node.blendMode || 'normal',
        clipping: !!node.clipping,
        effects: node.effects || null,
        isText: !!node.text,
        path: entry.path,
      }
      leaves.push(leaf)
      entry.leafId = leaf.id
      entry.bounds = [node.left ?? 0, node.top ?? 0, node.right ?? 0, node.bottom ?? 0]
      entry.hasPixels = true
    }
  }

  walk(psd.children || [], 0, [], 1, null)
  return { entries, leaves }
}

export function isEntryVisible(doc, entryId) {
  const entry = doc.entries.find((item) => item.id === entryId)
  if (!entry) return true
  return !entry.path.some((id) => doc.hidden.has(id))
}

export function isLeafVisible(doc, leaf) {
  return !leaf.path.some((id) => doc.hidden.has(id))
}

/**
 * Pick the likely product layers.
 *
 * Scores tall, medium-sized, non-text layers in the middle of the artwork, and
 * then folds in neighbours of a matching size on the same row so a two-bottle
 * template is marked as two slots in one go.
 */
export function suggestSlots(doc) {
  const { width: docW, height: docH } = doc
  const docArea = docW * docH
  const scored = []

  for (const leaf of doc.leaves) {
    if (!isLeafVisible(doc, leaf) || leaf.isText) continue
    const x0 = Math.max(0, leaf.left)
    const y0 = Math.max(0, leaf.top)
    const x1 = Math.min(docW, leaf.left + leaf.width)
    const y1 = Math.min(docH, leaf.top + leaf.height)
    const covered = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
    const ratio = (leaf.width * leaf.height) / docArea
    const coverage = covered / docArea
    if (coverage > 0.5 || ratio < 0.012) continue
    if (leaf.height / leaf.width < 1.05) continue

    let score = Math.min(ratio, 0.4) * 2
    if (SLOT_NAME_HINT.test(leaf.name)) score += 0.5
    if (SLOT_NAME_NOISE.test(leaf.name)) score -= 1
    score -= Math.abs(leaf.left + leaf.width / 2 - docW / 2) / docW
    if (score > 0.05) scored.push({ leaf, score })
  }

  scored.sort((a, b) => b.score - a.score)
  if (scored.length === 0) return []

  const best = scored[0]
  const picked = [best.leaf]
  for (const candidate of scored.slice(1)) {
    if (picked.length >= 4) break
    const leaf = candidate.leaf
    const sameSize =
      Math.abs(leaf.width - best.leaf.width) <= best.leaf.width * 0.35 &&
      Math.abs(leaf.height - best.leaf.height) <= best.leaf.height * 0.35
    const sameRow = Math.abs(leaf.top - best.leaf.top) <= docH * 0.06
    // A near-duplicate layer on top of a picked bottle is a shadow or
    // highlight copy, not a second product slot.
    const crowded = picked.some((other) => boundsOverlapRatio(leafBounds(other), leafBounds(leaf)) > 0.6)
    if (sameSize && sameRow && !crowded) picked.push(leaf)
  }
  return picked.map((leaf) => leaf.id)
}


function effectValue(input) {
  if (typeof input === 'number') return input
  return input && typeof input.value === 'number' ? input.value : 0
}

function effectList(effects, name) {
  if (!effects) return []
  const value = effects[name]
  if (!value) return []
  return (Array.isArray(value) ? value : [value]).filter((item) => item && item.enabled)
}

function cssColor(color, alpha = 1) {
  if (!color) return `rgba(0,0,0,${alpha})`
  const r = Math.round(color.r ?? 0)
  const g = Math.round(color.g ?? 0)
  const b = Math.round(color.b ?? 0)
  return `rgba(${r},${g},${b},${alpha})`
}

function paintGradient(ctx, width, height, effect) {
  const gradient = effect.gradient
  const stops = (gradient?.colorStops || []).slice().sort((a, b) => a.location - b.location)
  if (stops.length === 0) return false
  const angle = (((effect.angle ?? 90) * Math.PI) / 180)
  const scale = effect.scale ?? 1
  const offsetX = effect.offset?.x ?? 0
  const offsetY = effect.offset?.y ?? 0
  const cx = width / 2 + offsetX
  const cy = height / 2 + offsetY
  const type = effect.type || 'linear'

  let fill
  const safeScale = scale > 0 ? scale : 1
  if (type === 'radial' || type === 'diamond') {
    const radius = Math.max(width, height) / 2 / safeScale
    fill = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, radius))
  } else {
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const length = (Math.abs(width * cos) + Math.abs(height * sin)) / safeScale
    fill = ctx.createLinearGradient(
      cx + (cos * length) / 2,
      cy - (sin * length) / 2,
      cx - (cos * length) / 2,
      cy + (sin * length) / 2,
    )
  }

  for (const stop of stops) {
    fill.addColorStop(Math.max(0, Math.min(1, stop.location)), cssColor(stop.color, 1))
  }

  ctx.save()
  ctx.globalCompositeOperation = 'source-atop'
  ctx.globalAlpha = effect.opacity ?? 1
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
  return true
}


/** Photoshop masks store coverage in grayscale RGB; canvas needs it as alpha. */
const maskCache = new WeakMap()
function maskAlphaCanvas(maskCanvas) {
  const cached = maskCache.get(maskCanvas)
  if (cached) return cached
  const canvas = makeCanvas(maskCanvas.width, maskCanvas.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(maskCanvas, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = image.data
  for (let index = 0; index < data.length; index += 4) {
    const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3
    data[index + 3] = Math.round((data[index + 3] * luminance) / 255)
  }
  ctx.putImageData(image, 0, 0)
  maskCache.set(maskCanvas, canvas)
  return canvas
}

function silhouette(layer, color) {
  const canvas = makeCanvas(layer.width, layer.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(layer, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

function effectPadding(effects) {
  let pad = 0
  for (const shadow of effectList(effects, 'dropShadow')) {
    pad = Math.max(pad, effectValue(shadow.size) * 1.6 + effectValue(shadow.distance) + 6)
  }
  for (const glow of effectList(effects, 'outerGlow')) {
    pad = Math.max(pad, effectValue(glow.size) * 1.6 + 6)
  }
  const stroke = effectList(effects, 'stroke')[0]
  if (stroke) pad = Math.max(pad, effectValue(stroke.size) + 4)
  return Math.ceil(pad)
}

/**
 * Compose one layer with its Photoshop layer styles (solid/gradient overlay,
 * drop shadow, outer glow, stroke) plus its mask or clipping base.
 */
function composeLeaf(leaf, previous) {
  const base = makeCanvas(leaf.width, leaf.height)
  const ctx = base.getContext('2d')
  ctx.drawImage(leaf.canvas, 0, 0)

  if (leaf.mask) {
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(
      maskAlphaCanvas(leaf.mask.canvas),
      leaf.mask.left - leaf.left,
      leaf.mask.top - leaf.top,
    )
    ctx.globalCompositeOperation = 'source-over'
  }
  if (leaf.clipping && previous) {
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(previous.canvas, previous.left - leaf.left, previous.top - leaf.top)
    ctx.globalCompositeOperation = 'source-over'
  }

  const solid = effectList(leaf.effects, 'solidFill')[0]
  if (solid) {
    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    ctx.globalAlpha = solid.opacity ?? 1
    ctx.fillStyle = cssColor(solid.color, 1)
    ctx.fillRect(0, 0, leaf.width, leaf.height)
    ctx.restore()
  }
  const gradient = effectList(leaf.effects, 'gradientOverlay')[0]
  if (gradient) paintGradient(ctx, leaf.width, leaf.height, gradient)

  const shadows = [
    ...effectList(leaf.effects, 'dropShadow'),
    ...effectList(leaf.effects, 'outerGlow'),
  ]
  const stroke = effectList(leaf.effects, 'stroke')[0]
  const pad = effectPadding(leaf.effects)
  if (shadows.length === 0 && !stroke) return { canvas: base, left: leaf.left, top: leaf.top }

  const out = makeCanvas(leaf.width + pad * 2, leaf.height + pad * 2)
  const outCtx = out.getContext('2d')

  for (const shadow of shadows) {
    const color = cssColor(shadow.color, shadow.opacity ?? 1)
    const isGlow = shadow === effectList(leaf.effects, 'outerGlow')[0]
    const distance = isGlow ? 0 : effectValue(shadow.distance)
    const angle = (((shadow.angle ?? 120) * Math.PI) / 180)
    outCtx.save()
    outCtx.shadowColor = color
    outCtx.shadowBlur = effectValue(shadow.size) * (isGlow ? 2.2 : 1.4)
    outCtx.shadowOffsetX = Math.cos(angle) * distance
    outCtx.shadowOffsetY = Math.sin(angle) * distance
    outCtx.drawImage(base, pad, pad)
    outCtx.restore()
    outCtx.clearRect(pad, pad, 0, 0)
  }

  if (stroke) {
    const width = effectValue(stroke.size)
    const tinted = silhouette(base, cssColor(stroke.color, 1))
    const steps = 24
    outCtx.save()
    outCtx.globalAlpha = stroke.opacity ?? 1
    for (let index = 0; index < steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2
      outCtx.drawImage(tinted, pad + Math.cos(angle) * width, pad + Math.sin(angle) * width)
    }
    outCtx.restore()
  }

  outCtx.drawImage(base, pad, pad)
  return { canvas: out, left: leaf.left - pad, top: leaf.top - pad }
}

function renderLeaves(leaves, width, height) {
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  let clipBase = null

  for (const leaf of leaves) {
    const composed = composeLeaf(leaf, clipBase)
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, leaf.opacity))
    ctx.globalCompositeOperation = BLEND_MODES[leaf.blendMode] || 'source-over'
    ctx.drawImage(composed.canvas, composed.left, composed.top)
    ctx.restore()
    // Clipping layers clip to the base layer below them, not to each other.
    if (!leaf.clipping) {
      clipBase = { canvas: composed.canvas, left: composed.left, top: composed.top }
    }
  }

  return canvas
}

function leafBounds(leaf) {
  return {
    left: leaf.left,
    top: leaf.top,
    right: leaf.left + leaf.width,
    bottom: leaf.top + leaf.height,
  }
}

/**
 * How much of the smaller bounding box is covered by the other one (0-1).
 * The denominator is the SMALLER rectangle's area, so a small decoration on a
 * big slot still scores high.
 */
function boundsOverlapRatio(a, b) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  if (width <= 0 || height <= 0) return 0
  const areaA = (a.right - a.left) * (a.bottom - a.top)
  const areaB = (b.right - b.left) * (b.bottom - b.top)
  return (width * height) / Math.min(areaA, areaB)
}

function unionBounds(a, b) {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }
}

/**
 * A product usually occupies several stacked layers (the artwork plus a
 * shadow/highlight copy a few pixels away). Such copies join one slot cluster
 * so replacing the slot hides all of them and draws the SKU once.
 */
function isStackedCopy(base, other, doc) {
  const a = leafBounds(base)
  const b = leafBounds(other)
  const widthA = a.right - a.left
  const heightA = a.bottom - a.top
  const widthB = b.right - b.left
  const heightB = b.bottom - b.top
  const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  if (overlapWidth <= 0 || overlapHeight <= 0) return false
  const ratio =
    (overlapWidth * overlapHeight) / Math.min(widthA * heightA, widthB * heightB)
  if (ratio < 0.85) return false
  if (Math.abs(widthA - widthB) > Math.max(widthA, widthB) * 0.25) return false
  if (Math.abs(heightA - heightB) > Math.max(heightA, heightB) * 0.25) return false
  if (Math.abs(a.left - b.left) > doc.width * 0.03) return false
  if (Math.abs(a.top - b.top) > doc.height * 0.03) return false
  return true
}

/**
 * A visible sibling of a slot covering at least this much of the slot's box is
 * treated as stale product art and hidden together with the slot.
 */
const SLOT_SIBLING_OVERLAP = 0.25

/** Placed images as leaves, so they ride through the layer compositor. */
function elementLeaves(doc) {
  return (doc.elements || [])
    .filter((element) => element.canvas)
    .map((element, index) => ({
      id: `x${index}`,
      entryId: null,
      name: element.name || `元素 ${index + 1}`,
      left: Math.round(element.left || 0),
      top: Math.round(element.top || 0),
      width: element.canvas.width,
      height: element.canvas.height,
      canvas: element.canvas,
      mask: null,
      opacity: element.opacity == null ? 1 : element.opacity,
      blendMode: element.blend || 'normal',
      clipping: false,
      effects: null,
      path: [],
      isElement: true,
      aboveSlots: element.aboveSlots !== false,
    }))
}

/**
 * The PSD stack with placed elements folded in. Elements above the slots go
 * on top of everything; elements below go directly under the lowest slot, so
 * they stay above the background instead of vanishing under it. Without a
 * slot they sit right above the bottom layer.
 */
function stackWithElements(doc, leaves) {
  const elements = elementLeaves(doc)
  if (!elements.length) return leaves
  const above = elements.filter((element) => element.aboveSlots)
  const below = elements.filter((element) => !element.aboveSlots)
  let at = leaves.findIndex((leaf) => doc.slots.has(leaf.id))
  if (at < 0) at = Math.min(1, leaves.length)
  return [...leaves.slice(0, at), ...below, ...leaves.slice(at), ...above]
}

/**
 * Split the visible layer stack into background runs and product slots.
 *
 * @returns {{parts: Array<object>, slots: Array<object>, suppressed: Array<object>, width: number, height: number}}
 */
export function buildScene(doc) {
  const visibleLeaves = stackWithElements(
    doc,
    doc.leaves.filter((leaf) => isLeafVisible(doc, leaf)),
  )
  const entryById = new Map(doc.entries.map((entry) => [entry.id, entry]))
  const clusters = []
  const clusterOf = new Map()
  const claimed = new Set()
  const suppressed = []

  // Pass 1 folds near-identical stacked copies (shadow/highlight) into their
  // slot's cluster for EVERY slot before anything else claims them, so a
  // later slot never loses its own copy to an earlier slot's overlap pass.
  for (const leaf of visibleLeaves) {
    if (!doc.slots.has(leaf.id) || claimed.has(leaf.id)) continue
    claimed.add(leaf.id)
    let rect = leafBounds(leaf)
    // A copy that widens the fit rect is product art too: it must join the
    // cluster so the draw pass skips it, or it paints over the SKU.
    const members = new Set([leaf.id])
    for (const other of visibleLeaves) {
      if (claimed.has(other.id) || doc.slots.has(other.id) || other.isElement) continue
      if (!isStackedCopy(leaf, other, doc)) continue
      claimed.add(other.id)
      members.add(other.id)
      rect = unionBounds(rect, leafBounds(other))
    }
    const cluster = {
      id: leaf.id,
      name: leaf.name,
      members,
      rect: {
        x: rect.left,
        y: rect.top,
        w: rect.right - rect.left,
        h: rect.bottom - rect.top,
      },
      emitted: false,
    }
    clusters.push(cluster)
    clusterOf.set(leaf.id, cluster)
    for (const other of visibleLeaves) {
      if (cluster.members.has(other.id)) clusterOf.set(other.id, cluster)
    }
  }

  // Pass 2 hides stale product art: visible siblings inside the slot's group
  // overlapping the slot. They join the cluster (hidden, never drawn) but the
  // slot rect stays untouched so the fitting area keeps the designer's box.
  // Running this after pass 1 keeps slots from claiming each other's copies.
  for (const cluster of clusters) {
    const leaf = visibleLeaves.find((item) => item.id === cluster.id)
    const parent = entryById.get(leaf.entryId)?.parentId
    if (!parent) continue
    for (const other of visibleLeaves) {
      if (claimed.has(other.id) || doc.slots.has(other.id) || other.isElement) continue
      if (!other.path.includes(parent)) continue
      if (boundsOverlapRatio(leafBounds(leaf), leafBounds(other)) < SLOT_SIBLING_OVERLAP) continue
      cluster.members.add(other.id)
      claimed.add(other.id)
      clusterOf.set(other.id, cluster)
      suppressed.push({ leafId: other.id, name: other.name })
    }
  }

  const parts = []
  let run = []

  const flush = () => {
    if (run.length === 0) return
    parts.push({ kind: 'layers', canvas: renderLeaves(run, doc.width, doc.height), count: run.length })
    run = []
  }

  // The slot part is emitted where the slot layer itself sits in the stack.
  // Other cluster members (stacked copies, suppressed siblings) are skipped
  // without touching the order of everything around them.
  for (const leaf of visibleLeaves) {
    const cluster = clusterOf.get(leaf.id)
    if (!cluster) {
      run.push(leaf)
      continue
    }
    if (leaf.id !== cluster.id || cluster.emitted) continue
    cluster.emitted = true
    flush()
    parts.push({ kind: 'slot', leafId: cluster.id, name: cluster.name, rect: cluster.rect })
  }
  flush()

  if (parts.length === 0) {
    parts.push({ kind: 'layers', canvas: renderLeaves([], doc.width, doc.height), count: 0 })
  }

  return {
    parts,
    slots: parts.filter((part) => part.kind === 'slot'),
    suppressed,
    width: doc.width,
    height: doc.height,
  }
}

/** Free canvases of a template the studio no longer shows. */
export function disposeScene(scene) {
  if (!scene) return
  for (const part of scene.parts) {
    if (part.kind === 'layers' && part.canvas) {
      part.canvas.width = 1
      part.canvas.height = 1
    }
  }
}
