/**
 * The open transcript's hook on its own: the first read and the poll, one read at a time, the source that follows
 * the child, the text that stays when a tail goes quiet, a failure that leaves the text, and another child being
 * another transcript.
 */
import type { Subagent } from '@hermie/transcript'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { assistantItem } from '../../test-support/chat-fixtures'
import { useSubagentTranscript } from './use-subagent-transcript'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const child = (over: Partial<Subagent> = {}): Subagent => ({
  id: 'a',
  parentId: null,
  goal: 'Goal',
  taskIndex: 0,
  taskCount: 1,
  status: 'running',
  startedAt: 1,
  updatedAt: 2,
  filesRead: [],
  filesWritten: [],
  stream: [],
  ...over
})

const reader = (
  over: { tail?: (...args: unknown[]) => Promise<string>; stored?: (...args: unknown[]) => Promise<unknown[]> } = {}
) => ({
  tailSubagent: vi.fn(over.tail ?? (async () => 'tail')),
  childTranscript: vi.fn(over.stored ?? (async () => [assistantItem('stored')]))
})

const flush = (): Promise<void> => act(async () => void (await vi.advanceTimersByTimeAsync(0)))

describe('useSubagentTranscript', () => {
  it('reads nothing without a reader or a child', async () => {
    const none = renderHook(() => useSubagentTranscript(undefined, 'chat', child()))
    const other = reader()
    const nobody = renderHook(() => useSubagentTranscript(other as never, 'chat', undefined))

    await flush()
    expect(none.result.current).toMatchObject({ text: '', error: null })
    expect(other.tailSubagent).not.toHaveBeenCalled()
    expect(nobody.result.current.text).toBe('')
  })

  it('is loading until the first read answers, then has the text', async () => {
    const source = reader()
    const { result } = renderHook(() => useSubagentTranscript(source as never, 'chat', child()))

    expect(result.current).toMatchObject({ loading: true, text: '', source: 'tail' })
    await flush()
    expect(result.current).toMatchObject({ loading: false, text: 'tail', error: null })
    expect(source.tailSubagent).toHaveBeenCalledWith('chat', 'a')
  })

  it('reads again every three seconds while the child runs, and stops with it', async () => {
    const source = reader()
    const { rerender } = renderHook(({ current }) => useSubagentTranscript(source as never, 'chat', current), {
      initialProps: { current: child() }
    })

    await flush()
    await act(async () => void (await vi.advanceTimersByTimeAsync(6_000)))
    expect(source.tailSubagent).toHaveBeenCalledTimes(3)

    rerender({ current: child({ status: 'completed' }) })
    await flush()
    const after = source.tailSubagent.mock.calls.length

    await act(async () => void (await vi.advanceTimersByTimeAsync(9_000)))
    // A finished child with no session of its own is tailed once more, and then left alone.
    expect(source.tailSubagent.mock.calls.length).toBe(after)
  })

  it('keeps the last text when the tail goes quiet after the child has finished', async () => {
    const source = reader()
    const { result, rerender } = renderHook(({ current }) => useSubagentTranscript(source as never, 'chat', current), {
      initialProps: { current: child() }
    })

    await flush()
    expect(result.current.text).toBe('tail')

    source.tailSubagent.mockResolvedValue('')
    rerender({ current: child({ status: 'completed' }) })
    await flush()

    expect(result.current.text).toBe('tail')
  })

  it('shows an empty tail as empty while the child still runs', async () => {
    const source = reader({ tail: async () => '' })
    const { result } = renderHook(() => useSubagentTranscript(source as never, 'chat', child()))

    await flush()
    expect(result.current).toMatchObject({ text: '', loading: false })
  })

  it('reads the stored transcript of a finished child with a session, once', async () => {
    const source = reader()
    const { result } = renderHook(() =>
      useSubagentTranscript(source as never, 'chat', child({ status: 'completed', childSessionId: 'c1' }))
    )

    await flush()
    await act(async () => void (await vi.advanceTimersByTimeAsync(9_000)))

    expect(result.current).toMatchObject({ source: 'stored', text: 'stored' })
    expect(source.childTranscript).toHaveBeenCalledTimes(1)
    expect(source.childTranscript).toHaveBeenCalledWith('chat', 'c1')
    expect(source.tailSubagent).not.toHaveBeenCalled()
  })

  it('says a read failed and keeps what it had', async () => {
    const source = reader()
    const { result } = renderHook(() => useSubagentTranscript(source as never, 'chat', child()))

    await flush()
    source.tailSubagent.mockRejectedValueOnce(new Error('timed out'))
    await act(async () => void (await vi.advanceTimersByTimeAsync(3_000)))

    expect(result.current).toMatchObject({ text: 'tail', error: 'timed out' })

    await act(async () => void (await vi.advanceTimersByTimeAsync(3_000)))
    expect(result.current.error).toBeNull()
  })

  it('does not ask again while a read is in flight', async () => {
    let release: (text: string) => void = () => undefined
    const source = reader({ tail: () => new Promise<string>(resolve => (release = resolve)) })

    renderHook(() => useSubagentTranscript(source as never, 'chat', child()))
    await act(async () => void (await vi.advanceTimersByTimeAsync(9_000)))
    expect(source.tailSubagent).toHaveBeenCalledTimes(1)

    await act(async () => release('x'))
  })

  it('is another transcript for another child: nothing of the last one stays', async () => {
    const source = reader({ tail: async (_chat, id) => `text of ${String(id)}` })
    const { result, rerender } = renderHook(({ current }) => useSubagentTranscript(source as never, 'chat', current), {
      initialProps: { current: child({ id: 'a' }) }
    })

    await flush()
    expect(result.current.text).toBe('text of a')

    rerender({ current: child({ id: 'b' }) })
    expect(result.current.text).toBe('')
    await flush()
    expect(result.current.text).toBe('text of b')
  })

  it('does not set state after it was unmounted', async () => {
    let release: (text: string) => void = () => undefined
    const source = reader({ tail: () => new Promise<string>(resolve => (release = resolve)) })
    const { unmount } = renderHook(() => useSubagentTranscript(source as never, 'chat', child()))

    unmount()
    await act(async () => release('late'))
    // Nothing to assert beyond no warning and no throw: the read ended into a cancelled effect.
    expect(source.tailSubagent).toHaveBeenCalledTimes(1)
  })
})
