/**
 * Full-resolution export: one PNG/JPEG per SKU, packed into a ZIP download.
 */
import { zip } from 'fflate'
import { createCanvas as makeCanvas } from './canvas.js'
import { drawScene, measureContent } from './fit.js'

export function sanitizeName(name) {
  return (
    String(name || 'sku')
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .trim()
      .slice(0, 80) || 'sku'
  )
}

export function renderItem(doc, scene, image, settings, adjust, opaque = false) {
  const canvas = makeCanvas(doc.width, doc.height)
  const ctx = canvas.getContext('2d')
  if (opaque) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, doc.width, doc.height)
  }
  drawScene(ctx, scene, image, measureContent(image), settings, adjust)
  return canvas
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('图片编码失败'))), type, quality)
  })
}

export function zipFiles(files) {
  return new Promise((resolve, reject) => {
    zip(files, { level: 0 }, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function uniqueName(used, base, extension) {
  let name = `${base}.${extension}`
  let index = 2
  while (used.has(name)) {
    name = `${base}-${index}.${extension}`
    index += 1
  }
  used.add(name)
  return name
}
