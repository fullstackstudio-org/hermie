import { afterEach, describe, expect, it } from 'vitest'

import { WEB_STRINGS_SOURCE } from '../i18n/web-strings'
import { isFramed, refusalText, refuseInFrame } from './frame-guard'

afterEach(() => {
  document.body.replaceChildren()
})

/** A real frame inside the test's document: its window's `top` is not itself. */
function frame(): HTMLIFrameElement {
  const element = document.createElement('iframe')
  document.body.append(element)

  return element
}

describe('the frame guard', () => {
  it('knows a top-level window from a framed one', () => {
    const framed = frame().contentWindow!

    expect(isFramed(window)).toBe(false)
    expect(isFramed(framed)).toBe(true)
  })

  it('counts a window it cannot read as framed', () => {
    const unreadable = {
      get top(): unknown {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError')
      },
      self: {}
    }

    expect(isFramed(unreadable)).toBe(true)
  })

  it('replaces a framed page with one sentence and nothing else', () => {
    const element = frame()
    const framedDocument = element.contentDocument!
    const root = framedDocument.createElement('div')
    root.id = 'root'
    framedDocument.body.append(root, framedDocument.createElement('script'))

    const refused = refuseInFrame({ window: element.contentWindow!, document: framedDocument, languages: ['en-GB'] })

    expect(refused).toBe(true)
    expect(framedDocument.body.children).toHaveLength(1)
    expect(framedDocument.body.firstElementChild?.tagName).toBe('P')
    expect(framedDocument.body.textContent).toBe(WEB_STRINGS_SOURCE.frameGuard.refused.en)
    expect(framedDocument.getElementById('root')).toBeNull()
  })

  it('speaks the browser’s language without loading anything', () => {
    const element = frame()

    refuseInFrame({ window: element.contentWindow!, document: element.contentDocument!, languages: ['fr', 'nl-BE'] })

    expect(element.contentDocument!.body.textContent).toBe(WEB_STRINGS_SOURCE.frameGuard.refused.nl)
    expect(element.contentDocument!.documentElement.lang).toBe('nl')
    expect(refusalText(['de-AT'])).toBe(WEB_STRINGS_SOURCE.frameGuard.refused.de)
    expect(refusalText([])).toBe(WEB_STRINGS_SOURCE.frameGuard.refused.en)
  })

  it('touches nothing on a top-level page', () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.append(root)

    expect(refuseInFrame()).toBe(false)
    expect(document.getElementById('root')).toBe(root)
  })

  it('reads the page’s own window by default', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'top')
    Object.defineProperty(window, 'top', { configurable: true, get: () => ({}) })

    try {
      expect(refuseInFrame()).toBe(true)
      expect(document.body.textContent).toBe(WEB_STRINGS_SOURCE.frameGuard.refused.en)
    } finally {
      if (descriptor) {
        Object.defineProperty(window, 'top', descriptor)
      }
    }
  })
})
