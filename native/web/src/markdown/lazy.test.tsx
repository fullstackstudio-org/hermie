import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { lazyModule, useLazyModule, type LazyModule } from './lazy'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

function Probe({ lazy }: { lazy: LazyModule<{ name: string }> }) {
  const module = useLazyModule(lazy)

  return <p>{module ? module.name : 'fallback'}</p>
}

describe('lazyModule', () => {
  it('fetches once, however many ask, and hands every one the same module', async () => {
    const importer = vi.fn(() => Promise.resolve({ name: 'loaded' }))
    const lazy = lazyModule(importer)

    expect(lazy.current()).toBeUndefined()

    const [first, second] = await Promise.all([lazy.load(), lazy.load()])

    expect(importer).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(lazy.current()).toBe(first)
    await lazy.load()
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it('asks again after a fetch that failed', async () => {
    const importer = vi
      .fn<() => Promise<{ name: string }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ name: 'loaded' })
    const lazy = lazyModule(importer)

    await expect(lazy.load()).rejects.toThrow('offline')
    expect(lazy.current()).toBeUndefined()
    await expect(lazy.load()).resolves.toEqual({ name: 'loaded' })
    expect(importer).toHaveBeenCalledTimes(2)
  })
})

describe('useLazyModule', () => {
  it('shows the fallback, asks for the module on mount, and draws it once it is there', async () => {
    const gate = deferred<{ name: string }>()
    const importer = vi.fn(() => gate.promise)
    const lazy = lazyModule(importer)

    render(<Probe lazy={lazy} />)

    expect(screen.getByText('fallback')).toBeTruthy()
    expect(importer).toHaveBeenCalledTimes(1)

    await act(async () => {
      gate.resolve({ name: 'loaded' })
      await gate.promise
    })

    expect(screen.getByText('loaded')).toBeTruthy()
  })

  it('draws a module that is already there on the first render, without asking again', async () => {
    const importer = vi.fn(() => Promise.resolve({ name: 'loaded' }))
    const lazy = lazyModule(importer)

    await lazy.load()
    render(<Probe lazy={lazy} />)

    expect(screen.getByText('loaded')).toBeTruthy()
    expect(importer).toHaveBeenCalledTimes(1)
  })

  it('keeps the fallback when the fetch fails, and the next mount asks again', async () => {
    const importer = vi
      .fn<() => Promise<{ name: string }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ name: 'loaded' })
    const lazy = lazyModule(importer)
    const first = render(<Probe lazy={lazy} />)

    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText('fallback')).toBeTruthy()
    first.unmount()

    render(<Probe lazy={lazy} />)
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByText('loaded')).toBeTruthy()
    expect(importer).toHaveBeenCalledTimes(2)
  })
})
