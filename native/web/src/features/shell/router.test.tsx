import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { createHashRouter } from '../../platform/hash-router'
import { chatHref, formatRoute, HOME, parseRoute, type Route, useRoute } from './router'

describe('parseRoute', () => {
  it.each<[string, Route]>([
    ['', HOME],
    ['#', HOME],
    ['#/', HOME],
    ['#/chat/researcher', { name: 'chat', bot: 'researcher' }],
    ['#/chat/researcher/', { name: 'chat', bot: 'researcher' }],
    ['#/chat/researcher/s/20260101_abc', { name: 'chat', bot: 'researcher', session: '20260101_abc' }],
    ['#/settings', { name: 'settings' }],
    ['#/settings/', { name: 'settings' }],
    ['#/settings/notifications', { name: 'settings', section: 'notifications' }],
    ['#/settings/gateway-info', { name: 'settings', section: 'gateway-info' }]
  ])('reads %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route)
  })

  it('decodes a name that is not a plain word', () => {
    expect(parseRoute('#/chat/r%C3%A9sum%C3%A9%20bot')).toEqual({ name: 'chat', bot: 'résumé bot' })
    expect(parseRoute('#/chat/a%2Fb/s/c%2Fd')).toEqual({ name: 'chat', bot: 'a/b', session: 'c/d' })
  })

  it.each([
    '#/nonsense',
    '#/chat',
    '#/chat/',
    '#/chat//s/x',
    '#/chat/a/b',
    '#/chat/a/s',
    '#/chat/a/s/',
    '#/chat/a/s/b/c',
    '#/chat/a/x/b',
    '#/chat/%E0%A4%A',
    '#/settings/Not-Lower',
    '#/settings/a/b',
    '#/settings/1x',
    '#chat/a',
    '/chat/a',
    '#//',
    '#/chat/a//'
  ])('says %j is unknown', hash => {
    expect(parseRoute(hash)).toBeNull()
  })

  it('refuses a segment longer than a name can be', () => {
    expect(parseRoute(`#/chat/${'a'.repeat(300)}`)).toBeNull()
    expect(parseRoute(`#/chat/${'a'.repeat(256)}`)).not.toBeNull()
  })
})

describe('formatRoute', () => {
  const routes: Route[] = [
    HOME,
    { name: 'chat', bot: 'researcher' },
    { name: 'chat', bot: 'résumé bot' },
    { name: 'chat', bot: 'a/b?c#d', session: 'x y/z' },
    { name: 'settings' },
    { name: 'settings', section: 'notifications' }
  ]

  it('is the inverse of parseRoute for every route', () => {
    for (const route of routes) {
      expect(parseRoute(formatRoute(route)), formatRoute(route)).toEqual(route)
    }
  })

  it('writes a fragment that stays one fragment: nothing in a name can add a path or a query', () => {
    expect(formatRoute({ name: 'chat', bot: 'a/b?c#d' })).toBe('#/chat/a%2Fb%3Fc%23d')
    expect(chatHref('writer')).toBe('#/chat/writer')
  })
})

function Probe({ router }: { router: ReturnType<typeof createHashRouter> }) {
  const route = useRoute(router)

  return <p data-testid="route">{formatRoute(route)}</p>
}

describe('useRoute', () => {
  it('follows the address', () => {
    const router = createHashRouter(null)

    router.navigate('#/chat/writer')
    render(<Probe router={router} />)

    expect(screen.getByTestId('route').textContent).toBe('#/chat/writer')

    act(() => router.navigate('#/settings/notifications'))

    expect(screen.getByTestId('route').textContent).toBe('#/settings/notifications')
  })

  it('reads an empty address as home and leaves it alone', () => {
    const router = createHashRouter(null)

    render(<Probe router={router} />)

    expect(screen.getByTestId('route').textContent).toBe('#/')
    expect(router.current()).toBe('')
  })

  it('sends an unknown route to #/ by rewriting it, never adding an entry', () => {
    const router = createHashRouter(null)
    const written: string[] = []
    const replace = router.replace.bind(router)

    router.replace = hash => {
      written.push(hash)
      replace(hash)
    }
    router.navigate('#/no/such/place')
    render(<Probe router={router} />)

    expect(written).toEqual(['#/'])
    expect(router.current()).toBe('#/')
    expect(screen.getByTestId('route').textContent).toBe('#/')
  })

  it('sends a route that becomes unknown while open to #/', () => {
    const router = createHashRouter(null)

    router.navigate('#/chat/writer')
    render(<Probe router={router} />)
    act(() => router.navigate('#/chat/'))

    expect(router.current()).toBe('#/')
    expect(screen.getByTestId('route').textContent).toBe('#/')
  })

  it('stops listening when it unmounts', () => {
    const router = createHashRouter(null)
    const { unmount } = render(<Probe router={router} />)

    unmount()

    expect(() => act(() => router.navigate('#/chat/writer'))).not.toThrow()
  })
})
