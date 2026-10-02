import { describe, expect, it } from 'vitest'

import { APP_DOCUMENT_PATH, deriveBasePath, pageBasePath, storageNamespace } from './base-path'

const origin = 'https://gateway.example.com'

describe('the base path', () => {
  it('is the origin alone when the gateway is at the root', () => {
    expect(deriveBasePath({ origin, pathname: '/dashboard-plugins/hermie/app/index.html' })).toEqual({
      ok: true,
      prefix: '',
      baseUrl: 'https://gateway.example.com',
      appPath: '/dashboard-plugins/hermie/app/index.html',
      namespace: '/'
    })
  })

  it('keeps a path prefix a reverse proxy publishes the gateway under', () => {
    expect(deriveBasePath({ origin, pathname: '/hermes/dashboard-plugins/hermie/app/index.html' })).toEqual({
      ok: true,
      prefix: '/hermes',
      baseUrl: 'https://gateway.example.com/hermes',
      appPath: '/hermes/dashboard-plugins/hermie/app/index.html',
      namespace: '/hermes'
    })

    const deep = deriveBasePath({
      origin: 'http://127.0.0.1:9119',
      pathname: '/a/b/dashboard-plugins/hermie/app/index.html'
    })
    expect(deep).toMatchObject({ ok: true, prefix: '/a/b', baseUrl: 'http://127.0.0.1:9119/a/b' })
  })

  it('accepts the directory without index.html, for an alias', () => {
    for (const pathname of ['/dashboard-plugins/hermie/app/', '/dashboard-plugins/hermie/app']) {
      expect(deriveBasePath({ origin, pathname }), pathname).toMatchObject({ ok: true, prefix: '', appPath: pathname })
    }

    expect(deriveBasePath({ origin, pathname: '/hermes/dashboard-plugins/hermie/app/' })).toMatchObject({
      ok: true,
      prefix: '/hermes'
    })
  })

  it('is a configuration error anywhere else, naming the path it expected', () => {
    for (const pathname of [
      '/',
      '/index.html',
      '/dashboard-plugins/hermie/index.html',
      '/dashboard-plugins/other/app/index.html',
      '/dashboard-plugins/hermie/app/index.htm',
      '/dashboard-plugins/hermie/app/assets/index.html',
      '/notdashboard-plugins/hermie/app/index.html',
      '//evil.example/dashboard-plugins/hermie/app/index.html'
    ]) {
      expect(deriveBasePath({ origin, pathname }), pathname).toEqual({
        ok: false,
        expected: APP_DOCUMENT_PATH,
        pathname
      })
    }
  })

  it('refuses an origin that has no gateway behind it', () => {
    for (const bad of ['null', 'file://', '']) {
      expect(deriveBasePath({ origin: bad, pathname: APP_DOCUMENT_PATH }).ok, bad).toBe(false)
    }
  })

  it('drops a trailing slash from the prefix, so URLs built from it have one slash', () => {
    expect(deriveBasePath({ origin, pathname: '/hermes//dashboard-plugins/hermie/app/index.html' })).toMatchObject({
      ok: true,
      prefix: '/hermes',
      baseUrl: 'https://gateway.example.com/hermes'
    })
  })

  it('keeps colons out of the storage namespace', () => {
    expect(storageNamespace('')).toBe('/')
    expect(storageNamespace('/a:b')).toBe('/a%3Ab')
  })

  it('reads the page’s own location', () => {
    window.history.replaceState(null, '', '/hermes/dashboard-plugins/hermie/app/index.html#/chat/researcher')

    try {
      expect(pageBasePath()).toMatchObject({ ok: true, prefix: '/hermes', baseUrl: `${window.location.origin}/hermes` })
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })
})
