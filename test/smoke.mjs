/**
 * Self-contained smoke test for the Host-side compositor.
 *
 * Generates fixture PSDs in a temp workspace, then exercises the same entry
 * points the tools use: inspectTemplate, buildScene and renderBatch. Run with
 * `npm test`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { writePsd } from 'ag-psd'

import { parseTemplate, buildScene, suggestSlots } from '../src/core/psd.js'
import { inspectTemplate, renderBatch } from '../src/server.js'

// Importing src/server.js installs the ag-psd/@napi-rs canvas factory.

function fillCanvas(width, height, color, x = 0, y = 0, w = width, h = height) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
  return canvas
}

function buildFixturePsd() {
  return writePsd({
    width: 800,
    height: 800,
    children: [
      { name: '背景', left: 0, top: 0, right: 800, bottom: 800, canvas: fillCanvas(800, 800, '#cccccc') },
      {
        name: '主图',
        opened: true,
        children: [
          { name: '产品位', left: 260, top: 230, right: 540, bottom: 610, canvas: fillCanvas(280, 380, '#0000cc') },
          // Near-identical copy: joins the slot as a stacked copy.
          { name: '产品位阴影', left: 262, top: 236, right: 538, bottom: 612, canvas: fillCanvas(276, 376, '#000088') },
          // Stale product art: visible sibling overlapping the slot (and
          // crossing its right edge), but far enough away in size/offset not
          // to be a stacked copy.
          { name: '产品旧图', left: 300, top: 270, right: 640, bottom: 530, canvas: fillCanvas(340, 260, '#00aa00') },
        ],
      },
      {
        name: '装饰',
        opened: true,
        children: [
          { name: '角标', left: 20, top: 20, right: 140, bottom: 110, canvas: fillCanvas(120, 90, '#ff0000') },
        ],
      },
      {
        name: '价格',
        // Photoshop stores rasterized pixels for text layers; ag-psd does not
        // generate them on write, so provide the raster explicitly.
        left: 100,
        top: 700,
        right: 300,
        bottom: 760,
        canvas: fillCanvas(200, 60, '#c81414'),
        text: {
          text: '¥16.80',
          transform: [1, 0, 0, 1, 100, 700],
          style: {
            font: { name: 'SourceHanSansCN-Bold' },
            fontSize: 48,
            fauxBold: true,
            fillColor: { r: 200, g: 20, b: 20 },
          },
          styleRuns: [
            { length: 3, style: { font: { name: 'SourceHanSansCN-Bold' }, fontSize: 48 } },
            // Font-only override: the base fauxBold flag must survive.
            { length: 3, style: { font: { name: 'SourceHanSansCN-Regular' }, fontSize: 28 } },
          ],
        },
      },
      // Non-RGB fill colors: grayscale and CMYK documents must not report as
      // pure black.
      {
        name: '灰度价',
        left: 320,
        top: 700,
        right: 380,
        bottom: 730,
        canvas: fillCanvas(60, 30, '#808080'),
        text: {
          text: '128',
          transform: [1, 0, 0, 1, 320, 700],
          style: { font: { name: 'ArialMT' }, fontSize: 24, fillColor: { k: 128 } },
        },
      },
      {
        name: 'CMYK价',
        left: 420,
        top: 700,
        right: 460,
        bottom: 730,
        canvas: fillCanvas(40, 30, '#ff0000'),
        text: {
          text: '红',
          transform: [1, 0, 0, 1, 420, 700],
          style: { font: { name: 'ArialMT' }, fontSize: 24, fillColor: { c: 0, m: 255, y: 255, k: 0 } },
        },
      },
    ],
  })
}

// Issue regression: a stale sibling BELOW a kept layer must not pull the slot
// part earlier in the stack, or the SKU ends up under the kept layer.
function buildZOrderPsd() {
  return writePsd({
    width: 800,
    height: 800,
    children: [
      { name: '背景', left: 0, top: 0, right: 800, bottom: 800, canvas: fillCanvas(800, 800, '#cccccc') },
      {
        // Kept decoration in a different group, below the slot in z-order,
        // overlapping the slot box by less than 25%.
        name: '保留组',
        opened: true,
        children: [
          { name: '保留层', left: 500, top: 500, right: 660, bottom: 660, canvas: fillCanvas(160, 160, '#ffcc00') },
        ],
      },
      {
        name: '主图',
        opened: true,
        children: [
          // Stale art at the BOTTOM of the group, slot on top.
          { name: '旧图', left: 300, top: 270, right: 500, bottom: 530, canvas: fillCanvas(200, 260, '#00aa00') },
          { name: '槽位', left: 260, top: 230, right: 540, bottom: 610, canvas: fillCanvas(280, 380, '#0000cc') },
        ],
      },
    ],
  })
}

// Issue regression: an earlier slot must not claim a later slot's stacked
// shadow copy, or that slot's fit rect shrinks.
function buildShadowStealPsd() {
  return writePsd({
    width: 800,
    height: 800,
    children: [
      { name: '背景', left: 0, top: 0, right: 800, bottom: 800, canvas: fillCanvas(800, 800, '#cccccc') },
      {
        name: '主图',
        opened: true,
        children: [
          { name: '槽位A', left: 200, top: 230, right: 480, bottom: 610, canvas: fillCanvas(280, 380, '#0000cc') },
          { name: '槽位B', left: 240, top: 230, right: 520, bottom: 610, canvas: fillCanvas(280, 380, '#0000aa') },
          // Offset stacked copy of 槽位B: far enough from 槽位A not to be its
          // stacked copy, close enough to overlap it by ≥25%.
          { name: '阴影B', left: 242, top: 232, right: 522, bottom: 612, canvas: fillCanvas(280, 380, '#000066') },
        ],
      },
    ],
  })
}

async function parseFixture(cwd, name) {
  return parseTemplate({
    name,
    size: (await fs.stat(path.join(cwd, name))).size,
    arrayBuffer: async () => (await fs.readFile(path.join(cwd, name))).buffer,
  })
}

async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'psd-studio-smoke-'))
  // macOS /var is a symlink; the workspace guard compares real paths.
  const cwd = await fs.realpath(workspace)
  const sku = fillCanvas(300, 400, '#e02020', 25, 25, 250, 350)
  await fs.writeFile(path.join(cwd, 'fixture.psd'), Buffer.from(buildFixturePsd()))
  await fs.writeFile(path.join(cwd, 'zorder.psd'), Buffer.from(buildZOrderPsd()))
  await fs.writeFile(path.join(cwd, 'shadow-steal.psd'), Buffer.from(buildShadowStealPsd()))
  await fs.writeFile(path.join(cwd, 'sku.png'), await sku.encode('png'))

  try {
    // --- psd_inspect: text layers report copy and per-run styles ----------
    const inspect = await inspectTemplate({ cwd, template: 'fixture.psd' })
    const price = inspect.layers.find((layer) => layer.name === '价格')
    assert.ok(price, 'text layer listed')
    assert.equal(price.textContent, '¥16.80')
    assert.equal(price.runCount, 2)
    assert.equal(price.runs[0].size, 48)
    assert.equal(price.runs[0].weight, 700)
    assert.equal(price.runs[1].size, 28)
    assert.equal(price.runs[1].family, 'Noto Sans SC')
    // A font-only run keeps the base style's fauxBold weight.
    assert.equal(price.runs[1].weight, 700)
    assert.deepEqual(price.runs[0].color, [200, 20, 20])

    // Grayscale and CMYK fills decode to real colors, not black.
    const gray = inspect.layers.find((layer) => layer.name === '灰度价')
    assert.deepEqual(gray.runs[0].color, [128, 128, 128], 'grayscale fill reported as gray')
    const cmyk = inspect.layers.find((layer) => layer.name === 'CMYK价')
    assert.deepEqual(cmyk.runs[0].color, [255, 0, 0], 'CMYK red fill reported as red')

    const slotNames = inspect.suggestedSlots.map((slot) => slot.name)
    assert.ok(slotNames.includes('产品位'), 'auto slots include 产品位')
    assert.ok(!slotNames.includes('产品旧图'), 'stale sibling is not suggested as slot')

    // --- buildScene: overlapping siblings are suppressed ------------------
    const doc = await parseFixture(cwd, 'fixture.psd')
    doc.slots = new Set(suggestSlots(doc))
    const scene = buildScene(doc)
    assert.deepEqual(
      scene.suppressed.map((layer) => layer.name),
      ['产品旧图'],
      'exactly the stale sibling is suppressed',
    )

    const slotPart = scene.slots[0]
    // Slot rect stays on the slot + stacked shadow copy (union 260..540 ×
    // 230..612); the suppressed sibling must not inflate the fitting area.
    assert.equal(slotPart.rect.x, 260)
    assert.equal(slotPart.rect.y, 230)
    assert.equal(slotPart.rect.w, 280)
    assert.equal(slotPart.rect.h, 382)
    assert.ok(!scene.suppressed.some((layer) => layer.name === '角标'), 'distant decoration survives')

    // --- psd_batch_render: suppression reported, other layers intact ------
    const render = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png'],
      outDir: 'out',
    })
    assert.equal(render.count, 1)
    assert.deepEqual(
      render.suppressed.map((layer) => layer.name),
      ['产品旧图'],
      'render result reports suppressed layers',
    )
    assert.equal(render.suppressedCount, 1)
    assert.equal(render.suppressedTruncated, false)

    const output = createCanvas(800, 800)
    const outputCtx = output.getContext('2d')
    outputCtx.drawImage(await loadImageFrom(path.join(cwd, 'out', render.files[0])), 0, 0)
    // The render is JPEG by default, so assert with compression tolerance.
    const badge = outputCtx.getImageData(70, 60, 1, 1).data
    assert.ok(badge[0] > 240, '角标 still rendered after suppression')
    const ground = outputCtx.getImageData(700, 700, 1, 1).data
    assert.ok(Math.abs(ground[0] - 204) < 10, '背景 still rendered after suppression')
    // The stale art crossed the slot's right edge: that part must be gone too.
    const staleRemainder = outputCtx.getImageData(570, 400, 1, 1).data
    assert.ok(Math.abs(staleRemainder[0] - 204) < 10, '旧图 pixels outside the slot are suppressed')

    // --- regression: slot part stays at the slot layer's stack position ---
    const zDoc = await parseFixture(cwd, 'zorder.psd')
    const slotLeaf = zDoc.leaves.find((leaf) => leaf.name === '槽位')
    zDoc.slots = new Set([slotLeaf.id])
    const zScene = buildScene(zDoc)
    assert.deepEqual(
      zScene.suppressed.map((layer) => layer.name),
      ['旧图'],
      'stale art suppressed in the z-order fixture',
    )
    const zRender = await renderBatch({
      cwd,
      template: 'zorder.psd',
      skus: ['sku.png'],
      outDir: 'out-zorder',
      format: 'png',
      slots: ['槽位'],
    })
    const zCanvas = createCanvas(800, 800)
    const zCtx = zCanvas.getContext('2d')
    zCtx.drawImage(await loadImageFrom(path.join(cwd, 'out-zorder', zRender.files[0])), 0, 0)
    // This pixel sits on the kept layer AND inside the drawn SKU: the SKU
    // (slot layer's position) must win, not the kept layer above the old art.
    const zPixel = zCtx.getImageData(520, 560, 1, 1).data
    assert.ok(zPixel[0] > 180 && zPixel[1] < 120, 'SKU renders above the kept layer below the slot')

    // --- regression: a slot never steals a later slot's stacked copy ------
    const stealDoc = await parseFixture(cwd, 'shadow-steal.psd')
    stealDoc.slots = new Set(
      stealDoc.leaves.filter((leaf) => leaf.name === '槽位A' || leaf.name === '槽位B').map((leaf) => leaf.id),
    )
    const stealScene = buildScene(stealDoc)
    assert.deepEqual(stealScene.suppressed.map((layer) => layer.name), [], 'shadow copy stays with its own slot')
    const slotB = stealScene.slots.find((slot) => slot.name === '槽位B')
    // B's rect = union with its own shadow copy (240..522 × 230..612), not
    // shrunk back to the bare slot because A's overlap pass ran first.
    assert.equal(slotB.rect.x, 240)
    assert.equal(slotB.rect.y, 230)
    assert.equal(slotB.rect.w, 282)
    assert.equal(slotB.rect.h, 382)

    console.log('smoke test passed')
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

async function loadImageFrom(file) {
  const { loadImage } = await import('@napi-rs/canvas')
  return loadImage(file)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
