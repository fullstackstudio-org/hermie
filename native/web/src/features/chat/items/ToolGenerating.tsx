/**
 * The bot is writing a tool call and has said which tool (`tool.generating`),
 * before the call has an id and so before there is a row for it.
 *
 * Drawn at the tail of the transcript, where the typing row would be, and in its
 * place (`rows.ts`): the dots say a reply is coming, this says what is coming,
 * which is the narrower truth. It goes when the call starts (`tool.start` clears
 * the name and the tool's own row takes over) or the turn ends.
 *
 * The tool's name is the model's word: cleaned and bounded like a request's
 * strings (`displayText`), plain text, and isolated in `<bdi>` so its characters
 * cannot reorder the sentence around it.
 */
import { memo } from 'react'

import { displayText, NAME_LIMIT } from '../../../core/requests/secure-input'
import { useLocale } from '../../../i18n/use-locale'
import { sheetStrings } from '../../../i18n/sheet-strings'
import { WithName } from '../../requests/with-name'

function ToolGeneratingView({ name }: { name: string }) {
  useLocale()

  const shown = displayText(name, NAME_LIMIT)

  if (!shown) {
    return null
  }

  return (
    <div className="hm-msg" data-side="bot">
      <p className="hm-generating" data-generating="">
        {/* The typing row's dots, as decoration: the sentence beside them says what they mean. */}
        <span className="hm-dots" aria-hidden="true">
          <span className="hm-dots__dot" />
          <span className="hm-dots__dot" />
          <span className="hm-dots__dot" />
        </span>
        <span className="hm-generating__text">
          <WithName phrase={tool => sheetStrings.chat.preparingTool({ name: tool })} name={shown} />
        </span>
      </p>
    </div>
  )
}

export const ToolGenerating = memo(ToolGeneratingView)
