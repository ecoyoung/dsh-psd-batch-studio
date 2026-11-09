/**
 * Host half of the PSD batch studio bundle.
 *
 * Besides carrying the display metadata for the browser workbench, this Host
 * plugin registers the agent tools that render SKU batches headlessly through
 * the shared compositor (see `server.js`).
 */
import { registerTools } from './server.js'

// Only `tools` is required. `workingDirectory` exists from dsh 0.2.1 on but
// not in 0.2.0 (the desktop app's runtime); requiring it would leave the
// plugin pending there, so the tools look it up per call instead.
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => registerTools(ctx), 'psd-batch-studio: agent tools')
}
