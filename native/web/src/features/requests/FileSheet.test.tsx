/**
 * The sheet for an `input.file` request, in the request layer over the real interactive model and a hand-driven
 * connection: the picker and what it filters, the limits before any byte moves, previews, the upload (directly into
 * the request's directory, with the file's SHA-256), progress and cancel, a failure the person sees before the bot is
 * told, a refusal, Skip, the guard. The canvas that strips a picture's metadata is a browser's:
 * `e2e/requests-interactive.spec.ts` runs it for real.
 */
import { createHash } from 'node:crypto'

import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileUploadError } from '../../core/chats/file-upload'
import { REFUSED_CODE } from '../../core/requests/interactive'
import {
  button,
  dialog,
  fileFrame,
  type Harness,
  lastAnswer,
  mount,
  queryButton,
  raise,
  setup,
  teardown,
  type UploadCall
} from '../../test-support/interactive-layer'
import { FileSheet } from './FileSheet'
import { interactiveStore } from '../../state/interactive'
import { preloadRequestSheets } from './request-sheets'

beforeAll(async () => {
  await preloadRequestSheets()
})

let harness: Harness

beforeEach(() => {
  harness = setup()
})

afterEach(() => {
  teardown(harness)
  vi.unstubAllGlobals()
})

const DIR = '/home/ada/work/uploads/hermie/2026-10-04'

const upload = (extra: Record<string, unknown> = {}) => ({
  dir: DIR,
  max_bytes: 1_048_576,
  max_total_bytes: 2_097_152,
  max_files: 3,
  strip_metadata: false,
  ...extra
})

interface Uploads {
  calls: (UploadCall & { signal?: AbortSignal })[]
  fn: (path: string, file: UploadCall['file'], options: { signal?: AbortSignal }) => Promise<unknown>
}

/** An upload that succeeds, and remembers what it was given. */
function uploads(
  behaviour: (path: string, index: number, signal?: AbortSignal) => Promise<unknown> = async () => ({})
): Uploads {
  const calls: Uploads['calls'] = []

  return {
    calls,
    fn: (path, file, options) => {
      calls.push({ path, file, ...(options.signal ? { signal: options.signal } : {}) })

      return behaviour(path, calls.length - 1, options.signal)
    }
  }
}

const pick = (files: File[], selector = '[data-file-picker]'): void => {
  const input = dialog().querySelector<HTMLInputElement>(selector)

  if (!input) {
    throw new Error('no picker')
  }

  fireEvent.change(input, { target: { files } })
}

const text = (name: string, body = 'hello', type = 'text/plain'): File => new File([body], name, { type })

const sha = (body: string): string => createHash('sha256').update(body).digest('hex')

/** Press a button and let the promises settle. */
const press = async (name: string | RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(button(name))
  })
  // Reading a file is a browser task of its own: let it, and the uploads behind it, finish.
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 40))
  })
}

/** The names of the files on the list, in order. */
const listed = (): (string | null)[] =>
  Array.from(dialog().querySelectorAll('[data-file-name]')).map(item => item.getAttribute('data-file-name'))

describe('the sheet', () => {
  it('says what it is in the app’s words, where the files go and what the limits are', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))

    expect(screen.getByRole('dialog', { name: 'Files to upload' })).toBe(dialog())
    expect(dialog().querySelector('.hm-requests__from')?.textContent).toBe('From Dr. Researcher')
    expect(dialog().textContent).toContain('Send me the parking receipt.')
    expect(dialog().textContent).toContain('Saved on the gateway in')
    expect(dialog().querySelector('.hm-file__where')?.textContent).toBe(DIR)
    expect(dialog().textContent).toContain('Up to 1 MB.')
    expect(dialog().textContent).toContain('Any kind of file.')
    expect(dialog().textContent).toContain('Hermie uploads the files to the gateway')
    expect((button('Upload and send') as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([
    ['image', 'image/*', 'Pictures only.'],
    ['audio', 'audio/*', 'Audio only.']
  ])('filters the picker to %s', (accept, attribute, note) => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ accept, upload: upload() }))

    expect(dialog().querySelector('[data-file-picker]')?.getAttribute('accept')).toBe(attribute)
    expect(dialog().textContent).toContain(note)
  })

  it('takes many files when the request says so, and says the limits for them', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ multiple: true, upload: upload() }))

    expect(dialog().querySelector('[data-file-picker]')?.hasAttribute('multiple')).toBe(true)
    expect(button('Choose files')).toBeTruthy()
    expect(dialog().textContent).toContain('Up to 3 files, 1 MB each and 2 MB together.')
  })

  it('shows the camera next to the picker only where a camera is likely, and never for a scan', () => {
    // A phone: no mouse or trackpad attached.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query !== '(any-pointer: fine)', media: query }))
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ accept: 'image', capture: 'photo', upload: upload() }))

    const camera = dialog().querySelector('[data-file-camera]')

    expect(camera?.getAttribute('capture')).toBe('environment')
    expect(camera?.getAttribute('accept')).toBe('image/*')
    expect(button('Take a photo')).toBeTruthy()
    expect(button('Choose a file')).toBeTruthy()

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    raise(harness, 'srq-2', 'input.file', fileFrame({ accept: 'image', capture: 'scan', upload: upload() }))

    expect(dialog().querySelector('[data-file-camera]')).toBeNull()
  })

  it('shows no camera on a device with a mouse', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ accept: 'image', capture: 'photo', upload: upload() }))

    expect(dialog().querySelector('[data-file-camera]')).toBeNull()
  })
})

describe('picking', () => {
  it('lists a picked file with its size and a way to remove it, and the upload waits for one', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('receipt.txt', 'x'.repeat(2048))])

    const list = within(dialog()).getByRole('list', { name: 'Files to upload' })

    expect(within(list).getByText('receipt.txt')).toBeTruthy()
    expect(list.textContent).toContain('2 kB')
    expect((button('Upload and send') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(button('Remove receipt.txt'))

    expect(within(dialog()).queryByRole('list', { name: 'Files to upload' })).toBeNull()
    expect((button('Upload and send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('replaces the file when the request takes one', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('one.txt')])
    pick([text('two.txt')])

    expect(listed()).toEqual(['two.txt'])
  })

  it('adds to what was picked when the request takes many, up to its limit', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ multiple: true, upload: upload() }))
    pick([text('a.txt'), text('b.txt')])
    pick([text('c.txt'), text('d.txt')])

    expect(listed()).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(within(dialog()).getByRole('alert').textContent).toBe('At most 3 files can be sent.')
  })

  it('does not add a file over the limit per file, one over the limit together, an empty one or one of the wrong kind, and says why', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.file',
      fileFrame({ accept: 'document', multiple: true, upload: upload({ max_bytes: 1000, max_total_bytes: 1500 }) })
    )
    pick([
      text('big.txt', 'x'.repeat(1001)),
      text('empty.txt', ''),
      new File(['png'], 'shot.png', { type: 'image/png' }),
      text('a.txt', 'x'.repeat(900)),
      text('b.txt', 'x'.repeat(900))
    ])

    const alert = within(dialog()).getByRole('alert')

    expect(alert.textContent).toContain('big.txt is larger than 1,000B and was not added.')
    expect(alert.textContent).toContain('empty.txt is empty and was not added.')
    expect(alert.textContent).toContain('shot.png is not the kind of file the bot asked for and was not added.')
    expect(alert.textContent).toContain('Together the files may be at most 1 kB.')
    expect(listed()).toEqual(['a.txt'])
  })

  it('adds any picture when the request wants the metadata stripped: the browser decides at upload whether it can', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ accept: 'image', upload: upload({ strip_metadata: true }) }))
    pick([new File(['heic'], 'IMG_1.heic', { type: 'image/heic' })])

    expect(listed()).toEqual(['IMG_1.heic'])
    expect(dialog().textContent).toContain('Location and camera details are removed from pictures before they go.')
  })

  it('previews a picture, and lets go of its address when it is removed', () => {
    const created: string[] = []
    const revoked: string[] = []

    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: () => {
          created.push(`blob:preview-${created.length}`)

          return created.at(-1) as string
        },
        revokeObjectURL: (address: string) => void revoked.push(address)
      })
    )
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ accept: 'image', upload: upload() }))
    pick([new File(['png'], 'shot.png', { type: 'image/png' })])

    const image = within(dialog()).getByRole('img', { name: 'Preview of shot.png' })

    expect(image.getAttribute('src')).toBe('blob:preview-0')

    fireEvent.click(button('Remove shot.png'))

    expect(revoked).toEqual(['blob:preview-0'])
  })
})

describe('uploading', () => {
  it('uploads directly into the directory of the request and answers with the file’s path, name, type, size and SHA-256', async () => {
    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('receipt.txt', 'parking: 4,50')])
    await press('Upload and send')

    expect(up.calls).toHaveLength(1)
    expect(up.calls[0]?.path).toMatch(/^\/home\/ada\/work\/uploads\/hermie\/2026-10-04\/[0-9a-f]{16}-receipt\.txt$/u)
    expect(up.calls[0]?.file).toMatchObject({ name: 'receipt.txt', size: 13, mimeType: 'text/plain' })

    const result = lastAnswer(harness) as { status: string; files: Record<string, unknown>[] }

    expect(result).toEqual({
      status: 'answered',
      files: [
        {
          path: up.calls[0]?.path,
          name: 'receipt.txt',
          mime: 'text/plain',
          bytes: 13,
          sha256: sha('parking: 4,50')
        }
      ]
    })
    // Flat: the file's parent is the request's directory, and nothing is a subdirectory of it.
    expect(result.files[0]?.path).toBe(`${DIR}/${String(result.files[0]?.path).split('/').at(-1)}`)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('uploads many one after another and answers in the order they were picked', async () => {
    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ multiple: true, upload: upload() }))
    pick([text('a.txt', 'aaa'), text('b.pdf', 'bbbb', 'application/pdf')])
    await press('Upload and send')

    expect(up.calls.map(call => call.file.name)).toEqual(['a.txt', 'b.pdf'])
    expect(
      (lastAnswer(harness) as { files: { name: string; bytes: number; mime: string }[] }).files.map(file => [
        file.name,
        file.bytes,
        file.mime
      ])
    ).toEqual([
      ['a.txt', 3, 'text/plain'],
      ['b.pdf', 4, 'application/pdf']
    ])
  })

  it('gives a name with a path in it as the person knows it, and a safe one to the gateway', async () => {
    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('..\\my notes ü.txt', 'x')])
    await press('Upload and send')

    expect(up.calls[0]?.path).toMatch(/^\/home\/ada\/work\/uploads\/hermie\/2026-10-04\/[0-9a-f]{16}-[A-Za-z0-9._-]+$/u)
    expect(up.calls[0]?.path.split('/').slice(0, -1).join('/')).toBe(DIR)
  })

  it('shows progress while it uploads, and nothing can be changed meanwhile', async () => {
    let finish: (value: unknown) => void = () => undefined
    const up = uploads(() => new Promise(resolve => (finish = resolve)))

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('receipt.txt')])
    await press('Upload and send')

    expect(within(dialog()).getByRole('progressbar', { name: 'Upload progress' })).toBeTruthy()
    expect(dialog().textContent).toContain('Uploading 1 of 1: receipt.txt')
    expect(queryButton('Upload and send')).toBeNull()
    expect((button('Cancel upload') as HTMLButtonElement).disabled).toBe(false)
    expect((button('Choose a file') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Remove receipt.txt') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => finish({}))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('can be cancelled, which sends nothing and leaves the files for another go', async () => {
    const up = uploads(
      (_path, _index, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new FileUploadError('cancelled', 'cancelled')))
        })
    )

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('receipt.txt')])
    await press('Upload and send')
    await press('Cancel upload')

    expect(up.calls[0]?.signal?.aborted).toBe(true)
    expect(within(dialog()).getByText('The upload was cancelled. Nothing was sent to the bot.')).toBeTruthy()
    expect(harness.gw.calls).toEqual([])
    expect(harness.gw.declined).toEqual([])
    expect((button('Upload and send') as HTMLButtonElement).disabled).toBe(false)
    expect(within(dialog()).getByText('receipt.txt')).toBeTruthy()
  })

  it('abandons an upload in flight when the request goes', async () => {
    const up = uploads(() => new Promise(() => undefined))

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('receipt.txt')])
    await press('Upload and send')
    act(() => harness.gw.cancel('srq-1', 'interrupted'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(up.calls[0]?.signal?.aborted).toBe(true)
  })

  it('checks the limits on the bytes that will go, before any upload starts', async () => {
    const onUpload = vi.fn(async () => ({}))
    const onAnswer = vi.fn(async () => ({ kind: 'sent' as const }))

    // A prepared file larger than it was picked (a re-encoded picture can be): the limit is on what is sent.
    render(
      <FileSheet
        request={{
          id: 'srq-1',
          method: 'input.file',
          version: 1,
          bot: 'researcher',
          sessionId: 'rt-1',
          deadline: Date.now() + 60_000,
          earlierLost: null,
          refusal: null,
          seq: 1,
          ask: {
            method: 'input.file',
            title: 'Photo',
            summary: 'A photo.',
            expiresAt: 0,
            optional: true,
            accept: 'any',
            multiple: true,
            upload: { dir: DIR, maxBytes: 100, maxTotalBytes: 150, maxFiles: 3, stripMetadata: false }
          }
        }}
        gateway="gw.example.test"
        titleId="t"
        descriptionId="d"
        tapGuardMs={0}
        onAnswer={onAnswer}
        onSkip={async () => ({ kind: 'sent' })}
        onCannotShow={() => 'sent'}
        onLater={() => undefined}
        onUpload={onUpload}
        prepare={async file => ({
          blob: file,
          name: file.name,
          mime: 'text/plain',
          bytes: 120,
          sha256: 'a'.repeat(64)
        })}
      />
    )
    fireEvent.change(document.querySelector('[data-file-picker]') as HTMLInputElement, {
      target: { files: [text('a.txt', 'x'.repeat(80)), text('b.txt', 'x'.repeat(60))] }
    })
    // Each is within 100 bytes as picked; as prepared each is 120.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Upload and send' }))
    })
    await act(async () => undefined)

    expect(screen.getByRole('alert').textContent).toBe(
      'a.txt is larger than 100B once it is ready to send. Remove it, or choose a smaller one.'
    )
    expect(onUpload).not.toHaveBeenCalled()
    expect(onAnswer).not.toHaveBeenCalled()
  })
})

describe('a failure', () => {
  it('is said before the bot is told: try again, or give up (4041 upload_failed)', async () => {
    const up = uploads(async () => {
      throw new FileUploadError('failed', 'The gateway could not be reached')
    })

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('receipt.txt')])
    await press('Upload and send')

    expect(within(dialog()).getByRole('alert').textContent).toContain('receipt.txt could not be uploaded.')
    expect(within(dialog()).getByRole('alert').textContent).toContain('the bot is told the upload failed')
    expect(harness.gw.declined).toEqual([])
    expect(harness.gw.calls).toEqual([])

    await press('Give up')

    expect(harness.gw.declined).toEqual([{ id: 'srq-1', code: 4041, message: 'cannot_show', reason: 'upload_failed' }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('can be tried again, and a file that is already up is not uploaded twice', async () => {
    let failB = true
    const up = uploads(async path => {
      if (path.endsWith('-b.txt') && failB) {
        failB = false
        throw new FileUploadError('refused', 'refused', 400, 'Path must be absolute')
      }

      return {}
    })

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ multiple: true, upload: upload() }))
    pick([text('a.txt', 'aaa'), text('b.txt', 'bbb')])
    await press('Upload and send')

    expect(within(dialog()).getByRole('alert').textContent).toContain('b.txt could not be uploaded.')
    expect(up.calls.map(call => call.file.name)).toEqual(['a.txt', 'b.txt'])

    await press('Try again')

    expect(up.calls.map(call => call.file.name)).toEqual(['a.txt', 'b.txt', 'b.txt'])
    expect((lastAnswer(harness) as { files: unknown[] }).files).toHaveLength(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a failure too when the page has no way to upload', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('receipt.txt')])
    await press('Upload and send')

    expect(within(dialog()).getByRole('alert').textContent).toContain('receipt.txt could not be uploaded.')
    expect(harness.gw.calls).toEqual([])
  })

  it('does not send a picture the browser cannot clean (here: no canvas), says so, and leaves the choice to remove it', async () => {
    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ accept: 'image', upload: upload({ strip_metadata: true }) }))
    pick([new File(['heic'], 'IMG_1.heic', { type: 'image/heic' })])
    await press('Upload and send')

    expect(within(dialog()).getByRole('alert').textContent).toContain(
      'IMG_1.heic is a picture this browser cannot clean of location data, so it is not sent.'
    )
    expect(up.calls).toEqual([])
    expect(harness.gw.calls).toEqual([])
    // Not a failure to try again: the file is still listed, to remove.
    expect(queryButton('Try again')).toBeNull()
    expect(button('Remove IMG_1.heic')).toBeTruthy()
  })

  it('is a failure when a file cannot be prepared for another reason', async () => {
    const up = uploads()
    const original = globalThis.crypto

    // The digest fails: the file cannot be prepared, which is said like a failed upload.
    Object.defineProperty(globalThis, 'crypto', {
      value: { subtle: { digest: () => Promise.reject(new Error('no')) } },
      configurable: true
    })

    try {
      mount(harness, { uploadFileTo: up.fn })
      raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
      pick([text('a.txt')])
      await press('Upload and send')

      expect(within(dialog()).getByRole('alert').textContent).toContain('a.txt could not be prepared for upload.')
      expect(up.calls).toEqual([])
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })
})

describe('the gateway’s refusal', () => {
  const refuse = (reason: string) => () => {
    throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason } })
  }

  it('is said in words, leaves the request open, and goes once the files change; nothing is uploaded twice', async () => {
    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ multiple: true, upload: upload() }))
    pick([text('a.txt', 'aaa'), text('b.txt', 'bbb')])
    harness.gw.onCall.handler = refuse('file:1:too_large')
    await press('Upload and send')

    expect(within(dialog()).getByRole('alert').textContent).toBe(
      'The gateway did not accept b.txt. Remove it and try again.'
    )
    expect(screen.getByRole('dialog')).toBe(dialog())
    expect(up.calls).toHaveLength(2)

    fireEvent.click(button('Remove b.txt'))
    harness.gw.onCall.handler = () => ({ status: 'ok' })

    expect(within(dialog()).queryByText(/did not accept b.txt/u)).toBeNull()

    await press('Upload and send')

    expect(up.calls).toHaveLength(2)
    expect((lastAnswer(harness) as { files: { name: string }[] }).files.map(file => file.name)).toEqual(['a.txt'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each([
    ['files:too_many', /takes at most 3 here/u],
    ['files:too_large', /more than the gateway takes \(2 MB\)/u],
    ['bad_shape', /did not accept this answer \(bad_shape\)/u]
  ])('says %s', async (reason, message) => {
    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ multiple: true, upload: upload() }))
    pick([text('a.txt')])
    harness.gw.onCall.handler = refuse(reason)
    await press('Upload and send')

    expect(within(dialog()).getByRole('alert').textContent).toMatch(message)
  })

  it('says offline once the files are up, keeps them, and answers without uploading again', async () => {
    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    pick([text('a.txt')])
    act(() => harness.gw.status('connecting'))
    await press('Upload and send')

    expect(within(dialog()).getByText(/Not connected to the gateway/u)).toBeTruthy()
    expect(up.calls).toHaveLength(1)
    expect(harness.gw.calls).toEqual([])

    act(() => harness.gw.status('ready'))
    await press('Upload and send')

    expect(up.calls).toHaveLength(1)
    expect(lastAnswer(harness)).toMatchObject({ status: 'answered' })
  })
})

describe('Skip, the guard and the end', () => {
  it('skips an optional request', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    await press('Skip')

    expect(harness.gw.calls).toEqual([
      { method: 'request.answer', params: { id: 'srq-1', result: { status: 'skipped' } } }
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers no Skip when the request is not optional', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ optional: false, upload: upload() }))

    expect(queryButton('Skip')).toBeNull()
  })

  it('takes nothing for a moment after it appears', async () => {
    mount(harness, { tapGuardMs: 40 })
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))

    expect((button('Choose a file') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Skip') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })

    expect((button('Choose a file') as HTMLButtonElement).disabled).toBe(false)
  })

  it('puts the sheet away on Escape, without answering: the request waits', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ upload: upload() }))
    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(harness.gw.calls).toEqual([])
    expect(interactiveStore.getState().requests).toHaveLength(1)
  })

  it('goes when its time runs out, and the reader is told so', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', fileFrame({ expires_at: 1_030, upload: upload() }))
    act(() => harness.timers.advance(30_000))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toContain('The request from Dr. Researcher timed out.')
  })
})
