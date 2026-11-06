/**
 * Live text engine shared by the browser workbench and the Host batch
 * renderer.
 *
 * PSD text layers normally render from their rasterized pixels. This module
 * re-renders a text layer with real glyphs so agents and the panel can rewrite
 * prices and copy: the style runs parsed from the PSD are merged with an
 * override, expanded per character, laid out into a canvas the size of the
 * ink, and swapped in for the layer's raster. Masks, clipping and layer styles
 * keep working because the swap happens below `composeLeaf`.
 *
 * Sizing only looks at the ORIGINAL text geometry (lines × max size): editing
 * the value never rescales the existing glyphs, which is what a price bar
 * needs when the decimal digits shrink.
 */
import { createCanvas as makeCanvas } from './canvas.js'

/** PSD font names arrive squashed ("PingFangSC-Regular"); map the common ones. */
export const FONT_FAMILY_MAP = [
  [/^PingFangSC/i, 'PingFang SC'],
  [/^PingFang/i, 'PingFang SC'],
  [/^HiraginoSansGB/i, 'Hiragino Sans GB'],
  [/^MicrosoftYaHei/i, 'Microsoft YaHei'],
  [/^MicrosoftJhengHei/i, 'Microsoft JhengHei'],
  [/^(SourceHanSans|SourceHanSansCN|NotoSansSC|NotoSansCJK)/i, 'Noto Sans SC'],
  [/^SourceHanSerif/i, 'Noto Serif SC'],
  [/^SimHei|^STHeiti/i, 'Heiti SC'],
  [/^SimSun|^STSong/i, 'Songti SC'],
  [/^AlibabaPuHuiTi/i, 'Alibaba PuHuiTi'],
  [/^OPPOSans/i, 'OPPO Sans'],
  [/^HarmonyOS/i, 'HarmonyOS Sans'],
  [/^DIN/i, 'DIN Alternate'],
  [/^ArialMT|^Arial/i, 'Arial'],
  [/^HelveticaNeue|^Helvetica/i, 'Helvetica Neue'],
  [/^Inter/i, 'Inter'],
  [/^Roboto/i, 'Roboto'],
]

export function fontFamilyOf(name) {
  const raw = String(name || '').replace(/^#/, '').trim()
  if (!raw) return null
  for (const [pattern, family] of FONT_FAMILY_MAP) {
    if (pattern.test(raw)) return family
  }
  // Anything else is a PostScript name (GlowSansSC-Normal-Medium). Fonts are
  // registered under that same name, so cutting it down to "GlowSansSC"
  // would match neither the registered face nor a system family.
  return raw
}

/**
 * PostScript name (name ID 6) from a TTF/OTF/TTC buffer, or null.
 *
 * PSD text styles carry PostScript names while font files are usually named
 * something else (苹方中黑_0.ttf); registering under both keeps a layer that
 * says PingFangSC-Medium resolving to the file the user dropped in.
 */
export function readFontPostScriptName(buffer) {
  try {
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer
    const view = new DataView(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength)
    const tagAt = (offset) =>
      String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
    const fontStart = tagAt(0) === 'ttcf' ? view.getUint32(12) : 0
    const tables = view.getUint16(fontStart + 4)
    let nameOffset = 0
    for (let index = 0; index < tables; index += 1) {
      const record = fontStart + 12 + index * 16
      if (tagAt(record) === 'name') {
        nameOffset = view.getUint32(record + 8)
        break
      }
    }
    if (!nameOffset) return null
    const count = view.getUint16(nameOffset + 2)
    const stringsStart = nameOffset + view.getUint16(nameOffset + 4)
    for (let index = 0; index < count; index += 1) {
      const record = nameOffset + 6 + index * 12
      if (view.getUint16(record + 6) !== 6) continue
      const platformId = view.getUint16(record)
      const length = view.getUint16(record + 8)
      const start = stringsStart + view.getUint16(record + 10)
      let value = ''
      if (platformId === 3 || platformId === 0) {
        for (let cursor = 0; cursor + 1 < length; cursor += 2) value += String.fromCharCode(view.getUint16(start + cursor))
      } else {
        for (let cursor = 0; cursor < length; cursor += 1) value += String.fromCharCode(view.getUint8(start + cursor))
      }
      value = value.trim()
      if (value) return value
    }
  } catch {
    return null
  }
  return null
}

export function fontWeightOf(name, fauxBold) {
  const raw = String(name || '').toLowerCase()
  if (/heavy|black|extrabold|ultrabold/.test(raw)) return 800
  if (/semibold|demibold|bold/.test(raw)) return 700
  if (/medium/.test(raw)) return 500
  if (/light|thin/.test(raw)) return 300
  return fauxBold ? 700 : 400
}

// ag-psd decodes text fill colors as {r,g,b}, grayscale {k} or CMYK {c,m,y,k},
// all scaled 0-255 depending on the document's color mode.
function fillColorOf(fill) {
  if (!fill) return [0, 0, 0]
  if (fill.r != null) {
    return [Math.round(fill.r ?? 0), Math.round(fill.g ?? 0), Math.round(fill.b ?? 0)]
  }
  if (fill.k != null && fill.c == null) {
    const value = Math.round(fill.k)
    return [value, value, value]
  }
  if (fill.c != null) {
    const c = (fill.c ?? 0) / 255
    const m = (fill.m ?? 0) / 255
    const y = (fill.y ?? 0) / 255
    const k = (fill.k ?? 0) / 255
    return [
      Math.round(255 * (1 - c) * (1 - k)),
      Math.round(255 * (1 - m) * (1 - k)),
      Math.round(255 * (1 - y) * (1 - k)),
    ]
  }
  return [0, 0, 0]
}

export function parseColor(input) {
  if (Array.isArray(input)) return [input[0] | 0, input[1] | 0, input[2] | 0]
  const hex = String(input || '').replace(/^#/, '')
  const value = parseInt(hex, 16)
  if (!Number.isFinite(value)) return null
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function cssColor(color) {
  return `rgb(${color[0]},${color[1]},${color[2]})`
}

function describeTextStyle(raw) {
  const style = raw || {}
  return {
    family: fontFamilyOf(style.font ? style.font.name : ''),
    weight: fontWeightOf(style.font ? style.font.name : '', style.fauxBold),
    size: Math.round((style.fontSize || 0) * 100) / 100,
    color: fillColorOf(style.fillColor),
    tracking: style.tracking || 0,
  }
}

// styleRuns only carry the fields that differ from the base style, so each run
// must be merged over it. Flags absent from the run (like fauxBold) inherit
// from the PSD base style, so a font-only override keeps its weight.
function mergeTextStyle(base, raw, baseStyle) {
  const style = (raw && raw.style) || {}
  const has = (key) => style[key] !== undefined && style[key] !== null
  const merged = { ...base }
  if (has('font') && style.font && style.font.name) {
    merged.family = fontFamilyOf(style.font.name)
    merged.weight = fontWeightOf(style.font.name, has('fauxBold') ? style.fauxBold : baseStyle?.fauxBold)
  } else if (has('fauxBold')) {
    merged.weight = fontWeightOf(merged.family, style.fauxBold)
  }
  if (has('fontSize') && style.fontSize > 0) merged.size = Math.round(style.fontSize * 100) / 100
  if (has('fillColor') && style.fillColor) {
    merged.color = [
      Math.round(style.fillColor.r ?? 0),
      Math.round(style.fillColor.g ?? 0),
      Math.round(style.fillColor.b ?? 0),
    ]
  }
  if (has('tracking')) merged.tracking = style.tracking
  return merged
}

/**
 * Summarize a PSD text layer: content, one style entry per run, and the
 * paragraph alignment — the base data every override starts from.
 */
export function describeTextLayer(text) {
  const style = Array.isArray(text.style) ? text.style[0] : text.style || {}
  const paragraph = Array.isArray(text.paragraphStyle)
    ? text.paragraphStyle[0] || {}
    : text.paragraphStyle || {}
  const justification = String(paragraph.justification || '')
  const base = describeTextStyle(style)
  const value = String(text.text || '').replace(/\r$/, '').replace(/\r/g, '\n')
  const runs = []
  for (const run of text.styleRuns || []) {
    const length = Math.max(0, Math.round(run.length || 0))
    if (!length) continue
    runs.push({ len: length, ...mergeTextStyle(base, run, style) })
  }
  let total = runs.reduce((sum, run) => sum + run.len, 0)
  if (total !== value.length && runs.length) {
    if (total < value.length) {
      runs.push({ len: value.length - total, ...base })
    } else {
      let left = value.length
      for (let index = 0; index < runs.length && left > 0; index += 1) {
        runs[index].len = Math.min(runs[index].len, left)
        left -= runs[index].len
      }
      while (runs.length && runs[runs.length - 1].len <= 0) runs.pop()
    }
  }
  if (!runs.length && value.length) runs.push({ len: value.length, ...base })
  // Fixed leading only; auto leading (the default) stays 0 and the layout
  // uses 1.2 × the line's largest size.
  const leading = style.autoLeading === false && style.leading > 0 ? Math.round(style.leading * 100) / 100 : 0
  return {
    value,
    runs,
    align: /center/i.test(justification) ? 'center' : /right/i.test(justification) ? 'right' : 'left',
    leading,
  }
}

/**
 * Canvas px per PSD pt for a text layer, from its ORIGINAL geometry only:
 * raster height ≈ lines × largest pt × 1.2. Edits never feed back into this,
 * so a pixel size asked for by a caller lands as exactly that many pixels.
 */
export function pxPerPtOf(base, rasterHeight) {
  const lines = Math.max(1, String(base.value || '字').split('\n').length)
  const maxPt = (base.runs || []).reduce((max, run) => Math.max(max, run.size || 0), 0) || 24
  return rasterHeight > 0 ? rasterHeight / (lines * maxPt * 1.2) : 1
}

// ---------------------------------------------------------------------------
// Run editing
// ---------------------------------------------------------------------------

function sameStyle(a, b) {
  return (
    a.family === b.family &&
    a.weight === b.weight &&
    a.size === b.size &&
    a.tracking === b.tracking &&
    a.color[0] === b.color[0] &&
    a.color[1] === b.color[1] &&
    a.color[2] === b.color[2]
  )
}

/**
 * Merge consecutive per-character styles into style runs. The length always
 * comes from the characters counted here: per-character entries are often the
 * original runs themselves, whose own `len` must not leak back in.
 */
export function compressRuns(chars) {
  const runs = []
  for (const { len: _len, ...style } of chars) {
    const last = runs[runs.length - 1]
    if (last && sameStyle(last, style)) last.len += 1
    else runs.push({ ...style, len: 1 })
  }
  return runs
}

/**
 * Keep per-character styles intact when the text changes: untouched head and
 * tail keep their runs, inserted characters inherit their neighbour.
 */
export function remapRuns(runs, oldText, newText) {
  const chars = []
  for (const run of runs || []) {
    for (let index = 0; index < run.len; index += 1) chars.push(run)
  }
  while (chars.length < oldText.length && chars.length) chars.push(chars[chars.length - 1])
  if (!chars.length) return []

  let head = 0
  while (head < oldText.length && head < newText.length && oldText[head] === newText[head]) head += 1
  let tail = 0
  while (
    tail < oldText.length - head &&
    tail < newText.length - head &&
    oldText[oldText.length - 1 - tail] === newText[newText.length - 1 - tail]
  ) {
    tail += 1
  }

  const inserted = newText.length - head - tail
  const inherit = chars[head - 1] || chars[head] || chars[0]
  const out = chars.slice(0, head)
  for (let index = 0; index < inserted; index += 1) out.push(inherit)
  out.push(...chars.slice(oldText.length - tail))
  while (out.length < newText.length) out.push(inherit)
  return compressRuns(out.slice(0, newText.length))
}

/** Expand style runs into one style per character, clamped to the value. */
export function charStyles(runs, value) {
  const out = []
  const source = runs && runs.length ? runs : []
  for (const run of source) {
    for (let index = 0; index < run.len && out.length < value.length; index += 1) out.push(run)
  }
  while (out.length < value.length && source.length) out.push(source[source.length - 1])
  return out
}

const ALIGNS = new Set(['left', 'center', 'right'])

function sizeOf(row, pxPerPt) {
  if (row.sizePx != null && Number(row.sizePx) > 0 && pxPerPt > 0) {
    return Math.round((Number(row.sizePx) / pxPerPt) * 100) / 100
  }
  if (row.size != null && Number(row.size) > 0) return Number(row.size)
  return null
}

/**
 * Merge a tool/panel override into the base text description.
 *
 * `value` rewrites the copy (styles follow their characters), `runs` restyles
 * consecutive segments `[{len, family?, weight?, size?, sizePx?, color?,
 * tracking?}]` from the first character, and the flat `font`/`weight`/`size`/
 * `sizePx`/`color`/`tracking` fields restyle every run. `size` is in PSD pt;
 * `sizePx` is in canvas px and needs `pxPerPt` (see `pxPerPtOf`), otherwise it
 * is ignored. `align`/`leading` (pt)/`dx`/`dy` (px) adjust the layout.
 * Colors accept `#rrggbb` or `[r,g,b]`. Returns null when nothing changes.
 */
export function mergeTextOverride(base, override = {}, pxPerPt = 0) {
  const value = override.value != null ? String(override.value) : base.value
  const layout = ['align', 'leading', 'dx', 'dy'].some((key) => override[key] != null)
  if (value === base.value && !override.runs && override.font == null && override.weight == null &&
    override.size == null && override.sizePx == null && override.color == null &&
    override.tracking == null && !layout) {
    return null
  }

  let runs = (value === base.value ? base.runs : remapRuns(base.runs, base.value, value)).map(
    (run) => ({ ...run }),
  )
  if (!runs.length && value.length) {
    const only = base.runs[0]
    runs = [{ len: value.length, ...(only || { family: null, weight: 400, size: 24, color: [0, 0, 0], tracking: 0 }) }]
  }

  if (Array.isArray(override.runs) && override.runs.length) {
    // Expand the inherited styles per character first, then restyle each
    // requested segment in place. The requested `len` always wins: spreading
    // an inherited run after it would put the run's own length back.
    const chars = charStyles(runs, value).map(({ len: _len, ...style }) => style)
    let offset = 0
    for (const row of override.runs) {
      const len = Math.max(0, Math.round(Number(row.len) || 0))
      if (!len || offset >= chars.length) continue
      const patch = {}
      if (row.family != null) patch.family = String(row.family)
      if (row.weight != null) patch.weight = Number(row.weight)
      const size = sizeOf(row, pxPerPt)
      if (size != null) patch.size = size
      if (row.tracking != null) patch.tracking = Number(row.tracking)
      if (row.color != null) {
        const parsed = parseColor(row.color)
        if (parsed) patch.color = parsed
      }
      const end = Math.min(chars.length, offset + len)
      for (let index = offset; index < end; index += 1) chars[index] = { ...chars[index], ...patch }
      offset = end
    }
    if (chars.length) runs = compressRuns(chars)
  }

  const patch = {}
  if (override.font != null) patch.family = String(override.font)
  if (override.weight != null) patch.weight = Number(override.weight)
  const size = sizeOf(override, pxPerPt)
  if (size != null) patch.size = size
  if (override.tracking != null) patch.tracking = Number(override.tracking)
  if (override.color != null) {
    const parsed = parseColor(override.color)
    if (parsed) patch.color = parsed
  }
  if (Object.keys(patch).length) {
    runs = runs.map((run) => ({ ...run, ...patch }))
  }
  return {
    value,
    runs,
    align: ALIGNS.has(override.align) ? override.align : base.align,
    leading: Number(override.leading) > 0 ? Number(override.leading) : base.leading || 0,
    dx: Number(override.dx) || 0,
    dy: Number(override.dy) || 0,
  }
}

// ---------------------------------------------------------------------------
// Layout and drawing
// ---------------------------------------------------------------------------

/** One segment = consecutive characters sharing family/weight/size/color. */
function segmentsOf(chars, pxPerPt) {
  const out = []
  for (const style of chars) {
    const px = Math.max(1, style.size * pxPerPt)
    const last = out[out.length - 1]
    if (
      last &&
      last.family === style.family &&
      last.weight === style.weight &&
      Math.abs(last.px - px) < 0.01 &&
      last.tracking === style.tracking &&
      last.color[0] === style.color[0] &&
      last.color[1] === style.color[1] &&
      last.color[2] === style.color[2]
    ) {
      last.text += style.ch
      continue
    }
    out.push({
      text: style.ch,
      family: style.family,
      weight: style.weight,
      px,
      tracking: style.tracking || 0,
      color: style.color,
    })
  }
  return out
}

function fontString(segment) {
  return `${segment.weight} ${segment.px}px "${segment.family || 'sans-serif'}", "PingFang SC", "Microsoft YaHei", sans-serif`
}

function applyTracking(ctx, segment) {
  try {
    ctx.letterSpacing = `${((segment.tracking / 1000) * segment.px).toFixed(2)}px`
  } catch {
    /* older runtimes ignore letter spacing */
  }
}

function drawSegments(ctx, segments, x, baseline) {
  let cursor = x
  for (const segment of segments) {
    ctx.font = fontString(segment)
    ctx.fillStyle = cssColor(segment.color)
    applyTracking(ctx, segment)
    ctx.fillText(segment.text, cursor, baseline)
    const trackPx = (segment.tracking / 1000) * segment.px
    cursor += ctx.measureText(segment.text).width + Math.max(0, segment.text.length) * trackPx
  }
}

function measureSegments(ctx, segments) {
  let width = 0
  for (const segment of segments) {
    ctx.font = fontString(segment)
    const trackPx = (segment.tracking / 1000) * segment.px
    width += ctx.measureText(segment.text).width + Math.max(0, segment.text.length) * trackPx
  }
  return width
}

/**
 * Re-render one text layer with live glyphs.
 *
 * @param {object} leaf the pixel leaf carrying the rasterized text
 *   (`{left, top, width, height, canvas, ...}`); restored/replaced in place.
 * @param {object} base the original text description from `describeTextLayer`.
 * @param {object} override the requested edit, see `mergeTextOverride`.
 * @param {(family: string) => boolean} [hasFont] font availability probe;
 *   unknown families still render (canvas fallback) but are reported.
 * @returns {string[]} warnings for fonts that could not be resolved.
 */
export function synthesizeTextLeaf(leaf, base, override, hasFont) {
  const raster = leaf.__raster || {
    left: leaf.left,
    top: leaf.top,
    width: leaf.width,
    height: leaf.height,
  }
  // Point size → canvas px comes from the ORIGINAL geometry only, so editing
  // the value never rescales existing glyphs (price bars keep their size) and
  // a `sizePx` override is drawn at exactly that pixel size.
  const pxPerPt = pxPerPtOf(base, raster.height)
  const effective = mergeTextOverride(base, override, pxPerPt)
  if (!effective) {
    restoreTextLeaf(leaf)
    return []
  }

  const warnings = []
  const seen = new Set()
  for (const run of effective.runs) {
    if (!run.family || seen.has(run.family)) continue
    seen.add(run.family)
    if (hasFont && !hasFont(run.family)) {
      warnings.push(`字体 ${run.family} 未注册，该段将用回退字体渲染`)
    }
  }

  const lines = effective.value.split('\n')
  const chars = charStyles(effective.runs, effective.value)

  const perLine = []
  let cursor = 0
  for (const line of lines) {
    const slice = []
    for (let index = 0; index < line.length; index += 1) {
      slice.push({ ch: line[index], ...chars[cursor] })
      cursor += 1
    }
    perLine.push(segmentsOf(slice, pxPerPt))
  }

  const scratch = makeCanvas(4, 4).getContext('2d')
  const widths = perLine.map((segments) => measureSegments(scratch, segments))
  const maxW = Math.max(1, ...widths)
  const fixedLeading = effective.leading > 0 ? effective.leading * pxPerPt : 0
  const lineHeights = perLine.map(
    (segments) => fixedLeading || Math.max(1, ...segments.map((segment) => segment.px)) * 1.2,
  )
  const totalH = lineHeights.reduce((sum, height) => sum + height, 0)
  const maxPx = Math.max(1, ...perLine.flatMap((segments) => segments.map((segment) => segment.px)))
  const pad = Math.ceil(maxPx * 0.25) + 2

  const canvas = makeCanvas(Math.max(1, Math.ceil(maxW) + pad * 2), Math.max(1, Math.ceil(totalH) + pad * 2))
  const ctx = canvas.getContext('2d')
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  let top = pad
  for (let index = 0; index < perLine.length; index += 1) {
    const segments = perLine[index]
    const lineHeight = lineHeights[index]
    const baseline = top + lineHeight * 0.82
    let x = pad
    if (effective.align === 'center') x = pad + (maxW - widths[index]) / 2
    else if (effective.align === 'right') x = pad + (maxW - widths[index])
    drawSegments(ctx, segments, x, baseline)
    top += lineHeight
  }

  // Anchor the ink box where the raster sat: left/right aligns to that edge,
  // center keeps the middle, at natural size.
  let left = raster.left + raster.width / 2 - canvas.width / 2
  if (effective.align === 'left') left = raster.left - pad
  else if (effective.align === 'right') left = raster.left + raster.width - canvas.width + pad

  leaf.canvas = canvas
  leaf.left = Math.round(left + effective.dx)
  leaf.top = Math.round(raster.top + raster.height / 2 - canvas.height / 2 + effective.dy)
  leaf.width = canvas.width
  leaf.height = canvas.height
  return warnings
}

/** Put a text leaf back onto its original raster pixels. */
export function restoreTextLeaf(leaf) {
  if (!leaf.__raster) return
  leaf.canvas = leaf.__raster.canvas
  leaf.left = leaf.__raster.left
  leaf.top = leaf.__raster.top
  leaf.width = leaf.__raster.width
  leaf.height = leaf.__raster.height
}

/**
 * Apply text overrides to a document, replacing rasterized text layers with
 * live re-rendered glyphs. Leaves remember their raster under `__raster`, so
 * re-applying (or clearing an override) always starts from the pristine
 * pixels. Mutates `doc`; clone it first when working from a cache.
 *
 * @param {object} doc parsed template document.
 * @param {Array<object>} overrides `[{layer, value?, runs?, font?, weight?, size?, color?, tracking?}]`
 *   where `layer` is a leaf id (`l3`), entry id (`e7`) or layer name.
 * @returns {string[]} warnings.
 */
export function applyTextOverrides(doc, overrides, hasFont) {
  const warnings = []
  const list = Array.isArray(overrides) ? overrides : []
  for (const override of list) {
    const target = String(override.layer ?? '')
    const entry = doc.entries.find(
      (item) => item.id === target || item.leafId === target || item.name === target,
    )
    if (!entry) {
      warnings.push(`文字层不存在：${target}`)
      continue
    }
    if (!entry.text || !entry.leafId) {
      warnings.push(`${entry.name}：没有栅格像素或文字数据，跳过`)
      continue
    }
    const leaf = doc.leaves.find((item) => item.id === entry.leafId)
    if (!leaf) {
      warnings.push(`${entry.name}：找不到对应图层，跳过`)
      continue
    }
    if (!leaf.__raster) {
      leaf.__raster = {
        canvas: leaf.canvas,
        left: leaf.left,
        top: leaf.top,
        width: leaf.width,
        height: leaf.height,
      }
    } else {
      restoreTextLeaf(leaf)
    }
    try {
      warnings.push(...synthesizeTextLeaf(leaf, entry.text, override, hasFont))
    } catch (error) {
      restoreTextLeaf(leaf)
      warnings.push(`${entry.name}：重绘失败（${error?.message || error}），保留原像素`)
    }
  }
  return warnings
}

/**
 * Shallow-clone a parsed document so per-SKU overrides can mutate leaves
 * without touching the cached original. Canvases are shared by reference.
 */
export function cloneDoc(doc) {
  return {
    ...doc,
    slots: new Set(doc.slots),
    hidden: new Set(doc.hidden),
    entries: doc.entries.map((entry) => ({ ...entry })),
    leaves: doc.leaves.map((leaf) => ({ ...leaf })),
  }
}

/**
 * Merge a global override list with a per-SKU list; per-SKU entries win per
 * layer target. Returns null when the merged list is empty.
 */
export function mergeOverrideLists(globalList, skuList) {
  const globalOverrides = Array.isArray(globalList) ? globalList : []
  const skuOverrides = Array.isArray(skuList) ? skuList : []
  if (!globalOverrides.length && !skuOverrides.length) return null
  if (!skuOverrides.length) return globalOverrides
  if (!globalOverrides.length) return skuOverrides
  const byTarget = new Map()
  for (const override of globalOverrides) byTarget.set(String(override.layer), override)
  for (const override of skuOverrides) byTarget.set(String(override.layer), override)
  return [...byTarget.values()]
}
