import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native'

import { useTheme } from '../theme'
import type { TextColorRole, TypeToken } from '../tokens'

export type TextProps = RNTextProps & {
  variant?: TypeToken
  /** Inks only. A fill role — `accent`, `danger`, `ok` — has no contrast floor; see `TextColorRole`. */
  color?: TextColorRole
}

export function Text({ variant = 'body', color = 'text', style, ...rest }: TextProps) {
  const theme = useTheme()
  const token = theme.type[variant]

  const base: TextStyle = {
    fontSize: token.fontSize,
    lineHeight: token.lineHeight,
    fontWeight: token.fontWeight,
    color: theme.colors[color]
  }

  return <RNText {...rest} style={[base, style]} />
}
