/**
 * Where the reader's own chats live, bound to this page's stores (ADR-0007, amended): the Expo app's
 * `ChatRuntime` built the same three things inline.
 *
 *  - **Who is asking** is read through a function, late: `/api/auth/me` was read by the boot, but the identity is
 *    put in `deviceContextStore` after the connection is made, so the first roster after a sign-in must read it when
 *    it needs it and not when this is built. A gateway that named nobody has no identity to write a title from, and
 *    no own chat to offer; a gateway without sign-in names the owner (`OWNER_USER_ID`), as on the Expo and native
 *    apps.
 *  - **What they chose** is the arrangement's `myChats` and `current` (`state/layout.ts`), which follow the person
 *    through the gateway's `ui_meta` to every device.
 *  - **Where the choice goes** is the same store, as a dated choice (the reader's) or a chore (the app's own
 *    correction, which never outranks a choice made on another device).
 *
 * **What is in the first load and what is not.** Whether there is an own chat to offer, what it is called, which
 * chat the reader's memory names and what is written back are answered here from the stores, with the title's few
 * lines (`core/user-chats/title.ts`). What talks to the gateway (finding the chat on a bot, making it the first
 * time, looking a remembered id up: `core/user-chats/user-chat-directory.ts`) is a chunk of its own, fetched the
 * first time one of those is asked for, and a bot nobody has chosen an own chat on never asks. A chat resolved is
 * kept here as well (`cached` is a synchronous question, asked while a list is built), and dropped with the person it
 * was resolved for.
 *
 * `followChosenChats` is the other half: when the arrangement's choice changes (this device's pick, another
 * device's arriving through `ui_meta`), the roster is told, so every bot whose chat is not open here is placed on
 * the conversation the reader's memory names. A chat that is open is left where it is and follows on its next open.
 */
import type { BotsController } from '../../core/bots-controller'
import type { UserChatSwitch } from '../../core/chat-controller'
import type { ChatGateway } from '../../core/link'
import { type ChatIdentity, userChatTitle } from '../../core/user-chats/title'
import { userChatSwitch } from '../../core/user-chats/user-chat-switch'
import type { BotCanonicalSession } from '../../state/bots'
import { deviceContextStore } from '../../state/device-context'
import { currentTargetOf, layoutStore } from '../../state/layout'

/** Who the gateway says the reader is, or nobody. */
function identity(): ChatIdentity | null {
  const context = deviceContextStore.getState()

  return context.userId ? { userId: context.userId, displayName: context.displayName } : null
}

/** The switch for one connection: the stores of this page, and the directory over its gateway when it is needed. */
export function userChatsFor(gateway: ChatGateway): UserChatSwitch {
  const choice = (name: string): 'mine' | 'shared' => (layoutStore.getState().myChats[name] ? 'mine' : 'shared')
  const target = (name: string): string | null | undefined => currentTargetOf(layoutStore.getState(), name)

  let directory: ReturnType<typeof load> | null = null
  const load = () =>
    import('../../core/user-chats/user-chat-directory').then(
      ({ UserChatDirectory }) => new UserChatDirectory({ gateway, identity, choice, target })
    )

  /** What was resolved, for the person it was resolved for. */
  const known = new Map<string, BotCanonicalSession>()
  let knownFor = ''
  const title = (): string => {
    const now = userChatTitle(identity())

    if (now !== knownFor) {
      known.clear()
      knownFor = now
    }

    return now
  }

  return userChatSwitch({
    available: () => title() !== '',
    title,
    chose: name => title() !== '' && choice(name) === 'mine',
    cached: name => (title() === '' ? null : (known.get(name) ?? null)),
    async resolve(bot) {
      const lead = title()
      const session = await (await (directory ??= load())).resolve(bot)

      // Only for the person it was resolved for: a sign-out that landed mid-flight has already cleared the memo.
      if (lead !== '' && title() === lead) {
        known.set(bot.name, session)
      }

      return session
    },
    remember: (name, picked) => layoutStore.getState().setMyChat(name, picked === 'mine'),
    target: name => (title() === '' ? undefined : target(name)),
    async resolveTarget(bot) {
      // Nothing remembered, or nobody named: the group chat, without asking the gateway or fetching anything.
      if (title() === '' || target(bot.name) === undefined) {
        return { kind: 'group' }
      }

      return (await (directory ??= load())).resolveTarget(bot)
    },
    rememberCurrent: (name, storedId, options) => layoutStore.getState().setCurrent(name, storedId, options)
  })
}

/** Place the roster on the chats the reader's memory names whenever that memory changes. Returns the stop. */
export function followChosenChats(bots: Pick<BotsController, 'placeCurrentChats'>): () => void {
  return layoutStore.subscribe((state, previous) => {
    if (state.current !== previous.current || state.myChats !== previous.myChats) {
      // A placement that fails, or throws before it starts, costs the placement and never the store that said it.
      void Promise.resolve()
        .then(() => bots.placeCurrentChats())
        .catch(() => undefined)
    }
  })
}
