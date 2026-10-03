/**
 * `vault.unlock_prompt`: the master password of an external password manager,
 * which the gateway hands to the manager's own command line and does not keep
 * (only a session token stays in its memory). The manager's name is the
 * request's, shown in its own box. Masked, and no saved password is offered.
 */
import type { ReactElement } from 'react'

import { sheetStrings } from '../../i18n/sheet-strings'
import { SecureQuote, type SecureSheetProps, SecureSheetFrame } from './SecureSheet'
import { WithName } from './with-name'

export function VaultUnlockSheet(props: SecureSheetProps): ReactElement | null {
  const { ask } = props.prompt

  if (ask.kind !== 'vault_unlock') {
    return null
  }

  const words = sheetStrings.secureInput

  return (
    <SecureSheetFrame
      {...props}
      title={<WithName phrase={name => words.titleVaultUnlock({ name })} name={props.name} />}
      details={
        <>
          <p className="hm-requests__text">{words.vaultUnlockLead}</p>
          {ask.name ? <SecureQuote text={ask.name} label={words.quoteManager} /> : null}
        </>
      }
      fields={[{ role: 'value', label: words.fieldMasterPassword, type: 'password' }]}
      receiver={words.receiverUsed}
      sendLabel={words.send}
    />
  )
}
