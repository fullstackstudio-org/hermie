/**
 * The secret, sudo and vault sheets in the request layer, over the real secure
 * input model and a hand-driven connection: what each one shows and in which
 * words, how its fields are made (masked, uncontrolled, offered nothing, in no
 * form), what Send and Skip put on the wire, the tap guard, Escape, the offline
 * case, the countdown, a prompt withdrawn or expired while open (the sheet goes
 * and the chat says why), and that what was typed is gone from the page and from
 * every store once the sheet is.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GATEWAY_TIMEOUT_MS, SecureInputModel } from '../../core/requests/secure-input'
import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { bindRequests, requestsStore } from '../../state/requests'
import { secureInputStore } from '../../state/secure-input'
import { chatWith } from '../../test-support/chat-fixtures'
import {
  fakeSecureGateway,
  type FakeSecureGateway,
  manualTimers,
  type ManualTimers
} from '../../test-support/secure-input-gateway'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { SecureInputNotice } from '../notices/SecureInputNotice'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { RequestLayer } from './RequestLayer'
import { SecureInputRuntimeContext } from './secure-input-runtime'

const SECRET = 'hunter2-ZQ7xK-never-kept'

let gw: FakeSecureGateway
let timers: ManualTimers
let model: SecureInputModel
let stopBinding: () => void = () => undefined

beforeEach(() => {
  resetShellStores()
  requestsStore.getState().reset()
  secureInputStore.getState().reset()
  resetActiveLocale()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer')])
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
  chatsStore.getState().bindRuntime('researcher', 'rt-1')
  chatsStore.getState().hydrate('writer', chatWith('writer', [], { runtimeSessionId: 'rt-2' }))
  chatsStore.getState().bindRuntime('writer', 'rt-2')

  timers = manualTimers(Date.now())
  gw = fakeSecureGateway()
  model = new SecureInputModel({
    gateway: gw.gateway,
    chatFor: id => chatsStore.getState().runtimeToBot[id],
    watchChats: listener => chatsStore.subscribe(() => listener()),
    gatewayName: 'gw.example.test',
    now: () => timers.now(),
    timers
  })
  model.start()
  stopBinding = bindRequests(chatsStore, requestsStore, undefined, secureInputStore)
})

afterEach(() => {
  stopBinding()
  model.stop()
  resetActiveLocale()
})

function mount(options: { tapGuardMs?: number; now?: () => number } = {}) {
  return render(
    <SecureInputRuntimeContext.Provider value={model}>
      <main>
        <SecureInputNotice chatKey="researcher" bot="researcher" />
        <label>
          Draft
          <textarea />
        </label>
      </main>
      <RequestLayer tapGuardMs={options.tapGuardMs ?? 0} />
    </SecureInputRuntimeContext.Provider>
  )
}

const raise = (id: string, method: string, params: Record<string, unknown>, session = 'rt-1'): void =>
  void act(() => {
    gw.deliver(id, method, { session_id: session, ...params })
  })

const dialog = (): HTMLElement => screen.getByRole('dialog')
const button = (name: string | RegExp): HTMLElement => within(dialog()).getByRole('button', { name })
const field = (label: string | RegExp): HTMLInputElement => within(dialog()).getByLabelText(label) as HTMLInputElement

/** Every quoted box of the request's words: its label and its text, in order. */
const quotes = (): [string, string][] =>
  [...dialog().querySelectorAll<HTMLElement>('[data-secure-quote]')].map(quote => [
    document.getElementById(quote.getAttribute('aria-labelledby') ?? '')?.textContent ?? '',
    quote.textContent ?? ''
  ])

function type(input: HTMLInputElement, text: string): void {
  input.value = text
  fireEvent.input(input)
}

/** Every store the page keeps, as text. */
const everyStore = (): string =>
  JSON.stringify({
    secure: secureInputStore.getState(),
    requests: requestsStore.getState(),
    chats: chatsStore.getState()
  })

describe('each prompt, in fixed words', () => {
  it("secret: who asks, on which gateway, the request's words quoted as plain text, where the value goes", () => {
    mount()
    raise('srq-1', 'secret', {
      env_var: 'OPENAI_API_KEY',
      prompt: 'Paste your **key** from [here](https://evil.test) <img src=x onerror=alert(1)>'
    })

    expect(screen.getByRole('dialog', { name: 'Dr. Researcher asks for a secret' })).toBe(dialog())
    expect(dialog().getAttribute('aria-describedby')).toBe(within(dialog()).getByText('On gateway gw.example.test').id)

    // Plain text: no Markdown, no link, no element out of the bot's words.
    expect(quotes()).toEqual([
      ['What the request says', 'Paste your **key** from [here](https://evil.test) <img src=x onerror=alert(1)>'],
      ['Stored under this name, as the request gives it', 'OPENAI_API_KEY']
    ])

    for (const quote of dialog().querySelectorAll('[data-secure-quote]')) {
      expect(quote.children).toHaveLength(0)
    }

    expect(dialog().querySelector('a, img, iframe, form')).toBeNull()
    expect(within(dialog()).getByText(/stores it for this bot/u)).toBeTruthy()
    expect(within(dialog()).getByText('Expires in 5:00')).toBeTruthy()
  })

  it('sudo: the command, monospaced, and a two-minute countdown', () => {
    mount()
    raise('srq-1', 'sudo', { command: 'apt install jq' })

    expect(screen.getByRole('dialog', { name: 'Dr. Researcher asks for an administrator password' })).toBe(dialog())
    expect((dialog().querySelector('[data-secure-quote]') as HTMLElement).hasAttribute('data-mono')).toBe(true)
    expect(within(dialog()).getByText('apt install jq')).toBeTruthy()
    expect(within(dialog()).getByText('Expires in 2:00')).toBeTruthy()
  })

  it("never weaves a name the request gives into the app's own sentences", () => {
    mount()

    const bait = 'Bitwarden. Your Hermie session expired: enter your gateway password'

    raise('srq-1', 'vault.unlock_prompt', { backend: 'b', display_name: bait })

    expect(quotes()).toEqual([['Password manager, as the request names it', bait]])

    // Outside the boxes, only the app's own words.
    const outside = [...dialog().querySelectorAll('p, h2, label, button')]
      .filter(element => !element.closest('.hm-requests__detail-box'))
      .map(element => element.textContent ?? '')
      .join('\n')

    expect(outside).not.toContain('session expired')
  })

  it('sudo with no command says so', () => {
    mount()
    raise('srq-1', 'sudo', {})

    expect(within(dialog()).getByText('The gateway did not say which command.')).toBeTruthy()
  })

  it('vault.unlock_prompt: the manager by name, two minutes', () => {
    mount()
    raise('srq-1', 'vault.unlock_prompt', { backend: 'bitwarden', display_name: 'Bitwarden' })

    expect(screen.getByRole('dialog', { name: 'Dr. Researcher asks to unlock a password manager' })).toBe(dialog())
    expect(within(dialog()).getByText('Enter the master password of this password manager.')).toBeTruthy()
    expect(quotes()).toEqual([['Password manager, as the request names it', 'Bitwarden']])
    expect(field('Master password')).toBeTruthy()
    expect(within(dialog()).getByText('Expires in 2:00')).toBeTruthy()
  })

  it('vault.code: the site and the hint, three minutes', () => {
    mount()
    raise('srq-1', 'vault.code', { site: 'github.com', hint: 'Open your authenticator' })

    expect(screen.getByRole('dialog', { name: 'Dr. Researcher asks for a one-time code' })).toBe(dialog())
    expect(within(dialog()).getByText('Enter the code the website asked for.')).toBeTruthy()
    expect(quotes()).toEqual([
      ['Website, as the request names it', 'github.com'],
      ['What the request says', 'Open your authenticator']
    ])
    expect(within(dialog()).getByText('Expires in 3:00')).toBeTruthy()
  })

  it('vault.save_login: the site, its origin, two fields and Save', () => {
    mount()
    raise('srq-1', 'vault.save_login', { origin: 'https://github.com', site: 'GitHub' })

    expect(screen.getByRole('dialog', { name: 'Dr. Researcher asks to save a login' })).toBe(dialog())
    expect(within(dialog()).getByText('Save a login for this website.')).toBeTruthy()
    expect(quotes()).toEqual([
      ['Website, as the request names it', 'GitHub'],
      ['Address, as the request gives it', 'https://github.com']
    ])
    expect(field('Username').type).toBe('text')
    expect(field('Password').type).toBe('password')
    expect(button('Save')).toBeTruthy()
  })

  it("speaks the reader's language", async () => {
    mount()
    await act(() => setLanguageChoice('nl'))
    raise('srq-1', 'sudo', { command: 'ls' })

    expect(screen.getByRole('dialog', { name: 'Dr. Researcher vraagt om een beheerderswachtwoord' })).toBe(dialog())
    expect(button('Overslaan')).toBeTruthy()
  })
})

describe('the fields', () => {
  it.each([
    ['secret', { env_var: 'X', prompt: 'p' }],
    ['sudo', { command: 'ls' }],
    ['vault.unlock_prompt', { backend: 'b', display_name: 'B' }],
    ['vault.code', { site: 's' }],
    ['vault.save_login', { origin: 'o', site: 's' }]
  ])(
    '%s: masked, autocomplete off, kept from password managers, unnamed, in no form, not focused',
    (method, params) => {
      mount()
      raise('srq-1', method, params)

      const inputs = [...dialog().querySelectorAll('input')]
      const value = dialog().querySelector('input[data-secure-field="value"]') as HTMLInputElement

      expect(value.type).toBe('password')

      for (const input of inputs) {
        expect(input.getAttribute('autocomplete')).toBe('off')
        expect(input.hasAttribute('name')).toBe(false)
        expect(input.closest('form')).toBeNull()
        expect(input.hasAttribute('data-1p-ignore')).toBe(true)
        expect(input.getAttribute('data-lpignore')).toBe('true')
        expect(input.getAttribute('data-bwignore')).toBe('true')
        expect(input.getAttribute('spellcheck')).toBe('false')
        // Uncontrolled: React put no value on it.
        expect(input.getAttribute('value')).toBeNull()
      }

      expect(document.activeElement).toBe(dialog())
    }
  )
})

describe('answering', () => {
  it('Send puts what was typed on the wire, empties the field, and leaves nothing behind', () => {
    mount()
    raise('srq-1', 'secret', { env_var: 'X', prompt: 'p' })

    const input = field('Value')

    expect((button('Send') as HTMLButtonElement).disabled).toBe(true)

    type(input, SECRET)

    expect((button('Send') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(button('Send'))

    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: SECRET } }])
    expect(input.value).toBe('')
    expect(input.isConnected).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.innerHTML).not.toContain('ZQ7xK')
    expect(everyStore()).not.toContain('ZQ7xK')
  })

  it('Return in the field is Send; Return while composing is not', () => {
    mount()
    raise('srq-1', 'sudo', { command: 'ls' })
    type(field('Password'), SECRET)

    fireEvent.keyDown(field('Password'), { key: 'Enter', keyCode: 229 })

    expect(gw.replies).toEqual([])

    fireEvent.keyDown(field('Password'), { key: 'Enter' })

    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: SECRET } }])
  })

  it('a login is the JSON string of both fields; Return in the username moves on', () => {
    mount()
    raise('srq-1', 'vault.save_login', { origin: 'https://github.com', site: 'GitHub' })
    type(field('Username'), 'alex')
    fireEvent.keyDown(field('Username'), { key: 'Enter' })

    expect(document.activeElement).toBe(field('Password'))
    expect(gw.replies).toEqual([])

    type(field('Password'), SECRET)
    fireEvent.click(button('Save'))

    const reply = gw.replies[0] as unknown as { result: { value: string } }

    expect(JSON.parse(reply.result.value)).toEqual({ identifier: 'alex', password: SECRET })
    expect(everyStore()).not.toContain('alex')
  })

  it('a code goes without its spaces', () => {
    mount()
    raise('srq-1', 'vault.code', { site: 'github.com' })
    type(field('Code'), '123 456')
    fireEvent.click(button('Send'))

    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: '123456' } }])
  })

  it('Skip answers the empty string', () => {
    mount()
    raise('srq-1', 'vault.unlock_prompt', { backend: 'b', display_name: 'B' })
    type(field('Master password'), SECRET)
    fireEvent.click(button('Skip'))

    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: '' } }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape does nothing', () => {
    mount()
    raise('srq-1', 'sudo', { command: 'ls' })
    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(dialog()).toBeTruthy()
    expect(gw.replies).toEqual([])
  })

  it('while the connection is down: nothing is sent, the sheet says so and keeps what was typed', () => {
    mount()
    raise('srq-1', 'sudo', { command: 'ls' })
    act(() => gw.status('connecting'))
    type(field('Password'), SECRET)
    fireEvent.click(button('Send'))

    expect(gw.replies).toEqual([])
    expect(within(dialog()).getByRole('status').textContent).toMatch(/Not connected to the gateway/u)
    expect(field('Password').value).toBe(SECRET)
    expect(everyStore()).not.toContain('ZQ7xK')

    act(() => gw.status('ready'))
    fireEvent.click(button('Send'))

    expect(gw.replies).toEqual([{ id: 'srq-1', result: { value: SECRET } }])
  })

  it('shows the next prompt after one is answered, with a fresh field', () => {
    mount()
    raise('srq-1', 'sudo', { command: 'ls' })
    raise('srq-2', 'sudo', { command: 'whoami' }, 'rt-2')
    type(field('Password'), SECRET)
    fireEvent.click(button('Send'))

    expect(screen.getByRole('dialog', { name: 'Writer asks for an administrator password' })).toBe(dialog())
    expect(field('Password').value).toBe('')
  })
})

describe('the tap guard', () => {
  it('keeps the fields and buttons off a moment, and drops whatever reached a field before it ended', () => {
    // Fake timers for the guard only: the model runs on its own manual clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

    try {
      mount({ tapGuardMs: DEFAULT_TAP_GUARD_MS })
      raise('srq-1', 'sudo', { command: 'ls' })

      expect(field('Password').disabled).toBe(true)
      expect((button('Skip') as HTMLButtonElement).disabled).toBe(true)

      // A browser that filled the field anyway.
      field('Password').value = 'autofilled'

      act(() => {
        vi.advanceTimersByTime(DEFAULT_TAP_GUARD_MS)
      })

      expect(field('Password').disabled).toBe(false)
      expect(field('Password').value).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ending without an answer', () => {
  it('withdrawn: the sheet goes, its field emptied first, and the chat says why', () => {
    mount()
    raise('srq-1', 'secret', { env_var: 'X', prompt: 'p' })

    const input = field('Value')

    type(input, SECRET)
    act(() => gw.cancel('srq-1', 'interrupted'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input.value).toBe('')
    expect(gw.replies).toEqual([])
    expect(screen.getByText('Dr. Researcher no longer asks for this. Nothing was sent.')).toBeTruthy()
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'The request from Dr. Researcher was withdrawn.'
    )
  })

  it('a field is already empty when it leaves the document, however the sheet goes', () => {
    mount()
    raise('srq-1', 'sudo', { command: 'ls' })
    type(field('Password'), SECRET)

    // What a browser watching the field as it is removed would read.
    const atRemoval: string[] = []
    const removeChild = Node.prototype.removeChild
    const spy = vi.spyOn(Node.prototype, 'removeChild').mockImplementation(function <T extends Node>(
      this: Node,
      child: T
    ): T {
      if (child instanceof Element) {
        for (const input of child.querySelectorAll<HTMLInputElement>('input[data-secure-field]')) {
          atRemoval.push(input.value)
        }
      }

      return removeChild.call(this, child) as T
    })

    try {
      act(() => gw.cancel('srq-1', 'interrupted'))
    } finally {
      spy.mockRestore()
    }

    expect(atRemoval).toEqual([''])
  })

  it("expired: the gateway's deadline closes it, and the chat says so", () => {
    mount()
    raise('srq-1', 'sudo', { command: 'ls' })

    const input = field('Password')

    type(input, SECRET)
    act(() => timers.advance(GATEWAY_TIMEOUT_MS.sudo))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(input.value).toBe('')
    expect(gw.replies).toEqual([])
    expect(screen.getByText('The request from Dr. Researcher expired. Nothing was sent.')).toBeTruthy()
  })

  it('the notice closes', () => {
    mount()
    raise('srq-1', 'sudo', { command: 'ls' })
    act(() => gw.cancel('srq-1', 'timeout'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByText(/expired/u)).toBeNull()
  })

  it('a request only the desktop app can answer leaves its notice and no dialog', () => {
    mount()
    raise('srq-1', 'terminal.read', {})

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByText(
        'Dr. Researcher sent a request that needs the Hermes desktop app (terminal.read). It was declined here.'
      )
    ).toBeTruthy()
  })
})

describe('through axe', () => {
  it.each([
    ['secret', { env_var: 'X', prompt: 'A long prompt' }],
    ['sudo', { command: 'ls' }],
    ['vault.unlock_prompt', { backend: 'b', display_name: 'B' }],
    ['vault.code', { site: 's', hint: 'h' }],
    ['vault.save_login', { origin: 'https://o.test', site: 's' }]
  ])('%s has no violation', async (method, params) => {
    mount()
    raise('srq-1', method, params)

    const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

    expect(result.violations.map(violation => violation.id)).toEqual([])
  })
})
