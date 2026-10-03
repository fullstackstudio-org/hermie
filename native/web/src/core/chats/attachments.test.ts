/**
 * The attachment tray on its own: which road a file takes, what a chip says at
 * each step, and the two rules the composer leans on: `take` empties the tray in
 * the same step (HERM-126), and `restore` puts back exactly what was taken.
 *
 * The upload and the read are functions the test holds open, so every
 * assertion can be made WHILE something is in flight, not only before or after.
 */
import { describe, expect, it, vi } from 'vitest'

import { AttachmentTray, imageNameFor, MAX_IMAGE_BYTES, MAX_PREVIEW_BYTES, type StagedAttachment } from './attachments'
import { FileUploadError, MAX_UPLOAD_BYTES, type UploadableFile, type UploadedFile } from './file-upload'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

/** A `File` whose `size` says what the test needs without allocating it. */
function fileOf(name: string, type: string, size = 12): File {
  const file = new File(['x'], name, { type })

  Object.defineProperty(file, 'size', { value: size })

  return file
}

function harness() {
  const uploads: { file: UploadableFile; signal: AbortSignal; answer: Deferred<UploadedFile> }[] = []
  const reads: { file: Blob; answer: Deferred<string> }[] = []
  let id = 0

  const tray = new AttachmentTray({
    upload(file, { signal }) {
      const answer = deferred<UploadedFile>()

      uploads.push({ file, signal, answer })

      return answer.promise
    },
    readBase64(file) {
      const answer = deferred<string>()

      reads.push({ file, answer })

      return answer.promise
    },
    newId: () => `a${(id += 1)}`
  })

  const uploaded = (index: number, path: string): Promise<void> => {
    const upload = uploads[index]!

    upload.answer.resolve({ path, reference: `@file:${path}`, filename: upload.file.name, size: upload.file.size })

    return flush()
  }

  return { tray, uploads, reads, uploaded }
}

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const statuses = (items: readonly StagedAttachment[]): string[] => items.map(item => `${item.name}:${item.status}`)

describe('imageNameFor', () => {
  it('keeps the image road for the raster formats the gateway takes, by extension', () => {
    expect(imageNameFor({ name: 'shot.PNG', type: 'image/png' })).toBe('shot.PNG')
    expect(imageNameFor({ name: 'photo.jpeg', type: 'image/jpeg' })).toBe('photo.jpeg')
    expect(imageNameFor({ name: 'scan.tif', type: '' })).toBe('scan.tif')
  })

  it('sends an SVG, an icon, a HEIC photo and anything that is not an image as a file', () => {
    expect(imageNameFor({ name: 'logo.svg', type: 'image/svg+xml' })).toBeNull()
    expect(imageNameFor({ name: 'favicon.ico', type: 'image/x-icon' })).toBeNull()
    expect(imageNameFor({ name: 'IMG_0001.HEIC', type: 'image/heic' })).toBeNull()
    expect(imageNameFor({ name: 'report.pdf', type: 'application/pdf' })).toBeNull()
    // A name that says image with a type that says otherwise is not trusted for the image road.
    expect(imageNameFor({ name: 'notes.png', type: 'text/plain' })).toBeNull()
  })

  it('gives a nameless paste the extension of its type, so the gateway reads the right format', () => {
    expect(imageNameFor({ name: '', type: 'image/png' })).toBe('image.png')
    expect(imageNameFor({ name: 'clipboard', type: 'image/jpeg' })).toBe('clipboard.jpg')
    expect(imageNameFor({ name: '', type: 'application/zip' })).toBeNull()
  })
})

describe('staging', () => {
  it('uploads a file at once, says it is working, then ready with the path the gateway answered', async () => {
    const { tray, uploads, uploaded } = harness()

    expect(tray.add([fileOf('report.csv', 'text/csv', 2048)])).toBe(1)
    expect(statuses(tray.getSnapshot())).toEqual(['report.csv:working'])
    expect(tray.blocked).toBe(true)
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.file).toMatchObject({ name: 'report.csv', size: 2048, mimeType: 'text/csv' })
    expect(uploads[0]!.file.body).toBeInstanceOf(File)

    await uploaded(0, '/root/projects/researcher/uploads/hermie/2026-10-03/abc-report.csv')

    expect(statuses(tray.getSnapshot())).toEqual(['report.csv:ready'])
    expect(tray.blocked).toBe(false)
  })

  it('reads an image for the socket instead of uploading it, with a thumbnail of its own bytes', async () => {
    const { tray, uploads, reads } = harness()

    tray.add([fileOf('shot.png', 'image/png')])

    expect(uploads).toHaveLength(0)
    expect(reads).toHaveLength(1)
    expect(tray.getSnapshot()[0]).toMatchObject({ kind: 'image', status: 'working' })
    expect(tray.getSnapshot()[0]?.previewUrl).toBeUndefined()

    reads[0]!.answer.resolve('iVBORw0KGgo=')
    await flush()

    expect(tray.getSnapshot()[0]).toMatchObject({ status: 'ready', previewUrl: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(tray.take()?.inputs).toEqual([{ kind: 'image', filename: 'shot.png', base64: 'iVBORw0KGgo=' }])
  })

  it('draws no thumbnail of an image too large to put in the page twice, or of a type it cannot name', async () => {
    const { tray, reads } = harness()

    tray.add([fileOf('big.jpg', 'image/jpeg', MAX_PREVIEW_BYTES + 1), fileOf('odd.png', 'image/png;x="y"')])
    reads[0]!.answer.resolve('AAAA')
    reads[1]!.answer.resolve('AAAA')
    await flush()

    expect(tray.getSnapshot().map(item => [item.status, item.previewUrl])).toEqual([
      ['ready', undefined],
      ['ready', undefined]
    ])
  })

  it('refuses an image over the gateway’s 25 MB before reading a byte, and offers no retry for it', () => {
    const { tray, reads } = harness()

    tray.add([fileOf('huge.png', 'image/png', MAX_IMAGE_BYTES + 1)])

    expect(reads).toHaveLength(0)
    expect(tray.getSnapshot()[0]).toMatchObject({
      status: 'failed',
      problem: { reason: 'too-large', limitBytes: MAX_IMAGE_BYTES }
    })

    tray.retry('a1')
    expect(reads).toHaveLength(0)
  })

  it('names the gateway’s reason on the chip it refused, and the cap on a 413', async () => {
    const { tray, uploads } = harness()

    tray.add([fileOf('a.txt', 'text/plain'), fileOf('b.bin', '')])
    uploads[0]!.answer.reject(new FileUploadError('refused', 'The gateway refused…', 400, 'Path must be absolute'))
    uploads[1]!.answer.reject(new FileUploadError('too-large', 'too large', 413, 'File is too large'))
    await flush()

    expect(tray.getSnapshot().map(item => item.problem)).toEqual([
      { reason: 'refused', detail: 'Path must be absolute' },
      { reason: 'too-large', limitBytes: MAX_UPLOAD_BYTES }
    ])
    // A file with no type goes as a stream of bytes.
    expect(uploads[1]!.file.mimeType).toBe('application/octet-stream')
  })

  it('says when the chat has no workspace to upload into', async () => {
    const { tray, uploads } = harness()

    tray.add([fileOf('a.txt', 'text/plain')])
    uploads[0]!.answer.reject(new FileUploadError('no-workspace', 'no cwd'))
    await flush()

    expect(tray.getSnapshot()[0]?.problem).toEqual({ reason: 'no-workspace' })
  })
})

describe('cancel, retry, remove', () => {
  it('aborts an upload that is cancelled and drops whatever it answers afterwards', async () => {
    const { tray, uploads } = harness()

    tray.add([fileOf('big.zip', 'application/zip')])
    tray.remove('a1')

    expect(uploads[0]!.signal.aborted).toBe(true)
    expect(tray.getSnapshot()).toEqual([])

    uploads[0]!.answer.reject(new FileUploadError('cancelled', 'cancelled'))
    await flush()

    expect(tray.getSnapshot()).toEqual([])
  })

  it('starts a failed upload again on retry, and only the newest attempt may settle the chip', async () => {
    const { tray, uploads, uploaded } = harness()

    tray.add([fileOf('a.txt', 'text/plain')])
    uploads[0]!.answer.reject(new FileUploadError('failed', 'socket hang up'))
    await flush()
    expect(tray.getSnapshot()[0]?.problem).toEqual({ reason: 'failed', message: 'socket hang up' })

    tray.retry('a1')
    expect(statuses(tray.getSnapshot())).toEqual(['a.txt:working'])
    expect(uploads).toHaveLength(2)

    await uploaded(1, '/w/a.txt')
    expect(statuses(tray.getSnapshot())).toEqual(['a.txt:ready'])
  })

  it('stops every upload and empties the tray on clear', () => {
    const { tray, uploads } = harness()

    tray.add([fileOf('one.png', 'image/png'), fileOf('c.txt', 'text/plain')])
    tray.clear()

    expect(uploads[0]!.signal.aborted).toBe(true)
    expect(tray.getSnapshot()).toEqual([])
  })
})

describe('take and restore (HERM-126)', () => {
  async function readyTray() {
    const h = harness()

    h.tray.add([fileOf('first.png', 'image/png'), fileOf('second.csv', 'text/csv')])
    h.reads[0]!.answer.resolve('AAAA')
    await h.uploaded(0, '/w/second.csv')

    return h
  }

  it('takes everything in one step, so a second take finds nothing', async () => {
    const { tray } = await readyTray()
    const listener = vi.fn()

    tray.subscribe(listener)

    const taken = tray.take()

    expect(taken?.inputs).toEqual([
      { kind: 'image', filename: 'first.png', base64: 'AAAA' },
      { kind: 'file', filename: 'second.csv', path: '/w/second.csv' }
    ])
    expect(tray.getSnapshot()).toEqual([])
    expect(tray.empty).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(tray.take()).toBeNull()
  })

  it('takes nothing while a chip is still working or has failed', () => {
    const { tray } = harness()

    tray.add([fileOf('a.txt', 'text/plain')])

    expect(tray.take()).toBeNull()
    expect(tray.getSnapshot()).toHaveLength(1)
  })

  it('puts back exactly what a failed send took, in order, ahead of anything staged meanwhile', async () => {
    const { tray, reads } = await readyTray()
    const taken = tray.take()!

    tray.add([fileOf('later.png', 'image/png')])
    reads[1]!.answer.resolve('BBBB')
    await flush()

    tray.restore(taken)
    tray.restore(taken)

    expect(tray.getSnapshot().map(item => item.name)).toEqual(['first.png', 'second.csv', 'later.png'])
    expect(tray.take()?.inputs.map(input => input.filename)).toEqual(['first.png', 'second.csv', 'later.png'])
  })

  it('lets go of the bytes of a send that went', async () => {
    const { tray } = await readyTray()
    const taken = tray.take()!

    tray.release(taken)
    tray.restore(taken)

    // Nothing left to send: the bytes went with the message.
    expect(tray.take()?.inputs).toEqual([])
  })
})
