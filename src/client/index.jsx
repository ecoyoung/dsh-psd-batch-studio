import { NS, zh, en } from './i18n.js'
import { createStudio } from './page.jsx'

const PANEL_ID = 'psd-batch'

/** Sidebar glyph: a template frame with a product block and a slot target. */
function PanelIcon({ size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="3.2" />
      <path d="M7.2 9.4h3.6M7.2 12.4h9M7.2 15.4h5.4" />
      <circle cx="17" cy="9.4" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export const inject = ['slots', 'locale']

export function apply(ctx) {
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      // A reloaded module can find its namespace already registered; the
      // dictionaries are identical, so keep using them.
      return () => {}
    }
  }, 'psd-batch-studio: copy')

  const t = ctx.locale.bind(NS)
  const Studio = createStudio(ctx, t)

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => t('page.title'),
          },
          PanelIcon,
        ),
      ),
    'psd-batch-studio: sidebar entry',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, Studio),
      ),
    'psd-batch-studio: studio panel',
  )
}
