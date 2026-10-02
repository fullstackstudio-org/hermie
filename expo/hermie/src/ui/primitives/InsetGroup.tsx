import { Children, createContext, isValidElement, useContext, type ReactNode } from 'react'
import { Pressable, type PressableProps, View, type ViewProps } from 'react-native'

import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT, type TextColorRole } from '../tokens'
import { Text } from './Text'

export type InsetGroupProps = ViewProps & {
  /** Small capitalised label above the card, as iOS grouped tables use. */
  header?: string
  /** Explanatory line under the card. */
  footer?: ReactNode
}

/**
 * The iOS inset grouped section: a rounded card of rows on a tinted background,
 * with a quiet header above and an explanation below. Rows are separated by a
 * hairline that stops short of the leading edge, so the group reads as one
 * object rather than as a stack of boxes.
 */
export function InsetGroup({ header, footer, children, style, ...rest }: InsetGroupProps) {
  const theme = useTheme()
  const rows = Children.toArray(children).filter(child => isValidElement(child) || typeof child === 'string')

  return (
    <View {...rest} style={[{ gap: theme.space.sm }, style]}>
      {header ? (
        <Text
          accessibilityRole="header"
          // The section label under a screen's title, which is what it looks
          // like and now what it is: level 2 under the title's 1.
          aria-level={2}
          color="textMuted"
          style={{ marginLeft: theme.space.lg }}
          variant="micro"
        >
          {/*
            Casing lives HERE, not in the string. `header` used to be typed in
            capitals by whichever caller wanted the look — 'GATEWAY', 'ACCOUNT'
            — and left in sentence case by whichever caller did not, which is
            the whole of HERM-106: two screens side by side, one shouting and
            one not. `toLocaleUpperCase` is a locale-aware uppercase rather than
            a text-transform, because a text-transform runs on the DEVICE'S
            locale rather than the app's own language setting, and the two can
            disagree — a Turkish device would uppercase an English "i" to "İ"
            under `text-transform: uppercase` on the STYLE, not on the string.
          */}
          {header.toLocaleUpperCase()}
        </Text>
      ) : null}

      <View
        style={{
          backgroundColor: theme.elevation.e3c,
          borderRadius: theme.radii.lg,
          borderWidth: 1,
          borderColor: theme.hairline,
          overflow: 'hidden'
        }}
      >
        {rows.map((row, index) => (
          // The wrapper only carries the separator; rows a caller builds
          // dynamically carry their own keys on the row itself.
          <View key={index}>
            {index > 0 ? (
              <View style={{ height: 1, marginLeft: theme.space.lg, backgroundColor: theme.hairline }} />
            ) : null}
            {row}
          </View>
        ))}
      </View>

      {footer ? (
        typeof footer === 'string' ? (
          <Text variant="meta" color="textMuted" style={{ marginHorizontal: theme.space.lg }}>
            {footer}
          </Text>
        ) : (
          <View style={{ marginHorizontal: theme.space.lg }}>{footer}</View>
        )
      ) : null}
    </View>
  )
}

export type InsetRowProps = ViewProps & { compact?: boolean }

/** One row inside an `InsetGroup`. */
/**
 * True inside an inset row, where the row itself is already the field's chrome.
 *
 * A `TextField` draws its own sunk well everywhere else — a sheet has no rows to
 * lend it one, which is how the cron editor ended up with placeholder text
 * floating on the glass. Inside a row that well would be a second box around the
 * first, so the row says so rather than every caller remembering to.
 */
const InsetRowContext = createContext(false)

export function useInsetRow(): boolean {
  return useContext(InsetRowContext)
}

export function InsetRow({ compact = false, style, ...rest }: InsetRowProps) {
  const theme = useTheme()

  return (
    <InsetRowContext.Provider value>
      <View
        {...rest}
        style={[
          {
            paddingHorizontal: theme.space.lg,
            paddingVertical: compact ? theme.space.sm : theme.space.md,
            minHeight: CONTROL_MIN_HEIGHT,
            justifyContent: 'center',
            gap: theme.space.xxs
          },
          style
        ]}
      />
    </InsetRowContext.Provider>
  )
}

export type InsetButtonRowProps = Omit<PressableProps, 'children'> & {
  title: string
  /** Destructive rows are red, the way iOS marks "Sign out" and "Delete". */
  tone?: InsetRowTone
  detail?: string
}

export type InsetRowTone = 'accent' | 'danger' | 'text'

/**
 * The INK a row's tone is drawn in.
 *
 * A tone names an intention — "this row acts", "this row destroys" — and the
 * intention is not a colour. `accent` and `danger` are fills, with no contrast
 * floor of their own; `accentText` and `dangerText` are the floored siblings that
 * `scripts/check-contrast.ts` measures on every surface of every theme.
 *
 * This is the whole of the owner's Graphite report: the title was painted in the
 * accent SWATCH, which on Graphite is a grey barely off the grey card under it,
 * and the check could not fail because a swatch is not an ink. Exported so the
 * mapping is testable on its own — the bug was in this one line.
 */
export function toneInk(tone: InsetRowTone): TextColorRole {
  switch (tone) {
    case 'accent':
      return 'accentText'
    case 'danger':
      return 'dangerText'
    default:
      return 'text'
  }
}

/** A tappable row: the inset-group equivalent of a link. */
export function InsetButtonRow({ title, tone = 'accent', detail, disabled, style, ...rest }: InsetButtonRowProps) {
  const theme = useTheme()

  return (
    <Pressable accessibilityRole="button" aria-disabled={Boolean(disabled)} disabled={disabled} style={style} {...rest}>
      {({ pressed }) => (
        <View
          style={{
            paddingHorizontal: theme.space.lg,
            paddingVertical: theme.space.md,
            minHeight: CONTROL_MIN_HEIGHT,
            justifyContent: 'center',
            gap: theme.space.xxs,
            backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
            opacity: disabled ? 0.4 : 1
          }}
        >
          <Text variant="body" color={toneInk(tone)}>
            {title}
          </Text>
          {detail ? (
            <Text variant="meta" color="textMuted">
              {detail}
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  )
}

export type InsetValueRowProps = {
  label: string
  value: string
  mono?: boolean
  /**
   * A quieter second line under the value, for a value that needs a
   * qualification rather than a footnote.
   *
   * One caller today: the browser build's gateway address, where the value is
   * the gateway's own host and the qualification is that this page reaches it
   * through Hermie Web. Two separate rows would read as two gateways, and a
   * group footer is about the group rather than about the row.
   */
  detail?: string
}

/** A read-only label/value row, used by Settings to show the configured gateway. */
export function InsetValueRow({ label, value, mono = false, detail }: InsetValueRowProps) {
  const theme = useTheme()

  return (
    <InsetRow style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.md }}>
      <Text variant="body" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <View style={{ flex: 1 }}>
        <Text variant={mono ? 'code' : 'body'} color="textMuted" numberOfLines={1} style={{ textAlign: 'right' }}>
          {value}
        </Text>
        {detail ? (
          <Text color="textFaint" numberOfLines={1} style={{ textAlign: 'right' }} variant="micro">
            {detail}
          </Text>
        ) : null}
      </View>
    </InsetRow>
  )
}
