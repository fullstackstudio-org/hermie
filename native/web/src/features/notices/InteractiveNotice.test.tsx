/**
 * The chat's line about a form, a file request or a draft that ended without the reader's answer or that this page
 * could not show: over the real interactive model, so each line is the one a real ending leaves, and closing it goes
 * through the model.
 */
import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { REFUSED_CODE } from '../../core/requests/interactive'
import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { interactiveStore } from '../../state/interactive'
import {
  draftFrame,
  fileFrame,
  formFrame,
  type Harness,
  mount,
  raise,
  setup,
  teardown
} from '../../test-support/interactive-layer'
import { InteractiveRuntimeContext } from '../requests/interactive-runtime'
import { preloadRequestSheets } from '../requests/request-sheets'
import { InteractiveNotice } from './InteractiveNotice'

beforeAll(async () => {
  await preloadRequestSheets()
})

let harness: Harness

beforeEach(() => {
  harness = setup()
})

afterEach(() => teardown(harness))

const banner = (): HTMLElement | null => document.querySelector('[data-interactive-notice]')

/** The layer, the notice beside it, over one model. */
function mountWithNotice() {
  mount(harness)

  return render(
    <InteractiveRuntimeContext.Provider value={harness.model}>
      <InteractiveNotice chatKey="researcher" bot="researcher" />
    </InteractiveRuntimeContext.Provider>
  )
}

describe('the chat’s line about an interactive request', () => {
  it('says nothing while nothing ended', () => {
    mountWithNotice()
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'a', kind: 'text', label: 'A' }]))

    expect(banner()).toBeNull()
  })

  it('says a request timed out', () => {
    mountWithNotice()
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'a', kind: 'text', label: 'A' }], { expires_at: 1_030 }))
    act(() => harness.timers.advance(30_000))

    expect(banner()?.getAttribute('data-interactive-notice')).toBe('expired')
    expect(banner()?.textContent).toContain('The request from Dr. Researcher timed out.')
  })

  it('says a request was withdrawn', () => {
    mountWithNotice()
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    act(() => harness.gw.cancel('srq-1', 'interrupted'))

    expect(banner()?.getAttribute('data-interactive-notice')).toBe('withdrawn')
    expect(banner()?.textContent).toContain('The request from Dr. Researcher was withdrawn.')
  })

  it('says another device answered it', () => {
    mountWithNotice()
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    act(() => harness.gw.cancel('srq-1', 'resolved'))

    expect(banner()?.getAttribute('data-interactive-notice')).toBe('answered_elsewhere')
    expect(banner()?.textContent).toContain('answered on another device')
  })

  it('says an answer may not have arrived: it was sent, and the request ended without the gateway’s word', async () => {
    mountWithNotice()
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'a', kind: 'text', label: 'A' }]))
    harness.gw.onCall.handler = () => {
      throw new Error('socket closed')
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    })
    // The gateway settled it (another answer, or this one after all): the answer from here may not have arrived.
    act(() => harness.gw.cancel('srq-1', 'resolved'))

    expect(banner()?.getAttribute('data-interactive-notice')).toBe('may_not_have_arrived')
    expect(banner()?.textContent).toMatch(/may not have arrived/u)
  })

  it('says a request this page could not show, by what it was, and that the bot was told', async () => {
    mountWithNotice()
    raise(harness, 'srq-1', 'input.file', fileFrame())
    act(() => {
      harness.model.cannotShow('srq-1', 'upload_failed')
    })

    expect(banner()?.getAttribute('data-interactive-notice')).toBe('cannot_show')
    expect(banner()?.textContent).toContain('Dr. Researcher sent a file request, and this page could not show it.')
    expect(banner()?.textContent).toContain('Dr. Researcher was told.')
  })

  it('says it in the reader’s language', () => {
    setActiveLocale('nl')
    mountWithNotice()
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    act(() => {
      harness.model.cannotShow('srq-1', 'not_supported_on_device')
    })

    expect(banner()?.textContent).toContain('stuurde een concept om na te kijken')
    resetActiveLocale()
  })

  it('is closed by its button, through the model', () => {
    mountWithNotice()
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(banner()).toBeNull()
    expect(interactiveStore.getState().notices.researcher).toBeUndefined()
  })

  it('leaves a refusal to the sheet: the request stays open, so there is no line', async () => {
    mountWithNotice()
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'a', kind: 'text', label: 'A' }]))
    harness.gw.onCall.handler = () => {
      throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason: 'field:a:too_long' } })
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send answers' }))
    })

    expect(banner()).toBeNull()
  })
})
