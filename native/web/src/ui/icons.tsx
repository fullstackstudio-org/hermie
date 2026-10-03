/**
 * The few glyphs the shell draws, as inline SVG: no icon font, no image file
 * (the policy allows neither more than it has to), and they take the colour of
 * the text they sit in.
 *
 * Every icon is decoration. The control that holds one carries its name in
 * text, so the SVG is hidden from assistive technology.
 */
import type { ReactElement } from 'react'

export type IconName = 'chevronLeft' | 'signOut' | 'plug' | 'wifiOff' | 'alert'

/** Stroke paths on a 24 x 24 grid, drawn with a round 2px pen. */
const PATHS: Record<IconName, readonly string[]> = {
  chevronLeft: ['M15 5l-7 7 7 7'],
  signOut: ['M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4', 'M16 8l4 4-4 4', 'M20 12H9'],
  plug: ['M9 3v5', 'M15 3v5', 'M6 8h12v3a6 6 0 0 1-12 0V8z', 'M12 17v4'],
  wifiOff: ['M3 3l18 18', 'M8.5 16.4a5 5 0 0 1 7 0', 'M5 12.9a10 10 0 0 1 3.2-2', 'M12 20h.01'],
  alert: ['M12 3l10 18H2L12 3z', 'M12 10v4', 'M12 17.5h.01']
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
