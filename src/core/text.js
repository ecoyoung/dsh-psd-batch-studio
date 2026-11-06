/**
 * Text layer repaint shared by the browser workbench and the Host renderer.
 *
 * PSD text layers arrive as raster pixels, so a template could not change its
 * copy or its font. This module redraws a text layer from its `entry.text`
 * description (value + per-run styles) inside the layer's original bounding
 * box, keeping the designer's position and line count.
 *
 * Fonts are not resolved by the canvas itself: a family that is not registered
 * silently falls back to the system default, which is how a batch can look
 * "almost right" while every layer uses the wrong face. Callers register fonts
 * through `registerFontFace` / `markFontRegistered`, and `unregisteredFamilies`
 * reports what a template still needs.
 */

import { createCanvas } from './canvas.js'

const registered = new Set()
let fontFaceInstaller = null

/**
 * Install the runtime-specific font loader.
 *
 * Host: (family, filePath) => boolean, backed by @napi-rs/canvas GlobalFonts.
 * Browser: (family, url) => Promise, backed by FontFace + document.fonts.
 */
export function setFontFaceInstaller(installer) {
  fontFaceInstaller = installer
}

export function markFontRegistered(family) {
  const name = String(family || '').trim()
  if (name) registered.add(name)
}

export function isFontRegistered(family) {
  return registered.has(String(family || '').trim())
}

export function registeredFonts() {
  return [...registered].sort()
}

export async function registerFont(family, source) {
  const name = String(family || '').trim()
  if (!name) throw new Error('A font family name is required')
  if (registered.has(name)) return name
  if (!fontFaceInstaller) throw new Error('No font installer registered for this runtime')
  const ok = await fontFaceInstaller(name, source)
  if (ok === false) throw new Error(`Could not register font: ${name}`)
  registered.add(name)
  return name
}

/** Every family a template's text layers ask for. */
export function templateFamilies(doc) {
  const families = new Set()
  for (const entry of doc.entries || []) {
    if (!entry.text) continue
    for (const run of entry.text.runs || []) {
      if (run.family) families.add(run.family)
    }
  }
  return [...families].sort()
}

/** Families a template needs that were never registered. */
export function unregisteredFamilies(doc) {
  return templateFamilies(doc).filter((family) => !registered.has(family))
}

export function cssFont(style, sizePx) {
  const weight = style.weight || 400
  const italic = style.italic ? 'italic ' : ''
  const family = String(style.family || 'PingFang SC').replace(/"/g, '\\"')
  return `${italic}${weight} ${Math.max(1, sizePx)}px "${family}"`
}

/**
 * pt → px conversion for a text layer.
 *
 * PSD stores `fontSize` in points and the composer works in pixels; the layer's
 * raster box is the only reliable anchor, so the ratio is derived from it:
 * box height ≈ lines × max pt × 1.2 (the 1.2 is the usual single line height).
 */
export function textMetrics(entry) {
  const bounds = entry.bounds || [0, 0, 0, 0]
  const box = {
    x: bounds[0],
    y: bounds[1],
    w: Math.max(1, bounds[2] - bounds[0]),
    h: Math.max(1, bounds[3] - bounds[1]),
  }
  const value = entry.text && typeof entry.text.value === 'string' ? entry.text.value : ''
  const lines = Math.max(1, value.split('\n').length)
  const runs = (entry.text && entry.text.runs) || []
  const maxPt = Math.max(1, ...runs.map((run) => run.size || 0), 1)
  const pxPerPt = box.h / (lines * maxPt * 1.2)
  return { box, lines, maxPt, pxPerPt }
}

/** Style of the character at `index`, runs are contiguous over the raw value. */
function styleAt(runs, index) {
  let accumulated = 0
  for (const run of runs) {
    accumulated += run.len || 0
    if (index < accumulated) return run
  }
  return runs.length ? runs[runs.length - 1] : null
}

/** Split one line into chunks that share a style, keeping text order. */
function chunkLine(line, offset, runs, fallback) {
  const chunks = []
  for (let index = 0; index < line.length; index += 1) {
    const style = styleAt(runs, offset + index) || fallback
    const last = chunks[chunks.length - 1]
    if (last && last.style === style) last.text += line[index]
    else chunks.push({ style, text: line[index] })
  }
  return chunks
}

function measureChunk(ctx, chunk, pxPerPt, tracking) {
  const size = Math.max(1, (chunk.style.size || 12) * pxPerPt)
  ctx.font = cssFont(chunk.style, size)
  const spacing = (chunk.style.tracking || tracking || 0) * pxPerPt
  if (!spacing) return ctx.measureText(chunk.text).width
  let width = 0
  for (const char of chunk.text) width += ctx.measureText(char).width + spacing
  return width
}

function drawChunk(ctx, chunk, x, baseline, pxPerPt, tracking) {
  const size = Math.max(1, (chunk.style.size || 12) * pxPerPt)
  ctx.font = cssFont(chunk.style, size)
  const color = chunk.style.color || [0, 0, 0]
  ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`
  const spacing = (chunk.style.tracking || tracking || 0) * pxPerPt
  if (!spacing) {
    ctx.fillText(chunk.text, x, baseline)
    return
  }
  let cursor = x
  for (const char of chunk.text) {
    ctx.fillText(char, cursor, baseline)
    cursor += ctx.measureText(char).width + spacing
  }
}

const ALIGN_TO_ANCHOR = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', justify: 'left' }

/**
 * Redraw one text entry into a canvas sized to its original box.
 *
 * Returns `{ canvas, left, top }` shaped like the leaves the compositor draws.
 */
export function renderTextEntry(entry, options = {}) {
  const text = entry.text || { value: '', runs: [] }
  const runs = text.runs || []
  const meta = textMetrics(entry)
  const value = String(text.value || '')
  const lines = value.split('\n')

  const canvas = createCanvas(Math.max(1, Math.ceil(meta.box.w)), Math.max(1, Math.ceil(meta.box.h)))
  const ctx = canvas.getContext('2d')
  if (!ctx) return { canvas, left: meta.box.x, top: meta.box.y }

  const align = String(options.align || text.align || 'left').toLowerCase()
  const anchor = ALIGN_TO_ANCHOR[align] || 'left'
  const tracking = typeof options.tracking === 'number' ? options.tracking : 0
  const lineHeight = meta.maxPt * meta.pxPerPt * (typeof text.leading === 'number' && text.leading > 0
    ? Math.max(1, text.leading / meta.maxPt)
    : 1.2)
  const fallback = runs[0] || { size: meta.maxPt, family: 'PingFang SC', weight: 400, color: [0, 0, 0] }

  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const chunks = chunkLine(line, offset, runs, fallback)
    offset += line.length + 1

    const widths = chunks.map((chunk) => measureChunk(ctx, chunk, meta.pxPerPt, tracking))
    const total = widths.reduce((sum, width) => sum + width, 0)
    let cursor = anchor === 'center' ? (meta.box.w - total) / 2 : anchor === 'right' ? meta.box.w - total : 0

    // Baseline sits a bit above the line's lower edge; 0.82 is the usual
    // ascent share for CJK faces and keeps the block optically centred.
    const baseline = lineHeight * (index + 0.82)
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      drawChunk(ctx, chunks[chunkIndex], cursor, baseline, meta.pxPerPt, tracking)
      cursor += widths[chunkIndex]
    }
  }

  return { canvas, left: meta.box.x, top: meta.box.y }
}

/**
 * PostScript name (name ID 6) from a TTF/OTF/TTC buffer.
 *
 * PSD text styles carry PostScript names while fonts are usually registered
 * under their file stem; registering both is what keeps a Chinese-named file
 * (苹方中黑_0.ttf) matching a layer that says PingFangSC-Medium.
 */
export function readFontPostScriptName(buffer) {
  try {
    const view = new DataView(buffer.buffer ? buffer.buffer : buffer, buffer.byteOffset || 0, buffer.byteLength)
    const tagAt = (offset) => String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
    )
    let nameOffset = 0
    if (tagAt(0) === 'ttcf') {
      const first = view.getUint32(12)
      const count = view.getUint16(first + 4)
      for (let index = 0; index < count; index += 1) {
        const record = first + 12 + index * 16
        if (tagAt(record) === 'name') { nameOffset = view.getUint32(record + 8); break }
      }
    } else {
      const count = view.getUint16(4)
      for (let index = 0; index < count; index += 1) {
        const record = 12 + index * 16
        if (tagAt(record) === 'name') { nameOffset = view.getUint32(record + 8); break }
      }
    }
    if (!nameOffset) return null
    const count = view.getUint16(nameOffset + 2)
    const stringsStart = nameOffset + view.getUint16(nameOffset + 4)
    for (let index = 0; index < count; index += 1) {
      const record = nameOffset + 6 + index * 12
      const platformId = view.getUint16(record)
      const nameId = view.getUint16(record + 6)
      if (nameId !== 6) continue
      const length = view.getUint16(record + 8)
      const offset = view.getUint16(record + 10)
      let value = ''
      if (platformId === 3 || platformId === 0) {
        for (let cursor = 0; cursor < length; cursor += 2) {
          value += String.fromCharCode(view.getUint16(stringsStart + offset + cursor))
        }
      } else {
        for (let cursor = 0; cursor < length; cursor += 1) {
          value += String.fromCharCode(view.getUint8(stringsStart + offset + cursor))
        }
      }
      value = value.trim()
      if (value) return value
    }
  } catch {
    return null
  }
  return null
}
