/**
 * The transcript item gallery: every kind of item in every presentation is on
 * it, and in every language, closed and with every disclosure opened, axe finds
 * no violation.
 *
 * jsdom has no layout, so colour contrast cannot be computed here (the theme's
 * pairs are measured by `ui/theme.contrast.test.ts`, and the end-to-end axe
 * suite runs in real browsers).
 */
import axe from 'axe-core'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale, setActiveLocale, type Locale } from '../i18n/active-locale'

import { GALLERY_ROLLUP, GALLERY_SECTIONS, ItemGalleryPage, MEDIA_SECTIONS, PRESENTATIONS } from './item-gallery'

beforeEach(() => {
  document.documentElement.lang = 'en'
  document.title = 'Transcript items'
})

afterEach(() => {
  resetActiveLocale()
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, {
    rules: { 'color-contrast': { enabled: false } }
  })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

/** Press every closed disclosure on the page until none is left (a roll-up opens onto more). */
function openEverything(container: HTMLElement): void {
  for (let pass = 0; pass < 5; pass += 1) {
    const closed = [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')]

    if (closed.length === 0) {
      return
    }

    closed.forEach(button => fireEvent.click(button))
  }
}

describe('the transcript item gallery', () => {
  it('has every kind of item the engine has, in every presentation', () => {
    const { container } = render(<ItemGalleryPage />)
    const kinds = new Set(GALLERY_SECTIONS.flatMap(section => section.cases.map(entry => entry.item.kind)))

    expect([...kinds].sort()).toEqual(
      [
        'approval',
        'assistant',
        'bot_dm_in',
        'bot_dm_out',
        'clarify',
        'cron_delivery',
        'notice',
        'status',
        'subagent_group',
        'tool',
        'user'
      ].sort()
    )

    for (const section of GALLERY_SECTIONS) {
      for (const entry of section.cases) {
        for (const presentation of PRESENTATIONS) {
          expect(
            container.querySelector(`[id="gallery-${entry.item.id}-${presentation}"]`),
            entry.item.id
          ).not.toBeNull()
        }
      }
    }

    expect(GALLERY_ROLLUP.item.kind).toBe('status')
    expect(container.querySelector('.hm-rollup')).not.toBeNull()
  })

  it('draws something for every presentation but the placeholder', () => {
    const { container } = render(<ItemGalleryPage />)

    for (const section of GALLERY_SECTIONS) {
      for (const entry of section.cases) {
        const placeholder = container.querySelector(`[id="gallery-${entry.item.id}-hidden-placeholder"]`)

        expect(placeholder?.childElementCount, `${entry.item.id} placeholder`).toBe(0)

        const full = container.querySelector(`[id="gallery-${entry.item.id}-full"]`)

        expect(full?.childElementCount, `${entry.item.id} full`).toBeGreaterThan(0)
      }
    }
  })

  it('has what the views draw inside a row and around the transcript', () => {
    const { container } = render(<ItemGalleryPage />)

    for (const id of MEDIA_SECTIONS) {
      expect(container.querySelector(`#gallery-media-${id}`), id).not.toBeNull()
    }

    for (const selector of [
      'ins',
      'del',
      'progress',
      '.hm-gallery img',
      '.hm-gallery .hm-file',
      '.hm-file[data-state="error"]',
      '[data-message-id][aria-keyshortcuts]'
    ]) {
      expect(container.querySelector(selector), selector).not.toBeNull()
    }

    // No message holds a control of its own: the menu is one for the page.
    expect(screen.queryByRole('button', { name: 'Message actions' })).toBeNull()
  })

  for (const locale of ['en', 'nl', 'de'] as Locale[]) {
    it(`has no accessibility violation in ${locale} with the message menu, the options and the viewer open`, async () => {
      setActiveLocale(locale)
      document.documentElement.lang = locale

      const { container } = render(<ItemGalleryPage />)
      const reply = container.querySelector<HTMLElement>('[data-message-id="gallery-assistant-reply"] .hm-bubble')!

      // The hover button and the menu.
      fireEvent.pointerOver(reply)
      fireEvent.contextMenu(reply)
      expect(await screen.findByRole('menu')).toBeTruthy()
      expect(await violations()).toEqual([])
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })

      // The chat's options, whose panel loads when it is first opened.
      fireEvent.click(container.querySelector<HTMLElement>('.hm-chat-options__button')!)
      await vi.waitFor(() => expect(container.querySelector('.hm-chat-options__panel')).not.toBeNull())
      expect(await violations()).toEqual([])

      // A picture, in the viewer over everything.
      fireEvent.click(container.querySelector<HTMLElement>('.hm-gallery button.hm-image')!)
      expect(screen.getByRole('dialog')).toBeTruthy()
      expect(await violations()).toEqual([])
    }, 20_000)
  }

  for (const locale of ['en', 'nl', 'de'] as Locale[]) {
    it(`has no accessibility violation in ${locale}, closed and opened`, async () => {
      setActiveLocale(locale)
      document.documentElement.lang = locale

      const { container } = render(<ItemGalleryPage />)

      expect(await violations()).toEqual([])

      openEverything(container)

      expect(container.querySelectorAll('button[aria-expanded="false"]')).toHaveLength(0)
      expect(await violations()).toEqual([])
      // Two axe runs over every item kind: about 1.5 s alone, past the default 5 s when the whole suite shares the CPU.
    }, 20_000)
  }
})
