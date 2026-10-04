/**
 * The few glyphs the shell draws, as inline SVG: no icon font, no image file
 * (the policy allows neither more than it has to), and they take the colour of
 * the text they sit in.
 *
 * Every icon is decoration. The control that holds one carries its name in
 * text, so the SVG is hidden from assistive technology.
 */
import type { ReactElement } from 'react'

export type IconName =
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'arrowDown'
  | 'signOut'
  | 'plug'
  | 'wifiOff'
  | 'alert'
  | 'paperclip'
  | 'file'
  | 'settings'
  | 'grip'
  | 'bellOff'
  | 'pin'

/** Stroke paths on a 24 x 24 grid, drawn with a round 2px pen. */
const PATHS: Record<IconName, readonly string[]> = {
  chevronLeft: ['M15 5l-7 7 7 7'],
  chevronRight: ['M9 5l7 7-7 7'],
  chevronDown: ['M5 9l7 7 7-7'],
  arrowDown: ['M12 5v14', 'M6 13l6 6 6-6'],
  signOut: ['M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4', 'M16 8l4 4-4 4', 'M20 12H9'],
  plug: ['M9 3v5', 'M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0V8z', 'M12 17v4'],
  wifiOff: ['M3 3l18 18', 'M8.5 16.4a5 5 0 0 1 7 0', 'M5 12.9a10 10 0 0 1 3.2-2', 'M12 20h.01'],
  alert: ['M12 3l10 18H2L12 3z', 'M12 10v4', 'M12 17.5h.01'],
  paperclip: [
    'M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8'
  ],
  file: ['M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4z', 'M14 3v4h4'],
  settings: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  bellOff: [
    'M13.7 21a2 2 0 0 1-3.4 0',
    'M18.6 13A18 18 0 0 1 18 8',
    'M6.3 6.3A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14',
    'M18 8a6 6 0 0 0-9.3-5',
    'M2 2l20 20'
  ],
  pin: ['M12 16v5', 'M8 3h8l-1 6.5 3 4.5H6l3-4.5L8 3z']
}

export interface IconProps {
  name: IconName
  /** Pixels; the icon is square. */
  size?: number
  className?: string
}

export function Icon({ name, size = 20, className }: IconProps): ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `hm-icon ${className}` : 'hm-icon'}
    >
      {PATHS[name].map(path => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}
