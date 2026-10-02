/**
 * A unified diff as coloured monospace lines with gutter numbers.
 *
 * Horizontally scrollable rather than wrapped: a wrapped diff line reads as
 * two edits, and the gutter stops lining up the moment one wraps.
 */
import { useMemo } from 'react'
import { ScrollView, View } from 'react-native'

import { MONOSPACE } from '../markdown'
import { directTouchPanRef } from '../platform/pointer-drag'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { parseUnifiedDiff, type DiffLine } from './diff'

export interface DiffViewProps {
  diff: string
  /** Lines beyond this are dropped with a tail note; 0 shows everything. */
  maxLines?: number
  testID?: string
}

const GUTTER_WIDTH = 34

function lineColors(kind: DiffLine['kind'], scheme: 'light' | 'dark') {
  const dark = scheme === 'dark'

  switch (kind) {
    case 'add':
      return { background: dark ? '#14331F' : '#E3F5E8', text: dark ? '#76D995' : '#166534' }
    case 'delete':
      return { background: dark ? '#3A1519' : '#FBE4E6', text: dark ? '#FF9AA4' : '#9B1C2A' }
    case 'hunk':
      return { background: dark ? '#1C2733' : '#E6EEF7', text: dark ? '#8FBBEA' : '#2A5A8C' }
    default:
      return { background: 'transparent', text: undefined }
  }
}

function marker(kind: DiffLine['kind']): string {
  if (kind === 'add') {
    return '+'
  }

  if (kind === 'delete') {
    return '−'
  }

  return ' '
}

export function DiffView({ diff, maxLines = 160, testID }: DiffViewProps) {
  const theme = useTheme()
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const shown = maxLines > 0 ? lines.slice(0, maxLines) : lines
  const hidden = lines.length - shown.length

  return (
    <View
      style={{
        borderColor: theme.hairline,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
        marginTop: theme.space.sm,
        overflow: 'hidden'
      }}
      testID={testID}
    >
      <ScrollView
        directionalLockEnabled
        horizontal
        ref={directTouchPanRef}
        showsHorizontalScrollIndicator={false}
        // A horizontal `ScrollView` grows to fill its column unless told not to.
        style={{ flexGrow: 0 }}
      >
        <View style={{ minWidth: '100%' }}>
          {shown.map((line, index) => {
            const colors = lineColors(line.kind, theme.scheme)

            return (
              <View
                key={index}
                style={{ backgroundColor: colors.background, flexDirection: 'row', paddingHorizontal: 6 }}
              >
                <Text
                  color="textMuted"
                  style={{ fontFamily: MONOSPACE, fontSize: 11, textAlign: 'right', width: GUTTER_WIDTH }}
                >
                  {line.oldLine ?? ''}
                </Text>
                <Text
                  color="textMuted"
                  style={{
                    fontFamily: MONOSPACE,
                    fontSize: 11,
                    marginRight: 6,
                    textAlign: 'right',
                    width: GUTTER_WIDTH
                  }}
                >
                  {line.newLine ?? ''}
                </Text>
                <Text
                  selectable
                  style={{
                    color: colors.text ?? theme.colors.text,
                    fontFamily: MONOSPACE,
                    fontSize: 12,
                    lineHeight: 18
                  }}
                >
                  {`${marker(line.kind)}${line.text}`}
                </Text>
              </View>
            )
          })}
        </View>
      </ScrollView>

      {hidden > 0 ? (
        <Text color="textMuted" style={{ fontSize: 11, padding: theme.space.sm }}>
          {`… ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`}
        </Text>
      ) : null}
    </View>
  )
}
