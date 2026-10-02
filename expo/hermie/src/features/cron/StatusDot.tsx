/**
 * The coloured dot in front of a routine.
 *
 * Green and red are theme tokens. Amber is not — `ui/tokens.ts` has no warning
 * role yet, and a routine that is paused or has never run is neither a success
 * nor a failure. The literal lives here rather than becoming a token by
 * accident; when a warning role is added this file is the only caller to move.
 */
import { View } from 'react-native'

import { useTheme } from '../../ui/theme'
import { cronStatusLabel, type CronStatus } from './model'

/** Amber, at a lightness that clears AA against both `bg` values as a 10pt dot. */
const AMBER = '#B87400'

export interface StatusDotProps {
  status: CronStatus
  size?: number
}

export function StatusDot({ status, size = 10 }: StatusDotProps) {
  const theme = useTheme()
  const color = status === 'ok' ? theme.colors.ok : status === 'failed' ? theme.colors.danger : AMBER

  return (
    <View
      accessibilityLabel={cronStatusLabel(status)}
      accessible
      style={{ backgroundColor: color, borderRadius: size / 2, height: size, width: size }}
      testID={`cron-status-${status}`}
    />
  )
}
