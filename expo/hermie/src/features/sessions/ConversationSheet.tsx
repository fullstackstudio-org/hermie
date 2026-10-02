/**
 * `ConversationListView`, presented as the manual sheet kind `'conversations'`
 * (`features/chats/sheet-host.ts`) — the compact shell's, and a narrow regular
 * window's, way into a bot's conversations. The wide layout draws
 * `ConversationColumn` instead (Task 7) and never opens this.
 *
 * Same shape as `AgentsSheet`: a title row with a Done button, over
 * `BottomSheet`'s own scroller — `ConversationListView` renders no `ScrollView`
 * of its own for exactly that reason.
 */
import { Pressable, View } from 'react-native'

import { BottomSheet } from '../../ui/BottomSheet'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../../ui/tokens'
import { chatStrings } from '../../chat-ui/strings'
import { ConversationListView } from './ConversationListView'

export interface ConversationSheetProps {
  visible: boolean
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
  botName: string
  /** The footer's "All conversations" link, to the archive page. Absent hides the footer. */
  onOpenArchive?: () => void
}

export function ConversationSheet({ visible, onClose, onClosed, botName, onOpenArchive }: ConversationSheetProps) {
  const theme = useTheme()

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.conversations.columnTitle}
      onClosed={onClosed}
      onRequestClose={onClose}
      testID="conversation-sheet"
      visible={visible}
    >
      <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="sheetTitle">{chatStrings.conversations.columnTitle}</Text>
        <Pressable
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={onClose}
          style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
          testID="conversation-sheet-close"
        >
          <Text color="accentText" variant="body">
            {chatStrings.options.done}
          </Text>
        </Pressable>
      </View>

      <View style={{ paddingTop: theme.space.md }}>
        <ConversationListView
          botName={botName}
          onOpenArchive={onOpenArchive}
          // Picking a row — the group, one of the reader's own, or "New chat" —
          // is the whole reason the sheet was opened; it closes on the same
          // success that `ConversationsScreen`'s own actions re-list on.
          onPicked={onClose}
          testID="conversation-sheet-list"
        />
      </View>
    </BottomSheet>
  )
}
