/**
 * The stand-in sheet for a form, a file request and a draft, in the request layer, over the real
 * interactive model and a hand-driven connection: what it says and in whose words, the two ways out it
 * offers (Skip when the request is optional, Decline otherwise and always), what each puts on the wire,
 * the tap guard, Escape, the offline case, a request withdrawn while open, and axe.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CANNOT_SHOW_CODE, InteractiveModel } from '../../core/requests/interactive'
import { resetActiveLocale } from '../../i18n/active-locale'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { interactiveStore } from '../../state/interactive'
import { bindRequests, requestsStore } from '../../state/requests'
import { chatWith } from '../../test-support/chat-fixtures'
import { type FakeInteractiveGateway, fakeInteractiveGateway } from '../../test-support/interactive-gateway'
import { manualTimers, type ManualTimers } from '../../test-support/secure-input-gateway'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { InteractiveRuntimeContext } from './interactive-runtime'
import { preloadRequestSheets } from './request-sheets'
import { RequestLayer } from './RequestLayer'

beforeAll(async () => {
  await preloadRequestSheets()
})

let gw: FakeInteractiveGateway
let timers: ManualTimers
let model: InteractiveModel
let stopBinding: () => void = () => undefined

const NOW_SECONDS = 1_000

beforeEach(() => {
  resetShellStores()
  requestsStore.getState().reset()
  interactiveStore.getState().reset()
  resetActiveLocale()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer')])
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
  chatsStore.getState().bindRuntime('researcher', 'rt-1')

  timers = manualTimers(NOW_SECONDS * 1000)
  gw = fakeInteractiveGateway()
  model = new InteractiveModel({
    gateway: gw.gateway,
    chatFor: id => chatsStore.getState().runtimeToBot[id],
    watchChats: listener => chatsStore.subscribe(() => listener()),
    failWithData: gw.failWithData,
    gatewayName: 'gw.example.test',
    now: () => timers.now(),
    timers
  })
  model.start()
  stopBinding = bindRequests(chatsStore, requestsStore, undefined, undefined, undefined, interactiveStore)
})

afterEach(() => {
  stopBinding()
  model.stop()
  resetActiveLocale()
})

function mount(tapGuardMs = 0) {
  return render(
    <InteractiveRuntimeContext.Provider value={model}>
      <main>
        <label>
          Draft
          <textarea />
        </label>
      </main>
      <RequestLayer tapGuardMs={tapGuardMs} />
    </InteractiveRuntimeContext.Provider>
  )
}

const FORM = {
  session_id: 'rt-1',
  v: 1,
  title: 'Hotel **booking** details',
  summary: 'Fill <b>this</b> in [here](https://evil.test) and I will book it.',
  expires_at: NOW_SECONDS + 300,
  optional: true,
  fields: [{ id: 'name', kind: 'text', label: 'Name' }]
}

const DRAFT = {
  session_id: 'rt-1',
  v: 1,
  title: 'Reply to Bram',
  summary: 'Approve or reject it.',
  expires_at: NOW_SECONDS + 300,
  optional: false,
  kind: 'mail',
  text: 'Hi Bram',
  editable: true
}

const raise = (id: string, method: string, params: Record<string, unknown>): void =>
  void act(() => {
    gw.deliver(id, method, params)
  })

const dialog = (): HTMLElement => screen.getByRole('dialog')
const button = (name: string | RegExp): HTMLElement => within(dialog()).getByRole('button', { name })

describe('the stand-in for a sheet that does not exist yet', () => {
  it("says what it is in the app's words and shows the request's own words quoted, as plain text", () => {
    mount()
    raise('srq-1', 'input.form', FORM)

    expect(screen.getByRole('dialog', { name: 'A request this page cannot show yet' })).toBe(dialog())
    expect(dialog().querySelector('.hm-requests__from')?.textContent).toBe('From Dr. Researcher')

    const quote = dialog().querySelector('[data-secure-quote]') as HTMLElement

    expect(document.getElementById(quote.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('What the bot says')
    expect(quote.textContent).toBe(`${FORM.title}\n${FORM.summary}`)
    expect(quote.children).toHaveLength(0)
    expect(dialog().querySelector('a, img, iframe, form, input, textarea')).toBeNull()
  })

  it('declines: 4041 cannot_show goes out on the request, and the dialog goes', () => {
    mount()
    raise('srq-1', 'input.form', FORM)
    fireEvent.click(button('Decline'))

    expect(gw.declined).toEqual([
      { id: 'srq-1', code: CANNOT_SHOW_CODE, message: 'cannot_show', reason: 'not_supported_on_device' }
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(interactiveStore.getState().notices.researcher?.notice).toEqual({
      kind: 'cannot_show',
      method: 'input.form',
      reason: 'not_supported_on_device'
    })
  })

  it('skips an optional request: {status: skipped} through request.answer', async () => {
    mount()
    raise('srq-1', 'input.form', FORM)
    await act(async () => {
      fireEvent.click(button('Skip'))
    })

    expect(gw.calls).toEqual([{ method: 'request.answer', params: { id: 'srq-1', result: { status: 'skipped' } } }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers no Skip for a request that is not optional, nor ever for a draft', () => {
    mount()
    raise('srq-1', 'input.form', { ...FORM, optional: false })
    expect(within(dialog()).queryByRole('button', { name: 'Skip' })).toBeNull()
    expect(button('Decline')).toBeTruthy()

    act(() => {
      fireEvent.click(button('Decline'))
    })
    raise('srq-2', 'review.draft', { ...DRAFT, optional: true })

    expect(within(dialog()).queryByRole('button', { name: 'Skip' })).toBeNull()
  })

  it('takes nothing for a moment after it appears (the tap guard)', async () => {
    mount(40)
    raise('srq-1', 'input.form', FORM)

    expect((button('Decline') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Skip') as HTMLButtonElement).disabled).toBe(true)

    // The sheet's own guard runs on the real clock.
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })

    expect((button('Decline') as HTMLButtonElement).disabled).toBe(false)
    expect((button('Skip') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not close on Escape: only an answer closes a question', () => {
    mount()
    raise('srq-1', 'input.form', FORM)
    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(screen.getByRole('dialog')).toBe(dialog())
    expect(gw.replies).toEqual([])
  })

  it('says so, and sends nothing, when declining is pressed while the connection is down', () => {
    mount()
    raise('srq-1', 'input.form', FORM)
    act(() => gw.status('connecting'))
    fireEvent.click(button('Decline'))

    expect(within(dialog()).getByText(/Not connected to the gateway/u)).toBeTruthy()
    expect(gw.replies).toEqual([])
    expect(interactiveStore.getState().requests).toHaveLength(1)
  })

  it('goes when the gateway withdraws the request, and the reader is told in words', () => {
    mount()
    raise('srq-1', 'input.form', FORM)
    act(() => gw.cancel('srq-1', 'interrupted'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toContain('The request from Dr. Researcher was withdrawn.')
  })

  it('goes when its time runs out, and the reader is told so', () => {
    mount()
    raise('srq-1', 'input.form', { ...FORM, expires_at: NOW_SECONDS + 30 })
    act(() => timers.advance(30_000))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toContain('The request from Dr. Researcher timed out.')
  })

  it('queues the second behind the first and says how many wait', () => {
    mount()
    raise('srq-1', 'input.form', FORM)
    raise('srq-2', 'review.draft', DRAFT)

    expect(within(dialog()).getByText('1 more waiting')).toBeTruthy()
  })
})

describe('through axe', () => {
  it.each([
    ['input.form', FORM],
    ['review.draft', DRAFT]
  ])('has no violation for %s', async (method, params) => {
    mount()
    raise('srq-1', method, params)

    const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

    expect(result.violations.map(violation => violation.id)).toEqual([])
  })
})
