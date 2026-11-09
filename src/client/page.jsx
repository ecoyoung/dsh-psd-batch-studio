import React from 'react'
import {
  parseTemplate,
  buildScene,
  suggestSlots,
  isEntryVisible,
  disposeScene,
} from '../core/psd.js'
import {
  DEFAULT_SETTINGS,
  DEFAULT_ADJUST,
  drawScene,
  productBox,
  measureContent,
} from '../core/fit.js'
import {
  renderItem,
  canvasToBlob,
  downloadBlob,
  sanitizeName,
  uniqueName,
  zipFiles,
} from '../core/export.js'
import { applyTextOverrides, restoreTextLeaf, mergeTextOverride, fontFamilyOf } from '../core/text.js'
import { CSS } from './styles.js'
import { Icon } from './icons.jsx'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function brandColor() {
  try {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--dsw-alias-brand-primary')
      .trim()
    return value || '#4b5ef5'
  } catch {
    return '#4b5ef5'
  }
}
let sequence = 0
const uid = () => `sku-${Date.now().toString(36)}-${sequence++}`

/** Survives a panel switch: the parsed template and the SKU queue stay put. */
const cache = {
  doc: null,
  items: [],
  selectedId: null,
  settings: DEFAULT_SETTINGS,
  view: { zoom: 1, panX: 0, panY: 0 },
  format: 'jpeg',
  showSlots: true,
  textEdits: {},
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

function productScreens(doc, item, bitmap, content, settings, view) {
  return doc.scene.slots.map((part) => {
    const box = productBox(part.rect, bitmap, content, settings, item.adjust)
    return {
      part,
      box,
      x: view.ox + box.x * view.scale,
      y: view.oy + box.y * view.scale,
      w: box.w * view.scale,
      h: box.h * view.scale,
    }
  })
}

function hitTestProduct(doc, item, bitmap, content, settings, point, view) {
  if (!doc || !item || !bitmap) return null
  for (const screen of productScreens(doc, item, bitmap, content, settings, view)) {
    const corners = [
      [screen.x, screen.y],
      [screen.x + screen.w, screen.y],
      [screen.x, screen.y + screen.h],
      [screen.x + screen.w, screen.y + screen.h],
    ]
    if (corners.some(([cx, cy]) => Math.hypot(cx - point.x, cy - point.y) <= 12)) {
      return { mode: 'scale', screen }
    }
    if (
      point.x >= screen.x &&
      point.x <= screen.x + screen.w &&
      point.y >= screen.y &&
      point.y <= screen.y + screen.h
    ) {
      return { mode: 'move', screen }
    }
  }
  return null
}

/**
 * One editable text layer: value input plus an advanced runs editor whose JSON
 * shape matches the psd_batch_render `text` parameter.
 */
function TextRow({ entry, edit, onCommit, onRemove, t }) {
  const base = entry.text
  const [value, setValue] = React.useState(edit?.value ?? '')
  const [runsOpen, setRunsOpen] = React.useState(false)
  const [runsDraft, setRunsDraft] = React.useState('')

  const effective = React.useMemo(() => {
    if (!edit) return base
    const override = {}
    if (edit.value != null && edit.value !== '') override.value = edit.value
    if (edit.runsRaw != null && edit.runsRaw.trim()) {
      try {
        const runs = JSON.parse(edit.runsRaw)
        if (Array.isArray(runs)) override.runs = runs
      } catch {
        /* invalid drafts fall back to the base styles for the badge */
      }
    }
    return mergeTextOverride(base, override) || base
  }, [base, edit])

  const missingFonts = React.useMemo(() => {
    const seen = new Set()
    const missing = []
    for (const run of effective.runs || []) {
      if (!run.family || seen.has(run.family)) continue
      seen.add(run.family)
      try {
        if (!document.fonts.check(`400 16px "${run.family}"`)) missing.push(run.family)
      } catch {
        /* assume available when the probe is unsupported */
      }
    }
    return missing
  }, [effective])

  return (
    <div className="psb-text-row">
      <div className="psb-text-line">
        <span className="psb-text-name" title={entry.name}>
          {entry.name}
        </span>
        {missingFonts.length ? (
          <span
            className="psb-text-warn"
            title={t('text.fontMissing', { fonts: missingFonts.join(', ') })}
          >
            ⚠
          </span>
        ) : null}
        <button
          className={`psb-icon-btn ${edit?.runsRaw ? 'on' : ''}`}
          onClick={() => {
            if (!runsOpen) setRunsDraft(edit?.runsRaw ?? '')
            setRunsOpen((open) => !open)
          }}
          title={t('panel.textRuns')}
        >
          {'{}'}
        </button>
        <button className="psb-icon-btn" onClick={onRemove} title={t('action.reset')}>
          ↺
        </button>
      </div>
      <input
        className="psb-text-input"
        value={value}
        placeholder={base.value}
        title={base.value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (value !== (edit?.value ?? '')) onCommit({ value })
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.target.blur()
        }}
      />
      {runsOpen ? (
        <div className="psb-text-runs">
          <textarea
            className="psb-text-runs-input"
            rows={3}
            value={runsDraft}
            placeholder={JSON.stringify(
              (base.runs || []).map(({ len, family, weight, size }) => ({ len, family, weight, size })),
            )}
            onChange={(event) => setRunsDraft(event.target.value)}
          />
          <button
            className="psb-btn ghost small"
            onClick={() => {
              onCommit({ runsRaw: runsDraft })
              setRunsOpen(false)
            }}
          >
            {t('action.applyRuns')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function createStudio(ctx, t) {
  return function StudioPage() {
    const localeRevision = React.useSyncExternalStore(
      React.useCallback((notify) => ctx.locale.subscribe(notify), []),
      React.useCallback(() => ctx.locale.getSnapshot().revision, []),
      () => 0,
    )

    const [doc, setDoc] = React.useState(cache.doc)
    const [items, setItems] = React.useState(cache.items)
    const [selectedId, setSelectedId] = React.useState(cache.selectedId)
    const [settings, setSettings] = React.useState(cache.settings)
    const [view, setView] = React.useState(cache.view)
    const [format, setFormat] = React.useState(cache.format)
    const [showSlots, setShowSlots] = React.useState(cache.showSlots)
    const [textEdits, setTextEdits] = React.useState(cache.textEdits)

    const [size, setSize] = React.useState({ w: 0, h: 0 })
    const [bitmap, setBitmap] = React.useState(null)
    const [content, setContent] = React.useState(null)
    const [busy, setBusy] = React.useState(null)
    const [toast, setToast] = React.useState(null)
    const [query, setQuery] = React.useState('')
    const [dragOver, setDragOver] = React.useState(false)

    const wrapRef = React.useRef(null)
    const canvasRef = React.useRef(null)
    const psdInputRef = React.useRef(null)
    const imgInputRef = React.useRef(null)
    const fontInputRef = React.useRef(null)
    const dragRef = React.useRef(null)
    const viewRef = React.useRef({ scale: 1, ox: 0, oy: 0, base: 1, w: 0, h: 0 })
    const cancelRef = React.useRef(false)
    const sceneRef = React.useRef(null)
    const selectedItem = items.find((item) => item.id === selectedId) || null
    const scene = doc?.scene || null

    React.useEffect(() => {
      cache.doc = doc
      cache.items = items
      cache.selectedId = selectedId
      cache.settings = settings
      cache.view = view
      cache.format = format
      cache.showSlots = showSlots
      cache.textEdits = textEdits
    }, [doc, items, selectedId, settings, view, format, showSlots, textEdits])

    // Dispose the previous composite when a new one replaces it.
    React.useEffect(() => {
      const current = scene
      if (sceneRef.current && sceneRef.current !== current) disposeScene(sceneRef.current)
      sceneRef.current = current
    }, [scene])

    React.useEffect(() => {
      const element = wrapRef.current
      if (!element) return undefined
      const observer = new ResizeObserver((entries) => {
        const rect = entries[0].contentRect
        setSize({ w: Math.round(rect.width), h: Math.round(rect.height) })
      })
      observer.observe(element)
      return () => observer.disconnect()
    }, [])

    React.useEffect(() => {
      if (!toast) return undefined
      const timer = setTimeout(() => setToast(null), 3600)
      return () => clearTimeout(timer)
    }, [toast])

    // Load the selected SKU at full resolution for the live preview.
    React.useEffect(() => {
      if (!selectedItem) {
        setBitmap(null)
        setContent(null)
        return undefined
      }
      let cancelled = false
      createImageBitmap(selectedItem.file)
        .then((next) => {
          if (cancelled) {
            next.close()
            return
          }
          setContent(measureContent(next))
          setBitmap((previous) => {
            if (previous && previous !== next) previous.close()
            return next
          })
        })
        .catch(() => {
          if (!cancelled) setBitmap(null)
        })
      return () => {
        cancelled = true
      }
    }, [selectedItem?.id])

    const draw = React.useCallback(() => {
      const canvas = canvasRef.current
      if (!canvas || !size.w || !size.h) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const pixelWidth = Math.max(1, Math.round(size.w * dpr))
      const pixelHeight = Math.max(1, Math.round(size.h * dpr))
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight
      const ctx2d = canvas.getContext('2d')
      if (!ctx2d) return
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx2d.clearRect(0, 0, size.w, size.h)
      if (!doc || !scene) return

      const pad = 30
      const base = Math.min((size.w - pad * 2) / doc.width, (size.h - pad * 2) / doc.height)
      const scale = base * view.zoom
      const ox = (size.w - doc.width * scale) / 2 + view.panX
      const oy = (size.h - doc.height * scale) / 2 + view.panY
      viewRef.current = { base, scale, ox, oy, w: size.w, h: size.h }

      // Paper
      ctx2d.save()
      ctx2d.shadowColor = 'rgba(15, 23, 42, 0.18)'
      ctx2d.shadowBlur = 22
      ctx2d.shadowOffsetY = 8
      ctx2d.fillStyle = '#ffffff'
      ctx2d.fillRect(ox, oy, doc.width * scale, doc.height * scale)
      ctx2d.restore()

      ctx2d.save()
      ctx2d.translate(ox, oy)
      ctx2d.scale(scale, scale)
      ctx2d.beginPath()
      ctx2d.rect(0, 0, doc.width, doc.height)
      ctx2d.clip()
      drawScene(
        ctx2d,
        scene,
        bitmap,
        content,
        settings,
        selectedItem ? selectedItem.adjust : DEFAULT_ADJUST,
      )
      ctx2d.restore()

      const slots = scene.parts.filter((part) => part.kind === 'slot')
      if (slots.length === 0) return
      const accent = brandColor()

      for (const part of slots) {
        const screen = {
          x: ox + part.rect.x * scale,
          y: oy + part.rect.y * scale,
        }
        if (!showSlots) continue
        const width = part.rect.w * scale
        const height = part.rect.h * scale
        ctx2d.save()
        ctx2d.strokeStyle = accent
        ctx2d.globalAlpha = 0.85
        ctx2d.lineWidth = 1.35
        ctx2d.setLineDash([6, 4])
        ctx2d.strokeRect(screen.x + 0.5, screen.y + 0.5, width, height)
        ctx2d.restore()

        const label = t('canvas.slot')
        ctx2d.save()
        ctx2d.font = '600 10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
        ctx2d.textBaseline = 'middle'
        const textWidth = ctx2d.measureText(label).width
        const labelY = screen.y > 22 ? screen.y - 19 : screen.y + 3
        roundRect(ctx2d, screen.x, labelY, textWidth + 12, 15, 4)
        ctx2d.fillStyle = accent
        ctx2d.fill()
        ctx2d.fillStyle = '#fff'
        ctx2d.fillText(label, screen.x + 6, labelY + 8)
        ctx2d.restore()
      }

      if (bitmap && selectedItem) {
        for (const part of slots) {
          const box = productBox(
            part.rect,
            bitmap,
            content,
            settings,
            selectedItem.adjust,
          )
          const sx = ox + box.x * scale
          const sy = oy + box.y * scale
          const sw = box.w * scale
          const sh = box.h * scale
          ctx2d.save()
          ctx2d.strokeStyle = accent
          ctx2d.lineWidth = 1.5
          ctx2d.strokeRect(sx + 0.5, sy + 0.5, sw, sh)
          for (const [hx, hy] of [
            [sx, sy],
            [sx + sw, sy],
            [sx, sy + sh],
            [sx + sw, sy + sh],
          ]) {
            ctx2d.fillStyle = '#ffffff'
            ctx2d.strokeStyle = accent
            ctx2d.lineWidth = 1.5
            ctx2d.beginPath()
            ctx2d.rect(hx - 3.5, hy - 3.5, 7, 7)
            ctx2d.fill()
            ctx2d.stroke()
          }
          ctx2d.restore()
        }
      } else if (items.length === 0 && slots.length > 0) {
        const part = slots[0]
        const cx = ox + (part.rect.x + part.rect.w / 2) * scale
        const cy = oy + (part.rect.y + part.rect.h / 2) * scale
        const label = t('canvas.ghost')
        ctx2d.save()
        ctx2d.font = '500 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
        const textWidth = ctx2d.measureText(label).width
        roundRect(ctx2d, cx - textWidth / 2 - 14, cy - 15, textWidth + 28, 30, 15)
        ctx2d.fillStyle = 'rgba(15, 23, 42, 0.55)'
        ctx2d.fill()
        ctx2d.fillStyle = '#ffffff'
        ctx2d.textAlign = 'center'
        ctx2d.textBaseline = 'middle'
        ctx2d.fillText(label, cx, cy)
        ctx2d.restore()
      }
    }, [doc, scene, bitmap, content, selectedItem, settings, view, size, showSlots, items.length, t, localeRevision])

    React.useEffect(() => {
      draw()
    }, [draw])

    // Wheel zoom needs a non-passive listener so the page does not scroll.
    React.useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas || !doc) return undefined
      const onWheel = (event) => {
        event.preventDefault()
        const rect = canvas.getBoundingClientRect()
        const px = event.clientX - rect.left
        const py = event.clientY - rect.top
        const current = viewRef.current
        if (!current.scale) return
        const docX = (px - current.ox) / current.scale
        const docY = (py - current.oy) / current.scale
        setView((previous) => {
          const zoom = clamp(previous.zoom * Math.exp(-event.deltaY * 0.0014), 0.2, 8)
          const nextScale = current.base * zoom
          return {
            zoom,
            panX: px - docX * nextScale - (current.w - doc.width * nextScale) / 2,
            panY: py - docY * nextScale - (current.h - doc.height * nextScale) / 2,
          }
        })
      }
      canvas.addEventListener('wheel', onWheel, { passive: false })
      return () => canvas.removeEventListener('wheel', onWheel)
    }, [doc])

    const applyDoc = React.useCallback((next) => {
      next.scene = buildScene(next)
      setDoc(next)
    }, [])

    const setAdjust = React.useCallback(
      (patch) => {
        setItems((previous) =>
          previous.map((item) =>
            item.id === selectedId
              ? { ...item, adjust: { ...item.adjust, ...patch } }
              : item,
          ),
        )
      },
      [selectedId],
    )

    const loadTemplate = React.useCallback(
      async (file) => {
        if (!file) return
        if (!/\.(psd|psb)$/i.test(file.name)) {
          setToast({ type: 'error', text: t('toast.notPsd') })
          return
        }
        setBusy({ label: t('busy.parse') })
        try {
          const next = await parseTemplate(file, (stage) => setBusy({ label: stage }))
          setBusy({ label: t('busy.compose') })
          await new Promise((resolve) => setTimeout(resolve, 24))
          next.slots = new Set(suggestSlots(next))
          next.scene = buildScene(next)
          setDoc(next)
          setTextEdits({})
          setQuery('')
          setView({ zoom: 1, panX: 0, panY: 0 })
          setToast({
            type: 'ok',
            text: t('toast.templateLoaded', {
              w: next.width,
              h: next.height,
              layers: next.leaves.length,
            }),
          })
        } catch (error) {
          setToast({
            type: 'error',
            text: t('toast.parseFailed', { message: error?.message || String(error) }),
          })
        } finally {
          setBusy(null)
        }
      },
      [t],
    )

    const addSkus = React.useCallback(
      (fileList) => {
        const files = Array.from(fileList || []).filter(
          (file) =>
            !/\.(psd|psb)$/i.test(file.name) &&
            (/^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name)),
        )
        if (files.length === 0) {
          setToast({ type: 'error', text: t('toast.notImage') })
          return
        }
        const added = files.map((file) => ({
          id: uid(),
          name: file.name,
          file,
          url: URL.createObjectURL(file),
          adjust: { ...DEFAULT_ADJUST },
        }))
        setItems((previous) => [...previous, ...added])
        setSelectedId((previous) => previous ?? added[0]?.id ?? null)
        setToast({ type: 'ok', text: t('toast.skusAdded', { count: added.length }) })
      },
      [t],
    )

    const removeItem = React.useCallback(
      (id) => {
        const target = items.find((item) => item.id === id)
        if (target) URL.revokeObjectURL(target.url)
        const next = items.filter((item) => item.id !== id)
        setItems(next)
        if (selectedId === id) setSelectedId(next[0]?.id ?? null)
      },
      [items, selectedId],
    )

    const clearItems = React.useCallback(() => {
      for (const item of items) URL.revokeObjectURL(item.url)
      setItems([])
      setSelectedId(null)
      setToast({ type: 'ok', text: t('toast.cleared') })
    }, [items, t])

    const toggleHidden = React.useCallback(
      (entryId) => {
        if (!doc) return
        const hidden = new Set(doc.hidden)
        if (hidden.has(entryId)) hidden.delete(entryId)
        else hidden.add(entryId)
        applyDoc({ ...doc, hidden })
      },
      [doc, applyDoc],
    )

    const toggleSlot = React.useCallback(
      (leafId) => {
        if (!doc) return
        const slots = new Set(doc.slots)
        if (slots.has(leafId)) slots.delete(leafId)
        else slots.add(leafId)
        applyDoc({ ...doc, slots })
      },
      [doc, applyDoc],
    )

    const autoDetect = React.useCallback(() => {
      if (!doc) return
      const slots = new Set(suggestSlots(doc))
      applyDoc({ ...doc, slots })
      setToast({ type: 'ok', text: t('toast.slotsDetected', { count: slots.size }) })
    }, [doc, applyDoc, t])

    const fontAvailable = React.useCallback((family) => {
      try {
        return document.fonts.check(`400 16px "${family}"`)
      } catch {
        return true
      }
    }, [])

    const textEntries = React.useMemo(
      () => (doc ? doc.entries.filter((entry) => entry.text && entry.leafId) : []),
      [doc],
    )

    // Re-render overridden text layers with live glyphs. Leaves keep their
    // raster under __raster, so every commit starts from the pristine pixels.
    const commitTextEdits = React.useCallback(
      (nextEdits) => {
        if (!doc) return
        const overrides = []
        for (const [entryId, edit] of Object.entries(nextEdits)) {
          const entry = doc.entries.find((item) => item.id === entryId)
          if (!entry?.text) continue
          const override = { layer: entryId }
          if (edit.value != null && edit.value !== '' && edit.value !== entry.text.value) {
            override.value = edit.value
          }
          if (edit.runsRaw != null && edit.runsRaw.trim()) {
            let runs
            try {
              runs = JSON.parse(edit.runsRaw)
            } catch {
              setToast({ type: 'error', text: t('toast.runsInvalid') })
              return
            }
            if (!Array.isArray(runs)) {
              setToast({ type: 'error', text: t('toast.runsInvalid') })
              return
            }
            override.runs = runs
          }
          // Push even when nothing changed: an empty override restores the
          // raster, so editing back to the original undoes the rewrite.
          overrides.push(override)
        }
        setTextEdits(nextEdits)
        const warnings = applyTextOverrides(doc, overrides, fontAvailable)
        applyDoc({ ...doc })
        if (warnings.length) {
          setToast({ type: 'error', text: t('toast.textWarn', { count: warnings.length }) })
        }
      },
      [doc, applyDoc, fontAvailable, t],
    )

    const resetTextEntry = React.useCallback(
      (entryId) => {
        if (!doc) return
        const next = { ...textEdits }
        delete next[entryId]
        setTextEdits(next)
        const entry = doc.entries.find((item) => item.id === entryId)
        const leaf = entry?.leafId ? doc.leaves.find((item) => item.id === entry.leafId) : null
        if (leaf) restoreTextLeaf(leaf)
        applyDoc({ ...doc })
      },
      [doc, textEdits, applyDoc],
    )

    const resetAllText = React.useCallback(() => {
      if (!doc) return
      setTextEdits({})
      for (const entry of textEntries) {
        const leaf = doc.leaves.find((item) => item.id === entry.leafId)
        if (leaf) restoreTextLeaf(leaf)
      }
      applyDoc({ ...doc })
    }, [doc, textEntries, applyDoc])

    const loadFontFiles = React.useCallback(
      async (fileList) => {
        const files = Array.from(fileList || []).filter((file) => /\.(ttf|otf|ttc|woff2?)$/i.test(file.name))
        if (!files.length) {
          setToast({ type: 'error', text: t('toast.notFont') })
          return
        }
        let loaded = 0
        for (const file of files) {
          const match = file.name.match(/\.(ttf|otf|ttc|woff2?)$/i)
          const alias = file.name.slice(0, file.name.length - match[0].length).replace(/_+/g, ' ').trim() || 'font'
          try {
            const buffer = await file.arrayBuffer()
            const face = new FontFace(alias, buffer)
            await face.load()
            document.fonts.add(face)
            loaded += 1
            const mapped = fontFamilyOf(alias)
            if (mapped && mapped !== alias) {
              try {
                const alt = new FontFace(mapped, buffer.slice(0))
                await alt.load()
                document.fonts.add(alt)
              } catch {
                /* the mapped alias may collide with a system family */
              }
            }
          } catch {
            /* skip unreadable font files */
          }
        }
        if (loaded) {
          setToast({ type: 'ok', text: t('toast.fontsLoaded', { count: loaded }) })
          if (Object.keys(textEdits).length) commitTextEdits(textEdits)
        } else {
          setToast({ type: 'error', text: t('toast.notFont') })
        }
      },
      [textEdits, commitTextEdits, t],
    )

    const resetView = React.useCallback(() => setView({ zoom: 1, panX: 0, panY: 0 }), [])

    const runExport = React.useCallback(
      async (list, single = false) => {
        if (!doc || !doc.scene) return
        if (list.length === 0) {
          setToast({ type: 'error', text: t('toast.noItems') })
          return
        }
        if (doc.slots.size === 0) {
          setToast({ type: 'error', text: t('toast.needSlot') })
          return
        }
        cancelRef.current = false
        const ext = format === 'png' ? 'png' : 'jpg'
        const mime = format === 'png' ? 'image/png' : 'image/jpeg'
        try {
          if (single) {
            const item = list[0]
            setBusy({ label: t('busy.export', { done: 0, total: 1 }), progress: 0 })
            const image = await createImageBitmap(item.file)
            const canvas = renderItem(doc, doc.scene, image, settings, item.adjust, format === 'jpeg')
            const blob = await canvasToBlob(canvas, mime, format === 'jpeg' ? 0.92 : undefined)
            image.close()
            downloadBlob(blob, `${sanitizeName(item.name)}.${ext}`)
            setToast({ type: 'ok', text: t('toast.exported', { count: 1 }) })
            return
          }

          const files = {}
          const used = new Set()
          for (let index = 0; index < list.length; index += 1) {
            if (cancelRef.current) return
            setBusy({
              label: t('busy.export', { done: index, total: list.length }),
              progress: list.length ? index / list.length : 0,
              cancelable: true,
            })
            const item = list[index]
            const image = await createImageBitmap(item.file)
            const canvas = renderItem(
              doc,
              doc.scene,
              image,
              settings,
              item.adjust,
              format === 'jpeg',
            )
            const blob = await canvasToBlob(canvas, mime, format === 'jpeg' ? 0.92 : undefined)
            image.close()
            files[uniqueName(used, sanitizeName(item.name), ext)] = new Uint8Array(
              await blob.arrayBuffer(),
            )
            canvas.width = 1
            canvas.height = 1
            if (index % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 0))
          }

          setBusy({ label: t('busy.zip'), progress: 1, cancelable: false })
          const data = await zipFiles(files)
          downloadBlob(new Blob([data], { type: 'application/zip' }), `${sanitizeName(doc.name)}-${list.length}.zip`)
          setToast({ type: 'ok', text: t('toast.exported', { count: list.length }) })
        } catch (error) {
          setToast({
            type: 'error',
            text: t('toast.exportFailed', { message: error?.message || String(error) }),
          })
        } finally {
          setBusy(null)
        }
      },
      [doc, format, settings, t],
    )

    const pointerPoint = (event) => {
      const rect = canvasRef.current.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const onPointerDown = (event) => {
      if (!doc) return
      event.preventDefault()
      wrapRef.current?.focus()
      const canvas = canvasRef.current
      const point = pointerPoint(event)
      const current = viewRef.current
      const hit =
        bitmap && selectedItem
          ? hitTestProduct(doc, selectedItem, bitmap, content, settings, point, current)
          : null
      canvas.setPointerCapture?.(event.pointerId)
      if (hit?.mode === 'scale' && selectedItem) {
        dragRef.current = {
          mode: 'scale',
          x: point.x,
          y: point.y,
          center: { x: hit.screen.x + hit.screen.w / 2, y: hit.screen.y + hit.screen.h / 2 },
          adjust: { ...selectedItem.adjust },
        }
        canvas.style.cursor = 'nwse-resize'
        return
      }
      if (hit?.mode === 'move' && selectedItem) {
        dragRef.current = { mode: 'move', x: point.x, y: point.y, adjust: { ...selectedItem.adjust } }
        canvas.style.cursor = 'grabbing'
        return
      }
      dragRef.current = { mode: 'pan', x: point.x, y: point.y, panX: view.panX, panY: view.panY }
      canvas.style.cursor = 'grabbing'
    }

    const onPointerMove = (event) => {
      const canvas = canvasRef.current
      const drag = dragRef.current
      const point = pointerPoint(event)
      if (!drag) {
        if (!doc) return
        const hit =
          bitmap && selectedItem
            ? hitTestProduct(doc, selectedItem, bitmap, content, settings, point, viewRef.current)
            : null
        canvas.style.cursor =
          hit?.mode === 'scale' ? 'nwse-resize' : hit?.mode === 'move' ? 'grab' : 'default'
        return
      }
      if (drag.mode === 'pan') {
        setView((previous) => ({
          ...previous,
          panX: drag.panX + (point.x - drag.x),
          panY: drag.panY + (point.y - drag.y),
        }))
        return
      }
      if (drag.mode === 'move') {
        const scale = viewRef.current.scale || 1
        const snap = 6 / scale
        let dx = drag.adjust.dx + (point.x - drag.x) / scale
        let dy = drag.adjust.dy + (point.y - drag.y) / scale
        if (Math.abs(dx) < snap) dx = 0
        if (Math.abs(dy) < snap) dy = 0
        setAdjust({ dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10 })
        return
      }
      if (drag.mode === 'scale') {
        const startDistance = Math.max(6, Math.hypot(drag.x - drag.center.x, drag.y - drag.center.y))
        const nextDistance = Math.hypot(point.x - drag.center.x, point.y - drag.center.y)
        const nextScale = clamp(drag.adjust.scale * (nextDistance / startDistance), 0.1, 5)
        setAdjust({ scale: Math.round(nextScale * 1000) / 1000 })
      }
    }

    const endDrag = (event) => {
      if (!dragRef.current) return
      dragRef.current = null
      try {
        canvasRef.current?.releasePointerCapture?.(event.pointerId)
      } catch {
        /* the pointer may already be released */
      }
      if (canvasRef.current) canvasRef.current.style.cursor = 'default'
    }

    const onKeyDown = (event) => {
      if (!selectedItem) return
      const step = event.shiftKey ? 10 : 1
      if (event.key === 'ArrowLeft') setAdjust({ dx: selectedItem.adjust.dx - step })
      else if (event.key === 'ArrowRight') setAdjust({ dx: selectedItem.adjust.dx + step })
      else if (event.key === 'ArrowUp') setAdjust({ dy: selectedItem.adjust.dy - step })
      else if (event.key === 'ArrowDown') setAdjust({ dy: selectedItem.adjust.dy + step })
      else return
      event.preventDefault()
    }

    const rows = React.useMemo(() => {
      if (!doc) return []
      const queryText = query.trim().toLowerCase()
      if (!queryText) return doc.entries
      const matched = new Set()
      for (const entry of doc.entries) {
        if (entry.name.toLowerCase().includes(queryText)) matched.add(entry.id)
      }
      const keep = new Set()
      for (const entry of doc.entries) {
        if (matched.has(entry.id)) for (const id of entry.path) keep.add(id)
      }
      return doc.entries.filter((entry) => keep.has(entry.id))
    }, [doc, query])

    const slotCount = doc?.slots.size || 0
    const zoomPercent = Math.round(view.zoom * 100)

    return (
      <div
        className="psb-root"
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          if (!dragOver) setDragOver(true)
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return
          setDragOver(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragOver(false)
          const files = Array.from(event.dataTransfer.files || [])
          const psd = files.find((file) => /\.(psd|psb)$/i.test(file.name))
          if (psd) loadTemplate(psd)
          const fonts = files.filter((file) => /\.(ttf|otf|ttc|woff2?)$/i.test(file.name))
          if (fonts.length) loadFontFiles(fonts)
          const images = files.filter(
            (file) =>
              !/\.(psd|psb)$/i.test(file.name) &&
              !/\.(ttf|otf|ttc|woff2?)$/i.test(file.name) &&
              /^image\//.test(file.type),
          )
          if (images.length) addSkus(images)
        }}
      >
        <style>{CSS}</style>

        <header className="psb-head">
          <Icon name="layers" size={20} style={{ color: 'var(--dsw-alias-brand-primary)' }} />
          <div className="psb-title">
            <b>{t('page.title')}</b>
            <span>
              {doc ? `${doc.name} · ${doc.width}×${doc.height}` : t('page.noTemplate')}
            </span>
          </div>
          <div className="psb-head-spacer" />
          <input
            ref={psdInputRef}
            type="file"
            accept=".psd,.psb"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) loadTemplate(file)
            }}
          />
          <input
            ref={imgInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              const files = Array.from(event.target.files || [])
              event.target.value = ''
              if (files.length) addSkus(files)
            }}
          />
          <input
            ref={fontInputRef}
            type="file"
            accept=".ttf,.otf,.ttc,.woff,.woff2"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              const files = Array.from(event.target.files || [])
              event.target.value = ''
              loadFontFiles(files)
            }}
          />
          <button className="psb-btn" onClick={() => psdInputRef.current?.click()}>
            <Icon name="image" size={14} />
            {t('action.loadTemplate')}
          </button>
          <button className="psb-btn" onClick={() => imgInputRef.current?.click()}>
            <Icon name="plus" size={14} />
            {t('action.addSkus')}
          </button>
          <select
            className="psb-select"
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            title={t('export.format')}
          >
            <option value="jpeg">{t('export.jpeg')}</option>
            <option value="png">{t('export.png')}</option>
          </select>
          <button
            className="psb-btn primary"
            disabled={!doc || items.length === 0}
            onClick={() => runExport(items)}
          >
            <Icon name="download" size={14} />
            {t('action.exportAll')}
          </button>
        </header>

        <div className="psb-body">
          <aside className="psb-left">
            <div className="psb-section-head">
              {t('panel.layers')}
              <span className="psb-count">{doc ? doc.entries.length : 0}</span>
            </div>
            {doc ? (
              <>
                <div className="psb-slot-summary">
                  <Icon name="target" size={14} style={{ color: 'var(--dsw-alias-brand-primary)' }} />
                  <span>
                    {t('panel.slots')} <b>{slotCount}</b>
                  </span>
                  <button className="psb-btn ghost small" onClick={autoDetect}>
                    {t('action.autoDetect')}
                  </button>
                </div>
                <input
                  className="psb-search"
                  value={query}
                  placeholder={t('panel.searchLayers')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="psb-layers">
                  {rows.map((entry) => {
                    const visible = isEntryVisible(doc, entry.id)
                    const isSlot = entry.leafId ? doc.slots.has(entry.leafId) : false
                    return (
                      <div
                        key={entry.id}
                        className={[
                          'psb-layer',
                          entry.kind === 'group' ? 'is-group' : '',
                          visible ? '' : 'is-hidden',
                          isSlot ? 'is-slot' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        style={{ paddingLeft: 2 + entry.depth * 13 }}
                        title={entry.name}
                      >
                        <span className="psb-layer-caret">
                          {entry.kind === 'group' ? '▾' : ''}
                        </span>
                        <button
                          className={`psb-icon-btn ${visible ? '' : 'on'}`}
                          onClick={() => toggleHidden(entry.id)}
                          title={visible ? t('layer.hide') : t('layer.show')}
                        >
                          <Icon name={visible ? 'eye' : 'eyeOff'} size={13} />
                        </button>
                        <span className="psb-layer-name">{entry.name}</span>
                        {entry.leafId ? (
                          <button
                            className={`psb-icon-btn ${isSlot ? 'on' : ''}`}
                            onClick={() => toggleSlot(entry.leafId)}
                            title={isSlot ? t('action.clearSlots') : t('panel.slots')}
                          >
                            <Icon name="target" size={13} />
                          </button>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
                <div className="psb-layers-hint">{t('panel.layersHint')}</div>
                <div className="psb-textpanel">
                  <div className="psb-text-head">
                    {t('panel.text')}
                    <span className="psb-count">{textEntries.length}</span>
                    <div className="psb-head-spacer" />
                    {Object.keys(textEdits).length ? (
                      <button className="psb-btn ghost small" onClick={resetAllText}>
                        {t('action.reset')}
                      </button>
                    ) : null}
                    <button
                      className="psb-btn ghost small"
                      onClick={() => fontInputRef.current?.click()}
                    >
                      {t('action.loadFonts')}
                    </button>
                  </div>
                  {textEntries.length === 0 ? (
                    <div className="psb-placeholder">{t('panel.textEmpty')}</div>
                  ) : (
                    textEntries.map((entry) => (
                      <TextRow
                        key={entry.id}
                        entry={entry}
                        edit={textEdits[entry.id]}
                        onCommit={(patch) =>
                          commitTextEdits({
                            ...textEdits,
                            [entry.id]: { ...textEdits[entry.id], ...patch },
                          })
                        }
                        onRemove={() => resetTextEntry(entry.id)}
                        t={t}
                      />
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="psb-placeholder">{t('panel.noTemplate')}</div>
            )}
          </aside>

          <main className="psb-main">
            <div
              className="psb-canvas-wrap"
              ref={wrapRef}
              tabIndex={0}
              onKeyDown={onKeyDown}
              style={dragOver ? { boxShadow: 'inset 0 0 0 2px var(--dsw-alias-brand-primary)' } : undefined}
            >
              <canvas
                ref={canvasRef}
                className="psb-canvas"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onDoubleClick={() => {
                  if (selectedItem) setAdjust(DEFAULT_ADJUST)
                }}
              />

              {doc ? (
                <>
                  <div className="psb-toolbar">
                    <button
                      className="psb-icon-btn"
                      onClick={() =>
                        setView((previous) => ({ ...previous, zoom: clamp(previous.zoom / 1.2, 0.2, 8) }))
                      }
                    >
                      <Icon name="zoomOut" size={15} />
                    </button>
                    <span className="psb-zoom">{zoomPercent}%</span>
                    <button
                      className="psb-icon-btn"
                      onClick={() =>
                        setView((previous) => ({ ...previous, zoom: clamp(previous.zoom * 1.2, 0.2, 8) }))
                      }
                    >
                      <Icon name="zoomIn" size={15} />
                    </button>
                    <button className="psb-btn ghost small" onClick={resetView}>
                      <Icon name="maximize" size={13} />
                      {t('action.fitView')}
                    </button>
                  </div>
                  <div className="psb-viewtoggle" onClick={() => setShowSlots((value) => !value)}>
                    <input type="checkbox" readOnly checked={showSlots} style={{ pointerEvents: 'none' }} />
                    {t('canvas.showSlots')}
                  </div>
                  <div className="psb-hintbar">{t('canvas.hint')}</div>
                </>
              ) : null}

              {!doc ? (
                <div className="psb-empty">
                  <div className="psb-empty-card">
                    <div className="psb-empty-icon">
                      <Icon name="layers" size={30} />
                    </div>
                    <h3>{t('canvas.emptyTitle')}</h3>
                    <p>{t('canvas.emptyDesc')}</p>
                    <button className="psb-btn primary" onClick={() => psdInputRef.current?.click()}>
                      {t('canvas.choosePsd')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </main>

          <aside className="psb-right">
            <div className="psb-section-head">
              {t('panel.queue')}
              <span className="psb-count">{items.length}</span>
              <div className="psb-head-spacer" />
              {items.length > 0 ? (
                <button className="psb-btn ghost small" onClick={clearItems}>
                  {t('action.clear')}
                </button>
              ) : null}
              <button className="psb-btn small" onClick={() => imgInputRef.current?.click()}>
                <Icon name="plus" size={13} />
                {t('action.addSkus')}
              </button>
            </div>

            <div className="psb-queue">
              {items.length === 0 ? (
                <div className="psb-queue-empty">
                  <Icon name="image" size={22} />
                  <span>{t('panel.queueEmpty')}</span>
                </div>
              ) : (
                items.map((item) => (
                  <div
                    key={item.id}
                    className={`psb-item ${item.id === selectedId ? 'is-on' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <img className="psb-thumb" src={item.url} alt="" loading="lazy" decoding="async" draggable={false} />
                    <div className="psb-item-main">
                      <span className="psb-item-name" title={item.name}>
                        {item.name}
                      </span>
                      <span className="psb-item-meta">
                        {item.adjust.dx || item.adjust.dy || item.adjust.scale !== 1
                          ? `${Math.round(item.adjust.dx)}, ${Math.round(item.adjust.dy)} · ${Math.round(item.adjust.scale * 100)}%`
                          : '—'}
                      </span>
                    </div>
                    <button
                      className="psb-icon-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeItem(item.id)
                      }}
                      title={t('action.clear')}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="psb-adjust">
              <div className="psb-adjust-head">
                <Icon name="cursor" size={14} />
                {t('panel.adjust')}
                <span className="psb-adjust-name">{selectedItem ? selectedItem.name : ''}</span>
              </div>

              {selectedItem ? (
                <>
                  <div className="psb-field">
                    <div className="psb-field-label">{t('field.fit')}</div>
                    <div className="psb-seg">
                      {['height', 'width', 'contain', 'cover'].map((mode) => (
                        <button
                          key={mode}
                          className={settings.mode === mode ? 'is-on' : ''}
                          onClick={() => setSettings({ ...settings, mode })}
                        >
                          {t(`fit.${mode}`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="psb-field">
                    <div className="psb-field-label">{t('field.anchor')}</div>
                    <div className="psb-seg">
                      {['bottom', 'center', 'top'].map((anchor) => (
                        <button
                          key={anchor}
                          className={settings.anchor === anchor ? 'is-on' : ''}
                          onClick={() => setSettings({ ...settings, anchor })}
                        >
                          {t(`anchor.${anchor}`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="psb-field">
                    <div className="psb-field-label">
                      {t('field.fill')}
                      <span>{Math.round(settings.fill * 100)}%</span>
                    </div>
                    <div className="psb-range-row">
                      <input
                        type="range"
                        min="40"
                        max="120"
                        step="1"
                        value={Math.round(settings.fill * 100)}
                        onChange={(event) =>
                          setSettings({ ...settings, fill: Number(event.target.value) / 100 })
                        }
                      />
                    </div>
                  </div>

                  <div className="psb-xy">
                    <div className="psb-field">
                      <div className="psb-field-label">{t('field.offsetX')}</div>
                      <input
                        className="psb-num"
                        type="number"
                        value={Math.round(selectedItem.adjust.dx)}
                        onChange={(event) => setAdjust({ dx: Number(event.target.value) || 0 })}
                      />
                    </div>
                    <div className="psb-field">
                      <div className="psb-field-label">{t('field.offsetY')}</div>
                      <input
                        className="psb-num"
                        type="number"
                        value={Math.round(selectedItem.adjust.dy)}
                        onChange={(event) => setAdjust({ dy: Number(event.target.value) || 0 })}
                      />
                    </div>
                  </div>

                  <div className="psb-field">
                    <div className="psb-field-label">
                      {t('field.scale')}
                      <span>{Math.round(selectedItem.adjust.scale * 100)}%</span>
                    </div>
                    <div className="psb-range-row">
                      <input
                        type="range"
                        min="10"
                        max="300"
                        step="1"
                        value={Math.round(selectedItem.adjust.scale * 100)}
                        onChange={(event) => setAdjust({ scale: Number(event.target.value) / 100 })}
                      />
                    </div>
                  </div>

                  <div className="psb-field">
                    <div className="psb-field-label">
                      {t('field.rotation')}
                      <span>{Math.round(selectedItem.adjust.rotation)}°</span>
                    </div>
                    <div className="psb-range-row">
                      <input
                        type="range"
                        min="-180"
                        max="180"
                        step="1"
                        value={Math.round(selectedItem.adjust.rotation)}
                        onChange={(event) => setAdjust({ rotation: Number(event.target.value) })}
                      />
                    </div>
                  </div>

                  <div className="psb-actions">
                    <button className="psb-btn" onClick={() => setAdjust(DEFAULT_ADJUST)}>
                      <Icon name="refresh" size={13} />
                      {t('action.reset')}
                    </button>
                    <button
                      className="psb-btn"
                      onClick={() => {
                        setItems((previous) =>
                          previous.map((item) => ({
                            ...item,
                            adjust: { ...selectedItem.adjust },
                          })),
                        )
                        setToast({ type: 'ok', text: t('toast.copied') })
                      }}
                    >
                      <Icon name="check" size={13} />
                      {t('action.syncAll')}
                    </button>
                  </div>
                  <div className="psb-actions">
                    <button className="psb-btn" onClick={() => runExport([selectedItem], true)}>
                      <Icon name="download" size={13} />
                      {t('action.exportOne')}
                    </button>
                  </div>
                </>
              ) : (
                <div className="psb-placeholder" style={{ padding: '6px 0' }}>
                  {t('panel.adjustEmpty')}
                </div>
              )}
            </div>
          </aside>
        </div>

        {toast ? (
          <div className={`psb-toast ${toast.type === 'error' ? 'is-error' : 'is-ok'}`}>
            <span className="psb-toast-icon">
              <Icon name={toast.type === 'error' ? 'alert' : 'check'} size={15} />
            </span>
            <span className="psb-toast-text">{toast.text}</span>
          </div>
        ) : null}

        {busy ? (
          <div className="psb-busy">
            <div className="psb-busy-card">
              <div className="psb-spinner" />
              <div className="psb-busy-label">{busy.label}</div>
              {typeof busy.progress === 'number' ? (
                <div className="psb-progress">
                  <i style={{ width: `${Math.round(busy.progress * 100)}%` }} />
                </div>
              ) : null}
              {busy.cancelable ? (
                <button
                  className="psb-btn ghost small"
                  onClick={() => {
                    cancelRef.current = true
                  }}
                >
                  {t('action.cancel')}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    )
  }
}
