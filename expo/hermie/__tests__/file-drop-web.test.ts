/**
 * The browser's drop seam: what the overlay reacts to, and what reaches the
 * upload.
 *
 * The DOM listeners themselves are bound to a React Native Web node, which the
 * native test renderer does not produce — so what is asserted here is the logic
 * those listeners run, which is where every rule in the module lives.
 */
// One import, from the web module: under the jest-expo resolver
// `../src/platform/file-drop` resolves to this same file, so naming it twice
// would only look like two modules. `normaliseDroppedFiles` is the shared
// implementation, re-exported here.
import {
  dragCarriesFiles,
  dropDepth,
  filesFromTransfer,
  nativeDropView,
  normaliseDroppedFiles
} from '../src/platform/file-drop.web'
import { droppedFile } from '../src/features/chats/file-attachments'

/** A `DataTransfer` as far as this module reads one. */
const transfer = (types: string[], files: File[] = []) =>
  ({
    types,
    files: {
      length: files.length,
      item: (index: number) => files[index] ?? null
    }
  }) as unknown as DataTransfer

const file = (name: string, type = 'image/png', size = 2048) => {
  const made = new File(['x'], name, { type })

  // jsdom computes `size` from the parts; the tests care about the number that
  // travels, so it is pinned rather than derived.
  Object.defineProperty(made, 'size', { value: size })

  return made
}

beforeAll(() => {
  // `filesFromTransfer` mints object URLs; jsdom has no implementation.
  Object.defineProperty(URL, 'createObjectURL', { value: (f: File) => `blob:${f.name}`, writable: true })
})

describe('the drop depth', () => {
  it('is up on the first enter and down on the matching leave', () => {
    expect(dropDepth(0, 'enter')).toBe(1)
    expect(dropDepth(1, 'leave')).toBe(0)
  })

  it('does not flicker as the pointer crosses the bubbles inside the chat', () => {
    // This is the whole reason the state is a counter. `dragenter` and
    // `dragleave` fire for every DESCENDANT, so crossing a bubble fires the
    // container's leave and the bubble's enter — with a boolean the overlay
    // strobes on everything the pointer passes over.
    let depth = 0

    depth = dropDepth(depth, 'enter')
    depth = dropDepth(depth, 'enter')
    depth = dropDepth(depth, 'leave')

    expect(depth).toBeGreaterThan(0)
  })

  it('goes straight to zero on a drop, however deep the pointer was', () => {
    // No matching `dragleave` is coming for any element the pointer was
    // inside, so decrementing would strand the overlay on screen forever.
    expect(dropDepth(3, 'drop')).toBe(0)
  })

  it('cannot be driven below zero by an unmatched leave', () => {
    // A drag that starts outside the document and ends over it arrives as a
    // leave with no enter; a negative depth would need two enters to recover.
    expect(dropDepth(0, 'leave')).toBe(0)
  })
})

describe('dragCarriesFiles', () => {
  it('recognises a file drag', () => {
    expect(dragCarriesFiles(transfer(['Files']))).toBe(true)
  })

  it('ignores a dragged selection or link', () => {
    // The composer cannot stage a dragged paragraph, and an overlay that
    // promises to take one only resolves the lie after the reader lets go.
    expect(dragCarriesFiles(transfer(['text/plain']))).toBe(false)
    expect(dragCarriesFiles(transfer(['text/uri-list']))).toBe(false)
  })

  it('answers no rather than throwing for a drag with no transfer', () => {
    expect(dragCarriesFiles(null)).toBe(false)
    expect(dragCarriesFiles(undefined)).toBe(false)
  })
})

describe('filesFromTransfer', () => {
  it('reads every dropped file', () => {
    const files = filesFromTransfer(transfer(['Files'], [file('a.png'), file('b.pdf', 'application/pdf')]))

    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ mimeType: 'image/png', name: 'a.png', size: 2048 })
  })

  it('carries the File itself, which is the only thing a browser can upload', () => {
    // A browser's `FormData` streams a `File` and rejects React Native's
    // `{uri, name, type}` blob, so an upload rebuilt from the object URL alone
    // would fail at the last step.
    const [dropped] = filesFromTransfer(transfer(['Files'], [file('a.png')]))

    expect(dropped?.body).toBeInstanceOf(File)
  })

  it('has nothing to report for an empty drop', () => {
    expect(filesFromTransfer(transfer(['Files']))).toEqual([])
    expect(filesFromTransfer(null)).toEqual([])
  })

  it('survives the trip through the shared normaliser with its body intact', () => {
    // The web view hands `DropZone` the same envelope the native one does, and
    // `DropZone` normalises whatever arrives. The `File` has to come out again.
    const normalised = normaliseDroppedFiles(filesFromTransfer(transfer(['Files'], [file('a.png')])))

    expect(normalised[0]?.body).toBeInstanceOf(File)
  })

  it('reaches the upload as the picker-shaped file, body preserved', () => {
    const [dropped] = normaliseDroppedFiles(filesFromTransfer(transfer(['Files'], [file('a.png')])))
    const staged = droppedFile(dropped!)

    expect(staged.body).toBeInstanceOf(File)
    expect(staged).toMatchObject({ mimeType: 'image/png', name: 'a.png', size: 2048 })
  })
})

describe('the native side', () => {
  it('still builds its own FormData part, because it has no File', () => {
    const staged = droppedFile({ mimeType: 'image/png', name: 'a.png', size: 10, uri: 'file:///tmp/a.png' })

    expect(staged.body).toEqual({ name: 'a.png', type: 'image/png', uri: 'file:///tmp/a.png' })
  })
})

describe('nativeDropView', () => {
  it('offers nothing where there is no document to bind to', () => {
    // A server render, or this test environment. `DropZone` reads `null` as
    // "render the children bare", which is what keeps a screen's tree the same
    // shape whether or not a drop target exists.
    expect(nativeDropView()).toBeNull()
  })
})
