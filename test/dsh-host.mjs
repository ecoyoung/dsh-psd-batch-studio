/**
 * Host contract test: register the agent tools the way dsh does.
 *
 * The smoke test calls the tool functions directly, which skips everything the
 * host enforces at registration and call time. This test runs the real
 * `@deepseek-ai/dsh-tools` checks (pinned to the desktop app's runtime,
 * 0.2.0-rc.2): every schema must be in dsh's supported subset, every tool must
 * declare `output.render`, and real tool results must match their output
 * schema. It also covers the workspace lookup on both sides of dsh 0.2.1,
 * where the `workingDirectory` service appeared.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { writePsd } from 'ag-psd'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

import * as entry from '../index.js'
import { registerTools } from '../src/server.js'

function fillCanvas(width, height, color) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas
}

function buildPsd() {
  return writePsd({
    width: 400,
    height: 400,
    children: [
      { name: '背景', left: 0, top: 0, right: 400, bottom: 400, canvas: fillCanvas(400, 400, '#cccccc') },
      {
        name: '主图',
        opened: true,
        children: [
          { name: '产品位', left: 100, top: 80, right: 300, bottom: 320, canvas: fillCanvas(200, 240, '#0000cc') },
        ],
      },
      {
        name: '价格',
        left: 20,
        top: 340,
        right: 180,
        bottom: 380,
        canvas: fillCanvas(160, 40, '#cc0000'),
        text: {
          text: '¥9.90',
          transform: [1, 0, 0, 1, 20, 340],
          style: { font: { name: 'ArialMT' }, fontSize: 32, fillColor: { r: 200, g: 0, b: 0 } },
        },
      },
      // No font name: the layer's family resolves to nothing, which the host
      // schema can only express by leaving `family` out.
      {
        name: '无字体',
        left: 220,
        top: 340,
        right: 380,
        bottom: 380,
        canvas: fillCanvas(160, 40, '#333333'),
        text: {
          text: '包邮',
          transform: [1, 0, 0, 1, 220, 340],
          style: { font: { name: '' }, fontSize: 32 },
        },
      },
    ],
  })
}

/** Register the tools against a stub host that enforces what dsh enforces. */
function register(services = {}) {
  const tools = new Map()
  const ctx = {
    reflect: { get: (name) => services[name] },
    tools: {
      register(definition) {
        const output = definition.output
        assert.equal(typeof output?.render, 'function', `${definition.name}: output.render is required`)
        assertSupportedJsonSchema(definition.parameters)
        assertSupportedJsonSchema(output.schema)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  const dispose = registerTools(ctx)
  return { tools, dispose }
}

/** Run a tool and check its result like the dsh tool runtime does. */
async function call(tool, args, exec) {
  const value = await tool.execute(args, exec)
  assert.deepEqual(
    validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value))),
    [],
    `${tool.name} result matches its output schema`,
  )
  const rendered = tool.output.render(args, value)
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${tool.name} renders its result`)
  return value
}

const sessionAt = (cwd) => ({ agent: { session: { header: { cwd } } }, signal: undefined })

async function main() {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'psd-studio-host-')))
  await fs.writeFile(path.join(workspace, 'tpl.psd'), Buffer.from(buildPsd()))
  await fs.writeFile(path.join(workspace, 'sku.png'), await fillCanvas(120, 160, '#e02020').encode('png'))

  try {
    // --- the host plugin only requires services every dsh version has -------
    assert.deepEqual(entry.inject, ['tools'], 'workingDirectory is not a hard dependency')

    // --- dsh 0.2.0: no workingDirectory service, the session header wins ----
    const legacy = register()
    assert.deepEqual([...legacy.tools.keys()].sort(), ['psd_batch_render', 'psd_inspect'])
    const inspected = await call(legacy.tools.get('psd_inspect'), { template: 'tpl.psd' }, sessionAt(workspace))
    assert.equal(inspected.width, 400)
    const price = inspected.layers.find((layer) => layer.name === '价格')
    assert.equal(price.textContent, '¥9.90')
    assert.equal(price.runs[0].family, 'Arial')
    const noFont = inspected.layers.find((layer) => layer.name === '无字体')
    assert.ok(noFont.runs.length > 0)
    assert.ok(noFont.runs.every((run) => !('family' in run)), 'a run without a font omits family, never null')

    const rendered = await call(
      legacy.tools.get('psd_batch_render'),
      { template: 'tpl.psd', skus: ['sku.png'], slots: ['产品位'], outDir: 'out', format: 'png' },
      sessionAt(workspace),
    )
    assert.equal(rendered.count, 1)
    await fs.access(path.join(workspace, 'out', rendered.files[0]))
    legacy.dispose()

    // --- dsh >= 0.2.1: the workingDirectory service is preferred ------------
    const ensured = []
    const modern = register({
      workingDirectory: {
        async ensure(agent) {
          ensured.push(agent)
          return workspace
        },
      },
    })
    // The header points somewhere else: only the service can resolve tpl.psd.
    const elsewhere = sessionAt(path.join(workspace, 'missing'))
    await call(modern.tools.get('psd_inspect'), { template: 'tpl.psd' }, elsewhere)
    assert.equal(ensured.length, 1, 'workingDirectory.ensure was used')
    assert.equal(ensured[0], elsewhere.agent)
    modern.dispose()

    // --- no service and no session workspace: a clear error, not process.cwd
    const bare = register()
    await assert.rejects(
      bare.tools.get('psd_inspect').execute({ template: 'tpl.psd' }, { agent: { session: { header: {} } } }),
      /no workspace directory/,
    )
    bare.dispose()

    console.log('dsh host contract test passed')
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
