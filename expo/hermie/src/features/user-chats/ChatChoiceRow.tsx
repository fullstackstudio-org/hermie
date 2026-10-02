/**
 * "Shared Bot Chat / My chat", as one row.
 *
 * Drawn on the chat's options popover and on the Conversations page, which is
 * why it is a component of its own rather than two copies of a segmented
 * control: the two surfaces have to agree about the labels, about which segment
 * is lit, and about what happens while the gateway is thinking.
 *
 * Three things it does that a bare `SegmentedRow` does not:
 *
 *  - **It draws nothing at all when there is no identity.** A gateway that
 *    never said who this is has one chat per bot and always did, so the row is
 *    absent rather than disabled. A disabled control is a promise that
 *    something could be turned on.
 *  - **It holds the pending choice.** Switching is a resolve and a re-hydrate,
 *    which is two round trips on a cold bot; the segment moves at the tap and
 *    moves back if the gateway refuses, so the control never sits under the
 *    reader's finger doing nothing.
 *  - **It says who else is reading.** One line under the control, because
 *    "shared" is the sort of thing a reader should not have to infer from a
 *    word.
 */
import { useCallback, useState } from 'react'
import { View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import { Text } from '../../ui/primitives'
import { SegmentedRow } from '../../ui/sheets/controls'
import { useTheme } from '../../ui/theme'
import type { ChatChoice } from './user-chat'

export interface ChatChoiceRowProps {
  /** Absent hides the row entirely; see above. */
  available: boolean
  choice: ChatChoice
  /** Resolves when the switch is done; a rejection puts the segment back. */
  onChoose: (choice: ChatChoice) => Promise<void>
  /** Where a refusal should be shown, when the surface has somewhere for it. */
  onFailed?: (message: string) => void
  testID?: string
}

export function ChatChoiceRow({ available, choice, onChoose, onFailed, testID = 'chat-choice' }: ChatChoiceRowProps) {
  const theme = useTheme()
  /** What the reader asked for while the gateway is still answering. */
  const [pending, setPending] = useState<ChatChoice | null>(null)

  const change = useCallback(
    (next: ChatChoice) => {
      if (next === choice) {
        return
      }

      setPending(next)
      void onChoose(next)
        .catch((error: unknown) => {
          onFailed?.(error instanceof Error ? error.message : chatStrings.sessions.switchFailed)
        })
        .finally(() => setPending(null))
    },
    [choice, onChoose, onFailed]
  )

  if (!available) {
    return null
  }

  const shown = pending ?? choice

  return (
    <View>
      <SegmentedRow<ChatChoice>
        label={chatStrings.sessions.whose}
        onChange={change}
        options={[
          { value: 'shared', label: chatStrings.sessions.shared },
          { value: 'mine', label: chatStrings.sessions.mine }
        ]}
        testID={testID}
        value={shown}
      />

      <View style={{ paddingHorizontal: theme.space.lg, paddingBottom: theme.space.sm }}>
        <Text color="textMuted" testID={`${testID}-note`} variant="meta">
          {shown === 'mine' ? chatStrings.sessions.mineNote : chatStrings.sessions.sharedNote}
        </Text>
      </View>
    </View>
  )
}
