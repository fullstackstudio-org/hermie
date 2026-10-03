import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNoticesStore } from '../state/notices'
import type { SessionSignal } from './chat-controller'
import { DEFAULT_TTL_MS, MAX_NOTICES, noticeLifetime, NoticesModel, NOTICE_TEXT_LIMIT } from './notices'

function setup() {
  const listeners = new Set<(signal: SessionSignal) => void>()
  const store = createNoticesStore()
  const model = new NoticesModel({
    store,
    watchSignals: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  })
  const say = (signal: SessionSignal): void => {
    for (const listener of listeners) {
      listener(signal)
    }
  }
  const show = (payload: Record<string, unknown>, chat?: string): void => say({ kind: 'notice.show', chat, payload })
  const shown = () => store.getState().notices.map(notice => [notice.id, notice.text, notice.level, notice.chat])

  model.start()

  return { model, store, say, show, shown, listeners }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the gateway’s notices', () => {
  it('shows a notice under its key, with its level and the chat that carried it', () => {
    const { show, shown } = setup()

    show({ text: 'Credits are low', level: 'warn', kind: 'sticky', key: 'credits' }, 'researcher')
    show({ text: 'Starting the agent', level: 'info', kind: 'agent', id: 'boot-1' })

    expect(shown()).toEqual([
      ['credits', 'Credits are low', 'warn', 'researcher'],
      ['boot-1', 'Starting the agent', 'info', undefined]
    ])
  })

  it('replaces a notice with the same key in place, and a clear withdraws it', () => {
    const { show, say, shown } = setup()

    show({ text: 'One', level: 'info', kind: 'sticky', key: 'a' })
    show({ text: 'Two', level: 'info', kind: 'sticky', key: 'b' })
    show({ text: 'One, again', level: 'error', kind: 'sticky', key: 'a' })

    expect(shown().map(([id, text, level]) => [id, text, level])).toEqual([
      ['a', 'One, again', 'error'],
      ['b', 'Two', 'info']
    ])

    say({ kind: 'notice.clear', payload: { key: 'a' } })
    say({ kind: 'notice.clear', payload: { key: '' } })

    expect(shown().map(([id]) => id)).toEqual(['b'])
  })

  it('names a notice without a key or an id itself, so two of them are two', () => {
    const { show, shown } = setup()

    show({ text: 'First', level: 'info', kind: 'sticky' })
    show({ text: 'Second', level: 'info', kind: 'sticky', key: '   ' })

    expect(shown().map(([, text]) => text)).toEqual(['First', 'Second'])
    expect(new Set(shown().map(([id]) => id)).size).toBe(2)
  })

  it('lets a ttl notice go after its own lifetime, or the default, and keeps a sticky one', () => {
    const { show, shown } = setup()

    show({ text: 'Quick', level: 'info', kind: 'ttl', ttl_ms: 2_000, key: 'quick' })
    show({ text: 'Default', level: 'info', kind: 'ttl', key: 'default' })
    show({ text: 'Stays', level: 'info', kind: 'sticky', key: 'stays' })

    vi.advanceTimersByTime(2_000)
    expect(shown().map(([id]) => id)).toEqual(['default', 'stays'])

    vi.advanceTimersByTime(DEFAULT_TTL_MS)
    expect(shown().map(([id]) => id)).toEqual(['stays'])
  })

  it('restarts the lifetime of a notice shown again', () => {
    const { show, shown } = setup()

    show({ text: 'Tick', level: 'info', kind: 'ttl', ttl_ms: 1_000, key: 'tick' })
    vi.advanceTimersByTime(800)
    show({ text: 'Tock', level: 'info', kind: 'ttl', ttl_ms: 1_000, key: 'tick' })
    vi.advanceTimersByTime(800)

    expect(shown().map(([, text]) => text)).toEqual(['Tock'])

    vi.advanceTimersByTime(200)
    expect(shown()).toEqual([])
  })

  it('keeps at most the newest notices, dropping the oldest first', () => {
    const { show, shown } = setup()

    for (let index = 0; index <= MAX_NOTICES; index += 1) {
      show({ text: `Notice ${index}`, level: 'info', kind: 'sticky', key: `n${index}` })
    }

    expect(shown()).toHaveLength(MAX_NOTICES)
    expect(shown()[0]?.[0]).toBe('n1')
  })

  it('shows the text as plain, bounded text, and nothing for a notice with none', () => {
    const { show, shown } = setup()

    show({ text: '‮evil‬ line\u0007 one\n\n\nline two', level: 'loud', kind: 'sticky', key: 'x' })
    show({ text: '​\u0000 ', level: 'info', kind: 'sticky', key: 'empty' })
    show({ text: 'x'.repeat(NOTICE_TEXT_LIMIT * 2), level: 'info', kind: 'sticky', key: 'long' })
    show({ level: 'info', kind: 'sticky', key: 'none' })

    const [first, long] = shown()

    expect(first).toEqual(['x', 'evil line one\nline two', 'info', undefined])
    // The limit, and the ellipsis that says something was cut.
    expect([...String(long?.[1])].length).toBeLessThanOrEqual(NOTICE_TEXT_LIMIT + 1)
    expect(String(long?.[1]).endsWith('…')).toBe(true)
    expect(shown()).toHaveLength(2)
  })

  it('takes a notice away when the person closes it, and everything when it stops', () => {
    const { model, show, shown, listeners } = setup()

    show({ text: 'One', level: 'info', kind: 'ttl', key: 'a' })
    show({ text: 'Two', level: 'info', kind: 'sticky', key: 'b' })
    model.dismiss('a')

    expect(shown().map(([id]) => id)).toEqual(['b'])

    model.stop()

    expect(shown()).toEqual([])
    expect(listeners.size).toBe(0)
    // A timer of a notice that is gone does nothing.
    vi.advanceTimersByTime(DEFAULT_TTL_MS)
    expect(shown()).toEqual([])
  })

  it('reads a lifetime defensively', () => {
    expect(noticeLifetime('sticky', 500)).toBe(500)
    expect(noticeLifetime('ttl', 0)).toBe(DEFAULT_TTL_MS)
    expect(noticeLifetime('ttl', -1)).toBe(DEFAULT_TTL_MS)
    expect(noticeLifetime('agent', 'soon')).toBeUndefined()
    expect(noticeLifetime(undefined, Number.NaN)).toBeUndefined()
  })
})
