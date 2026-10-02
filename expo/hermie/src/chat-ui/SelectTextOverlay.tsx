/**
 * One message, as one piece of text a mouse can drag across.
 *
 * ## Why a panel and not the bubble
 *
 * The owner asked to sweep the pointer across a reply and get a selection. The
 * transcript cannot give him one: `Text selectable` is a long press and a
 * whole-paragraph copy, with no selection range in the component at all (the
 * reading is in `src/markdown/attributed.ts`), and the only thing in UIKit that
 * drag-selects RICH text is a `UITextView` — which cannot hold the scrolling code
 * block and the box-built table our renderer emits.
 *
 * So the bubble keeps the renderer, and this is a SECOND presentation of the same
 * message: the same lexer, the same text, flattened to styled runs and handed to
 * a real text view. Drag, double click for a word, shift-click to extend, ⌘A, ⌘C
 * and the system's edit menu all come from UIKit rather than from here.
 *
 * ## The fallback is a `Text` tree, not nothing
 *
 * On an iPhone, on Android and in the test renderer there is no native view, and
 * the panel still opens — as a nested `Text selectable` tree over the same runs.
 * That is the ceiling on those platforms anyway (long press, Copy, the whole
 * block), and a menu entry that opens an empty panel on a device somebody happens
 * to be holding would be worse than one that opens a readable one.
 *
 * Esc closes it through `useEscapeKey`, so it takes the key off whatever is under
 * it while it is up and gives it back when it goes — the same stack every sheet
 * in the app is on.
 */
import { useMemo } from 'react'
import { Modal, Pressable, ScrollView, Text as RNText, View } from 'react-native'

import { runsToPlainText, selectableRuns, type SelectableRun } from '../markdown/attributed'
import { MONOSPACE } from '../markdown/context'
import { copyToClipboard } from '../platform/clipboard'
import { nativeSelectableText } from '../platform/selectable-text'
import { GlassSurface } from '../ui/glass'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { SCRIM_COLOR, TAP_SLOP } from '../ui/tokens'
import { useEscapeKey } from '../ui/useEscapeKey'
import { chatStrings } from './strings'

export interface SelectTextOverlayProps {
  /** The message's markdown source, exactly as the bubble holds it. */
  markdown: string
  onClose: () => void
  testID?: string
}

/** The scale steps the native view uses, kept here so the fallback matches it. */
const HEADING_SCALE: Record<string, number> = { heading1: 1.5, heading2: 1.3, heading3: 1.1 }

/**
 * One run as a nested `Text`'s style. Exported so a test can state the mapping
 * without reaching into a rendered tree.
 */
export function runTextStyle(
  run: SelectableRun,
  theme: { body: number; text: string; muted: string; link: string; codeBackground: string }
): {
  fontSize: number
  fontWeight: '400' | '600' | '700'
  fontStyle: 'normal' | 'italic'
  color: string
  fontFamily?: string
  backgroundColor?: string
  textDecorationLine?: 'line-through' | 'underline'
} {
  const mono = run.mono || run.block === 'code'
  const scale = HEADING_SCALE[run.block] ?? 1
  const heading = scale !== 1

  return {
    color: run.href ? theme.link : run.block === 'quote' ? theme.muted : theme.text,
    fontSize: mono ? theme.body - 1 : Math.round(theme.body * scale),
    fontStyle: run.italic ? 'italic' : 'normal',
    fontWeight: heading || run.bold ? (run.block === 'heading3' ? '600' : heading ? '700' : '600') : '400',
    ...(mono ? { backgroundColor: theme.codeBackground, fontFamily: MONOSPACE } : {}),
    ...(run.strike ? { textDecorationLine: 'line-through' as const } : {}),
    ...(run.href && !run.strike ? { textDecorationLine: 'underline' as const } : {})
  }
}

export function SelectTextOverlay({ markdown, onClose, testID = 'select-text' }: SelectTextOverlayProps) {
  const theme = useTheme()
  const runs = useMemo(() => selectableRuns(markdown), [markdown])
  const Native = nativeSelectableText()

  useEscapeKey(onClose)

  const palette = {
    body: theme.type.body.fontSize,
    codeBackground: theme.tintSunk,
    link: theme.colors.accentText,
    muted: theme.colors.textMuted,
    text: theme.colors.text
  }

  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent transparent visible>
      <View style={{ backgroundColor: SCRIM_COLOR, flex: 1 }} testID={testID}>
        {/*
          The panel is full height on purpose. A message worth selecting out of is
          usually a long one, and a sheet that shows a third of it turns one drag
          into a drag plus a scroll plus a second drag.
        */}
        <GlassSurface
          accessibilityLabel={chatStrings.selectText.panel}
          accessibilityViewIsModal
          contentStyle={{
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            flex: 1
          }}
          // `opaque`, like every sheet: a panel whose whole job is reading and
          // copying cannot have its contrast be a function of the wallpaper.
          opaque
          radius={theme.radii.sheet}
          style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, flex: 1, marginTop: theme.space.xl }}
          testID={`${testID}-panel`}
          variant="sheet"
        >
          <View
            style={{
              alignItems: 'center',
              borderBottomColor: theme.hairline,
              borderBottomWidth: 1,
              flexDirection: 'row',
              gap: theme.space.md,
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.md
            }}
          >
            <View style={{ flex: 1 }}>
              <Text variant="name">{chatStrings.selectText.title}</Text>
              <Text color="textMuted" variant="meta">
                {chatStrings.selectText.hint}
              </Text>
            </View>

            {/*
              A button for the same thing ⌘C does, because the panel also opens on
              an iPad and on a phone, where there is no ⌘ to press.
            */}
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={() => copyToClipboard(runsToPlainText(runs))}
              testID={`${testID}-copy-all`}
            >
              <Text color="accentText">{chatStrings.selectText.copyAll}</Text>
            </Pressable>

            <Pressable accessibilityRole="button" hitSlop={TAP_SLOP} onPress={onClose} testID={`${testID}-done`}>
              <Text color="accentText" variant="name">
                {chatStrings.selectText.done}
              </Text>
            </Pressable>
          </View>

          {Native ? (
            <Native
              codeBackground={palette.codeBackground}
              fontSize={palette.body}
              linkColor={palette.link}
              mutedColor={palette.muted}
              runs={runs}
              style={{ flex: 1, margin: theme.space.lg }}
              testID={`${testID}-native`}
              textColor={palette.text}
            />
          ) : (
            <ScrollView contentContainerStyle={{ padding: theme.space.lg }} testID={`${testID}-scroll`}>
              {/*
                ONE `Text`, with the runs nested inside it. Separate `Text`s per
                run would each be their own selection on the platforms that have
                one, and would break a paragraph's wrapping into boxes.
              */}
              <RNText selectable testID={`${testID}-body`}>
                {runs.map((run, index) => (
                  <RNText key={index} style={runTextStyle(run, palette)}>
                    {run.text}
                  </RNText>
                ))}
              </RNText>
            </ScrollView>
          )}
        </GlassSurface>
      </View>
    </Modal>
  )
}
