/**
 * The agents bar expanded: the delegation tree, each child's stream, and the
 * three things you can actually do to a running child — steer it, stop it, or
 * open its own transcript.
 *
 * Steering is a text field rather than a menu because a correction is prose;
 * `subagent.steer` takes the words as written.
 */
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native'

import { MONOSPACE } from '../markdown/context'
import { directTouchPanRef } from '../platform/pointer-drag'
import { BottomSheet, SheetPage } from '../ui/BottomSheet'
import { Button, Text, TextField } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../ui/tokens'
import { useEscapeKey } from '../ui/useEscapeKey'
import { formatDuration } from './format'
import { statusGlyph, statusTone } from './SubagentGroupCard'
import { chatStrings } from './strings'
import type { SubagentNode } from './types'

/**
 * One agent's transcript as the sheet shows it.
 *
 * Two sources, deliberately labelled apart: `subagent.tail` is a LIVE tail that
 * stops existing when the child does, and `session.history` under the child's
 * own session id is the stored transcript that outlives it. A reader who cannot
 * tell which one they are looking at cannot tell whether "nothing new" means
 * finished or disconnected.
 */
export interface SubagentTranscript {
  subagentId: string
  goal: string
  text: string
  source: 'tail' | 'stored'
  loading: boolean
  error?: string
}

export interface AgentsSheetProps {
  visible: boolean
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
  /** `subagentTree(state)` — roots first, children nested. */
  tree: SubagentNode[]
  onSteer?: (subagentId: string, text: string) => void
  onInterrupt?: (subagentId: string) => void
  onOpenTranscript?: (subagentId: string) => void
  /** The transcript panel, when the caller has opened one. */
  transcript?: SubagentTranscript | null
  onCloseTranscript?: () => void
  /** A one-line result of the last Steer or Stop, shown above the tree. */
  notice?: string | null
}

/** Caption-sized actions keep their size and grow their touch target instead. */
const ACTION_STYLE = { justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT } as const

function AgentRow({
  node,
  depth,
  onSteer,
  onInterrupt,
  onOpenTranscript
}: {
  node: SubagentNode
  depth: number
  onSteer?: (subagentId: string, text: string) => void
  onInterrupt?: (subagentId: string) => void
  onOpenTranscript?: (subagentId: string) => void
}) {
  const theme = useTheme()
  const [steering, setSteering] = useState(false)
  const [draft, setDraft] = useState('')

  const live = node.status === 'running' || node.status === 'queued'

  const submitSteer = () => {
    const text = draft.trim()

    if (!text) {
      return
    }

    onSteer?.(node.id, text)
    setDraft('')
    setSteering(false)
  }

  return (
    <View
      style={{
        // A child is indented AND hangs off a rail. Indentation alone stopped
        // reading as a tree past the first level — three cards inset by 12pt
        // look like three cards with odd margins, not like a parent and its
        // children — and the rail is one hairline rather than a second card.
        borderLeftColor: depth > 0 ? theme.hairline : 'transparent',
        borderLeftWidth: depth > 0 ? 1 : 0,
        gap: theme.space.xs,
        marginLeft: depth > 0 ? theme.space.md : 0,
        paddingLeft: depth > 0 ? theme.space.md : 0
      }}
    >
      <View
        style={{
          backgroundColor: theme.elevation.e3c,
          borderColor: theme.hairlineSoft,
          borderRadius: theme.radii.card,
          borderWidth: 1,
          gap: theme.space.xs,
          padding: theme.space.md
        }}
        testID={`agent-row-${node.id}`}
      >
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
          <Text color={statusTone(node.status)} style={{ fontSize: 12, width: 14 }}>
            {statusGlyph(node.status)}
          </Text>
          <Text style={{ color: theme.colors.text, flex: 1, fontSize: 15, fontWeight: '600' }}>{node.goal}</Text>
          <Text color="textMuted" style={{ fontSize: 11 }}>
            {formatDuration(node.durationSeconds ?? Math.max(0, (node.updatedAt - node.startedAt) / 1000))}
          </Text>
        </View>

        {/*
          The status word carries the tone; nothing here pulses or spins. §3:
          a child being busy is information, and the only state allowed to
          animate anywhere in the app is "needs input".
        */}
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
          <Text color={statusTone(node.status)} variant="micro">
            {chatStrings.subagents.status[node.status].toUpperCase()}
          </Text>
          {node.currentTool ? (
            <Text color="textFaint" numberOfLines={1} style={{ flex: 1, fontFamily: MONOSPACE }} variant="meta">
              {node.currentTool}
            </Text>
          ) : null}
        </View>

        {node.stream.length ? (
          <View style={{ gap: 2 }}>
            {node.stream.slice(-4).map((entry, index) => (
              <Text
                color={entry.isError ? 'dangerText' : 'textMuted'}
                key={index}
                numberOfLines={2}
                style={{ fontSize: 12, lineHeight: 17 }}
              >
                {entry.text}
              </Text>
            ))}
          </View>
        ) : null}

        {node.summary ? (
          <Text color="text" style={{ fontSize: 13, lineHeight: 19 }}>
            {node.summary}
          </Text>
        ) : null}

        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
          {live && onSteer ? (
            <Pressable
              accessibilityRole="button"
              aria-expanded={steering}
              hitSlop={TAP_SLOP}
              onPress={() => setSteering(current => !current)}
              style={ACTION_STYLE}
              testID={`agent-steer-${node.id}`}
            >
              <Text color="accentText" variant="meta">
                {chatStrings.subagents.steer}
              </Text>
            </Pressable>
          ) : null}

          {live && onInterrupt ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={() => onInterrupt(node.id)}
              style={ACTION_STYLE}
              testID={`agent-stop-${node.id}`}
            >
              <Text color="dangerText" variant="meta">
                {chatStrings.subagents.stop}
              </Text>
            </Pressable>
          ) : null}

          {onOpenTranscript && node.childSessionId ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={() => onOpenTranscript(node.id)}
              style={ACTION_STYLE}
              testID={`agent-transcript-${node.id}`}
            >
              <Text color="accentText" variant="meta">
                {chatStrings.subagents.openTranscript}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {steering ? (
          <View style={{ gap: theme.space.sm }}>
            <TextField
              onChangeText={setDraft}
              onSubmitEditing={submitSteer}
              placeholder={chatStrings.subagents.steerPlaceholder}
              returnKeyType="send"
              testID={`agent-steer-input-${node.id}`}
              value={draft}
            />
            <Button
              disabled={!draft.trim()}
              onPress={submitSteer}
              testID={`agent-steer-send-${node.id}`}
              title={chatStrings.subagents.steer}
            />
          </View>
        ) : null}
      </View>

      {node.children.map(child => (
        <AgentRow
          depth={depth + 1}
          key={child.id}
          node={child}
          onInterrupt={onInterrupt}
          onOpenTranscript={onOpenTranscript}
          onSteer={onSteer}
        />
      ))}
    </View>
  )
}

/**
 * One child's transcript, as a PAGE of the sheet rather than as a panel inside it.
 *
 * Same header as every other sheet page — `SheetPage` — so the back control is
 * where the reader has already learnt it is, and so the level Escape pops is the
 * level the chevron pops. The tree is not unmounted while it is open; the page
 * simply takes the body.
 */
function TranscriptPage({ transcript, onBack }: { transcript: SubagentTranscript; onBack?: () => void }) {
  const theme = useTheme()

  return (
    <SheetPage
      backLabel={chatStrings.subagents.transcriptBack}
      onBack={() => onBack?.()}
      testID="agent-transcript-back"
      title={transcript.goal}
    >
      <View style={{ gap: theme.space.sm }} testID="agent-transcript">
        <Text color="textFaint" variant="micro">
          {(transcript.source === 'tail'
            ? chatStrings.subagents.transcriptLive
            : chatStrings.subagents.transcriptStored
          ).toUpperCase()}
        </Text>

        {transcript.error ? (
          <Text color="dangerText" variant="preview">
            {transcript.error}
          </Text>
        ) : null}

        <ScrollView
          ref={directTouchPanRef}
          style={{
            backgroundColor: theme.tintSunk,
            borderColor: theme.hairlineSoft,
            borderRadius: theme.radii.inset,
            borderWidth: 1,
            maxHeight: 340,
            padding: theme.space.md
          }}
        >
          {transcript.loading && !transcript.text ? (
            <ActivityIndicator />
          ) : (
            <Text
              color={transcript.text ? 'text' : 'textMuted'}
              selectable
              style={{ fontFamily: MONOSPACE, fontSize: 12.5, lineHeight: 19 }}
              testID="agent-transcript-text"
            >
              {transcript.text || chatStrings.subagents.transcriptEmpty}
            </Text>
          )}
        </ScrollView>
      </View>
    </SheetPage>
  )
}

export function AgentsSheet({
  visible,
  onClose,
  onClosed,
  tree,
  onSteer,
  onInterrupt,
  onOpenTranscript,
  transcript,
  onCloseTranscript,
  notice
}: AgentsSheetProps) {
  const theme = useTheme()

  /**
   * Escape closes the transcript page first, and only then the sheet.
   *
   * `useEscapeKey` delivers to whoever registered LAST and effects flush
   * child-first, so the `BottomSheet` below registers its own "close the sheet"
   * handler before this line runs. The page therefore wins the key while it is
   * open, pops itself, unregisters, and hands the key back — the same mount-order
   * arrangement `ChatOptionsSheet` relies on, which is why it is not coordinated
   * anywhere.
   */
  useEscapeKey(() => onCloseTranscript?.(), visible && Boolean(transcript) && Boolean(onCloseTranscript))

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.subagents.title}
      onClosed={onClosed}
      onRequestClose={onClose}
      testID="agents-sheet"
      visible={visible}
    >
      {transcript ? (
        <TranscriptPage onBack={onCloseTranscript} transcript={transcript} />
      ) : (
        <>
          <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text variant="sheetTitle">{chatStrings.subagents.title}</Text>
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={onClose}
              style={ACTION_STYLE}
              testID="agents-sheet-close"
            >
              <Text color="accentText" variant="body">
                {chatStrings.options.done}
              </Text>
            </Pressable>
          </View>

          {notice ? (
            <Text color="textMuted" testID="agents-sheet-notice" variant="preview">
              {notice}
            </Text>
          ) : null}

          {tree.length ? (
            <View style={{ gap: theme.space.sm }}>
              {tree.map(node => (
                <AgentRow
                  depth={0}
                  key={node.id}
                  node={node}
                  onInterrupt={onInterrupt}
                  onOpenTranscript={onOpenTranscript}
                  onSteer={onSteer}
                />
              ))}
            </View>
          ) : (
            <Text color="textMuted">{chatStrings.subagents.idle}</Text>
          )}
        </>
      )}
    </BottomSheet>
  )
}
