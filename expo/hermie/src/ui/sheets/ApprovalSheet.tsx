/**
 * The approval sheet (ADR-0010).
 *
 * Three rules this component exists to enforce:
 *
 *  1. The buttons are EXACTLY the server's `choices`, in the server's order.
 *     Never a hard-coded set — the gateway decides what may be answered, and
 *     inventing an "Always allow" the server did not offer would send a choice
 *     it will reject.
 *  2. Only an explicit tap ANSWERS. The sheet can be dismissed — backdrop,
 *     Escape, a drag down — and none of those is an answer: the question stays
 *     open and comes back from its own row in the transcript.
 *  3. A 400 ms guard after mount. A sheet that appears under a finger already
 *     travelling toward the screen would otherwise answer a question the user
 *     never read. It guards the MOUNT only; a tap that gets through answers at
 *     once and the sheet leaves on it — see `respond`, which is the guard
 *     against the second tap.
 *
 * The sheet closes on the tap and the RPC travels on its own. It used to wait
 * for the gateway to confirm and then sit for two seconds saying "Answered:
 * Allow once", which is a sheet explaining to the reader what the reader just
 * did. If the answer fails to land, the question is still open in the
 * transcript with an `Answer` button on it and the error is on the banner.
 */
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

import { MONOSPACE } from '../../markdown'
import { chatStrings } from '../../chat-ui/strings'
import type { ApprovalItem } from '../../chat-ui/types'
import { BottomSheet, SheetEyebrow } from '../BottomSheet'
import { Button, Text } from '../primitives'
import { useTheme } from '../theme'

export interface ApprovalSheetProps {
  visible: boolean
  item: ApprovalItem
  /** The bot whose chat asked; shown in the eyebrow. */
  botHandle: string
  /** `choice` is one of `item.choices`, verbatim. */
  onRespond: (choice: string) => void
  /** Only reachable once the request is no longer open. */
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
  /** Milliseconds before taps are accepted. Tests pass 0. */
  tapGuardMs?: number
  /** Extra context line, e.g. the working directory. */
  workingDirectory?: string
}

const DEFAULT_TAP_GUARD_MS = 400

/** `always` → "Always allow"; an unknown choice keeps its own name. */
function choiceLabel(choice: string): string {
  return chatStrings.approval.choices[choice] ?? choice.replace(/_/g, ' ')
}

function choiceVariant(choice: string): 'primary' | 'secondary' | 'danger' {
  if (choice === 'deny') {
    return 'danger'
  }

  return choice === 'once' ? 'primary' : 'secondary'
}

export function ApprovalSheet({
  visible,
  item,
  botHandle,
  onRespond,
  onClose,
  onClosed,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  workingDirectory
}: ApprovalSheetProps) {
  const theme = useTheme()
  const [armed, setArmed] = useState(tapGuardMs <= 0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * One answer per question.
   *
   * The sheet SLIDES OUT rather than vanishing, so its buttons are still under
   * the finger for the length of the animation — and now that the answer no
   * longer waits for the gateway, a second tap is a second `approval.respond`
   * for a request that has already been answered.
   */
  const answered = useRef(false)

  const respond = (choice: string) => {
    if (answered.current) {
      return
    }

    answered.current = true
    onRespond(choice)
  }

  // `item.id` is in here on purpose. The sheet host keeps ONE approval sheet
  // mounted and swaps the request into it, so a second question can arrive
  // without `visible` ever going false — and a guard that only re-armed on
  // `visible` would hand the next question a live "Allow once" under the
  // finger that just answered the previous one.
  useEffect(() => {
    if (!visible) {
      // Deliberately NOT resetting `answered` here: a sheet going invisible is
      // a sheet sliding out, usually because it was just answered, and its
      // buttons are still under the finger for the length of that animation.
      setArmed(tapGuardMs <= 0)

      return
    }

    answered.current = false

    if (tapGuardMs <= 0) {
      setArmed(true)

      return
    }

    setArmed(false)
    timer.current = setTimeout(() => setArmed(true), tapGuardMs)

    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [item.id, tapGuardMs, visible])

  const open = item.state === 'open'

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.approval.title}
      onClosed={onClosed}
      onRequestClose={onClose}
      testID="approval-sheet"
      visible={visible}
    >
      {/*
        §6.9's order, which is not the order this sheet had: lead line, then the
        command, then the consequence. The description used to sit ABOVE the
        well, so the reader met the sentence about the command before the
        command, and the well — the one thing they have to read — was in the
        middle of three paragraphs instead of being the object the sheet is about.
      */}
      <SheetEyebrow>{chatStrings.approval.eyebrow(botHandle)}</SheetEyebrow>
      <Text variant="sheetTitle">{chatStrings.approval.title}</Text>

      <Text color="textMuted" testID="approval-lead" variant="preview">
        {chatStrings.approval.lead(botHandle, workingDirectory)}
      </Text>

      <View
        style={{
          backgroundColor: theme.tintSunk,
          borderColor: theme.hairlineSoft,
          borderRadius: theme.radii.inset,
          borderWidth: 1,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.md
        }}
      >
        <Text
          selectable
          style={{ color: theme.colors.text, fontFamily: MONOSPACE, fontSize: 15, lineHeight: 22 }}
          testID="approval-command"
        >
          {item.command}
        </Text>
      </View>

      {item.description ? (
        <Text color="textMuted" variant="preview">
          {item.description}
        </Text>
      ) : null}

      {item.toolName ? (
        <Text color="textFaint" testID="approval-tool-name" variant="meta">
          {`${chatStrings.approval.runsOn} · ${item.toolName}`}
        </Text>
      ) : null}

      {open ? (
        <View style={{ gap: theme.space.sm }}>
          {item.choices.map(choice => (
            <Button
              disabled={!armed}
              key={choice}
              onPress={() => respond(choice)}
              testID={`approval-choice-${choice}`}
              title={choiceLabel(choice)}
              variant={choiceVariant(choice)}
            />
          ))}

          {item.choices.includes('always') ? (
            <Text color="textFaint" variant="meta">
              {chatStrings.approval.fine}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: theme.space.sm }}>
          <Text color="textMuted" testID="approval-resolution">
            {item.state === 'answered'
              ? chatStrings.approval.answered(choiceLabel(item.answer ?? ''))
              : item.cancelReason === 'timeout'
                ? chatStrings.approval.timedOut
                : chatStrings.approval.answeredElsewhere}
          </Text>
          <Button onPress={onClose} testID="approval-close" title={chatStrings.sheet.close} variant="secondary" />
        </View>
      )}
    </BottomSheet>
  )
}
