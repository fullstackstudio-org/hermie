/**
 * The browser's paste seam: what a `paste` event on the composer's field turns
 * into, and what it leaves alone.
 *
 * The listener itself is bound to a React Native Web node, which the native
 * test renderer does not produce — so, as `file-drop-web.test.ts` does for
 * `drop`, what is asserted here is the logic the listener runs against a
 * hand-built `ClipboardEvent`-shaped object.
 */
import { attachPasteListener, filesFromClipboard } from '../src/platform/composer-paste.web'

/** A `DataTransfer` as far as this module reads one. */
const clipboardData = (files: File[] = [], itemsOnly: File[] = []) =>
  ({
    files: {
      length: files.length,
      item: (index: number) => files[index] ?? null
    },
    items: [
      ...files.map(() => ({ kind: 'file', getAsFile: () => null })),
      ...itemsOnly.map(file => ({ kind: 'file', getAsFile: () => file })),
      { kind: 'string', getAsFile: () => null }
    ]
  }) as unknown as DataTransfer

const file = (name: string, type = 'image/png', size = 2048) => {
  const made = new File(['x'], name, { type })

  Object.defineProperty(made, 'size', { value: size })

  return made
}

beforeAll(() => {
  // `filesFromClipboard` mints object URLs; jsdom has no implementation and
  // this environment (see `file-drop-web.test.ts`) has none either.
  Object.defineProperty(URL, 'createObjectURL', { value: (f: File) => `blob:${f.name}`, writable: true })
})

describe('filesFromClipboard', () => {
  it('reads one pasted image', () => {
    const files = filesFromClipboard(clipboardData([file('image.png')]))

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ mimeType: 'image/png', name: 'image.png', size: 2048 })
  })

  it('reads every file in a multi-file paste', () => {
    const files = filesFromClipboard(clipboardData([file('a.png'), file('b.pdf', 'application/pdf')]))

    expect(files).toHaveLength(2)
    expect(files.map(f => f.name)).toEqual(['a.png', 'b.pdf'])
  })

  it('has nothing to report for a text-only paste', () => {
    expect(filesFromClipboard(clipboardData())).toEqual([])
    expect(filesFromClipboard(null)).toEqual([])
  })

  it('falls back to a file-kind item that `.files` left out', () => {
    // Safari has historically put a pasted screenshot only in `.items`, not in
    // `.files` — the whole reason this module reads both.
    const files = filesFromClipboard(clipboardData([], [file('shot.png')]))

    expect(files).toHaveLength(1)
    expect(files[0]?.name).toBe('shot.png')
  })

  it('never reports the same file twice when both lists carry it', () => {
    const only = file('a.png')
    const data = {
      files: { length: 1, item: () => only },
      items: [{ kind: 'file', getAsFile: () => only }]
    } as unknown as DataTransfer

    expect(filesFromClipboard(data)).toHaveLength(1)
  })

  it('carries the File itself, which is the only thing a browser can upload', () => {
    const [pasted] = filesFromClipboard(clipboardData([file('a.png')]))

    expect(pasted?.body).toBeInstanceOf(File)
  })
})

describe('attachPasteListener', () => {
  function fakeNode() {
    const listeners = new Map<string, (event: unknown) => void>()

    return {
      addEventListener: jest.fn((type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener)
      }),
      removeEventListener: jest.fn(),
      fire: (event: unknown) => listeners.get('paste')?.(event)
    }
  }

  it('takes a pasted image and prevents the default paste', () => {
    const node = fakeNode()
    const onFiles = jest.fn()

    attachPasteListener(node, onFiles)

    const preventDefault = jest.fn()

    node.fire({ clipboardData: clipboardData([file('image.png')]), preventDefault })

    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0]?.[0]).toMatchObject([{ mimeType: 'image/png', name: 'image.png' }])
    expect(preventDefault).toHaveBeenCalled()
  })

  it('takes every file in a multi-file paste, in order', () => {
    const node = fakeNode()
    const onFiles = jest.fn()

    attachPasteListener(node, onFiles)
    node.fire({
      clipboardData: clipboardData([file('a.png'), file('b.pdf', 'application/pdf')]),
      preventDefault: jest.fn()
    })

    expect(onFiles.mock.calls[0]?.[0]).toHaveLength(2)
  })

  it('leaves a text-only paste alone: no attachment, and the default runs', () => {
    const node = fakeNode()
    const onFiles = jest.fn()

    attachPasteListener(node, onFiles)

    const preventDefault = jest.fn()

    node.fire({ clipboardData: clipboardData(), preventDefault })

    expect(onFiles).not.toHaveBeenCalled()
    // Nothing was taken, so the browser's own paste — which puts the text in the
    // field — must be left to run.
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('answers a harmless unsubscribe for a node with no DOM listener API', () => {
    const detach = attachPasteListener(null, jest.fn())

    expect(() => detach()).not.toThrow()
  })

  it('removes its own listener and nothing else on cleanup', () => {
    const node = fakeNode()
    const detach = attachPasteListener(node, jest.fn())

    detach()

    expect(node.removeEventListener).toHaveBeenCalledWith('paste', expect.any(Function))
  })
})
