/**
 * The fixture page, in every language, through axe: no violation.
 *
 * jsdom has no layout, so the two kinds of rule that need one cannot run here:
 * colour contrast (the page's colours are theme tokens, W-10a) and whether a
 * scroll region really overflows. The scroll containers are focusable
 * regardless, which `scrollable-region-focusable` would otherwise ask for.
 */
import axe from 'axe-core'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale, setActiveLocale, type Locale } from '../i18n/active-locale'
import { highlightRenderer, mathRenderer } from '../markdown/lazy'

import { FIXTURE_SECTIONS, MarkdownFixturesPage } from './markdown-fixtures'

beforeEach(() => {
  document.documentElement.lang = 'en'
  document.title = 'Markdown fixtures'
})

afterEach(() => {
  resetActiveLocale()
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, {
    // No layout in jsdom: contrast cannot be computed.
    rules: { 'color-contrast': { enabled: false } }
  })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

describe('the Markdown fixture page', () => {
  it('has every fixture on it', () => {
    const { container } = render(<MarkdownFixturesPage />)

    for (const section of FIXTURE_SECTIONS) {
      expect(container.querySelector(`#fixture-${section.id}`), section.id).not.toBeNull()
    }

    // One of each thing the checker has to see.
    for (const selector of [
      'table',
      'pre code',
      'ul',
      'ol',
      'blockquote',
      'hr',
      'a[href]',
      'img',
      'input[type=checkbox]'
    ]) {
      expect(container.querySelector(selector), selector).not.toBeNull()
    }
  })

  it('is checked by a checker that does find things', async () => {
    render(
      <main>
        <h1>Broken</h1>
        <img src="/x.png" />
        <button type="button" />
        <table>
          <tbody>
            <tr>
              <th>no scope on a header that has data under it</th>
              <td />
            </tr>
          </tbody>
        </table>
      </main>
    )

    const found = await violations()

    expect(found.some(line => line.startsWith('image-alt'))).toBe(true)
    expect(found.some(line => line.startsWith('button-name'))).toBe(true)
  })

  it.each<Locale>(['en', 'nl', 'de'])('has no accessibility violation (%s)', async locale => {
    setActiveLocale(locale)
    document.documentElement.lang = locale
    render(<MarkdownFixturesPage />)

    expect(await violations()).toEqual([])
  })

  it('has no accessibility violation with the drawings and the colours loaded', async () => {
    await Promise.all([highlightRenderer.load(), mathRenderer.load()])

    const { container } = render(<MarkdownFixturesPage />)

    // The chunks drew what they draw: a formula, inline math, a coloured listing.
    expect(container.querySelector('svg[role="img"][aria-label]')).not.toBeNull()
    expect(container.querySelector('[role="math"][aria-label]')).not.toBeNull()
    expect(container.querySelector('.md-hl')).not.toBeNull()
    expect(await violations()).toEqual([])
  })
})
