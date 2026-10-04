/**
 * The transcript's one message menu: what it offers (the model in
 * `message-menu.ts`), and how it is reached without a control in any message,
 * from the keyboard's roving focus, a pointer's hover button, a right-click and
 * a long press.
 */
import type { TranscriptItem } from '@hermie/transcript'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { assistantItem, toolItem, userItem } from '../../test-support/chat-fixtures'
import { ChatItem } from './items/ChatItem'
import { DETACHED_ITEM_HOST, type ItemHost } from './items/item-host'
import { MESSAGE_MENU_KEYS, messageMenuAction, messageMenuEntries, messageText } from './message-menu'
import { LONG_PRESS_MS, MessageMenuLayer } from './MessageMenu'

afterEach(() => {
  vi.useRealTimers()
})

/** A host over these items, whose turn and regenerate target the test moves as the screen would. */
function liveHost(items: readonly TranscriptItem[], over: Partial<ItemHost> = {}) {
  const listeners = new Set<() => void>()
  const state = { turnActive: false, target: null as string | null, edit: null as string | null, branch: false }
  const byId = new Map(items.map(item => [item.id, item]))
  const host: ItemHost = {
    ...DETACHED_ITEM_HOST,
    itemById: id => byId.get(id),
    copy: vi.fn(async () => true),
    announce: vi.fn(),
    regenerate: vi.fn(),
    editResend: vi.fn(),
    branch: vi.fn(),
    subscribe: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    turnActive: () => state.turnActive,
    regenerateTarget: () => state.target,
    editTarget: () => state.edit,
    canBranch: () => state.branch,
    ...over
  }

  return {
    host,
    set(next: Partial<typeof state>) {
      act(() => {
        Object.assign(state, next)
        listeners.forEach(listener => listener())
      })
    }
  }
}

function Transcript({ items, host }: { items: readonly TranscriptItem[]; host: ItemHost }) {
  const stage = useRef<HTMLDivElement>(null)

  return (
    <>
      <div ref={stage}>
        <div role="log" aria-label="Conversation" tabIndex={0}>
          {items.map(item => (
            <ChatItem key={item.id} row={{ item, presentation: 'full' }} />
          ))}
        </div>
        <MessageMenuLayer container={stage} host={host} />
      </div>
      <p>elsewhere</p>
    </>
  )
}

const ITEMS = [
  userItem('first question', {}, 'u1'),
  assistantItem('some **bold** answer', {}, 'a1'),
  toolItem('web_search', {}, 't1'),
  assistantItem('the last answer', {}, 'a2')
]

const message = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
const log = (): HTMLElement => screen.getByRole('log')
const lines = async (): Promise<(string | null)[]> =>
  (await screen.findAllByRole('menuitem')).map(line => line.textContent)

/** Lets a lazy menu that is coming arrive, so its absence means something. */
const settle = (): Promise<void> =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })

describe('what a message’s menu offers', () => {
  it('offers Copy as Markdown only where it differs from Copy text', async () => {
    expect(messageMenuEntries({ item: userItem('plain words'), canRegenerate: false, turnActive: false })).toEqual([
      { id: 'copyText', disabled: false }
    ])
    expect(
      messageMenuEntries({ item: assistantItem('some **bold**'), canRegenerate: false, turnActive: false }).map(
        entry => entry.id
      )
    ).toEqual(['copyText', 'copyMarkdown'])
  })

  it('offers Regenerate on the one reply it may, disabled while a turn runs', async () => {
    expect(messageMenuEntries({ item: assistantItem('done'), canRegenerate: true, turnActive: true })).toContainEqual({
      id: 'regenerate',
      disabled: true
    })
    expect(
      messageMenuEntries({ item: userItem('hi'), canRegenerate: true, turnActive: false }).map(entry => entry.id)
    ).toEqual(['copyText'])
    expect(messageMenuEntries({ item: toolItem('x'), canRegenerate: false, turnActive: false })).toEqual([])
  })

  it('reads the text off the item when a line is chosen, stripped for Copy text and verbatim for Markdown', async () => {
    const reply = assistantItem('# Title\n\nsome **bold** and [a link](https://x.test)')

    expect(messageMenuAction('copyMarkdown', reply)).toEqual({ kind: 'copyMarkdown', text: reply.text })
    expect(messageMenuAction('copyText', reply)).toEqual({
      kind: 'copyText',
      text: expect.not.stringMatching(/[*#[\]]/u) as unknown as string
    })
    expect(messageMenuAction('regenerate', userItem('x'))).toBeNull()
    expect(messageText(toolItem('x'))).toBe('')
  })
})

describe('the shared menu', () => {
  it('puts no control in any message: two attributes, and one hover button for the whole transcript', async () => {
    const { host } = liveHost(ITEMS)

    render(<Transcript items={ITEMS} host={host} />)

    expect(screen.queryByRole('button', { name: 'Message actions' })).toBeNull()
    expect(message('u1').getAttribute('aria-keyshortcuts')).toBe(MESSAGE_MENU_KEYS)
    expect(document.querySelectorAll('[data-message-id]')).toHaveLength(3)
    expect(message('a1').hasAttribute('tabindex')).toBe(false)

    fireEvent.pointerOver(message('a1').querySelector('.hm-bubble')!)
    fireEvent.pointerOver(message('a2'))

    const more = screen.getAllByRole('button', { name: 'Message actions' })

    expect(more).toHaveLength(1)
    expect(more[0]!.tabIndex).toBe(-1)
    expect(more[0]!.getAttribute('aria-haspopup')).toBe('menu')
  })

  it('moves the keyboard between messages from the transcript, with the arrows, Home and End, and back with Escape', async () => {
    const { host } = liveHost(ITEMS)

    render(<Transcript items={ITEMS} host={host} />)
    log().focus()

    fireEvent.keyDown(log(), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(message('a2'))
    expect(message('a2').getAttribute('tabindex')).toBe('-1')

    fireEvent.keyDown(message('a2'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(message('a1'))

    fireEvent.keyDown(message('a1'), { key: 'Home' })
    expect(document.activeElement).toBe(message('u1'))

    fireEvent.keyDown(message('u1'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(message('u1'))

    fireEvent.keyDown(message('u1'), { key: 'End' })
    expect(document.activeElement).toBe(message('a2'))

    fireEvent.keyDown(message('a2'), { key: 'Escape' })
    expect(document.activeElement).toBe(log())

    // Back from the transcript to the message the reader was on.
    fireEvent.keyDown(log(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(message('a2'))
  })

  it('opens on Enter, Shift+F10 or the context-menu key, on its first line, and gives focus back on Escape', async () => {
    const { host } = liveHost(ITEMS)

    render(<Transcript items={ITEMS} host={host} />)
    log().focus()
    fireEvent.keyDown(log(), { key: 'ArrowUp' })
    fireEvent.keyDown(message('a2'), { key: 'ArrowUp' })

    for (const key of [{ key: 'Enter' }, { key: 'F10', shiftKey: true }, { key: 'ContextMenu' }]) {
      fireEvent.keyDown(message('a1'), key)

      expect(await screen.findByRole('menu', { name: 'Message actions' })).toBeTruthy()
      expect(await lines()).toEqual(['Copy text', 'Copy as Markdown'])
      expect(document.activeElement).toBe((await screen.findAllByRole('menuitem'))[0])

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      await settle()
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(message('a1'))
    }
  })

  it('moves within the menu with the arrows and copies the words, saying so', async () => {
    const { host } = liveHost(ITEMS)

    render(<Transcript items={ITEMS} host={host} />)
    message('a1').setAttribute('tabindex', '-1')
    message('a1').focus()
    fireEvent.keyDown(message('a1'), { key: 'Enter' })

    const [copyText, copyMarkdown] = await screen.findAllByRole('menuitem')

    fireEvent.keyDown(copyText!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(copyMarkdown)
    fireEvent.keyDown(copyMarkdown!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(copyText)

    fireEvent.click(copyText!)

    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(message('a1'))
    expect(host.copy).toHaveBeenCalledWith('some bold answer')
    await vi.waitFor(() => expect(host.announce).toHaveBeenCalledWith('Copied'))
  })

  it('opens from the hover button, which says it is expanded, and closes on a press elsewhere', async () => {
    const { host } = liveHost(ITEMS, { copy: vi.fn(async () => false) })

    render(<Transcript items={ITEMS} host={host} />)
    fireEvent.pointerOver(message('u1'))

    const more = screen.getByRole('button', { name: 'Message actions' })

    fireEvent.click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect((await screen.findByRole('menu')).id).toBe(more.getAttribute('aria-controls'))
    expect(await lines()).toEqual(['Copy text'])

    fireEvent.pointerDown(screen.getByText('elsewhere'))
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(more)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy text' }))
    await vi.waitFor(() => expect(host.announce).toHaveBeenCalledWith('Could not copy'))
  })

  it('opens on a right-click on a message, but leaves a link’s right-click to the browser', async () => {
    const items = [assistantItem('see [the docs](https://docs.example)', {}, 'a1')]
    const { host } = liveHost(items)

    render(<Transcript items={items} host={host} />)

    expect(fireEvent.contextMenu(screen.getByRole('link', { name: 'the docs' }))).toBe(true)
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()

    // Words the reader selected first are theirs to copy with the browser's own menu.
    const words = message('a1').querySelector('.hm-bubble p')!
    const range = document.createRange()

    range.selectNodeContents(words)
    document.getSelection()?.addRange(range)
    expect(fireEvent.contextMenu(words)).toBe(true)
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
    document.getSelection()?.removeAllRanges()

    expect(fireEvent.contextMenu(message('a1').querySelector('.hm-bubble')!)).toBe(false)
    expect(await screen.findByRole('menu')).toBeTruthy()
  })

  it('opens on a long press of a finger, and not when the finger moves away', async () => {
    vi.useFakeTimers()

    const { host } = liveHost(ITEMS)
    const press = (target: Element, type: string, x: number, y: number): void => {
      const event = new Event(type, { bubbles: true, cancelable: true })

      Object.assign(event, { pointerType: 'touch', clientX: x, clientY: y })
      act(() => {
        target.dispatchEvent(event)
      })
    }

    render(<Transcript items={ITEMS} host={host} />)

    const bubble = message('u1').querySelector('.hm-bubble')!

    press(bubble, 'pointerdown', 10, 10)
    press(bubble, 'pointermove', 40, 10)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10))
    expect(screen.queryByRole('menu')).toBeNull()

    press(bubble, 'pointerdown', 10, 10)
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10))
    vi.useRealTimers()
    expect(await screen.findByRole('menu')).toBeTruthy()

    // The tap that ends the press does not reach what is under the finger, nor does the browser's own menu open.
    expect(fireEvent.click(bubble)).toBe(false)
    expect(fireEvent.contextMenu(bubble)).toBe(false)
  })

  it('asks for the last reply again, holding the line disabled, and described, while a turn runs', async () => {
    const { host, set } = liveHost(ITEMS)

    set({ target: 'a2' })
    render(<Transcript items={ITEMS} host={host} />)
    fireEvent.pointerOver(message('a2'))
    fireEvent.click(screen.getByRole('button', { name: 'Message actions' }))
    set({ turnActive: true })

    const regenerate = await screen.findByRole('menuitem', { name: 'Regenerate' })

    expect(regenerate.getAttribute('aria-disabled')).toBe('true')
    expect(document.getElementById(regenerate.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Wait for the current turn to finish.'
    )
    fireEvent.click(regenerate)
    expect(host.regenerate).not.toHaveBeenCalled()

    set({ turnActive: false })
    expect(regenerate.hasAttribute('aria-disabled')).toBe(false)
    fireEvent.click(regenerate)
    expect(host.regenerate).toHaveBeenCalledTimes(1)
  })

  it('does not offer Regenerate on a reply that is not the last, and opens nothing for a message with nothing to offer', async () => {
    const items = [
      ...ITEMS,
      assistantItem('', { error: { message: 'boom', recoverable: false, partial: false } }, 'a3')
    ]
    const { host, set } = liveHost(items)

    set({ target: 'a2' })
    render(<Transcript items={items} host={host} />)

    fireEvent.contextMenu(message('a1').querySelector('.hm-bubble')!)
    expect(await lines()).toEqual(['Copy text', 'Copy as Markdown'])
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })

    fireEvent.contextMenu(message('a3'))
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('Edit and resend, Branch from here and the links', () => {
  /** Open the menu of one message with a right-click, as a pointer reader does. */
  const openMenu = async (id: string): Promise<void> => {
    fireEvent.contextMenu(message(id).querySelector('.hm-bubble') ?? message(id))
    await screen.findByRole('menu')
  }

  it('puts the newest turn’s words and attachment references back, and leaves the menu closed', async () => {
    const items = [userItem('fix the **typo**', { attachments: ['/tmp/a.png'] }, 'u1'), assistantItem('done', {}, 'a1')]
    const { host, set } = liveHost(items)

    set({ edit: 'u1' })
    render(<Transcript items={items} host={host} />)
    await openMenu('u1')
    expect(await lines()).toEqual(['Copy text', 'Copy as Markdown', 'Edit and resend'])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit and resend' }))
    await settle()

    expect(host.editResend).toHaveBeenCalledWith('fix the **typo**', ['/tmp/a.png'])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('holds Edit and resend disabled while a turn runs, and offers it on no other turn', async () => {
    const items = [userItem('first', {}, 'u1'), assistantItem('one', {}, 'a1'), userItem('second', {}, 'u2')]
    const { host, set } = liveHost(items)

    set({ edit: 'u2', turnActive: true })
    render(<Transcript items={items} host={host} />)

    await openMenu('u1')
    expect(await lines()).toEqual(['Copy text'])
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await settle()

    await openMenu('u2')

    const line = await screen.findByRole('menuitem', { name: 'Edit and resend' })

    expect(line.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(line)
    expect(host.editResend).not.toHaveBeenCalled()
  })

  it('branches from a turn and from a reply, not from a tool card, and not while the chat cannot', async () => {
    const { host, set } = liveHost(ITEMS)

    render(<Transcript items={ITEMS} host={host} />)
    await openMenu('u1')
    expect(await lines()).toEqual(['Copy text'])
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await settle()

    set({ branch: true })
    await openMenu('a1')
    expect(await lines()).toEqual(['Copy text', 'Copy as Markdown', 'Branch from here'])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch from here' }))
    await settle()
    // The text is read off the item as it is now; the host knows where the row sits.
    expect(host.branch).toHaveBeenCalledWith('a1', 'some **bold** answer')
    expect(screen.queryByRole('menu')).toBeNull()

    // A running turn does not disable it: a branch touches nothing of the session.
    set({ turnActive: true })
    await openMenu('u1')
    expect(screen.getByRole('menuitem', { name: 'Branch from here' }).hasAttribute('aria-disabled')).toBe(false)
  })

  it('copies the one link of a message from a line of its own', async () => {
    const items = [assistantItem('see [the docs](https://docs.example/a)', {}, 'a1')]
    const { host } = liveHost(items)

    render(<Transcript items={items} host={host} />)
    await openMenu('a1')
    expect(await lines()).toEqual(['Copy text', 'Copy as Markdown', 'Copy link'])

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }))
    await vi.waitFor(() => expect(host.copy).toHaveBeenCalledWith('https://docs.example/a'))
    await vi.waitFor(() => expect(host.announce).toHaveBeenCalledWith('Copied'))
  })

  it('lists the links of a message with several in a group, reached and left with the arrows', async () => {
    const items = [
      assistantItem('one https://a.example and [two](https://b.example/x) and <https://c.example>', {}, 'a1')
    ]
    const { host } = liveHost(items)

    render(<Transcript items={items} host={host} />)
    await openMenu('a1')

    const parent = await screen.findByRole('menuitem', { name: 'Copy links' })

    expect(parent.getAttribute('aria-haspopup')).toBe('true')
    expect(parent.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('group', { name: 'Copy links' })).toBeNull()

    // The right arrow opens it and goes in.
    parent.focus()
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    expect(parent.getAttribute('aria-expanded')).toBe('true')

    const group = await screen.findByRole('group', { name: 'Copy links' })

    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('https://a.example'))
    expect(await lines()).toEqual([
      'Copy text',
      'Copy as Markdown',
      'Copy links',
      'https://a.example',
      'https://b.example/x',
      'https://c.example'
    ])
    expect(group.querySelectorAll('[role="menuitem"]')).toHaveLength(3)

    // Left, and Escape inside the group, close only the group and go back to the line.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(parent.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(parent)
    expect(screen.getByRole('menu')).toBeTruthy()

    fireEvent.click(parent)
    await screen.findByRole('group', { name: 'Copy links' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('menu')).toBeTruthy()

    // A link is chosen from the group.
    fireEvent.keyDown(parent, { key: 'ArrowRight' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'https://c.example' }))
    await vi.waitFor(() => expect(host.copy).toHaveBeenCalledWith('https://c.example'))
    await settle()
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
