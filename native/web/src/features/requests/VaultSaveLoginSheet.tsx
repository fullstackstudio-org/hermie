/**
 * `vault.save_login`: a login for a site the bot is about to sign in to, which
 * the gateway saves in the bot's password vault. The answer is the JSON text
 * `{identifier, password}`, built in memory from the two fields at the press
 * (`answerText`). The site and, when it says more, its address are the
 * request's words, each in its own box. Neither field is filled from the browser's password manager:
 * what it holds for this page is the gateway's login, not the site's.
 */
import type { ReactElement } from 'react'

import { sheetStrings } from '../../i18n/sheet-strings'
import { SecureQuote, type SecureSheetProps, SecureSheetFrame } from './SecureSheet'
import { WithName } from './with-name'

export function VaultSaveLoginSheet(props: SecureSheetProps): ReactElement | null {
  const { ask } = props.prompt

  if (ask.kind !== 'vault_save_login') {
    return null
  }

  const words = sheetStrings.secureInput

  return (
    <SecureSheetFrame
      {...props}
      title={<WithName phrase={name => words.titleVaultSaveLogin({ name })} name={props.name} />}
      details={
        <>
          <p className="hm-requests__text">{words.vaultSaveLoginLead}</p>
          {ask.site ? <SecureQuote text={ask.site} label={words.quoteSite} /> : null}
          {ask.origin && ask.origin !== ask.site ? (
            <SecureQuote text={ask.origin} label={words.quoteOrigin} monospaced />
          ) : null}
        </>
      }
      fields={[
        { role: 'identifier', label: words.fieldUsername, type: 'text' },
        { role: 'value', label: words.fieldPassword, type: 'password' }
      ]}
      receiver={words.receiverLogin}
      sendLabel={words.save}
    />
  )
}
