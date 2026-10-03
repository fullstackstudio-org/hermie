/**
 * The words of a message, as Markdown, placed in the page they are drawn in.
 *
 * Under the page's `h1` (the bot's name) and the day's `h2`, a heading in a
 * message is an `h3`: pushed down two levels so a `#` is never a second title,
 * and capped there so a `##` written first does not skip a level. The size of the
 * heading still follows what the author wrote (`markdown/markdown.css`). Images
 * resolve against the gateway the chat is on.
 */
import { memo } from 'react'

import { Markdown } from '../../../markdown/Markdown'
import { useItemContext } from './item-context'

function MessageMarkdownView({ text }: { text: string }) {
  const { gatewayBaseUrl } = useItemContext()

  return <Markdown gatewayBaseUrl={gatewayBaseUrl} headingMax={3} headingOffset={2} text={text} />
}

export const MessageMarkdown = memo(MessageMarkdownView)
