import type React from 'react'

type IconName = 'search' | 'sun' | 'moon' | 'three' | 'focus' | 'dual' | 'close' | 'sync'

/** Inline single-colour SVG icons (currentColor) carried over from the reference. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }): React.ReactElement {
  const p = { width: size, height: size, viewBox: '0 0 16 16', fill: 'none' as const }
  switch (name) {
    case 'search':
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="4.8" stroke="currentColor" strokeWidth="1.5" />
          <line
            x1="10.6"
            y1="10.6"
            x2="14"
            y2="14"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'moon':
      return (
        <svg {...p}>
          <path
            d="M13.2 9.6A5.4 5.4 0 1 1 6.6 2.9 4.3 4.3 0 0 0 13.2 9.6Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'sun':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
          <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <line x1="8" y1="1.4" x2="8" y2="3" />
            <line x1="8" y1="13" x2="8" y2="14.6" />
            <line x1="1.4" y1="8" x2="3" y2="8" />
            <line x1="13" y1="8" x2="14.6" y2="8" />
            <line x1="3.4" y1="3.4" x2="4.5" y2="4.5" />
            <line x1="11.5" y1="11.5" x2="12.6" y2="12.6" />
            <line x1="12.6" y1="3.4" x2="11.5" y2="4.5" />
            <line x1="4.5" y1="11.5" x2="3.4" y2="12.6" />
          </g>
        </svg>
      )
    case 'three':
      return (
        <svg {...p}>
          <rect x="1.5" y="3.5" width="3" height="9" rx="1" fill="currentColor" opacity=".55" />
          <rect x="6" y="3.5" width="4" height="9" rx="1" fill="currentColor" />
          <rect x="11.5" y="3.5" width="3" height="9" rx="1" fill="currentColor" opacity=".55" />
        </svg>
      )
    case 'focus':
      return (
        <svg {...p}>
          <rect x="5" y="3.5" width="6" height="9" rx="1" fill="currentColor" />
        </svg>
      )
    case 'dual':
      return (
        <svg {...p}>
          <rect x="1.8" y="3.5" width="5.4" height="9" rx="1" fill="currentColor" />
          <rect x="8.8" y="3.5" width="5.4" height="9" rx="1" fill="currentColor" opacity=".55" />
        </svg>
      )
    case 'sync':
      return (
        <svg {...p}>
          <path
            d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path
            d="M11.5 1.8v2.7H8.8M4.5 14.2v-2.7H7.2"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    default:
      return <svg {...p} />
  }
}
