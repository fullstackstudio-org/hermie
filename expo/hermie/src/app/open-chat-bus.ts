/**
 * "Open this chat", from something that is not a link and not a tap on a row.
 *
 * `useHermieLink` already carries the widget and the URL scheme into whichever
 * shell is mounted, and each shell answers it with its own navigation — a native
 * stack on a phone, a selection in the sidebar on a wide window. A notification
 * needs exactly the same thing, but it arrives at `PushSync`, which lives beside
 * the chat controller rather than inside a shell and has no idea which of the
 * two is on screen.
 *
 * So this is the same shape as `Linking`'s own event, scoped to the app: one
 * emitter, both shells subscribe, and the sender knows nothing about layout.
 *
 * It is deliberately NOT a queue. A request with no shell mounted is dropped,
 * because the only moment that happens is before the first render or during a
 * sign-out, and replaying it afterwards would open a chat on a gateway the
 * reader has just left.
 */

/**
 * `sessionId` names one of that bot's OTHER conversations — a branch, or one
 * `/new` put away. Absent means the bot's own chat, which is what every
 * request through this bus meant before a bot had more than one.
 */
type Handler = (bot: string, sessionId?: string) => void

const handlers = new Set<Handler>()

/** Subscribe. Returns its own teardown, which is what a React effect wants. */
export function onOpenChatRequest(handler: Handler): () => void {
  handlers.add(handler)

  return () => {
    handlers.delete(handler)
  }
}

/**
 * Ask whichever shell is mounted to show that bot's chat, or one conversation
 * of it.
 *
 * The id is the STORED one, which is what a listing hands out and what the
 * conversation viewer resumes by. The shell resolves it against the gateway
 * like every other entry point; nothing here checks that it names anything.
 */
export function requestOpenChat(bot: string, sessionId?: string): void {
  for (const handler of [...handlers]) {
    try {
      handler(bot, sessionId)
    } catch {
      // One shell throwing must not stop another, and a navigation that failed
      // is not a reason to lose the notification's other work.
    }
  }
}
