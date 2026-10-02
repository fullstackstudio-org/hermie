import { afterEach, describe, expect, it, vi } from 'vitest'

import { createVisibilityWatcher, type Visibility, visibilityWatcher } from './visibility'

function environment(initial: 'visible' | 'hidden') {
  const document = Object.assign(new EventTarget(), { visibilityState: initial as string })
  const window = new EventTarget()

  return { document, window }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the visibility watcher', () => {
  it('follows visibilitychange, and reports a change once', () => {
    const env = environment('visible')
    const watcher = createVisibilityWatcher(env as never)
    const seen: Visibility[] = []
    const unsubscribe = watcher.subscribe(next => seen.push(next))

    env.document.visibilityState = 'hidden'
    env.document.dispatchEvent(new Event('visibilitychange'))
    env.document.dispatchEvent(new Event('visibilitychange'))
    expect(watcher.current()).toBe('hidden')

    env.document.visibilityState = 'visible'
    env.document.dispatchEvent(new Event('visibilitychange'))

    expect(seen).toEqual(['hidden', 'visible'])

    unsubscribe()
    env.document.visibilityState = 'hidden'
    env.document.dispatchEvent(new Event('visibilitychange'))
    expect(seen).toHaveLength(2)
  })

  it('reads pagehide as hidden even when visibilitychange never came, and pageshow as back', () => {
    const env = environment('visible')
    const seen: Visibility[] = []
    createVisibilityWatcher(env as never).subscribe(next => seen.push(next))

    env.window.dispatchEvent(new Event('pagehide'))
    env.window.dispatchEvent(new Event('pageshow'))

    expect(seen).toEqual(['hidden', 'visible'])
  })

  it('is visible and silent where there is no document', () => {
    const watcher = createVisibilityWatcher(null)

    expect(watcher.current()).toBe('visible')
    expect(watcher.subscribe(() => {})).toBeTypeOf('function')
  })

  it('watches the page by default', () => {
    const seen: Visibility[] = []
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const unsubscribe = visibilityWatcher.subscribe(next => seen.push(next))

    state.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    unsubscribe()

    expect(seen).toEqual(['visible', 'hidden'])
  })
})
