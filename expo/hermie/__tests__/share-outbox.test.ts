/**
 * The share manifest, as a table.
 *
 * This is the one file in the feature whose input comes from a process this
 * repository does not run — a share extension that may be older than the app,
 * inside another application's sheet, holding filenames that application chose.
 * So the tests here are mostly about REFUSING, and the cases that matter are
 * the ones a well-behaved writer would never produce.
 */
import {
  isSafeShareFileName,
  isSafeShareId,
  parseShareClaim,
  parseShareEntry,
  parseShareManifest,
  shareFiles,
  shareMessageText,
  shareSummary,
  sortShares,
  SHARE_ITEM_LIMIT,
  SHARE_MANIFEST_VERSION,
  SHARE_NOTE_LIMIT
} from '../src/features/share/outbox'

const manifest = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: SHARE_MANIFEST_VERSION,
    id: 'abc123',
    note: '',
    createdAt: 1_700_000_000,
    items: [{ kind: 'file', path: 'report.pdf', filename: 'report.pdf', size: 12, mimeType: 'application/pdf' }],
    ...over
  })

describe('parseShareManifest', () => {
  it('reads the ordinary shape', () => {
    expect(parseShareManifest(manifest({ bot: 'lance-vance', note: 'look' }))).toEqual({
      version: 1,
      id: 'abc123',
      bot: 'lance-vance',
      note: 'look',
      createdAt: 1_700_000_000,
      items: [{ kind: 'file', path: 'report.pdf', filename: 'report.pdf', size: 12, mimeType: 'application/pdf' }]
    })
  })

  it('leaves `bot` off rather than empty, which is how Android arrives', () => {
    expect(parseShareManifest(manifest())).not.toHaveProperty('bot')
    expect(parseShareManifest(manifest({ bot: '' }))).not.toHaveProperty('bot')
  })

  it('refuses a version it does not understand, in either direction', () => {
    expect(parseShareManifest(manifest({ version: 2 }))).toBeNull()
    expect(parseShareManifest(manifest({ version: 0 }))).toBeNull()
    expect(parseShareManifest(manifest({ version: '1' }))).toBeNull()
  })

  it('refuses anything that is not an object, including JSON that is not', () => {
    expect(parseShareManifest('not json')).toBeNull()
    expect(parseShareManifest('[]')).toBeNull()
    expect(parseShareManifest('null')).toBeNull()
  })

  /**
   * The id is a directory name AND a URL path component. A share whose id could
   * climb out of the outbox is a share that could name any file on the device,
   * and the deep-link parser answers nothing for the same alphabet.
   */
  it('refuses an id that is not a name', () => {
    for (const id of ['', '..', '../x', 'a/b', '.hidden', 'a b', 'a'.repeat(65)]) {
      expect(parseShareManifest(manifest({ id }))).toBeNull()
    }

    expect(parseShareManifest(manifest({ id: 'A-b_c.1' }))?.id).toBe('A-b_c.1')
  })

  it('drops an item whose path could leave the entry, and keeps the rest', () => {
    const parsed = parseShareManifest(
      manifest({
        items: [
          { kind: 'file', path: '../../escape.txt' },
          { kind: 'file', path: 'nested/file.txt' },
          { kind: 'file', path: '.profile' },
          { kind: 'file', path: 'keep.txt' }
        ]
      })
    )

    expect(parsed?.items.map(item => item.path)).toEqual(['keep.txt'])
  })

  it('falls back to the path when the filename is one that cannot be trusted', () => {
    const parsed = parseShareManifest(manifest({ items: [{ kind: 'file', path: 'x.txt', filename: '../y.txt' }] }))

    expect(parsed?.items[0]?.filename).toBe('x.txt')
  })

  it('drops an item of a kind it has never heard of', () => {
    expect(parseShareManifest(manifest({ items: [{ kind: 'contact', text: 'x' }], note: 'n' }))?.items).toEqual([])
  })

  it('drops a url or text item with nothing in it', () => {
    expect(parseShareManifest(manifest({ items: [{ kind: 'url', text: '   ' }], note: 'n' }))?.items).toEqual([])
  })

  it('caps the items, so one share cannot become a directory listing', () => {
    const items = Array.from({ length: SHARE_ITEM_LIMIT + 5 }, (_, index) => ({ kind: 'file', path: `f${index}.txt` }))

    expect(parseShareManifest(manifest({ items }))?.items).toHaveLength(SHARE_ITEM_LIMIT)
  })

  it('repairs a note that is not a string rather than losing the share', () => {
    expect(parseShareManifest(manifest({ note: 42 }))?.note).toBe('')
  })

  it('caps the note', () => {
    expect(parseShareManifest(manifest({ note: 'x'.repeat(SHARE_NOTE_LIMIT + 10) }))?.note).toHaveLength(
      SHARE_NOTE_LIMIT
    )
  })

  /**
   * A note with no attachments is a message, which is the same thing the
   * composer sends every day. Nothing at all is not.
   */
  it('keeps a note with no items, and refuses an entry with neither', () => {
    expect(parseShareManifest(manifest({ items: [], note: 'just words' }))?.note).toBe('just words')
    expect(parseShareManifest(manifest({ items: [], note: '   ' }))).toBeNull()
  })
})

describe('parseShareEntry', () => {
  const entry = (over: Record<string, unknown> = {}, files: Record<string, string> = {}) => ({
    id: 'abc123',
    manifest: manifest(over),
    files
  })

  it('pairs an item with the file the bridge found', () => {
    const share = parseShareEntry(entry({}, { 'report.pdf': 'file:///tmp/x/report.pdf' }))

    expect(share?.items).toEqual([
      {
        kind: 'file',
        uri: 'file:///tmp/x/report.pdf',
        filename: 'report.pdf',
        size: 12,
        mimeType: 'application/pdf'
      }
    ])
  })

  /**
   * The commonest way to reach this is not corruption: it is the system
   * reclaiming a share extension's copied bytes before the app was next opened.
   */
  it('drops an item whose file is gone', () => {
    expect(parseShareEntry(entry({ note: 'kept' }, {}))?.items).toEqual([])
    expect(parseShareEntry(entry({}, {}))).toBeNull()
  })

  it('refuses an entry whose manifest names a different id', () => {
    expect(parseShareEntry({ id: 'other', manifest: manifest(), files: { 'report.pdf': 'file:///x' } })).toBeNull()
  })

  it('defaults a missing mime type rather than sending an empty one', () => {
    const share = parseShareEntry(
      entry({ items: [{ kind: 'image', path: 'p.jpg' }] }, { 'p.jpg': 'file:///tmp/p.jpg' })
    )

    expect(share?.items[0]).toMatchObject({ kind: 'image', mimeType: 'application/octet-stream', size: 0 })
  })
})

describe('the message a share becomes', () => {
  const share = {
    id: 'a',
    note: ' look at this ',
    createdAt: 1,
    items: [
      { kind: 'url' as const, text: 'https://example.org' },
      { kind: 'file' as const, uri: 'file:///f', filename: 'f.pdf', size: 1, mimeType: 'application/pdf' },
      { kind: 'text' as const, text: 'some words' }
    ]
  }

  /**
   * The note first, because it is what the person typed, and the URLs and text
   * after it one paragraph each. The FILE is not in the words at all — its
   * `@file:` token is appended by `ChatController.send`, which is the only place
   * that knows where the upload landed.
   */
  it('puts the note first and the words after it', () => {
    expect(shareMessageText(share)).toBe('look at this\n\nhttps://example.org\n\nsome words')
  })

  it('is just the words when there is no note', () => {
    expect(shareMessageText({ ...share, note: '' })).toBe('https://example.org\n\nsome words')
  })

  it('separates the files from the words', () => {
    expect(shareFiles(share).map(file => file.filename)).toEqual(['f.pdf'])
  })

  it('summarises by count rather than by name', () => {
    expect(shareSummary(share)).toBe('1 file and a message')
    expect(shareSummary({ ...share, note: '', items: [share.items[1]!, share.items[1]!] })).toBe('2 files')
    expect(shareSummary({ ...share, items: [share.items[0]!] })).toBe('look at this\n\nhttps://example.org')
  })
})

describe('the queue order', () => {
  it('is oldest first, so shares arrive in the order somebody made them', () => {
    const make = (id: string, createdAt: number) => ({ id, note: 'n', createdAt, items: [] })

    expect(sortShares([make('c', 3), make('a', 1), make('b', 2)]).map(share => share.id)).toEqual(['a', 'b', 'c'])
  })

  it('breaks a tie on the id rather than leaving it to the file system', () => {
    const make = (id: string) => ({ id, note: 'n', createdAt: 1, items: [] })

    expect(sortShares([make('b'), make('a')]).map(share => share.id)).toEqual(['a', 'b'])
  })
})

describe('the two name rules, which Swift and Kotlin also implement', () => {
  it('accepts one ordinary segment and nothing else', () => {
    expect(isSafeShareFileName('IMG_0001.jpg')).toBe(true)
    expect(isSafeShareFileName('a file with spaces.pdf')).toBe(true)

    for (const name of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a b', 'x'.repeat(201)]) {
      expect(isSafeShareFileName(name)).toBe(false)
    }
  })

  it('accepts an id from the alphabet the extension mints from', () => {
    expect(isSafeShareId('0f2a4c6e8a0c2e4f6a8c0e2f4a6c8e0f')).toBe(true)
    expect(isSafeShareId('.leading')).toBe(false)
    expect(isSafeShareId('has space')).toBe(false)
  })
})

/**
 * The claim, which is the one field in this format whose EXISTENCE is the fact.
 *
 * It is written by a share extension immediately before it hands a message to a
 * gateway, so an entry that still has one is an entry that may or may not have
 * been sent. Every reading of it therefore errs towards "there is a claim": a
 * broken one still means somebody tried, and treating a corrupt byte as "no
 * claim" would turn an ambiguous entry back into one the app sends unasked.
 */
describe('the claim', () => {
  it('reads what the sender wrote', () => {
    expect(parseShareClaim(JSON.stringify({ version: 1, bot: 'ada', at: 42 }))).toEqual({
      version: 1,
      bot: 'ada',
      at: 42
    })
  })

  it('reads a broken one as a claim with nothing in it', () => {
    for (const json of ['{', 'null', '[]', '"words"']) {
      expect(parseShareClaim(json)).toEqual({ version: 1, bot: '', at: 0 })
    }
  })

  it('answers nothing only when there is nothing there', () => {
    expect(parseShareClaim('')).toBeNull()
    expect(parseShareClaim('   ')).toBeNull()
  })

  it('rides on the entry when the bridge reports one', () => {
    const entry = {
      id: 'e1',
      manifest: JSON.stringify({
        version: SHARE_MANIFEST_VERSION,
        id: 'e1',
        bot: 'ada',
        note: 'have a look',
        createdAt: 10,
        items: []
      }),
      claim: JSON.stringify({ version: 1, bot: 'ada', at: 42 }),
      files: {}
    }

    expect(parseShareEntry(entry)?.claim).toEqual({ version: 1, bot: 'ada', at: 42 })
  })

  it('is absent on an ordinary entry', () => {
    const entry = {
      id: 'e1',
      manifest: JSON.stringify({
        version: SHARE_MANIFEST_VERSION,
        id: 'e1',
        note: 'have a look',
        createdAt: 10,
        items: []
      }),
      files: {}
    }

    expect(parseShareEntry(entry)).not.toHaveProperty('claim')
  })
})
