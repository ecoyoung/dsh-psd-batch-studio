/**
 * Host half of the PSD batch studio bundle.
 *
 * Besides carrying the display metadata for the browser workbench, this Host
 * plugin registers the agent tools that render SKU batches headlessly through
 * the shared compositor (see `server.js`).
 */
import { registerTools } from './server.js'

export const inject = ['tools', 'workingDirectory']

export function apply(ctx) {
  ctx.effect(() => registerTools(ctx), 'psd-batch-studio: agent tools')
}
