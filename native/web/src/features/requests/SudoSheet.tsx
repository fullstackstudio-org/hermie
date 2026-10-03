/**
 * `sudo`: the administrator password for a command the bot runs on the
 * gateway's host. The command is the gateway's (already redacted) and is shown
 * monospaced as the bot's words; one that names none says so. Masked, and no
 * saved password of this site is ever offered here.
 */
import type { ReactElement } from 'react'

import { webStrings } from '../../i18n/web-strings'
import { SecureQuote, type SecureSheetProps, SecureSheetFrame } from './SecureSheet'

export function SudoSheet(props: SecureSheetProps): ReactElement | null {
  const { ask } = props.prompt

  if (ask.kind !== 'sudo') {
    return null
  }

  const words = webStrings.secureInput

  return (
    <SecureSheetFrame
      {...props}
      title={words.titleSudo({ name: props.name })}
      details={
        <>
          <p className="hm-requests__text">{words.sudoLead}</p>
          {ask.command ? (
            <SecureQuote text={ask.command} monospaced />
          ) : (
            <p className="hm-requests__meta">{words.sudoNoCommand}</p>
          )}
        </>
      }
      fields={[{ role: 'value', label: words.fieldPassword, type: 'password' }]}
      receiver={words.receiverUsed}
      sendLabel={words.send}
    />
  )
}
