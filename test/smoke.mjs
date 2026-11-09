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
import { editTemplate, inspectTemplate, renderBatch } from '../src/server.js'
import { mergeOverrideLists, mergeTextOverride, readFontPostScriptName } from '../src/core/text.js'

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
      // PostScript name that is not in the family map: it must be reported
      // whole, otherwise the registered face (named after the file) misses.
      {
        name: '卖点',
        left: 450,
        top: 100,
        right: 700,
        bottom: 160,
        canvas: fillCanvas(250, 60, '#333333'),
        text: {
          text: '买1享到手2件礼',
          transform: [1, 0, 0, 1, 450, 100],
          style: { font: { name: 'GlowSansSC-Normal-Medium' }, fontSize: 40 },
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
  await fs.writeFile(path.join(cwd, 'badge.png'), await fillCanvas(40, 40, '#00ff00').encode('png'))
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'psd-studio-outside-')))

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

    // === psd_edit ==========================================================
    // Edits persist on the cached document, so these run after every render
    // above that expects the pristine template.
    const pngOf = async (dir, name) => {
      const canvas = createCanvas(800, 800)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(await loadImageFrom(path.join(cwd, dir, name)), 0, 0)
      return ctx
    }
    const renderPng = (outDir, extra = {}) =>
      renderBatch({ cwd, template: 'fixture.psd', skus: ['sku.png'], outDir, format: 'png', ...extra })

    // --- font names keep their PostScript form ----------------------------
    const selling = inspect.layers.find((layer) => layer.name === '卖点')
    assert.equal(selling.runs[0].family, 'GlowSansSC-Normal-Medium', 'PostScript font name is not truncated')

    // --- text edit: shared override shape, repaint replaces the raster -----
    const edit = await editTemplate({
      cwd,
      template: 'fixture.psd',
      action: 'text',
      layer: '价格',
      value: '¥9.90',
      runs: [{ len: 1 }, { len: 1, sizePx: 56, color: '#CC3046' }, { len: 3 }],
    })
    assert.equal(edit.value, '¥9.90')
    // The unchanged trailing "0" keeps its original 28pt style, so the third
    // requested segment splits where the inherited styles differ.
    assert.deepEqual(edit.runs.map((run) => run.len), [1, 1, 2, 1])
    assert.equal(edit.runs[3].size, 28)
    assert.equal(edit.runs[1].sizePx, 56, 'sizePx lands as exactly that many pixels')
    assert.deepEqual(edit.runs[1].color, [204, 48, 70])
    const editedCtx = await pngOf('out-edit', (await renderPng('out-edit')).files[0])
    const corner = editedCtx.getImageData(106, 704, 1, 1).data
    assert.ok(!(corner[0] === 200 && corner[1] === 20 && corner[2] === 20), 'old solid price raster is gone')

    // A render's own `text` still wins over the saved edit for that layer.
    const wins = await renderPng('out-edit-wins', { text: [{ layer: '价格', value: '¥1' }] })
    assert.equal(wins.textVariants, 1)

    // --- regression: sizePx is not cancelled out on a single run -----------
    const inkHeight = (ctx) => {
      // Below the red SKU (ends at y 612), left of the red CMYK价 raster (x 420).
      const data = ctx.getImageData(0, 640, 420, 160).data
      let top = Infinity
      let bottom = -Infinity
      for (let index = 0; index < data.length; index += 4) {
        const [r, g, b] = [data[index], data[index + 1], data[index + 2]]
        if (r > 120 && g < 90 && b < 90) {
          const y = Math.floor(index / 4 / 420)
          top = Math.min(top, y)
          bottom = Math.max(bottom, y)
        }
      }
      return bottom - top + 1
    }
    const heights = {}
    for (const sizePx of [20, 50]) {
      await editTemplate({ cwd, template: 'fixture.psd', action: 'reset' })
      await editTemplate({
        cwd,
        template: 'fixture.psd',
        action: 'text',
        layer: '价格',
        value: '88',
        runs: [{ len: 2, sizePx }],
      })
      heights[sizePx] = inkHeight(await pngOf(`out-px-${sizePx}`, (await renderPng(`out-px-${sizePx}`)).files[0]))
    }
    const ratio = heights[50] / heights[20]
    assert.ok(ratio > 2 && ratio < 3, `50px glyphs are ~2.5× the 20px ones (${heights[20]} → ${heights[50]})`)
    // Flat sizePx behaves the same as a run-level one.
    await editTemplate({ cwd, template: 'fixture.psd', action: 'reset' })
    await editTemplate({ cwd, template: 'fixture.psd', action: 'text', layer: '价格', value: '88', sizePx: 50 })
    const flat = inkHeight(await pngOf('out-px-flat', (await renderPng('out-px-flat')).files[0]))
    assert.ok(Math.abs(flat - heights[50]) <= 1, `flat sizePx matches run sizePx (${flat} vs ${heights[50]})`)
    await editTemplate({ cwd, template: 'fixture.psd', action: 'reset' })

    // --- elements: above everything, or between background and slot -------
    await editTemplate({ cwd, template: 'fixture.psd', action: 'element', paths: ['badge.png'], name: 'top', dx: 600, dy: 600 })
    await editTemplate({
      cwd,
      template: 'fixture.psd',
      action: 'element',
      paths: ['badge.png'],
      name: 'under',
      dx: 650,
      dy: 300,
      aboveSlots: false,
    })
    await editTemplate({
      cwd,
      template: 'fixture.psd',
      action: 'element',
      paths: ['badge.png'],
      name: 'behind-sku',
      dx: 380,
      dy: 400,
      aboveSlots: false,
    })
    const elementCtx = await pngOf('out-element', (await renderPng('out-element')).files[0])
    const isGreen = (pixel) => pixel[1] > 240 && pixel[0] < 40 && pixel[2] < 40
    assert.ok(isGreen(elementCtx.getImageData(620, 620, 1, 1).data), 'above-slot element renders')
    // Regression: below-slot elements sit above the opaque background.
    assert.ok(isGreen(elementCtx.getImageData(670, 320, 1, 1).data), 'below-slot element stays above the background')
    const behind = elementCtx.getImageData(400, 420, 1, 1).data
    assert.ok(behind[0] > 200 && behind[1] < 60, 'below-slot element is covered by the SKU')
    const elementStatus = await editTemplate({ cwd, template: 'fixture.psd', action: 'remelement', names: ['behind-sku'] })
    assert.deepEqual(elementStatus.names, ['top', 'under'])

    // --- project round trip, including slots -------------------------------
    await editTemplate({ cwd, template: 'fixture.psd', action: 'text', layer: '价格', value: '¥9.90' })
    // Pick a slot the auto detection would not choose, via an explicit render.
    await renderPng('out-slot', { slots: ['角标'] })
    const saved = await editTemplate({ cwd, template: 'fixture.psd', action: 'save_project', project: 'p/project.json' })
    assert.equal(saved.textEdits, 1)
    assert.equal(saved.elements, 2)
    await editTemplate({ cwd, template: 'fixture.psd', action: 'reset' })
    const autoSlots = await renderPng('out-auto')
    assert.ok(!autoSlots.slots.some((slot) => slot.name === '角标'), 'auto detection does not pick 角标')
    const cleared = await editTemplate({ cwd, template: 'fixture.psd', action: 'status' })
    assert.equal(cleared.textEdits.length, 0, 'reset drops text edits')
    assert.equal(cleared.elements.length, 0, 'reset drops elements')

    const restored = await editTemplate({ cwd, template: 'fixture.psd', action: 'load_project', project: 'p/project.json' })
    assert.equal(restored.textEdits, 1, 'project restores the text edit')
    assert.equal(restored.elements, 2, 'project restores the placed elements')
    assert.ok(restored.missingFonts.includes('GlowSansSC-Normal-Medium'), 'PostScript families listed as missing')
    // Regression: a render without `slots` uses the restored slots.
    const pinned = await renderPng('out-pinned')
    assert.deepEqual(pinned.slots.map((slot) => slot.name), ['角标'], 'render keeps the project slots')

    // --- regression: a failed load leaves the current state untouched ------
    const broken = JSON.parse(await fs.readFile(path.join(cwd, 'p/project.json'), 'utf8'))
    broken.textEdits = { 价格: { value: '¥0.01' } }
    broken.elements.push({ name: 'gone', source: 'missing.png' })
    await fs.writeFile(path.join(cwd, 'p/broken.json'), JSON.stringify(broken))
    await assert.rejects(
      editTemplate({ cwd, template: 'fixture.psd', action: 'load_project', project: 'p/broken.json' }),
      /gone|missing/,
    )
    const intact = await editTemplate({ cwd, template: 'fixture.psd', action: 'status' })
    assert.equal(intact.elements.length, 2, 'elements survive a failed load')
    assert.equal(intact.textEdits.length, 1, 'text edits survive a failed load')
    assert.deepEqual(intact.slots, restored.slots, 'slots survive a failed load')
    await editTemplate({ cwd, template: 'fixture.psd', action: 'reset' })

    // --- regression: one layer named two ways still honours priority -------
    // psd_edit stores the entry id; text names the layer; textBySku reuses
    // the entry id, which used to slot it in BEFORE the by-name batch text.
    const { entryId: priceEntry } = await editTemplate({
      cwd,
      template: 'fixture.psd',
      action: 'text',
      layer: '价格',
      value: '¥7.70',
    })
    const priceLeaf = inspect.layers.find((layer) => layer.name === '价格').leafId
    const priority = await renderPng('out-priority', {
      text: [{ layer: '价格', color: '#ff0000' }],
      textBySku: { 'sku.png': [{ layer: priceEntry, color: '#00ff00' }] },
    })
    const priorityData = (await pngOf('out-priority', priority.files[0])).getImageData(0, 640, 420, 160).data
    let greenPx = 0
    let redPx = 0
    for (let index = 0; index < priorityData.length; index += 4) {
      const [r, g, b] = [priorityData[index], priorityData[index + 1], priorityData[index + 2]]
      if (g > 200 && r < 60 && b < 60) greenPx += 1
      if (r > 200 && g < 60 && b < 60) redPx += 1
    }
    assert.ok(greenPx > 100 && redPx < greenPx / 10, `textBySku by entry id beats text by name (${greenPx} green, ${redPx} red)`)
    // Leaf ids resolve to the same layer too.
    const byLeaf = await renderPng('out-priority-leaf', {
      text: [{ layer: priceEntry, color: '#ff0000' }],
      textBySku: { 'sku.png': [{ layer: priceLeaf, color: '#00ff00' }] },
    })
    assert.equal(byLeaf.textVariants, 1)

    // --- regression: viewing other templates keeps unsaved edits -----------
    await inspectTemplate({ cwd, template: 'zorder.psd' })
    await inspectTemplate({ cwd, template: 'shadow-steal.psd' })
    const afterEviction = await editTemplate({ cwd, template: 'fixture.psd', action: 'status' })
    assert.equal(afterEviction.textEdits.length, 1, 'text edit survives the template cache eviction')
    // Changing the PSD itself drops the edits, and status says why.
    const later = new Date(Date.now() + 5000)
    await fs.utimes(path.join(cwd, 'fixture.psd'), later, later)
    const afterChange = await editTemplate({ cwd, template: 'fixture.psd', action: 'status' })
    assert.equal(afterChange.textEdits.length, 0, 'edits dropped once the PSD changes on disk')
    assert.match(afterChange.editsDropped || '', /changed on disk/)
    await editTemplate({ cwd, template: 'fixture.psd', action: 'reset' })

    // --- regression: an output file symlink cannot redirect a render -------
    const trapTarget = path.join(outside, 'trap.png')
    await fs.writeFile(trapTarget, 'keep me')
    await fs.mkdir(path.join(cwd, 'out-trap'))
    await fs.symlink(trapTarget, path.join(cwd, 'out-trap', 'sku.png'))
    await assert.rejects(renderPng('out-trap'), /outside the session workspace/)
    await fs.mkdir(path.join(cwd, 'out-trap-zip'))
    await fs.symlink(path.join(outside, 'trap.zip'), path.join(cwd, 'out-trap-zip', 'fixture-1.zip'))
    await assert.rejects(renderPng('out-trap-zip', { zip: true }), /outside the session workspace/)
    assert.deepEqual(await fs.readdir(path.join(cwd, 'out-trap-zip')), ['fixture-1.zip'], 'nothing rendered before the check')
    assert.equal(await fs.readFile(trapTarget, 'utf8'), 'keep me', 'output symlink target untouched')
    await fs.rm(trapTarget)

    // --- regression: writes never follow a symlink out of the workspace ----
    const victim = path.join(outside, 'victim.txt')
    await fs.writeFile(victim, 'keep me')
    await fs.symlink(victim, path.join(cwd, 'link.json'))
    await assert.rejects(
      editTemplate({ cwd, template: 'fixture.psd', action: 'save_project', project: 'link.json' }),
      /outside the session workspace/,
    )
    await fs.symlink(outside, path.join(cwd, 'linkdir'))
    await assert.rejects(
      editTemplate({ cwd, template: 'fixture.psd', action: 'save_project', project: 'linkdir/new/p.json' }),
      /outside the session workspace/,
    )
    await assert.rejects(renderPng('linkdir/out'), /outside the session workspace/)
    await fs.symlink(path.join(outside, 'dangling.json'), path.join(cwd, 'dangling.json'))
    await assert.rejects(
      editTemplate({ cwd, template: 'fixture.psd', action: 'save_project', project: 'dangling.json' }),
      /outside the session workspace/,
    )
    assert.equal(await fs.readFile(victim, 'utf8'), 'keep me', 'file outside the workspace untouched')
    assert.deepEqual(await fs.readdir(outside), ['victim.txt'], 'nothing written outside the workspace')

    // --- font registration: file stem plus PostScript name -----------------
    let fontSource = null
    for (const candidate of [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/Library/Fonts/Arial.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]) {
      try {
        await fs.access(candidate)
        fontSource = candidate
        break
      } catch {
        /* try the next one */
      }
    }
    if (fontSource) {
      await fs.copyFile(fontSource, path.join(cwd, 'StudioSmoke.ttf'))
      const fonts = await editTemplate({ cwd, template: 'fixture.psd', action: 'fonts', fonts: ['StudioSmoke.ttf'] })
      assert.ok(fonts.loaded.includes('StudioSmoke'), 'font registered under its file stem')
      const postScript = readFontPostScriptName(await fs.readFile(fontSource))
      assert.ok(postScript && fonts.loaded.includes(postScript), `font registered under ${postScript}`)
      assert.deepEqual(fonts.skipped, [], 'no font skipped')
    }

    console.log('smoke test passed')
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
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
