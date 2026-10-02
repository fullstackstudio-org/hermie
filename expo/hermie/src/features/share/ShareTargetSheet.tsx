/**
 * "Which chat does this go to?", for a share that arrived without an answer.
 *
 * Android's `ACTION_SEND` hands the app an intent and nothing else. There is no
 * sheet of ours in that flow — the system's own chooser picked Hermie, not a
 * bot — so the question has to be asked once the app is up. iOS asks it inside
 * the share extension instead, where the roster is read out of the App Group
 * and nothing has to be launched; this sheet is the same question, one screen
 * later.
 *
 * Deliberately presentational. It is handed a list and calls back; it reads no
 * store, knows nothing about an outbox and cannot send. `ShareTargetHost` is
 * the half that is wired, which is what keeps the layout of this thing — a list
 * that can be a hundred rows long on a busy gateway — testable without a
 * gateway.
 *
 * **The note is editable here and pre-filled from the manifest.** On Android
 * there was nowhere to type one before this sheet, so an empty field is the
 * normal case; on the rare entry that already carries a note — a share replayed
 * after a failed delivery — the field shows it rather than silently dropping
 * what somebody wrote.
 *
 * **It also asks the one question ADR-0026 created.** An entry whose sender got
 * as far as submitting and did not live to see the answer carries a claim, and
 * an entry with a claim is never delivered on its own: it arrives here with a
 * line saying it may already have gone and a button that says "Send again"
 * rather than "Send". Nothing else in this feature needs a person; this does,
 * because both of the answers a program could pick are wrong some of the time.
 */
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { Avatar } from '../../chat-ui'
import { strings } from '../../i18n/strings'
import { BottomSheet } from '../../ui/BottomSheet'
import { Button, InsetGroup, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { TAP_SLOP } from '../../ui/tokens'
import { shareSummary, type PendingShare } from './outbox'

/** One choice, already named the way the reader's setting says to name it. */
export interface ShareTargetBot {
  /** The handle. This is what travels back to `onSend`. */
  name: string
  /** The primary line, per the "Bot names" setting. */
  label: string
  /** The profile's picture, when the roster has fetched one. */
  avatarUri?: string
}

export interface ShareTargetSheetProps {
  /** The entry being placed, or nothing — which is what closes the sheet. */
  share?: PendingShare
  /** Most recently active first; the list is not re-sorted here. */
  bots: readonly ShareTargetBot[]
  onSend: (bot: string, note: string) => void
  /** The reader backed out. The entry is discarded, not queued. */
  onCancel: () => void
  onClosed?: () => void
}

/**
 * The list's own height cap.
 *
 * A sheet that grows with the roster ends up taller than the window on a
 * gateway with thirty bots, and `BottomSheet` scrolls its whole body — so the
 * note field and the buttons would scroll away from the list they belong to.
 * The list scrolls inside instead, and everything that is not the list stays
 * where it was put.
 */
const LIST_MAX_HEIGHT = 320

export function ShareTargetSheet({ share, bots, onCancel, onClosed, onSend }: ShareTargetSheetProps) {
  const theme = useTheme()
  const [note, setNote] = useState('')
  const [picked, setPicked] = useState<string | null>(null)

  // A new entry is a new question. Re-seeding on the ID rather than on the
  // object keeps a re-render caused by the roster from wiping what is typed.
  useEffect(() => {
    setNote(share?.note ?? '')
    setPicked(null)
  }, [share?.id, share?.note])

  return (
    <BottomSheet
      accessibilityLabel={strings.share.sheetTitle}
      onClosed={onClosed}
      onRequestClose={onCancel}
      // The list does its own scrolling; see `LIST_MAX_HEIGHT`.
      scrollable={false}
      testID="share-target-sheet"
      visible={share !== undefined}
    >
      <View style={{ gap: theme.space.md }}>
        <View style={{ gap: theme.space.xs }}>
          <Text variant="sheetTitle">{strings.share.sheetTitle}</Text>
          {share ? (
            <Text color="textMuted" variant="meta">
              {shareSummary(share)}
            </Text>
          ) : null}
          {/*
            Named in `warning` rather than in the muted colour the summary uses,
            because it is the one line here that changes what the buttons mean:
            "Send" below is a second send, and the reader has to have been told
            so before they reach it. `warnText` rather than `dangerText`: nothing
            has gone wrong, something is merely unknown.

            The bot is the CLAIM's and only falls back to the manifest's — it
            says where it may already have gone, which is a fact about the past
            and not about the row somebody is about to tap.
          */}
          {share?.claim ? (
            <Text color="warnText" testID="share-maybe-sent" variant="meta">
              {strings.share.maybeSent(share.claim.bot || share.bot || '')}
            </Text>
          ) : null}
        </View>

        {bots.length === 0 ? (
          <Text color="textMuted" variant="body">
            {strings.share.noBots}
          </Text>
        ) : (
          <ScrollView style={{ maxHeight: LIST_MAX_HEIGHT }}>
            <InsetGroup>
              {bots.map(bot => (
                <Pressable
                  accessibilityLabel={bot.label}
                  accessibilityRole="button"
                  // `aria-selected` and not `accessibilityState`: the latter is
                  // dropped on the floor by react-native-web, so the state would
                  // stop at the bundle. See `__tests__/accessibility-state.test.tsx`.
                  aria-selected={picked === bot.name}
                  hitSlop={TAP_SLOP}
                  key={bot.name}
                  onPress={() => setPicked(bot.name)}
                  style={{
                    alignItems: 'center',
                    backgroundColor: picked === bot.name ? theme.accent().soft : 'transparent',
                    flexDirection: 'row',
                    gap: theme.space.sm,
                    paddingHorizontal: theme.space.md,
                    paddingVertical: theme.space.sm
                  }}
                  testID={`share-target-${bot.name}`}
                >
                  <Avatar name={bot.label} size={32} {...(bot.avatarUri ? { uri: bot.avatarUri } : {})} />
                  <Text numberOfLines={1} style={{ flex: 1 }} variant="name">
                    {bot.label}
                  </Text>
                </Pressable>
              ))}
            </InsetGroup>
          </ScrollView>
        )}

        <TextField
          accessibilityLabel={strings.share.noteLabel}
          multiline
          onChangeText={setNote}
          placeholder={strings.share.notePlaceholder}
          testID="share-note"
          value={note}
        />

        <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
          <Button
            onPress={onCancel}
            style={{ flex: 1 }}
            testID="share-cancel"
            title={strings.common.cancel}
            variant="secondary"
          />
          <Button
            disabled={picked === null}
            onPress={() => picked && onSend(picked, note)}
            style={{ flex: 1 }}
            testID="share-send"
            title={share?.claim ? strings.share.sendAgain : strings.share.send}
          />
        </View>
      </View>
    </BottomSheet>
  )
}
