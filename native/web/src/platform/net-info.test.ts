import { describe, expect, it } from 'vitest'

import { createNetworkWatcher, networkWatcher } from './net-info'

function environment(onLine: boolean | undefined) {
  const target = new EventTarget()
  const navigator = { onLine }

  return { target, navigator }
}

describe('the network watcher', () => {
  it('reports at once, then on online and offline', () => {
    const env = environment(true)
    const seen: boolean[] = []
    const unsubscribe = createNetworkWatcher(env).subscribe(online => seen.push(online))

    env.navigator.onLine = false
    env.target.dispatchEvent(new Event('offline'))
    env.navigator.onLine = true
    env.target.dispatchEvent(new Event('online'))

    expect(seen).toEqual([true, false, true])

    unsubscribe()
    env.target.dispatchEvent(new Event('offline'))
    expect(seen).toHaveLength(3)
  })

  it('counts an unknown answer as online, so a dial is never sat out on a guess', () => {
    const seen: boolean[] = []
    createNetworkWatcher(environment(undefined)).subscribe(online => seen.push(online))

    expect(seen).toEqual([true])
  })

  it('says online and nothing more where there is no window', () => {
    const seen: boolean[] = []
    createNetworkWatcher(null).subscribe(online => seen.push(online))

    expect(seen).toEqual([true])
  })

  it('never claims to know the kind of link', async () => {
    expect(await networkWatcher.kind()).toBe('unknown')
  })

  it('listens to the page by default', () => {
    const seen: boolean[] = []
    const unsubscribe = networkWatcher.subscribe(online => seen.push(online))

    window.dispatchEvent(new Event('online'))
    unsubscribe()

    expect(seen.length).toBe(2)
  })
})
