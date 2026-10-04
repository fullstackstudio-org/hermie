/**
 * The session-token prompt of a gateway without sign-in: a masked field nothing persistent fills or is
 * filled from, whose value is handed over once and never kept, and one clear sentence for a wrong token.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { TokenPrompt, type TokenPromptReason, type TokenSubmitOutcome } from './TokenPrompt'

beforeEach(() => {
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

function mount(
  submit: (token: string) => Promise<TokenSubmitOutcome> = async () => ({ kind: 'accepted' }),
  reason: TokenPromptReason = 'absent'
) {
  const onReadAgain = vi.fn()
  const spy = vi.fn(submit)
  const view = render(<TokenPrompt reason={reason} submit={spy} onReadAgain={onReadAgain} />)
  const field = screen.getByLabelText('Session token', { selector: 'input' }) as HTMLInputElement
  const proceed = screen.getByRole('button', { name: 'Continue' })

  return { ...view, field, proceed, submit: spy, onReadAgain }
}

const type = (field: HTMLInputElement, value: string): void => {
  field.value = value
  fireEvent.input(field)
}

describe('the token prompt', () => {
  it('is a masked field that nothing persistent fills and that fills nothing persistent', () => {
    const { container, field } = mount()

    expect(field.type).toBe('password')
    expect(field.getAttribute('autocomplete')).toBe('off')
    expect(field.hasAttribute('name')).toBe(false)
    expect(field.getAttribute('data-1p-ignore')).toBe('')
    expect(field.getAttribute('data-lpignore')).toBe('true')
    expect(container.querySelector('form')).toBeNull()
    // Uncontrolled: React holds no value for it.
    expect(field.getAttribute('value')).toBeNull()
  })

  it('says why it asks, and that the token is kept in memory only', () => {
    mount(undefined, 'rejected')

    expect(screen.getByText(/never stores it/u)).toBeTruthy()
    expect(screen.getByText(/did not accept the token from its dashboard page/u)).toBeTruthy()
  })

  it('hands the trimmed value over once and empties the field at that moment', async () => {
    let finish: (outcome: TokenSubmitOutcome) => void = () => undefined
    const { field, proceed, submit } = mount(() => new Promise(resolve => (finish = resolve)))

    expect(proceed).toHaveProperty('disabled', true)
    type(field, '  tok-123  ')
    expect(proceed).toHaveProperty('disabled', false)

    fireEvent.click(proceed)

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith('tok-123')
    expect(field.value).toBe('')
    expect(screen.getByRole('status').textContent).toBe('Checking the token…')

    // A second Continue while the first is out does nothing.
    fireEvent.click(proceed)
    expect(submit).toHaveBeenCalledTimes(1)

    await act(async () => finish({ kind: 'accepted' }))
  })

  it('submits on Return in the field', async () => {
    const { field, submit } = mount()

    type(field, 'tok-123')
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })

    expect(submit).toHaveBeenCalledWith('tok-123')
  })

  it('says a wrong token in one sentence, with an empty field for the next try', async () => {
    const { field, proceed } = mount(async () => ({ kind: 'wrong' }))

    type(field, 'nope')
    await act(async () => fireEvent.click(proceed))

    expect(screen.getByRole('alert').textContent).toBe('The gateway did not accept this token. Check it and try again.')
    expect(field.value).toBe('')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(proceed).toHaveProperty('disabled', true)

    // A second wrong token says the same sentence, not a second one.
    type(field, 'still nope')
    await act(async () => fireEvent.click(proceed))

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toBe('The gateway did not accept this token. Check it and try again.')
  })

  it('says any other failure in the words it was given', async () => {
    const { field, proceed } = mount(async () => ({ kind: 'failed', message: 'Cannot reach gw.example.test.' }))

    type(field, 'tok')
    await act(async () => fireEvent.click(proceed))

    expect(screen.getByRole('alert').textContent).toBe('Cannot reach gw.example.test.')
    expect(field.getAttribute('aria-invalid')).toBeNull()
  })

  it('offers to read the dashboard again', () => {
    const { onReadAgain } = mount(undefined, 'forgotten')

    expect(screen.getByText(/Hermie has forgotten the token/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Read it from the dashboard again' }))
    expect(onReadAgain).toHaveBeenCalledTimes(1)
  })

  it('empties the field when it leaves the page', () => {
    const { field, unmount } = mount()

    type(field, 'typed but never sent')
    unmount()

    expect(field.value).toBe('')
  })
})
