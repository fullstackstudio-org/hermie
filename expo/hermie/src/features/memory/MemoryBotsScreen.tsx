/**
 * Which bot's memory do you want to read?
 *
 * Two shapes of the same list. `MemoryBotList` is the list alone, and is what
 * Settings → Memory draws on its page, pushing a `MemoryBot` route per row.
 * `MemoryBotsScreen` is the list and one bot's page in the shape `CronScreen`
 * uses — a discriminated view held in state with an early return — for the
 * doors OUTSIDE Settings (a bot's profile sheet, the chat), which have no
 * navigator of their own to push onto.
 *
 * A bot is listed by the name this reader has chosen to see and is OPENED by
 * its profile name, which is the only thing the plugin's `profile` parameter
 * will accept. Those are routinely different in case alone, which is exactly
 * the difference nobody notices until a route answers 400.
 */
import { useState } from 'react'
import { ScrollView } from 'react-native'

import { strings } from '../../i18n/strings'
import { botNames, useHideHandleWhenNamed, useNameOrder } from '../../store/bot-names'
import { useBotsStore } from '../../store/bots'
import { useChatLayoutStore } from '../../store/chat-layout'
import { PageFrame, useFramedScroll } from '../../ui/chrome'
import { InsetButtonRow, InsetGroup, Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { MemoryScreen } from './MemoryScreen'
import { memoryStrings } from './strings'

/** The name a reader sees for one bot, for the bot page's title. */
export function useMemoryBotTitle(profile: string): string | undefined {
  const bot = useBotsStore(state => state.bots.find(row => row.name === profile))
  const order = useNameOrder()
  const hideHandle = useHideHandleWhenNamed()
  const label = useChatLayoutStore(state => state.labels[profile])

  return bot ? botNames({ ...bot, label: label ?? '' }, order, { hideHandle }).primary : undefined
}

export interface MemoryBotListProps {
  onOpen: (profile: string) => void
  testID?: string
}

/** The bots, one row each, or the sentence that says there are none. */
export function MemoryBotList({ onOpen, testID = 'memory-bots' }: MemoryBotListProps) {
  const bots = useBotsStore(state => state.bots)
  const order = useNameOrder()
  const hideHandle = useHideHandleWhenNamed()
  /* The names this reader gave their bots, which win over the roster's. */
  const labels = useChatLayoutStore(state => state.labels)

  if (bots.length === 0) {
    return (
      <Text color="textMuted" testID={`${testID}-empty`} variant="meta">
        {memoryStrings.botsEmpty}
      </Text>
    )
  }

  return (
    <InsetGroup footer={memoryStrings.botsHint} testID={`${testID}-list`}>
      {bots.map(bot => {
        const names = botNames({ ...bot, label: labels[bot.name] ?? '' }, order, { hideHandle })

        return (
          <InsetButtonRow
            detail={names.secondary}
            key={bot.name}
            onPress={() => onOpen(bot.name)}
            testID={`${testID}-row-${bot.name}`}
            title={names.primary}
          />
        )
      })}
    </InsetGroup>
  )
}

export interface MemoryBotsScreenProps {
  onClose: () => void
  /** What the back control says; the page it returns to. */
  backLabel?: string
  /** Open straight onto one bot — the profile sheet's row does this. */
  initialProfile?: string
  testID?: string
}

export function MemoryBotsScreen({
  onClose,
  backLabel,
  initialProfile,
  testID = 'memory-bots'
}: MemoryBotsScreenProps) {
  const [open, setOpen] = useState<string | null>(initialProfile ?? null)

  if (open) {
    return (
      <MemoryBot
        backLabel={initialProfile ? (backLabel ?? strings.common.back) : memoryStrings.botsTitle}
        onClose={() => (initialProfile ? onClose() : setOpen(null))}
        profile={open}
      />
    )
  }

  return (
    <PageFrame
      back={{ label: backLabel ?? strings.common.back, onPress: onClose }}
      subtitle={memoryStrings.botsHint}
      testID={`${testID}-header`}
      title={memoryStrings.botsTitle}
    >
      <BotListScroll onOpen={setOpen} testID={testID} />
    </PageFrame>
  )
}

function BotListScroll({ onOpen, testID }: { onOpen: (profile: string) => void; testID: string }) {
  const theme = useTheme()
  const scroll = useFramedScroll(theme.space.lg)

  return (
    <ScrollView
      {...scroll.props}
      contentContainerStyle={{ gap: theme.space.lg, padding: theme.space.lg, paddingTop: scroll.paddingTop }}
    >
      <MemoryBotList onOpen={onOpen} testID={testID} />
    </ScrollView>
  )
}

/** One bot's memory page, titled with the name the reader knows it by. */
function MemoryBot({ profile, onClose, backLabel }: { profile: string; onClose: () => void; backLabel: string }) {
  const title = useMemoryBotTitle(profile)

  return <MemoryScreen backLabel={backLabel} onClose={onClose} profile={profile} {...(title ? { title } : {})} />
}
