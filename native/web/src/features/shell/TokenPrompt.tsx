/**
 * The session token of a gateway without sign-in, asked of the person (plan W-23).
 *
 * The boot reads the token from the dashboard's own bootstrap first
 * (`boot/dashboard-token.ts`). This page is the fallback, shown when that gave
 * nothing (`absent`), when the gateway refused what it gave (`rejected`), and
 * after the reader asked Hermie to forget the token (`forgotten`). It is the one
 * place in the client where a credential is typed, so it follows the secret
 * prompts' rules (plan, "Secret prompts in a browser"; `SecureSheet.tsx`):
 *
 *  1. **The value is never state.** The field is uncontrolled: nothing in React
 *     state, a store or a ref holds what is typed, only whether there is
 *     something (for Continue). Continue reads the field at that moment, empties
 *     it, and hands the text to `submit`, which makes the session on it and keeps
 *     it nowhere else. The field is emptied before the page leaves the document.
 *  2. **Nothing persistent fills it, and it fills nothing persistent.**
 *     `type="password"`, `autocomplete="off"`, the opt-outs the password-manager
 *     extensions read, no `name` and no `<form>`: what this origin may have saved
 *     is nobody's (the gateway has no sign-in), and the token must not be offered
 *     for saving. The same known limit as the secret prompts: Chromium and
 *     Safari may still offer to save a password field's value.
 *  3. **Asked once.** A token the gateway takes moves the page on, and the
 *     connection keeps it in memory for as long as the tab is open. A token it
 *     refuses gets one clear sentence (`wrong`), replacing any earlier one, and an
 *     empty field for the next try. Any other failure says what failed, in the
 *     boot's words.
 *  4. **Reading the dashboard again** is always on offer: after a gateway restart
 *     its page carries the new token, which is the usual way out of `rejected`.
 */
import { type KeyboardEvent, type ReactElement, useId, useLayoutEffect, useRef, useState } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { Button } from '../../ui/primitives'

/** Why the prompt is on screen. */
export type TokenPromptReason = 'absent' | 'rejected' | 'forgotten'

/** What became of a typed token. */
export type TokenSubmitOutcome = { kind: 'accepted' } | { kind: 'wrong' } | { kind: 'failed'; message: string }

export interface TokenPromptProps {
  reason: TokenPromptReason
  /**
   * Check a typed token and, when the gateway takes it, start the app on it.
   * Resolves `accepted` once the page has moved on, `wrong` on a refusal, and
   * `failed` (with a sentence) for anything else. Must not reject.
   */
  submit: (token: string) => Promise<TokenSubmitOutcome>
  /** Read the token from the dashboard's bootstrap again: the whole boot, from the probe. */
  onReadAgain: () => void
}

const reasonText = (reason: TokenPromptReason): string =>
  reason === 'absent'
    ? webStrings.tokenMode.absent
    : reason === 'rejected'
      ? webStrings.tokenMode.rejected
      : webStrings.tokenMode.forgotten

export function TokenPrompt({ reason, submit, onReadAgain }: TokenPromptProps): ReactElement {
  useLocale()

  const ids = useId()
  const fieldId = `${ids}-token`
  const helpId = `${ids}-help`
  const field = useRef<HTMLInputElement>(null)
  const [answerable, setAnswerable] = useState(false)
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<Exclude<TokenSubmitOutcome, { kind: 'accepted' }> | null>(null)
  const words = webStrings.tokenMode
  const signIn = strings.app.onboarding.signIn

  // Emptied on the way out, in the commit that removes the field (rule 1).
  useLayoutEffect(() => {
    const node = field.current

    return () => {
      if (node) {
        node.value = ''
      }
    }
  }, [])

  const send = async (): Promise<void> => {
    const node = field.current
    const token = node?.value.trim() ?? ''

    if (!node || checking || token === '') {
      return
    }

    // The field gives the value up at once: it is the check's now, and nobody else's.
    node.value = ''
    setAnswerable(false)
    setChecking(true)
    setProblem(null)

    const outcome = await submit(token)

    if (outcome.kind === 'accepted') {
      return
    }

    setChecking(false)
    setProblem(outcome)
    // Back to the field for the next try; the sentence above says why.
    queueMicrotask(() => field.current?.focus())
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void send()
    }
  }

  return (
    <main className="boot boot--token">
      <h1>{signIn.tokenPlaceholder}</h1>
      <p>{words.lead}</p>
      <p>{reasonText(reason)}</p>

      <div className="boot__field">
        <label htmlFor={fieldId}>{signIn.tokenPlaceholder}</label>
        <input
          id={fieldId}
          ref={field}
          className="boot__input"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={helpId}
          aria-invalid={problem?.kind === 'wrong' ? true : undefined}
          disabled={checking}
          // The opt-outs of 1Password, LastPass, Bitwarden and Dashlane: see rule 2.
          data-1p-ignore=""
          data-lpignore="true"
          data-bwignore="true"
          data-form-type="other"
          onInput={() => setAnswerable((field.current?.value.trim() ?? '') !== '')}
          onKeyDown={onKeyDown}
        />
        <p className="boot__help" id={helpId}>
          {signIn.tokenHelp}
        </p>
      </div>

      <p className="boot__problem" role="alert">
        {problem === null ? '' : problem.kind === 'wrong' ? words.wrong : problem.message}
      </p>
      <p className="boot__status" role="status">
        {checking ? words.checking : ''}
      </p>

      <div className="boot__actions">
        <Button disabled={!answerable || checking} onClick={() => void send()}>
          {strings.app.common.continue}
        </Button>
        <Button variant="quiet" disabled={checking} onClick={onReadAgain}>
          {words.readAgain}
        </Button>
      </div>
    </main>
  )
}
