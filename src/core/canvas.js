/**
 * Canvas factory shared by the browser workbench and the Host batch renderer.
 *
 * The browser uses an HTML canvas; the Host installs a native canvas factory
 * before importing the compositor. Everything above this module stays identical
 * in both runtimes.
 */
let factory = null

export function setCanvasFactory(create) {
  factory = create
}

export function createCanvas(width, height) {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  if (factory) {
    const canvas = factory(w, h)
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    return canvas
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}
