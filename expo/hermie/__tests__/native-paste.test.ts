/**
 * Reading the general pasteboard for an attachment, off the Mac's ⌘V.
 *
 * The shortcut itself is `desktop-shortcuts.ts`'s concern; what is under test
 * here is the second half — normalising whatever `HermieMac.readPasteboardAttachment`
 * hands back, and answering an empty list rather than throwing when there is no
 * module, or when the call itself fails.
 */
import { readPasteboardAttachment } from '../src/platform/native-paste'

const mockReadPasteboardAttachment = jest.fn<Promise<unknown>, []>()

/**
 * Read through a getter, not captured.
 *
 * `native-paste.ts` asks the registry for the module ONCE, at its own module
 * load, and Babel hoists both that load and this `jest.mock` above the `const`
 * above — see `quick-look.test.ts` for the same trap.
 */
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => ({
    get readPasteboardAttachment() {
      return mockReadPasteboardAttachment
    }
  })
}))

beforeEach(() => {
  mockReadPasteboardAttachment.mockReset()
})

/*
  `HAS_NATIVE_PASTEBOARD` is computed ONCE, at this module's own import — the same
  shape `runs-on-mac.ts`'s `RUNS_ON_MAC` is, and for the same reason a caller reads
  it as a constant rather than a function. That is exactly what a getter on the
  mock above cannot help with: the getter is dereferenced the one time this file
  is loaded, before `beforeEach` has run and before any test gets to decide what
  it should answer. Testing that it becomes `true` would mean asserting an
  import-order accident rather than behaviour — `runs-on-mac.ts` documents the
  same limitation and takes the same way out — so what IS tested here is what
  every caller actually reaches for: `composer.test.tsx` and `chat-screen.test.tsx`
  mock this whole module and flip a `get HAS_NATIVE_PASTEBOARD()` themselves.
*/

describe('readPasteboardAttachment', () => {
  it('normalises a pasted image the same way a dropped file is', async () => {
    mockReadPasteboardAttachment.mockResolvedValue([
      {
        uri: 'file:///tmp/hermie-paste/1/pasted-image.png',
        name: 'pasted-image.png',
        size: 4096,
        mimeType: 'image/png'
      }
    ])

    const files = await readPasteboardAttachment()

    expect(files).toEqual([
      {
        uri: 'file:///tmp/hermie-paste/1/pasted-image.png',
        name: 'pasted-image.png',
        size: 4096,
        mimeType: 'image/png'
      }
    ])
  })

  it('normalises several attachments from one paste', async () => {
    mockReadPasteboardAttachment.mockResolvedValue([
      { uri: 'file:///tmp/a.png', name: 'a.png', size: 10, mimeType: 'image/png' },
      { uri: 'file:///tmp/b.pdf', name: 'b.pdf', size: 20, mimeType: 'application/pdf' }
    ])

    await expect(readPasteboardAttachment()).resolves.toHaveLength(2)
  })

  it('answers an empty list for a pasteboard holding only text', async () => {
    mockReadPasteboardAttachment.mockResolvedValue([])

    await expect(readPasteboardAttachment()).resolves.toEqual([])
  })

  it('drops an item with no uri rather than throwing', async () => {
    mockReadPasteboardAttachment.mockResolvedValue([{ name: 'nothing' }])

    await expect(readPasteboardAttachment()).resolves.toEqual([])
  })

  it('answers an empty list rather than rejecting when the native call fails', async () => {
    mockReadPasteboardAttachment.mockRejectedValue(new Error('no window'))

    await expect(readPasteboardAttachment()).resolves.toEqual([])
  })
})

describe('the browser half of the seam', () => {
  it('has no shortcut of its own to ask the pasteboard through', async () => {
    // Required rather than imported so the native mock above cannot answer for
    // it — the same trap `quick-look.test.ts` documents.
    const web = jest.requireActual('../src/platform/native-paste.web') as {
      HAS_NATIVE_PASTEBOARD: boolean
      readPasteboardAttachment: () => Promise<unknown[]>
    }

    expect(web.HAS_NATIVE_PASTEBOARD).toBe(false)
    await expect(web.readPasteboardAttachment()).resolves.toEqual([])
  })
})
