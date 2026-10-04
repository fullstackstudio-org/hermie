/**
 * The page's shortcut listener: what each shortcut does to the page it is on (focus the field, walk the rows of the
 * list as they are drawn, ask the Conversations page its question, show the list), and what it leaves alone (a key
 * typed into a field, a key held down, a modal layer, an input method composing, a key it does not act on).
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createHashRouter } from '../../platform/hash-router'
import { takeNewConversationRequest } from '../sessions/new-conversation-request'
import { formatRoute, type Route } from './router'
import { useShortcuts } from './use-shortcuts'

const BOTS = ['researcher', 'writer', 'ops', 'quiet']

/** A sidebar with a search field and a row for each bot, as the chat list draws them. */
function sidebar(bots = BOTS): void {
  const list = document.createElement('div')
  const rows = document.createElement('ul')
  const field = document.createElement('input')
  const composer = document.createElement('textarea')
  const button = document.createElement('button')

  list.className = 'hm-chat-list'
  field.className = 'hm-search__field'
  field.type = 'search'
  composer.id = 'composer'
  button.id = 'button'

  for (const bot of bots) {
    const item = document.createElement('li')
    const link = document.createElement('a')

    link.dataset.bot = bot
    link.href = `#/chat/${bot}`
    link.textContent = bot
    item.append(link)
    rows.append(item)
  }

  list.append(field, rows)
  document.body.replaceChildren(list, composer, button)
}

/** A sidebar with no row in it. */
function emptySidebar(): void {
  const list = document.createElement('div')

  list.className = 'hm-chat-list'
  document.body.replaceChildren(list)
}

function setup(route: Route = { name: 'chat', bot: 'writer' }) {
  const router = createHashRouter(null)
  const onHelp = vi.fn()

  // The page is on `route`, as its address says; what the shortcuts do is counted from here.
  router.navigate(formatRoute(route))

  const navigate = vi.spyOn(router, 'navigate')

  renderHook(() => useShortcuts({ router, onHelp }))

  // Another route, as a click on a link or the browser's Back would have made it.
  return { router, navigate, onHelp, rerender: (next: Route) => router.navigate(formatRoute(next)) }
}

/** Press a key on a target; answers whether the page cancelled the browser's own meaning of it. */
function press(init: KeyboardEventInit & { key: string }, target: Element | Document = document.body): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

  target.dispatchEvent(event)

  return event.defaultPrevented
}

const inCtrl = (init: KeyboardEventInit & { key: string }) => press({ ctrlKey: true, ...init })

beforeEach(() => {
  sidebar()
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  takeNewConversationRequest('writer')
  takeNewConversationRequest('researcher')
})

describe('search', () => {
  it('focuses the chats field and selects what is in it, and cancels the browser’s own search', () => {
    setup()

    const field = document.querySelector<HTMLInputElement>('.hm-search__field')!

    field.value = 'earlier'
    expect(inCtrl({ key: 'k' })).toBe(true)
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe('earlier'.length)
  })

  it('works from the composer, where a letter chord means nothing to the text', () => {
    setup()

    inCtrl({ key: 'k' })
    document.getElementById('composer')?.focus()
    expect(press({ key: 'k', ctrlKey: true }, document.getElementById('composer') as Element)).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('.hm-search__field'))
  })

  it('goes to the list first where the field is not drawn, and takes the focus once it is', async () => {
    const { navigate } = setup({ name: 'chat', bot: 'writer' })
    const field = document.querySelector<HTMLInputElement>('.hm-search__field')!
    const focus = vi.spyOn(field, 'focus')

    // A field that is not drawn takes no focus: the first try does not land.
    focus.mockImplementationOnce(() => undefined)
    expect(inCtrl({ key: 'k' })).toBe(true)
    expect(navigate).toHaveBeenCalledWith('#/')

    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    expect(document.activeElement).toBe(field)
  })

  it('does nothing, and leaves the key to the browser, where there is no field at all', () => {
    emptySidebar()
    setup()

    expect(inCtrl({ key: 'k' })).toBe(false)
  })
})

describe('walking the chats', () => {
  it('goes to the next and the previous row as the list draws them, and cancels the arrow', () => {
    const { navigate } = setup({ name: 'chat', bot: 'writer' })

    expect(inCtrl({ key: 'ArrowDown' })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/ops')
    // The next key walks from the chat that was just opened: the address says where the page is.
    expect(inCtrl({ key: 'ArrowUp' })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/writer')
    expect(inCtrl({ key: 'ArrowUp' })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/researcher')
  })

  it('wraps round at either end', () => {
    const { navigate, rerender } = setup({ name: 'chat', bot: 'quiet' })

    inCtrl({ key: 'ArrowDown' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/researcher')

    rerender({ name: 'chat', bot: 'researcher' })
    inCtrl({ key: 'ArrowUp' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/quiet')
  })

  it('starts at the first from no chat, and ends at the last going back', () => {
    const { navigate, rerender } = setup({ name: 'home' })

    inCtrl({ key: 'ArrowDown' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/researcher')

    rerender({ name: 'settings' })
    inCtrl({ key: 'ArrowUp' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/quiet')
  })

  it('counts the chat it is on from a bot’s other pages too', () => {
    const { navigate } = setup({ name: 'conversations', bot: 'ops' })

    inCtrl({ key: 'ArrowDown' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/quiet')
  })

  it('walks only the rows that are drawn: a folder that is closed has none, and a search narrows the list', () => {
    sidebar(['writer', 'quiet'])

    const { navigate } = setup({ name: 'chat', bot: 'writer' })

    inCtrl({ key: 'ArrowDown' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/quiet')
  })

  it('has the same walk on Alt+Arrow and on Control+Tab', () => {
    const { navigate } = setup({ name: 'chat', bot: 'writer' })

    expect(press({ key: 'ArrowDown', altKey: true })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/ops')
    expect(inCtrl({ key: 'Tab' })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/quiet')
    expect(inCtrl({ key: 'Tab', shiftKey: true })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/ops')
  })

  it('walks from the chat that was opened a moment ago, not from the one before it', () => {
    const { navigate, rerender } = setup({ name: 'chat', bot: 'researcher' })

    // A key pressed before the page has drawn the route it just changed to still reads the address.
    rerender({ name: 'chat', bot: 'ops' })
    inCtrl({ key: 'ArrowUp' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/writer')
  })

  it('leaves the arrows to a field while it has the caret, and cancels nothing', () => {
    const { navigate } = setup()
    const composer = document.getElementById('composer') as Element

    expect(press({ key: 'ArrowUp', ctrlKey: true }, composer)).toBe(false)
    expect(press({ key: 'ArrowDown', altKey: true }, composer)).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does nothing, and cancels nothing, with no chat in the list', () => {
    emptySidebar()

    const { navigate } = setup()

    expect(inCtrl({ key: 'ArrowDown' })).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('a chat by its number', () => {
  it('goes to the Nth row of the list, from a field as well', () => {
    const { navigate } = setup()

    expect(inCtrl({ key: '1', code: 'Digit1' })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/researcher')
    expect(press({ key: '3', code: 'Digit3', ctrlKey: true }, document.getElementById('composer') as Element)).toBe(
      true
    )
    expect(navigate).toHaveBeenLastCalledWith('#/chat/ops')
  })

  it('does nothing, and leaves the key to the browser, for a number the list has no row for', () => {
    const { navigate } = setup()

    expect(inCtrl({ key: '9', code: 'Digit9' })).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('encodes the name in the address', () => {
    sidebar(['a/b c'])

    const { navigate } = setup()

    inCtrl({ key: '1', code: 'Digit1' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/a%2Fb%20c')
  })
})

describe('a new conversation', () => {
  it('opens the Conversations page of the chat that is open, with its question asked for', () => {
    const { navigate } = setup({ name: 'chat', bot: 'writer' })

    expect(inCtrl({ key: 'n' })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/writer/conversations')
    expect(takeNewConversationRequest('writer')).toBe(true)
    expect(takeNewConversationRequest('writer')).toBe(false)
  })

  it('does the same on the chord a browser leaves alone', () => {
    const { navigate } = setup({ name: 'chat', bot: 'researcher' })

    expect(press({ key: 'n', ctrlKey: true, altKey: true })).toBe(true)
    expect(navigate).toHaveBeenLastCalledWith('#/chat/researcher/conversations')
    expect(takeNewConversationRequest('researcher')).toBe(true)
  })

  it('does nothing, and leaves Control+N to the browser, with no chat open', () => {
    const { navigate } = setup({ name: 'home' })

    expect(inCtrl({ key: 'n' })).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    expect(takeNewConversationRequest('writer')).toBe(false)
  })
})

describe('the list of shortcuts', () => {
  it('opens on the question mark outside a field, and on Control+/ anywhere', () => {
    const { onHelp } = setup()

    expect(press({ key: '?', shiftKey: true })).toBe(true)
    expect(onHelp).toHaveBeenCalledTimes(1)
    expect(press({ key: '/', ctrlKey: true }, document.getElementById('composer') as Element)).toBe(true)
    expect(onHelp).toHaveBeenCalledTimes(2)
  })

  it('leaves a question mark typed into a field to the text', () => {
    const { onHelp } = setup()

    expect(press({ key: '?', shiftKey: true }, document.getElementById('composer') as Element)).toBe(false)
    expect(press({ key: '?', shiftKey: true }, document.querySelector('.hm-search__field') as Element)).toBe(false)
    expect(onHelp).not.toHaveBeenCalled()
  })
})

describe('what it leaves alone', () => {
  it('acts on nothing while a modal layer is open', () => {
    const { navigate, onHelp } = setup()

    const modal = document.createElement('div')

    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    expect(inCtrl({ key: 'ArrowDown' })).toBe(false)
    expect(inCtrl({ key: 'k' })).toBe(false)
    expect(press({ key: '?' })).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    expect(onHelp).not.toHaveBeenCalled()
  })

  it('acts on nothing for a held key, an input method composing, or a key somebody else used', () => {
    const { navigate } = setup()

    expect(inCtrl({ key: 'ArrowDown', repeat: true })).toBe(false)
    expect(inCtrl({ key: 'ArrowDown', isComposing: true })).toBe(false)

    const used = new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true, cancelable: true })

    document.body.addEventListener('keydown', event => event.preventDefault(), { once: true })
    document.body.dispatchEvent(used)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('cancels nothing for a key that is no shortcut, or a shortcut with another modifier beside it', () => {
    setup()

    expect(press({ key: 'a' })).toBe(false)
    expect(press({ key: 'k' })).toBe(false)
    expect(press({ key: 'k', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(press({ key: 'ArrowDown' })).toBe(false)
  })

  it('stops listening when the page goes', () => {
    const { navigate } = setup()

    cleanup()
    inCtrl({ key: 'ArrowDown' })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('reads the route it is on now, not the one it was installed on', () => {
    const { navigate, rerender } = setup({ name: 'chat', bot: 'researcher' })

    rerender({ name: 'chat', bot: 'ops' })
    inCtrl({ key: 'ArrowDown' })
    expect(navigate).toHaveBeenLastCalledWith('#/chat/quiet')
  })
})
