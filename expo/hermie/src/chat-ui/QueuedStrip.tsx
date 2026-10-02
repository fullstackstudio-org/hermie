/**
 * The messages the reader sent while the turn was still running, as a STRIP.
 *
 * They used to be bubbles at the end of the transcript — the reader's own fill,
 * the reader's own side — on the argument that "your message is waiting" is not
 * a system notice and must not look like one. The owner's verdict on the built
 * version is the other half of that argument: a bubble is a thing that HAPPENED,
 * and a parked message has not happened. Drawn as one it sits in the history
 * with a word under it, three text buttons hanging off its corner, and a place
 * in the scroll that the reader has to go and find again.
 *
 * So it is a strip now: full width, over the composer, in the one part of the
 * screen that is already about what is being said rather than what was. It is
 * not in the transcript at all — see `TranscriptList`, where taking the parked
 * rows out of `rows` puts the anchor's leading count back to the typing row
 * alone.
 *
 * Three at a time, and a count for the rest. A reader who has parked six
 * messages has a different problem from one who has parked one, and six strips
 * stacked over the composer would take most of a phone — the cap says how many
 * without drawing them.
 *
 * **It outlives its own data on purpose.** A queued message stops being queued
 * the instant it goes, which would take the strip off screen on the same frame
 * the bubble arrives — two changes at once, and the reader cannot see that the
 * second is the first. `shown` keeps a departed entry until its `Appear` reports
 * the exit finished, so the strip leaves while the bubble comes in.
 */
import { useCallback, useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

import { Appear } from '../ui/Appear'
import { GlassSurface } from '../ui/glass'
import { Icon, ICON_SIZE } from '../ui/Icon'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { TAP_SLOP } from '../ui/tokens'
import { chatStrings } from './strings'
import { attachmentName } from './UserBubble'

/** One parked message, as the strip takes it. */
export interface QueuedRowEntry {
  id: string
  text: string
  /** The same `@file:` references a sent bubble carries. */
  attachments?: readonly string[]
}

/**
 * How many strips are drawn before the rest become a number.
 *
 * Three is the point where a stack still reads as a stack. Four is a panel.
 */
export const QUEUE_STRIP_LIMIT = 3

export interface QueuedStripProps {
  /** Oldest first: the order they will go out in. */
  queued: readonly QueuedRowEntry[]
  /** Inject it into the turn that is running, now. */
  onSteer?: (id: string) => void
  /**
   * Put it back in the composer. Absent where there is something to lose: a
   * queued message's attachments travel with the message and the composer
   * cannot be handed bytes back, so a message WITH an attachment offers Steer
   * and Delete and nothing that would silently drop a file.
   */
  onEdit?: (id: string) => void
  onDelete?: (id: string) => void
  testID?: string
}

export function QueuedStrip({ queued, onSteer, onEdit, onDelete, testID = 'queued-strip' }: QueuedStripProps) {
  const theme = useTheme()

  /** Everything that has been in the queue and has not finished leaving. */
  const [shown, setShown] = useState<readonly QueuedRowEntry[]>(() => [...queued])
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    setShown(current => {
      const already = new Set(current.map(entry => entry.id))
      const added = queued.filter(entry => !already.has(entry.id))

      // Nothing new: the departures are handled on the way out, by `forget`.
      return added.length ? [...current, ...added] : current
    })
  }, [queued])

  const forget = useCallback((id: string) => {
    setShown(current => current.filter(entry => entry.id !== id))
  }, [])

  const live = new Set(queued.map(entry => entry.id))
  const visible = shown.slice(0, QUEUE_STRIP_LIMIT)
  const hidden = queued.filter(entry => !visible.some(row => row.id === entry.id)).length

  if (!shown.length) {
    return null
  }

  return (
    <View style={{ gap: theme.space.xs }} testID={testID}>
      {visible.map(entry => (
        <Appear
          key={entry.id}
          onExited={() => forget(entry.id)}
          rise={6}
          testID={`${testID}-slot-${entry.id}`}
          token="row"
          visible={live.has(entry.id)}
        >
          <Strip
            entry={entry}
            expanded={expanded === entry.id}
            onToggle={() => setExpanded(current => (current === entry.id ? null : entry.id))}
            testID={testID}
            {...(onDelete ? { onDelete } : {})}
            {...(onEdit && !entry.attachments?.length ? { onEdit } : {})}
            {...(onSteer ? { onSteer } : {})}
          />
        </Appear>
      ))}

      {hidden > 0 ? (
        <Text color="textFaint" style={{ paddingHorizontal: theme.space.sm }} testID={`${testID}-more`} variant="meta">
          {chatStrings.queue.more(hidden)}
        </Text>
      ) : null}
    </View>
  )
}

function Action({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable accessibilityRole="button" hitSlop={TAP_SLOP} onPress={onPress} testID={testID}>
      {({ pressed }) => (
        <Text color="accentText" style={{ opacity: pressed ? 0.6 : 1 }} variant="meta">
          {label}
        </Text>
      )}
    </Pressable>
  )
}

function Strip({
  entry,
  expanded,
  onToggle,
  onSteer,
  onEdit,
  onDelete,
  testID
}: {
  entry: QueuedRowEntry
  expanded: boolean
  onToggle: () => void
  onSteer?: (id: string) => void
  onEdit?: (id: string) => void
  onDelete?: (id: string) => void
  testID: string
}) {
  const theme = useTheme()

  /*
    The message as ONE line, and its attachments named in it.

    Plain text rather than markdown: a strip is a receipt for something the
    reader typed a moment ago and still remembers, and rendering a heading or a
    table into a 20pt line is how a one-line summary becomes three.
  */
  const line = [entry.text.trim(), ...(entry.attachments ?? []).map(attachmentName)].filter(Boolean).join(' · ')

  return (
    <GlassSurface
      contentStyle={{
        alignItems: expanded ? 'flex-start' : 'center',
        flexDirection: 'row',
        gap: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
      opaque
      radius={theme.radii.card}
      variant="row"
    >
      <Icon color={theme.colors.textFaint} name="queue" size={ICON_SIZE.inline} />

      <Text color="textFaint" variant="micro">
        {chatStrings.queue.label}
      </Text>

      {/*
        The text takes the room that is left and gives it back on a tap. One line
        is what keeps the stack a strip; the whole message is what a reader needs
        before deciding to steer it, and a queued message is short enough that
        opening it in place beats sending them anywhere.
      */}
      <Pressable
        accessibilityRole="button"
        onPress={onToggle}
        style={{ flex: 1 }}
        testID={`${testID}-text-${entry.id}`}
      >
        <Text numberOfLines={expanded ? undefined : 1} variant="meta">
          {line}
        </Text>
      </Pressable>

      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        {onSteer ? (
          <Action
            label={chatStrings.queue.steer}
            onPress={() => onSteer(entry.id)}
            testID={`queued-steer-${entry.id}`}
          />
        ) : null}
        {onEdit ? (
          <Action label={chatStrings.queue.edit} onPress={() => onEdit(entry.id)} testID={`queued-edit-${entry.id}`} />
        ) : null}
        {onDelete ? (
          <Action
            label={chatStrings.queue.delete}
            onPress={() => onDelete(entry.id)}
            testID={`queued-delete-${entry.id}`}
          />
        ) : null}
      </View>
    </GlassSurface>
  )
}
