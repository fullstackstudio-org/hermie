import { describe, expect, it, vi } from 'vitest'

import { onDemandPart } from './on-demand'

interface Part {
  run(trace: string[]): Promise<string>
}

/** A part whose call writes to `trace` before its first `await`, as a method body does. */
const part: Part = {
  async run(trace) {
    trace.push('ran')
    await Promise.resolve()

    return 'done'
  }
}

describe('onDemandPart', () => {
  it('runs a call in the same tick once the part is there, and never loads it', async () => {
    const load = vi.fn(() => Promise.resolve())
    const onDemand = onDemandPart<Part>(load)
    const trace: string[] = []

    onDemand.provide(part)

    const result = onDemand.use(p => p.run(trace))

    // What the call does before its first `await` has happened when `use` returns, as it did in the method.
    expect(trace).toEqual(['ran'])
    await expect(result).resolves.toBe('done')
    expect(load).not.toHaveBeenCalled()
  })

  it('loads the part for a call that comes first, once for calls that come together', async () => {
    let provide: () => void = () => undefined
    const load = vi.fn(
      () =>
        new Promise<void>(resolve => {
          provide = () => {
            onDemand.provide(part)
            resolve()
          }
        })
    )
    const onDemand = onDemandPart<Part>(load)
    const trace: string[] = []

    const first = onDemand.use(p => p.run(trace))
    const second = onDemand.use(p => p.run(trace))

    expect(trace).toEqual([])
    expect(load).toHaveBeenCalledTimes(1)

    provide()

    await expect(Promise.all([first, second])).resolves.toEqual(['done', 'done'])
    expect(trace).toEqual(['ran', 'ran'])
  })

  it('rejects the calls of a load that failed, and loads again for the next one', async () => {
    const load = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockImplementationOnce(() => {
        onDemand.provide(part)

        return Promise.resolve()
      })
    const onDemand = onDemandPart<Part>(load)

    await expect(onDemand.use(p => p.run([]))).rejects.toThrow('chunk failed')
    await expect(onDemand.use(p => p.run([]))).resolves.toBe('done')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('says so when the module loaded without providing its part, and tries again next time', async () => {
    const load = vi.fn(() => Promise.resolve())
    const onDemand = onDemandPart<Part>(load)

    await expect(onDemand.use(p => p.run([]))).rejects.toThrow('did not provide its part')
    await expect(onDemand.use(p => p.run([]))).rejects.toThrow('did not provide its part')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
