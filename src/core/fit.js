/**
 * Product placement math and scene drawing shared by the live canvas and the
 * full-resolution exporter.
 *
 * SKU cut-outs usually carry transparent margins, so fitting uses the visible
 * content box (measured once per image) rather than the raw canvas size.
 */

export const FIT_MODES = ['height', 'width', 'contain', 'cover']
export const ANCHORS = ['bottom', 'center', 'top']

import { createCanvas } from './canvas.js'

export const DEFAULT_SETTINGS = { mode: 'contain', anchor: 'center', fill: 1 }

export const DEFAULT_ADJUST = { dx: 0, dy: 0, scale: 1, rotation: 0 }

/**
 * Alpha bounding box of an image at a reduced resolution, in image pixels.
 *
 * @returns {{x: number, y: number, w: number, h: number}} visible content box.
 */
export function measureContent(image, maxSize = 240) {
  const width = image.width || image.naturalWidth || 0
  const height = image.height || image.naturalHeight || 0
  if (!width || !height) return { x: 0, y: 0, w: 1, h: 1 }
  const ratio = Math.min(1, maxSize / Math.max(width, height))
  const sampleWidth = Math.max(1, Math.round(width * ratio))
  const sampleHeight = Math.max(1, Math.round(height * ratio))
  const canvas = createCanvas(sampleWidth, sampleHeight)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { x: 0, y: 0, w: width, h: height }
  ctx.drawImage(image, 0, 0, sampleWidth, sampleHeight)
  let pixels
  try {
    pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data
  } catch {
    return { x: 0, y: 0, w: width, h: height }
  }

  let minX = sampleWidth
  let minY = sampleHeight
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < sampleHeight; y += 1) {
    const row = y * sampleWidth * 4
    for (let x = 0; x < sampleWidth; x += 1) {
      if (pixels[row + x * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: width, h: height }

  const sx = width / sampleWidth
  const sy = height / sampleHeight
  // One sampled pixel of slack on each side keeps soft edges intact.
  const x = Math.max(0, Math.floor(minX * sx) - Math.ceil(sx))
  const y = Math.max(0, Math.floor(minY * sy) - Math.ceil(sy))
  const w = Math.min(width - x, Math.ceil((maxX - minX + 1) * sx) + 2 * Math.ceil(sx))
  const h = Math.min(height - y, Math.ceil((maxY - minY + 1) * sy) + 2 * Math.ceil(sy))
  return { x, y, w, h }
}

function contentOf(image, content) {
  if (content && content.w > 0 && content.h > 0) return content
  return { x: 0, y: 0, w: image.width, h: image.height }
}

export function baseScale(rect, content, settings) {
  const mode = settings.mode || 'contain'
  const fill = settings.fill ?? 1
  let scale
  if (mode === 'height') scale = rect.h / content.h
  else if (mode === 'width') scale = rect.w / content.w
  else if (mode === 'cover') scale = Math.max(rect.w / content.w, rect.h / content.h)
  else scale = Math.min(rect.w / content.w, rect.h / content.h)
  return scale * fill
}

/**
 * Resolve the product's draw rectangle and visible content box in document space.
 */
export function placement(rect, image, content, settings, adjust) {
  const box = contentOf(image, content)
  const anchor = settings.anchor || 'center'
  const scale = baseScale(rect, box, settings) * (adjust.scale ?? 1)
  const contentWidth = box.w * scale
  const contentHeight = box.h * scale
  const left = rect.x + (rect.w - contentWidth) / 2
  const top =
    anchor === 'top'
      ? rect.y
      : anchor === 'center'
        ? rect.y + (rect.h - contentHeight) / 2
        : rect.y + rect.h - contentHeight
  const cx = left + contentWidth / 2 + (adjust.dx ?? 0)
  const cy = top + contentHeight / 2 + (adjust.dy ?? 0)
  return {
    cx,
    cy,
    contentWidth,
    contentHeight,
    scale,
    rotation: adjust.rotation ?? 0,
    imageWidth: image.width,
    imageHeight: image.height,
    content: box,
  }
}

/** Axis-aligned box around a (possibly rotated) visible product area. */
export function productBox(rect, image, content, settings, adjust) {
  const placed = placement(rect, image, content, settings, adjust)
  const rad = (placed.rotation * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const w = placed.contentWidth * cos + placed.contentHeight * sin
  const h = placed.contentWidth * sin + placed.contentHeight * cos
  return { x: placed.cx - w / 2, y: placed.cy - h / 2, w, h }
}

export function drawProduct(ctx, image, rect, content, settings, adjust) {
  const placed = placement(rect, image, content, settings, adjust)
  const box = placed.content
  ctx.save()
  ctx.translate(placed.cx, placed.cy)
  if (placed.rotation) ctx.rotate((placed.rotation * Math.PI) / 180)
  // A near-1:1 draw (a cut-out whose pixels already match the slot) should not
  // be resampled: Skia/Chrome soften any non-integer scale, which makes text
  // on a bottle label unreadable. Down/upscales keep high-quality smoothing.
  const nearNative = Math.abs(placed.scale - 1) <= 0.02
  ctx.imageSmoothingEnabled = !nearNative
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    image,
    -(box.x + box.w / 2) * placed.scale,
    -(box.y + box.h / 2) * placed.scale,
    placed.imageWidth * placed.scale,
    placed.imageHeight * placed.scale,
  )
  ctx.restore()
}

/** Draw the template scene; slots receive the current SKU image when present. */
export function drawScene(ctx, scene, image, content, settings, adjust) {
  for (const part of scene.parts) {
    if (part.kind === 'layers') {
      ctx.drawImage(part.canvas, 0, 0)
    } else if (image) {
      drawProduct(ctx, image, part.rect, content, settings, adjust)
    }
  }
}
