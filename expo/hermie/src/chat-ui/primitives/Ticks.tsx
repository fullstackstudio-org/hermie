/**
 * The delivery ticks beside a timestamp.
 *
 * Drawn as paths rather than as the character `✓`. Two reasons, both learned the
 * hard way on this project: a glyph outside the Latin block can resolve to the
 * emoji font on iOS unless you ask for the text presentation (see the U+21A9 note
 * in `docs/platform-notes.md`), and a tick that has to sit on white text inside a
 * blue bubble needs its stroke weight controlled, which a font will not do.
 *
 * `sending` deliberately has no tick at all — a hollow ring instead. A tick means
 * the gateway has it; drawing one before that would be a promise the app cannot
 * keep, which is the same rule §6.6 applies to a pending dispatch.
 */
import Svg, { Circle, Path } from 'react-native-svg'

import type { Receipt } from '../types'

export interface TicksProps {
  receipt: Receipt
  color: string
  size?: number
}

const CHECK = 'M1 5.2 L3.6 8 L8.6 1.6'

export function Ticks({ receipt, color, size = 14 }: TicksProps) {
  const double = receipt === 'read'
  const width = double ? size * 1.15 : size * 0.85

  return (
    <Svg
      // The ticks repeat what the label beside them already says, so they carry
      // no accessibility value of their own.
      accessibilityElementsHidden
      // `aria-hidden` is the web's spelling of the two props around it; react-native-web
      // honours neither of those. See `ui/Icon.tsx`.
      aria-hidden
      height={size}
      importantForAccessibility="no-hide-descendants"
      viewBox={`0 0 ${double ? 13 : 10} 10`}
      width={width}
    >
      {receipt === 'sending' ? (
        <Circle cx={5} cy={5} fill="none" r={3.6} stroke={color} strokeWidth={1.4} />
      ) : (
        <>
          <Path d={CHECK} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} />
          {double ? (
            <Path
              d={CHECK}
              fill="none"
              stroke={color}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.6}
              x={3.4}
            />
          ) : null}
        </>
      )}
    </Svg>
  )
}
