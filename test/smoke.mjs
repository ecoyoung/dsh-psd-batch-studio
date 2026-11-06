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
import { mergeOverrideLists, mergeTextOverride } from '../src/core/text.js'

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
      // Two-colour copy: red AA, blue ZZ. A value-only rewrite must keep the
      // untouched suffix blue.
      {
        name: '双色',
        left: 160,
        top: 20,
        right: 400,
        bottom: 90,
        canvas: fillCanvas(240, 70, '#dddddd'),
        text: {
          text: 'AAZZ',
          transform: [1, 0, 0, 1, 160, 20],
          style: { font: { name: 'ArialMT' }, fontSize: 48, fillColor: { r: 255, g: 0, b: 0 } },
          styleRuns: [
            { length: 2, style: { fillColor: { r: 255, g: 0, b: 0 } } },
            { length: 2, style: { fillColor: { r: 0, g: 0, b: 255 } } },
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

    // --- regression: a stacked copy above the slot never covers the SKU ----
    // 产品位阴影 (#000088) sits above 产品位 and widens the fit rect; it is
    // product art and must be hidden with the slot, not drawn over the SKU.
    const copyRender = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png'],
      outDir: 'out-copy',
      format: 'png',
    })
    const copyCanvas = createCanvas(800, 800)
    const copyCtx = copyCanvas.getContext('2d')
    copyCtx.drawImage(await loadImageFrom(path.join(cwd, 'out-copy', copyRender.files[0])), 0, 0)
    for (const [x, y] of [[400, 420], [300, 300], [500, 580]]) {
      const pixel = copyCtx.getImageData(x, y, 1, 1).data
      assert.ok(
        pixel[0] > 200 && pixel[1] < 60 && pixel[2] < 60,
        `SKU red at (${x},${y}), not the stacked copy (got ${pixel[0]},${pixel[1]},${pixel[2]})`,
      )
    }

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

    // --- regression: runs keep their requested lengths ---------------------
    const priceBase = (await parseFixture(cwd, 'fixture.psd')).entries.find((entry) => entry.name === '价格').text
    const split = mergeTextOverride(priceBase, {
      value: '8888',
      runs: [{ len: 1, color: '#ff0000' }, { len: 3, color: '#0000ff' }],
    })
    assert.deepEqual(split.runs.map((run) => run.len), [1, 3], 'runs keep the requested [1, 3] split')
    assert.deepEqual(split.runs.map((run) => run.color), [[255, 0, 0], [0, 0, 255]])
    // A segment restyles only its own characters; the rest keep their style.
    const partial = mergeTextOverride(priceBase, { runs: [{ len: 1, color: '#00ff00' }] })
    assert.deepEqual(partial.runs[0], { ...priceBase.runs[0], len: 1, color: [0, 255, 0] })
    assert.equal(partial.runs.reduce((sum, run) => sum + run.len, 0), priceBase.value.length)
    assert.deepEqual(partial.runs[partial.runs.length - 1].size, 28, 'tail keeps its 28pt style')

    const twoTone = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png'],
      outDir: 'out-two-tone',
      format: 'png',
      text: [{ layer: '价格', value: '8888', runs: [{ len: 1, color: '#ff0000' }, { len: 3, color: '#0000ff' }] }],
    })
    const toneCanvas = createCanvas(800, 800)
    const toneCtx = toneCanvas.getContext('2d')
    toneCtx.drawImage(await loadImageFrom(path.join(cwd, 'out-two-tone', twoTone.files[0])), 0, 0)
    // Stay left of the red CMYK价 raster at x 420.
    const tone = toneCtx.getImageData(0, 660, 400, 140).data
    let red = 0
    let blue = 0
    for (let index = 0; index < tone.length; index += 4) {
      const [r, g, b] = [tone[index], tone[index + 1], tone[index + 2]]
      if (r > 200 && g < 60 && b < 60) red += 1
      if (b > 200 && r < 60 && g < 60) blue += 1
    }
    assert.ok(red > 30, `first glyph renders red (${red} px)`)
    assert.ok(blue > red, `last three glyphs render blue (${blue} px vs ${red} red)`)

    // --- regression: a value-only rewrite keeps untouched characters' style
    const twoColor = (await parseFixture(cwd, 'fixture.psd')).entries.find((entry) => entry.name === '双色').text
    const valueOnly = mergeTextOverride(twoColor, { value: 'ABZZ' })
    assert.deepEqual(valueOnly.runs.map((run) => run.len), [2, 2], 'value-only rewrite keeps the [2, 2] split')
    assert.deepEqual(valueOnly.runs.map((run) => run.color), [[255, 0, 0], [0, 0, 255]])
    const countColors = async (dir, files) => {
      const ctx = createCanvas(800, 800).getContext('2d')
      ctx.drawImage(await loadImageFrom(path.join(cwd, dir, files[0])), 0, 0)
      // 双色 area only: right of 角标 (x 140), above the SKU (y 230).
      const data = ctx.getImageData(145, 0, 300, 120).data
      let redCount = 0
      let blueCount = 0
      for (let index = 0; index < data.length; index += 4) {
        const [r, g, b] = [data[index], data[index + 1], data[index + 2]]
        if (r > 200 && g < 60 && b < 60) redCount += 1
        if (b > 200 && r < 60 && g < 60) blueCount += 1
      }
      return { redCount, blueCount }
    }
    const valueRender = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png'],
      outDir: 'out-value-only',
      format: 'png',
      text: [{ layer: '双色', value: 'ABZZ' }],
    })
    const valueColors = await countColors('out-value-only', valueRender.files)
    const runsRender = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png'],
      outDir: 'out-value-runs',
      format: 'png',
      text: [{ layer: '双色', value: 'ABZZ', runs: [{ len: 2, color: '#ff0000' }, { len: 2, color: '#0000ff' }] }],
    })
    const runsColors = await countColors('out-value-runs', runsRender.files)
    assert.ok(valueColors.blueCount > 30, `ZZ still blue after a value-only rewrite (${valueColors.blueCount} px)`)
    assert.ok(
      Math.abs(valueColors.blueCount - runsColors.blueCount) <= runsColors.blueCount * 0.05,
      `value-only matches the explicit-runs control (${valueColors.blueCount} vs ${runsColors.blueCount} blue px)`,
    )

    // --- per-SKU groups: interleaved prices keep input order, one scene each
    await fs.writeFile(path.join(cwd, 'sku-c.png'), await skuB.encode('png'))
    const grouped = await renderBatch({
      cwd,
      template: 'fixture.psd',
      skus: ['sku.png', 'sku-b.png', 'sku-c.png'],
      outDir: 'out-grouped',
      format: 'png',
      zip: true,
      textBySku: {
        'sku.png': [{ layer: '价格', value: '¥11.00' }],
        'sku-b.png': [{ layer: '价格', value: '¥22.00' }],
        'sku-c.png': [{ layer: '价格', value: '¥11.00' }],
      },
    })
    assert.equal(grouped.textVariants, 2, 'SKUs sharing a price share one scene')
    assert.deepEqual(grouped.files, ['sku.png', 'sku-b.png', 'sku-c.png'], 'output keeps input order')
    const [groupA, groupC] = await Promise.all(
      ['sku.png', 'sku-c.png'].map((name) => fs.readFile(path.join(cwd, 'out-grouped', name))),
    )
    assert.ok(!groupA.equals(groupC), 'different SKU images still differ inside one text group')
    assert.ok(grouped.zip, 'zip written for grouped batch')

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
