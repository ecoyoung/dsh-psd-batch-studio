/**
 * Self-contained smoke test for the Host-side compositor.
 *
 * Generates a fixture PSD in a temp workspace (slot + stale overlapping
 * sibling + stacked shadow copy + a decoration elsewhere + a two-run price
 * text layer), then exercises the same entry points the tools use:
 * inspectTemplate, buildScene and renderBatch. Run with `npm test`.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { writePsd } from 'ag-psd'

import { parseTemplate, buildScene, suggestSlots } from '../src/core/psd.js'
import { inspectTemplate, renderBatch } from '../src/server.js'
import { mergeOverrideLists } from '../src/core/text.js'

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
          // Stale product art: visible sibling overlapping the slot, but far
          // enough away in size/offset not to be a stacked copy.
          { name: '产品旧图', left: 300, top: 270, right: 500, bottom: 530, canvas: fillCanvas(200, 260, '#00aa00') },
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
            fillColor: { r: 200, g: 20, b: 20 },
          },
          styleRuns: [
            { length: 3, style: { font: { name: 'SourceHanSansCN-Bold' }, fontSize: 48 } },
            { length: 3, style: { font: { name: 'SourceHanSansCN-Regular' }, fontSize: 28 } },
          ],
        },
      },
    ],
  })
}

async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'psd-studio-smoke-'))
  // macOS /var is a symlink; the workspace guard compares real paths.
  const cwd = await fs.realpath(workspace)
  const sku = fillCanvas(300, 400, '#e02020', 25, 25, 250, 350)
  await fs.writeFile(path.join(cwd, 'fixture.psd'), Buffer.from(buildFixturePsd()))
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
    assert.deepEqual(price.runs[0].color, [200, 20, 20])

    const slotNames = inspect.suggestedSlots.map((slot) => slot.name)
    assert.ok(slotNames.includes('产品位'), 'auto slots include 产品位')
    assert.ok(!slotNames.includes('产品旧图'), 'stale sibling is not suggested as slot')

    // --- buildScene: overlapping siblings are suppressed ------------------
    const doc = await parseTemplate({
      name: 'fixture.psd',
      size: (await fs.stat(path.join(cwd, 'fixture.psd'))).size,
      arrayBuffer: async () => (await fs.readFile(path.join(cwd, 'fixture.psd'))).buffer,
    })
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

    const output = createCanvas(800, 800)
    const outputCtx = output.getContext('2d')
    outputCtx.drawImage(await loadImageFrom(path.join(cwd, 'out', render.files[0])), 0, 0)
    // The render is JPEG by default, so assert with compression tolerance.
    const badge = outputCtx.getImageData(70, 60, 1, 1).data
    assert.ok(badge[0] > 240, '角标 still rendered after suppression')
    const ground = outputCtx.getImageData(700, 700, 1, 1).data
    assert.ok(Math.abs(ground[0] - 204) < 10, '背景 still rendered after suppression')

    // --- text overrides: global rewrite with live glyphs -------------------
    const baseline = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png'],
      outDir: 'out-base',
      format: 'png',
    })
    const overridden = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png'],
      outDir: 'out',
      format: 'png',
      text: [
        {
          layer: '价格',
          value: '¥88.80',
          runs: [{ len: 3, color: '#0033cc' }, { len: 1, family: 'NoSuchFont' }, { len: 2 }],
        },
      ],
    })
    assert.equal(overridden.count, 1)
    assert.equal(overridden.textVariants, 1)
    assert.ok(
      overridden.textWarnings.some((warning) => warning.includes('NoSuchFont')),
      'unresolvable fonts are reported as fallback warnings',
    )

    // PNG keeps pixels exact: the price region must change when the copy is
    // rewritten with live glyphs.
    const beforeCanvas = createCanvas(800, 800)
    const beforeCtx = beforeCanvas.getContext('2d')
    beforeCtx.drawImage(await loadImageFrom(path.join(cwd, 'out-base', baseline.files[0])), 0, 0)
    outputCtx.drawImage(await loadImageFrom(path.join(cwd, 'out', overridden.files[0])), 0, 0)
    let changed = 0
    for (let y = 690; y < 775; y += 3) {
      for (let x = 95; x < 305; x += 3) {
        const a = beforeCtx.getImageData(x, y, 1, 1).data
        const b = outputCtx.getImageData(x, y, 1, 1).data
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 24) changed += 1
      }
    }
    assert.ok(changed > 50, `price region repainted by the override (${changed} sampled pixels)`)

    // The decoration and background must survive the text machinery.
    const badgeAfterText = outputCtx.getImageData(70, 60, 1, 1).data
    assert.ok(badgeAfterText[0] > 240, '角标 still rendered after text override')

    // --- per-SKU overrides: two SKUs, two prices, two scenes ---------------
    await fs.rm(path.join(cwd, 'out'), { recursive: true, force: true })
    const skuB = fillCanvas(300, 400, '#20b020', 25, 25, 250, 350)
    await fs.writeFile(path.join(cwd, 'sku-b.png'), await skuB.encode('png'))
    const perSku = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png', 'sku-b.png'],
      outDir: 'out',
      format: 'png',
      textBySku: {
        'sku.png': [{ layer: '价格', value: '¥11.00' }],
        'sku-b.png': [{ layer: '价格', value: '¥22.00' }],
      },
    })
    assert.equal(perSku.count, 2)
    assert.equal(perSku.textVariants, 2, 'one scene per distinct price')
    const [first, second] = await Promise.all(
      perSku.files.slice(0, 2).map((name) => fs.readFile(path.join(cwd, 'out', name))),
    )
    assert.ok(first.equals(second) === false, 'per-SKU text produces different images')

    // --- fontDir: registering real fonts removes the fallback warning ------
    const fontDir = path.join(cwd, 'fonts')
    await fs.mkdir(fontDir, { recursive: true })
    let fontFile = null
    for (const candidate of [
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
      '/System/Library/Fonts/Supplemental/Arial.ttf',
    ]) {
      try {
        await fs.copyFile(candidate, path.join(fontDir, 'TestFont_Bold.ttf'))
        fontFile = candidate
        break
      } catch {
        /* candidate not present on this machine */
      }
    }
    if (fontFile) {
      const withFonts = await renderBatch({
        cwd,
        template: 'fixture.psd',
        skus: ['sku.png'],
        outDir: 'out',
        format: 'png',
        fontDir: 'fonts',
        text: [{ layer: '价格', value: '¥66.00', font: 'TestFont Bold' }],
      })
      assert.ok(
        withFonts.fontsRegistered && withFonts.fontsRegistered.includes('TestFont Bold'),
        'registered family names reported',
      )
      assert.ok(
        !(withFonts.textWarnings || []).some((warning) => warning.includes('TestFont Bold')),
        'registered font resolves without fallback warning',
      )
    }

    // --- override list merge: per-SKU wins per layer ------------------------
    const merged = mergeOverrideLists([{ layer: 'a', value: '1' }, { layer: 'b', value: '2' }], [
      { layer: 'b', value: '3' },
    ])
    assert.deepEqual(
      merged.map((override) => `${override.layer}=${override.value}`),
      ['a=1', 'b=3'],
    )

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
