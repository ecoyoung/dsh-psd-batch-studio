/**
 * Build the two artifacts of dsh-psd-batch-studio.
 *
 * - client.js: the Harness Client loader format. `react` and
 *   `react/jsx-runtime` come from the page's module table, so everything else
 *   (ag-psd, fflate) is bundled and React stays external. The loader factory id
 *   must equal the package name from package.json.
 * - server.js: the Host tool half. It runs the same compositor on a native
 *   canvas; `@napi-rs/canvas` stays external because it ships a native binary.
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const minify = !process.argv.includes('--no-minify')

const client = await build({
  entryPoints: [path.join(root, 'src/client/index.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110'],
  external: ['react', 'react/jsx-runtime'],
  jsx: 'automatic',
  minify,
  legalComments: 'none',
  write: false,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
})

const body = client.outputFiles[0].text
const banner = `window.__ModuleLoader__.load({
  id: '${pkg.name}',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`
const footer = `
    return module.exports;
  },
});
`
fs.writeFileSync(path.join(root, 'client.js'), banner + body + footer)
console.log(`wrote client.js (${(fs.statSync(path.join(root, 'client.js')).size / 1024).toFixed(0)} KiB)`)

await build({
  entryPoints: [path.join(root, 'src/server.js')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  external: ['@napi-rs/canvas'],
  minify: false,
  legalComments: 'none',
  outfile: path.join(root, 'server.js'),
  logLevel: 'info',
})
console.log(`wrote server.js (${(fs.statSync(path.join(root, 'server.js')).size / 1024).toFixed(0)} KiB)`)
