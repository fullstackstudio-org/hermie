import { describe, expect, it } from 'vitest'

import { createHashRouter, type HashRouterEnvironment, pageHashRouter } from './hash-router'

/** A location whose `hash` setter fires `hashchange` the way a browser does. */
function environment(initial = '') {
  const window = new EventTarget()
  const calls: { replaced: string[] } = { replaced: [] }
  const location = {
    pathname: '/dashboard-plugins/hermie/app/index.html',
    search: '?x=1',
    _hash: initial,
    get hash() {
      return this._hash
    },
    set hash(value: string) {
      this._hash = value.startsWith('#') ? value : `#${value}`
      window.dispatchEvent(new Event('hashchange'))
    }
  }
  const history = {
    state: { kept: true } as unknown,
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      calls.replaced.push(String(url))
      location._hash = String(url).slice(String(url).indexOf('#'))
      this.state = state
    }
  }

  return { env: { location, history, window } as unknown as HashRouterEnvironment, window, location, history, calls }
}

describe('the hash router seam', () => {
  it('reads the fragment as the address holds it', () => {
    expect(createHashRouter(environment('#/chat/a').env).current()).toBe('#/chat/a')
    expect(createHashRouter(environment().env).current()).toBe('')
  })

  it('hears hashchange, and stops hearing after the unsubscribe', () => {
    const { env, window, location } = environment('#/')
    const router = createHashRouter(env)
    const seen: string[] = []
    const stop = router.subscribe(hash => seen.push(hash))

    location._hash = '#/chat/a'
    window.dispatchEvent(new Event('hashchange'))
    stop()
    location._hash = '#/chat/b'
    window.dispatchEvent(new Event('hashchange'))

    expect(seen).toEqual(['#/chat/a'])
  })

  it('removes its window listener when the last subscriber goes', () => {
    const { env, window } = environment()
    const added: string[] = []
    const removed: string[] = []
    const spied = {
      ...env,
      window: {
        addEventListener: (type: string, listener: EventListener) => {
          added.push(type)
          window.addEventListener(type, listener)
        },
        removeEventListener: (type: string, listener: EventListener) => {
          removed.push(type)
          window.removeEventListener(type, listener)
        }
      }
    } as unknown as HashRouterEnvironment
    const router = createHashRouter(spied)
    const stopA = router.subscribe(() => {})
    const stopB = router.subscribe(() => {})

    expect(added).toEqual(['hashchange'])
    stopA()
    expect(removed).toEqual([])
    stopB()
    expect(removed).toEqual(['hashchange'])
  })

  it('navigates by setting the fragment, and a repeat is not a second entry', () => {
    const { env, location } = environment('#/')
    const router = createHashRouter(env)
    const seen: string[] = []

    router.subscribe(hash => seen.push(hash))
    router.navigate('#/chat/a')
    router.navigate('#/chat/a')

    expect(location.hash).toBe('#/chat/a')
    expect(seen).toEqual(['#/chat/a'])
  })

  it('replaces in place, keeping the path, the query and the history state, and tells its listeners', () => {
    const { env, history, calls } = environment('#/nonsense')
    const router = createHashRouter(env)
    const seen: string[] = []

    router.subscribe(hash => seen.push(hash))
    router.replace('#/')

    expect(calls.replaced).toEqual(['/dashboard-plugins/hermie/app/index.html?x=1#/'])
    expect(history.state).toEqual({ kept: true })
    expect(router.current()).toBe('#/')
    expect(seen).toEqual(['#/'])
  })

  it('works with no window at all: the fragment is kept in memory', () => {
    const router = createHashRouter(null)
    const seen: string[] = []

    router.subscribe(hash => seen.push(hash))
    router.navigate('#/chat/a')
    router.replace('#/')

    expect(router.current()).toBe('#/')
    expect(seen).toEqual(['#/chat/a', '#/'])
  })

  it('the page’s own router reads the page’s fragment', () => {
    window.history.replaceState(null, '', '#/chat/page')

    expect(pageHashRouter.current()).toBe('#/chat/page')

    window.history.replaceState(null, '', window.location.pathname)
  })
})
