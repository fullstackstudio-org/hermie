/**
 * `secret`: a value for an environment variable, which the gateway stores for the
 * bot's profile (`save_env_value_secure`); the bot itself never sees it. The
 * request's prompt and the variable it is stored under are shown as the
 * request's words, each in its own box. Masked, and no saved password is offered.
 */
import type { ReactElement } from 'react'

import { webStrings } from '../../i18n/web-strings'
import { SecureQuote, type SecureSheetProps, SecureSheetFrame } from './SecureSheet'

export function SecretSheet(props: SecureSheetProps): ReactElement | null {
  const { ask } = props.prompt

  if (ask.kind !== 'secret') {
    return null
  }

  const words = webStrings.secureInput

  return (
    <SecureSheetFrame
      {...props}
      title={words.titleSecret({ name: props.name })}
      details={
        <>
          {ask.prompt ? <SecureQuote text={ask.prompt} /> : null}
          {ask.envVar ? <SecureQuote text={ask.envVar} label={words.quoteVariable} monospaced /> : null}
        </>
      }
      fields={[{ role: 'value', label: words.fieldValue, type: 'password' }]}
      receiver={words.receiverStored}
      sendLabel={words.send}
    />
  )
}
