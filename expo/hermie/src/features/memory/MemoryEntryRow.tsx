/**
 * One memory entry, and the two things that can be done to it.
 *
 * ## Tap to edit, in place
 *
 * An entry is a paragraph of plain text, so editing it is a text field in the
 * row rather than a screen of its own: pushing a page to change one sentence
 * loses the reader the other entries, which are the only context that says
 * whether this one is still right.
 *
 * ## Removing asks, and the question says why
 *
 * Hermes keeps no history of a memory file. A removed entry is gone, the bot
 * stops being told it, and nothing in this app or on the gateway can put it
 * back — so the confirmation says that rather than "are you sure". It is a
 * sheet rather than a second tap on the same row, because the destructive
 * control and the confirmation must not be the same pixel.
 *
 * ## The write is addressed by TEXT
 *
 * The row knows its positional id — `memory:3` — and does not send it as the
 * thing to change. The plugin prefers the text and so does Hermes' store, which
 * matches on it; an index that went stale between the read and this tap would
 * otherwise replace whichever entry moved into that place. The index still
 * travels, as the fallback the plugin documents, and the id is what the row is
 * keyed and labelled by.
 */
import { useEffect, useState } from 'react'
import { View } from 'react-native'

import { BottomSheet } from '../../ui/BottomSheet'
import { Button, InsetRow, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { MemoryEntry } from './model'
import { memoryStrings } from './strings'

export interface MemoryEntryRowProps {
  entry: MemoryEntry
  /** The advert offers browsing and not editing; the row is then just text. */
  readOnly: boolean
  /** A write is in flight somewhere on this page. */
  busy: boolean
  onReplace: (entry: MemoryEntry, text: string) => void
  onRemove: (entry: MemoryEntry) => void
  /** The graph's "open in browser tab" scrolls here and lights the row. */
  highlighted?: boolean
  testID?: string
}

export function MemoryEntryRow({
  entry,
  readOnly,
  busy,
  onReplace,
  onRemove,
  highlighted = false,
  testID = `memory-entry-${entry.id}`
}: MemoryEntryRowProps) {
  const theme = useTheme()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.text)
  const [confirming, setConfirming] = useState(false)

  /*
    A refetch after somebody else's write rewrites this entry underneath the
    reader. Following the text while the editor is OPEN would wipe what is being
    typed, so the draft is reseeded only when the editor is shut.
  */
  useEffect(() => {
    if (!editing) {
      setDraft(entry.text)
    }
  }, [editing, entry.text])

  return (
    <InsetRow style={highlighted ? { backgroundColor: theme.elevation.e2 } : undefined} testID={testID}>
      {editing ? (
        <View style={{ gap: theme.space.sm }}>
          <TextField
            autoFocus
            multiline
            onChangeText={setDraft}
            placeholder={memoryStrings.add.placeholder}
            testID={`${testID}-editor`}
            value={draft}
          />
          <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                onPress={() => setEditing(false)}
                testID={`${testID}-cancel`}
                title={memoryStrings.edit.cancel}
                variant="secondary"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                busy={busy}
                disabled={busy || !draft.trim() || draft === entry.text}
                onPress={() => {
                  onReplace(entry, draft)
                  setEditing(false)
                }}
                testID={`${testID}-save`}
                title={memoryStrings.edit.save}
              />
            </View>
          </View>
        </View>
      ) : (
        <View style={{ gap: theme.space.xs }}>
          <Text selectable variant="body">
            {entry.text}
          </Text>

          {readOnly ? null : (
            <View style={{ flexDirection: 'row', gap: theme.space.md }}>
              <Button
                accessibilityLabel={memoryStrings.edit.label(entry.index)}
                disabled={busy}
                onPress={() => setEditing(true)}
                testID={`${testID}-edit`}
                title={memoryStrings.edit.action}
                variant="secondary"
              />
              <Button
                accessibilityLabel={memoryStrings.remove.label(entry.index)}
                disabled={busy}
                onPress={() => setConfirming(true)}
                testID={`${testID}-remove`}
                title={memoryStrings.remove.action}
                variant="danger"
              />
            </View>
          )}
        </View>
      )}

      <BottomSheet
        accessibilityLabel={memoryStrings.remove.confirmTitle}
        onRequestClose={() => setConfirming(false)}
        testID={`${testID}-confirm-sheet`}
        visible={confirming}
      >
        <View style={{ gap: theme.space.md }}>
          <Text variant="sheetTitle">{memoryStrings.remove.confirmTitle}</Text>
          <Text color="textMuted" variant="meta">
            {memoryStrings.remove.confirmBody}
          </Text>
          <Text numberOfLines={4} variant="body">
            {entry.text}
          </Text>
          <Button
            onPress={() => {
              setConfirming(false)
              onRemove(entry)
            }}
            testID={`${testID}-confirm`}
            title={memoryStrings.remove.confirm}
            variant="danger"
          />
          <Button onPress={() => setConfirming(false)} title={memoryStrings.remove.cancel} variant="secondary" />
        </View>
      </BottomSheet>
    </InsetRow>
  )
}
