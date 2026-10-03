/**
 * `vault.code`: a one-time code a site asked for. Masked like every value a bot
 * asks for in a browser (the plan's rule; the native apps show it), and marked
 * `one-time-code`: the browser treats it as no password to save, and may offer a
 * code it just received. Spaces and dashes typed to read it in groups are dropped
 * from the answer (`answerText`).
 */
import type { ReactElement } from 'react'

import { webStrings } from '../../i18n/web-strings'
import { SecureQuote, type SecureSheetProps, SecureSheetFrame } from './SecureSheet'
import { WithName } from './with-name'

export function VaultCodeSheet(props: SecureSheetProps): ReactElement | null {
  const { ask } = props.prompt

  if (ask.kind !== 'vault_code') {
    return null
  }

  const words = webStrings.secureInput

  return (
    <SecureSheetFrame
      {...props}
      title={<WithName phrase={name => words.titleVaultCode({ name })} name={props.name} />}
      details={
        <>
          <p className="hm-requests__text">{words.vaultCodeLead}</p>
          {ask.site ? <SecureQuote text={ask.site} label={words.quoteSite} /> : null}
          {ask.hint ? <SecureQuote text={ask.hint} /> : null}
        </>
      }
      fields={[{ role: 'value', label: words.fieldCode, type: 'password', autoComplete: 'one-time-code' }]}
      receiver={words.receiverUsed}
      sendLabel={words.send}
    />
  )
}
