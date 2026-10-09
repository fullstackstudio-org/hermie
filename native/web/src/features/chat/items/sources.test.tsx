/**
 * The "Sources" pill under a reply and the dialog it opens (`contract/sources/`).
 *
 * What is held here: the pill is a button named by its word and count, with monograms that are decoration; the dialog is
 * modal, named by its heading, takes the focus, keeps Tab inside, closes on Escape and on the backdrop and gives the
 * focus back; every row shows its host whole whatever its title says; a link opens in a new tab with
 * `rel="noopener noreferrer"`; nothing is requested because a reply has sources (no image, no fetch); and the pill is
 * absent where there is nothing to list.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../../i18n/active-locale'
import { assistantItem } from '../../../test-support/chat-fixtures'
import { AssistantBubble } from './AssistantBubble'
import { ItemContext } from './item-context'
import { Sources } from './Sources'

const SOURCES = [
  { url: 'https://example.org/guide/install', title: 'Installing the gateway', via: 'read' as const },
  { url: 'https://phish.example.net/login', title: 'Your bank - secure sign in', via: 'found' as const },
  { url: 'https://docs.example.com/a?b=c#d', title: '', via: 'found' as const },
  { url: 'https://www.example.org/news', title: 'News', via: 'found' as const }
]

beforeEach(() => {
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const pill = (): HTMLElement => screen.getByRole('button', { name: /^Sources/u })
const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Sources' })

describe('the pill', () => {
  it('is a button named by its word and its count, with up to three monograms that are only decoration', () => {
    render(<Sources sources={SOURCES} />)

    const button = pill()

    expect(button.tagName).toBe('BUTTON')
    expect(button.textContent).toContain('Sources')
    expect(button.textContent).toContain('4')
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')

    const monograms = button.querySelectorAll('.hm-mono')

    // Four pages, three hosts (two on example.org): one monogram a host, at most three.
    expect(monograms.length).toBe(3)
    expect(Array.from(monograms).every(node => node.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(Array.from(monograms).map(node => node.textContent)).toEqual(['E', 'P', 'D'])
  })

  it('draws nothing for an empty list', () => {
    const { container } = render(<Sources sources={[]} />)

    expect(container.firstChild).toBeNull()
  })

  it('loads nothing: no image, no request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const { container } = render(<Sources sources={SOURCES} />)

    fireEvent.click(pill())

    expect(container.querySelector('img, picture, video, iframe, link, object')).toBeNull()
    expect(document.querySelector('img, picture, video, iframe, object')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the dialog', () => {
  it('is a modal dialog named by its heading and described by what it holds', () => {
    render(<Sources sources={SOURCES} />)
    fireEvent.click(pill())

    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('heading', { level: 2, name: 'Sources' })).toBeTruthy()
    expect(document.getElementById(dialog().getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
      /^The pages this reply used\./u
    )
  })

  it('has a section for the pages read and one for those found, each a list of its own links', () => {
    render(<Sources sources={SOURCES} />)
    fireEvent.click(pill())

    const read = screen.getByRole('region', { name: 'Read' })
    const found = screen.getByRole('region', { name: 'Found' })

    expect(within(read).getAllByRole('listitem')).toHaveLength(1)
    expect(within(found).getAllByRole('listitem')).toHaveLength(3)
  })

  it('shows only the sections it has', () => {
    render(<Sources sources={[SOURCES[0]!]} />)
    fireEvent.click(pill())

    expect(screen.queryByRole('region', { name: 'Found' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Read' })).toBeTruthy()
  })

  it('opens each link in a new tab without opener or referrer, on the address the gateway gave', () => {
    render(<Sources sources={SOURCES} />)
    fireEvent.click(pill())

    const links = within(dialog()).getAllByRole('link')

    expect(links).toHaveLength(4)

    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }

    expect(links.map(link => link.getAttribute('href'))).toEqual([
      'https://example.org/guide/install',
      'https://phish.example.net/login',
      'https://docs.example.com/a?b=c#d',
      'https://www.example.org/news'
    ])
  })

  it('shows the whole host beside every title, so a title cannot hide where the link goes', () => {
    render(<Sources sources={SOURCES} />)
    fireEvent.click(pill())

    const link = screen.getByRole('link', { name: /Your bank - secure sign in/u })

    expect(link.textContent).toContain('phish.example.net')
    // The name a screen reader reads has both, and says the link opens in another tab.
    expect(link.textContent).toMatch(/Your bank - secure sign in.*phish\.example\.net.*opens in a new tab/u)
  })

  it('shows the host as the title of an entry with none, and not twice', () => {
    render(<Sources sources={SOURCES} />)
    fireEvent.click(pill())

    const link = screen.getByRole('link', { name: /docs\.example\.com/u })

    expect(link.querySelectorAll('.hm-source__title')[0]?.textContent).toBe('docs.example.com')
    expect(link.querySelector('.hm-source__host')).toBeNull()
  })

  it('keeps a long host whole', () => {
    const host = 'a.very.long.sub.domain.of.some.site.example.org:8443'

    render(<Sources sources={[{ url: `https://${host}/p`, title: 'Long', via: 'read' }]} />)
    fireEvent.click(pill())

    expect(screen.getByRole('link').textContent).toContain(host)
  })

  it('draws a title as text, cleaned once more: markup stays markup, bidi and control characters go', () => {
    render(
      <Sources
        sources={[
          { url: 'https://example.org/', title: '<img src=x onerror=alert(1)>', via: 'read' },
          { url: 'https://example.net/', title: 'ab‮cd\u0007ef', via: 'read' }
        ]}
      />
    )
    fireEvent.click(pill())

    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(screen.getByRole('link', { name: /abcdef/u })).toBeTruthy()
  })

  it('moves the focus to Done, keeps Tab inside, and sets the page behind it inert', () => {
    render(
      <main>
        <Sources sources={SOURCES} />
        <button type="button">Elsewhere</button>
      </main>
    )
    fireEvent.click(pill())

    const done = screen.getByRole('button', { name: 'Done' })

    expect(document.activeElement).toBe(done)
    expect(screen.getByText('Elsewhere').closest('[inert]')).not.toBeNull()

    const links = within(dialog()).getAllByRole('link')
    const last = links[links.length - 1]!

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(done)

    fireEvent.keyDown(done, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('closes on Escape, on Done and on the backdrop, and gives the focus back to the pill', () => {
    render(<Sources sources={SOURCES} />)

    for (const close of [
      () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
      () => fireEvent.click(screen.getByRole('button', { name: 'Done' })),
      () => fireEvent.click(dialog().parentElement!)
    ]) {
      fireEvent.click(pill())
      expect(screen.queryByRole('dialog')).not.toBeNull()

      act(() => close())
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.querySelector('[inert]')).toBeNull()
      expect(document.activeElement).toBe(pill())
    }
  })

  it('does not close on a press inside the dialog', () => {
    render(<Sources sources={SOURCES} />)
    fireEvent.click(pill())
    fireEvent.click(screen.getByRole('heading', { name: 'Sources' }))

    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('shows an address the link policy refuses as text, and says so', () => {
    render(<Sources sources={[{ url: 'https://[', title: 'Broken', via: 'found' }]} />)
    fireEvent.click(pill())

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Not opened from here')).toBeTruthy()
  })

  it('speaks Dutch and German', async () => {
    const { setLanguageChoice } = await import('../../../i18n/locale')

    render(<Sources sources={SOURCES} />)

    await act(() => setLanguageChoice('nl'))
    expect(screen.getByRole('button', { name: /^Bronnen/u })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Bronnen/u }))
    expect(screen.getByRole('dialog', { name: 'Bronnen' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Gelezen' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Gevonden' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Klaar' })).toBeTruthy()

    await act(() => setLanguageChoice('de'))
    expect(screen.getByRole('dialog', { name: 'Quellen' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Gelesen' })).toBeTruthy()
  })

  it('has no axe violation, closed or open', async () => {
    const rules = {
      rules: { 'color-contrast': { enabled: false }, 'document-title': { enabled: false }, region: { enabled: false } }
    }

    render(
      <main>
        <Sources sources={SOURCES} />
      </main>
    )

    expect((await axe.run(document.documentElement, rules)).violations.map(violation => violation.id)).toEqual([])

    fireEvent.click(pill())

    expect((await axe.run(document.documentElement, rules)).violations.map(violation => violation.id)).toEqual([])
  })
})

describe('under a reply', () => {
  const frame = (item: ReturnType<typeof assistantItem>) =>
    render(
      <ItemContext.Provider
        value={{
          botName: 'Bot',
          gatewayBaseUrl: undefined,
          profile: 'researcher',
          ownAuthorId: undefined,
          groupChat: false
        }}
      >
        <AssistantBubble item={item} presentation="full" />
      </ItemContext.Provider>
    )

  it('puts the pill under the bubble, in the reply’s own article', () => {
    const { container } = frame(assistantItem('The gateway is installed with one command.', { sources: SOURCES }))
    const article = container.querySelector('article')!

    expect(within(article).getByRole('button', { name: /^Sources/u })).toBeTruthy()
    // After the bubble, not inside it.
    expect(article.querySelector('.hm-bubble')?.contains(pill())).toBe(false)
  })

  it('has no pill for a reply with no sources', () => {
    frame(assistantItem('Plain answer.'))

    expect(screen.queryByRole('button', { name: /^Sources/u })).toBeNull()
  })

  it('has no pill on a note the bot wrote on the way to its answer', () => {
    frame(assistantItem('Let me look that up.', { sources: SOURCES, interim: true }))

    expect(screen.queryByRole('button', { name: /^Sources/u })).toBeNull()
  })
})
