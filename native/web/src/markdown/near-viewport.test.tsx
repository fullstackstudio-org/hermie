/**
 * A listing is coloured once it comes near the visible area, and not before:
 * a long history keeps its far listings as one text node each.
 */
import { resetBlockCache } from '@hermie/markdown'
import { act, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { highlightRenderer } from './lazy'
import { Markdown } from './Markdown'
import { ScrollRootContext } from './near-viewport'

interface FakeObserver {
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit | undefined
  targets: Set<Element>
}

const observers: FakeObserver[] = []

class FakeIntersectionObserver {
  readonly record: FakeObserver

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = { callback, options, targets: new Set() }
    observers.push(this.record)
  }

  observe(target: Element): void {
    this.record.targets.add(target)
  }

  unobserve(target: Element): void {
    this.record.targets.delete(target)
  }

  disconnect(): void {
    this.record.targets.clear()
  }
}

/** Reports every watched element of every observer as intersecting. */
function bringNear(): void {
  for (const observer of observers) {
    const entries = [...observer.targets].map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry)

    act(() => observer.callback(entries, observer as unknown as IntersectionObserver))
  }
}

const LISTING = '```ts\nconst a = 1\n```'

beforeAll(async () => {
  await highlightRenderer.load()
})

beforeEach(() => {
  resetBlockCache()
  observers.length = 0
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (Element.prototype as Partial<{ checkVisibility: unknown }>).checkVisibility
})

describe('colouring near the reader', () => {
  it('draws a far listing plain, and colours it when it comes near', () => {
    const { container } = render(<Markdown text={LISTING} />)

    expect(container.querySelector('.md-hl')).toBeNull()
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1')
    expect(observers).toHaveLength(1)
    expect(observers[0]?.targets.size).toBe(1)

    bringNear()

    expect(container.querySelector('.md-hl-keyword')?.textContent).toBe('const')
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1')
    // Coloured for good: it is no longer watched.
    expect(observers[0]?.targets.size).toBe(0)
  })

  it('watches every listing with one observer, a viewport ahead, against the scroll container it is in', () => {
    const root = document.createElement('div')
    const ref = createRef<Element>() as { current: Element | null }

    ref.current = root
    render(
      <ScrollRootContext.Provider value={ref}>
        <Markdown text={[LISTING, LISTING, LISTING].join('\n\n')} />
      </ScrollRootContext.Provider>
    )

    expect(observers).toHaveLength(1)
    expect(observers[0]?.targets.size).toBe(3)
    expect(observers[0]?.options?.root).toBe(root)
    expect(observers[0]?.options?.rootMargin).toBe('100% 0px 100% 0px')
  })

  it('colours a listing that is already in view on its first frame, without waiting for the observer', () => {
    Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, value: () => true })

    const { container } = render(<Markdown text={LISTING} />)

    // jsdom lays nothing out: every box is at 0,0, inside the viewport.
    expect(container.querySelector('.md-hl-keyword')?.textContent).toBe('const')
    expect(observers[0]?.targets.size ?? 0).toBe(0)
  })

  it('leaves a listing the browser skips (content-visibility) to the observer, without reading its geometry', () => {
    Object.defineProperty(Element.prototype, 'checkVisibility', { configurable: true, value: () => false })
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')

    const { container } = render(<Markdown text={LISTING} />)

    expect(container.querySelector('.md-hl')).toBeNull()
    expect(rect).not.toHaveBeenCalled()
    rect.mockRestore()
  })

  it('never watches a listing it has nothing to colour in', () => {
    render(<Markdown text={'```\nplain\n```\n\n$$\nx\n$$'} />)

    expect(observers.flatMap(observer => [...observer.targets])).toHaveLength(0)
  })
})
