/**
 * The composer's attachments, from the outside: the attach button, a paste,
 * the chips and their buttons, and what a send carries.
 *
 * The HERM-126 group is the one this file exists for. The Expo app emptied its
 * tray only after `send` resolved, so a second Return, or a click on Send, that
 * landed while the first send was in flight found the same attachments still
 * staged and sent them again: a second, identical agent turn with no undo, even
 * with an empty field. `send` is held open here with a promise the test settles,
 * so what happens WHILE a send is outstanding is asserted, not only before and
 * after.
 *
 * The tray is the real one (`core/chats/attachments.ts`); its upload and read
 * are functions the test controls.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AttachmentTray } from '../../core/chats/attachments'
import type { UploadableFile, UploadedFile } from '../../core/chats/file-upload'
import { resetActiveLocale } from '../../i18n/active-locale'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { chatWith } from '../../test-support/chat-fixtures'
import { resetShellStores } from '../../test-support/shell-stores'
import { type ChatScreenController, ChatRuntimeContext } from './chat-runtime'
import { Composer } from './Composer'

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

function fakeController(over: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const controller = {
    send: vi.fn(async () => undefined),
    stopTurn: vi.fn(async () => undefined),
    editQueued: vi.fn(() => undefined),
    deleteQueued: vi.fn(),
    steerQueued: vi.fn(async () => 'queued'),
    querySlash: vi.fn(async () => ({ items: [] })),
    runSlash: vi.fn(async () => ({})),
    slashRouteFor: vi.fn((): string | null => null),
    ...over
  }

  return controller as unknown as typeof controller & ChatScreenController
}

/** A tray whose uploads wait for the test (`uploads`) and whose images read at once. */
function fakeTray(options: { holdUploads?: boolean } = {}) {
  const uploads: { file: UploadableFile; signal: AbortSignal; answer: Deferred<UploadedFile> }[] = []
  let id = 0
  const tray = new AttachmentTray({
    upload(file, { signal }) {
      const answer = deferred<UploadedFile>()

      uploads.push({ file, signal, answer })

      if (!options.holdUploads) {
        const path = `/root/projects/researcher/uploads/hermie/2026-10-03/t0k3n000-${file.name}`

        answer.resolve({ path, reference: `@file:${path}`, filename: file.name, size: file.size })
      }

      return answer.promise
    },
    readBase64: async file => `b64:${(file as File).name}`,
    newId: () => `a${(id += 1)}`
  })

  return { tray, uploads }
}

function mount(controller = fakeController(), tray: AttachmentTray | null = fakeTray().tray) {
  const result = render(
    <ChatRuntimeContext.Provider value={{ controller, gatewayBaseUrl: 'http://gateway.test' }}>
      <Composer chatKey="researcher" botName="Dr. Researcher" tray={tray} />
    </ChatRuntimeContext.Provider>
  )
  const picker = result.container.querySelector<HTMLInputElement>('input[type="file"]')

  return { ...result, controller, picker, field: screen.getByRole('textbox') as HTMLTextAreaElement }
}

const settle = (): Promise<void> => act(async () => undefined)
const press = (field: HTMLElement): boolean => fireEvent.keyDown(field, { key: 'Enter' })
const type = (field: HTMLElement, value: string): void => void fireEvent.change(field, { target: { value } })

/** Pick files through the attach button's dialog, as the browser reports a choice. */
async function pick(picker: HTMLInputElement | null, files: File[]): Promise<void> {
  if (!picker) {
    throw new Error('the composer has no file input')
  }

  Object.defineProperty(picker, 'files', { value: files, configurable: true })
  fireEvent.change(picker)
  await settle()
}

const csv = (name = 'report.csv'): File => new File(['a,b\n1,2\n'], name, { type: 'text/csv' })
const png = (name = 'shot.png'): File => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })

/** The Send button, whatever its name says about attachments. */
const sendButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Send/u }) as HTMLButtonElement

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
})

describe('attaching', () => {
  it('stages picked files as chips and sends them with no words', async () => {
    const { controller, picker } = mount()

    await pick(picker, [csv(), png()])

    const tray = screen.getByRole('list', { name: 'Attachments for the next message' })

    expect(
      within(tray)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual([expect.stringContaining('report.csv'), expect.stringContaining('shot.png')])
    expect(screen.getByRole('button', { name: 'Send message with 2 attachments' })).toBe(sendButton())
    expect(sendButton().disabled).toBe(false)
    expect(screen.getByText('2 attachments added')).toBeTruthy()

    fireEvent.click(sendButton())
    await settle()

    expect(controller.send).toHaveBeenCalledExactlyOnceWith('researcher', '', [
      {
        kind: 'file',
        filename: 'report.csv',
        path: '/root/projects/researcher/uploads/hermie/2026-10-03/t0k3n000-report.csv'
      },
      { kind: 'image', filename: 'shot.png', base64: 'b64:shot.png' }
    ])
    expect(screen.queryByRole('list', { name: 'Attachments for the next message' })).toBeNull()
  })

  it('sends the words and the attachments together', async () => {
    const { controller, picker, field } = mount()

    await pick(picker, [csv()])
    type(field, '  what is in it?  ')
    press(field)
    await settle()

    expect(controller.send).toHaveBeenCalledWith('researcher', 'what is in it?', [
      expect.objectContaining({ kind: 'file', filename: 'report.csv' })
    ])
  })

  it('holds the send while a file is still uploading, and says why', async () => {
    const { tray, uploads } = fakeTray({ holdUploads: true })
    const { controller, picker, field } = mount(undefined, tray)

    await pick(picker, [csv()])
    type(field, 'here you go')

    expect(screen.getByText('Uploading…')).toBeTruthy()
    expect(sendButton().disabled).toBe(true)
    const described = document.getElementById(sendButton().getAttribute('aria-describedby') ?? '')

    expect(described?.textContent).toBe('Send is available once every attachment is ready or removed.')

    press(field)
    await settle()
    expect(controller.send).not.toHaveBeenCalled()
    expect(field.value).toBe('here you go')

    await act(async () => {
      const upload = uploads[0]!

      upload.answer.resolve({
        path: '/w/report.csv',
        reference: '@file:/w/report.csv',
        filename: 'report.csv',
        size: 8
      })
    })

    expect(sendButton().disabled).toBe(false)
    press(field)
    await settle()
    expect(controller.send).toHaveBeenCalledTimes(1)
  })

  it('cancels an upload, retries a failed one and removes a chip, each by its own name', async () => {
    const { tray, uploads } = fakeTray({ holdUploads: true })

    mount(undefined, tray)

    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')

    await pick(picker, [csv('one.csv'), csv('two.csv')])

    fireEvent.click(screen.getByRole('button', { name: 'Cancel the upload of one.csv' }))
    expect(uploads[0]!.signal.aborted).toBe(true)
    expect(screen.queryByText('one.csv')).toBeNull()

    await act(async () => uploads[1]!.answer.reject(new Error('network down')))
    expect(screen.getByText('Upload failed: network down')).toBeTruthy()
    // Said once, politely: which file, and why.
    expect(screen.getByText('two.csv: Upload failed: network down').getAttribute('aria-live')).toBe('polite')

    fireEvent.click(screen.getByRole('button', { name: 'Try two.csv again' }))
    expect(uploads).toHaveLength(3)
    await act(async () =>
      uploads[2]!.answer.resolve({ path: '/w/two.csv', reference: '@file:/w/two.csv', filename: 'two.csv', size: 8 })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove two.csv' }))
    expect(screen.queryByRole('list', { name: 'Attachments for the next message' })).toBeNull()
  })

  it('says the gateway’s cap on an image too large to attach', async () => {
    const { picker } = mount()
    const huge = png('huge.png')

    Object.defineProperty(huge, 'size', { value: 26 * 1024 * 1024 })
    await pick(picker, [huge])

    expect(screen.getByText('Too large · 25 MB max')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try huge.png again' })).toBeNull()
    expect(sendButton().disabled).toBe(true)
  })

  it('leaves the attachments staged for a slash command, which takes none', async () => {
    const controller = fakeController({ slashRouteFor: vi.fn(() => 'exec') })
    const { picker, field } = mount(controller)

    await pick(picker, [csv()])
    type(field, '/model')
    press(field)
    await settle()

    expect(controller.runSlash).toHaveBeenCalledWith('researcher', '/model')
    expect(controller.send).not.toHaveBeenCalled()
    expect(screen.getByRole('list', { name: 'Attachments for the next message' })).toBeTruthy()
  })

  it('offers no attaching in a chat that has no session on the gateway yet', () => {
    chatsStore.getState().hydrate('researcher', chatWith('researcher', []))

    mount()

    expect((screen.getByRole('button', { name: 'Add attachment' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers no attaching at all without a tray', () => {
    mount(undefined, null)

    expect(screen.queryByRole('button', { name: 'Add attachment' })).toBeNull()
  })
})

describe('pasting', () => {
  function clipboard(files: File[], text = ''): DataTransfer {
    return {
      items: files.map(file => ({ kind: 'file', getAsFile: () => file })),
      files,
      getData: (type: string) => (type === 'text/plain' ? text : '')
    } as unknown as DataTransfer
  }

  it('attaches a pasted image instead of typing anything', async () => {
    const { field } = mount()

    const notPrevented = fireEvent.paste(field, { clipboardData: clipboard([png('image.png')]) })
    await settle()

    expect(notPrevented).toBe(false)
    expect(screen.getByText('image.png')).toBeTruthy()
    expect(field.value).toBe('')
  })

  it('lets text with a picture of it beside go into the field as text', async () => {
    const { field } = mount()

    const notPrevented = fireEvent.paste(field, { clipboardData: clipboard([png('cells.png')], 'a\tb\n1\t2') })
    await settle()

    expect(notPrevented).toBe(true)
    expect(screen.queryByRole('list', { name: 'Attachments for the next message' })).toBeNull()
  })
})

describe('HERM-126: a second send while one is in flight', () => {
  async function readyWithOne(controller: ReturnType<typeof fakeController>) {
    const view = mount(controller)

    await pick(view.picker, [png('shot.jpg')])

    return view
  }

  const SHOT = { kind: 'image', filename: 'shot.jpg', base64: 'b64:shot.jpg' }

  it('sends an attachment once when Return is pressed twice before the first send settles', async () => {
    const first = deferred<undefined>()
    const controller = fakeController({ send: vi.fn(() => first.promise) })
    const { field } = await readyWithOne(controller)

    // The field is empty on both presses: the shape the owner reported.
    press(field)
    press(field)
    await act(async () => first.resolve(undefined))

    expect(controller.send).toHaveBeenCalledExactlyOnceWith('researcher', '', [SHOT])
    expect(screen.queryByRole('list', { name: 'Attachments for the next message' })).toBeNull()
  })

  it('sends an attachment once when Return is followed by a click on Send before the first send settles', async () => {
    const first = deferred<undefined>()
    const controller = fakeController({ send: vi.fn(() => first.promise) })
    const { field } = await readyWithOne(controller)

    press(field)
    fireEvent.click(sendButton())
    await act(async () => first.resolve(undefined))

    expect(controller.send).toHaveBeenCalledTimes(1)
  })

  it('sends the words and the attachment once when Return is pressed twice with words in the field', async () => {
    const first = deferred<undefined>()
    const controller = fakeController({ send: vi.fn(() => first.promise) })
    const { field } = await readyWithOne(controller)

    type(field, 'look')
    press(field)
    press(field)
    await act(async () => first.resolve(undefined))

    expect(controller.send).toHaveBeenCalledExactlyOnceWith('researcher', 'look', [SHOT])
  })

  it('puts every attachment back exactly, in order and once, when the in-flight send fails', async () => {
    const failing = deferred<undefined>()
    const controller = fakeController({ send: vi.fn(() => failing.promise) })
    const { picker, field } = mount(controller)

    await pick(picker, [png('first.jpg'), png('second.jpg')])
    press(field)
    // Staged while the send is out: it stays, behind the two that come back.
    await pick(picker, [csv('later.csv')])
    await act(async () => failing.reject(new Error('gateway not connected')))

    expect(screen.getByRole('alert').textContent).toContain('gateway not connected')

    const names = within(screen.getByRole('list', { name: 'Attachments for the next message' }))
      .getAllByRole('listitem')
      .map(item => item.querySelector('.hm-attach__name')?.textContent)

    expect(names).toEqual(['first.jpg', 'second.jpg', 'later.csv'])

    controller.send.mockResolvedValueOnce(undefined)
    fireEvent.click(sendButton())
    await settle()

    expect(controller.send).toHaveBeenCalledTimes(2)
    const second = (controller.send.mock.calls as unknown[][])[1]?.[2] as { filename: string }[] | undefined

    expect(second?.map(input => input.filename)).toEqual(['first.jpg', 'second.jpg', 'later.csv'])
  })

  it('still lets a genuine next send through once the first one has completed', async () => {
    const first = deferred<undefined>()
    const controller = fakeController({ send: vi.fn(() => first.promise) })
    const { field } = await readyWithOne(controller)

    press(field)
    await act(async () => first.resolve(undefined))

    controller.send.mockResolvedValueOnce(undefined)
    type(field, 'and one more thing')
    press(field)
    await settle()

    expect(controller.send).toHaveBeenCalledTimes(2)
    expect(controller.send).toHaveBeenLastCalledWith('researcher', 'and one more thing')
  })
})
