import React from 'react'

const paths = {
  layers: (
    <>
      <path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4 20 20" />
      <path d="M9.6 6.1A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.3 4" />
      <path d="M6.2 7.2A17 17 0 0 0 2.5 12S6 18.5 12 18.5a9.8 9.8 0 0 0 3.6-.7" />
      <path d="M9.8 9.8a3 3 0 0 0 4.4 4.4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="8.6" cy="9.4" r="1.6" />
      <path d="m4 17 5-5 3.5 3.5L16 12l4 4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5.2c0-.7.6-1.2 1.2-1.2h3.6c.6 0 1.2.5 1.2 1.2V7" />
      <path d="M6.5 7 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.5 7" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4 20h16" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-2.3 6.2" />
      <path d="M20 4v7h-7" />
    </>
  ),
  zoomIn: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5M11 8.5v5M8.5 11h5" />
    </>
  ),
  zoomOut: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5M8.5 11h5" />
    </>
  ),
  maximize: (
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 4 2.8 20h18.4L12 4Z" />
      <path d="M12 10v4.5M12 17.4v.2" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  wand: (
    <>
      <path d="m5 19 9.5-9.5" />
      <path d="m13 6 1.2 2.8L17 10l-2.8 1.2L13 14l-1.2-2.8L9 10l2.8-1.2L13 6Z" />
      <path d="M18 15.5 18.7 17l1.5.7-1.5.7L18 20l-.7-1.6-1.5-.7 1.5-.7.7-1.5Z" />
    </>
  ),
  cursor: (
    <>
      <path d="m5 4 6.5 16 2.2-6.3L20 11.5 5 4Z" />
    </>
  ),
}

export function Icon({ name, size = 16, style }) {
  const shape = paths[name]
  if (!shape) return null
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      style,
    },
    shape,
  )
}
