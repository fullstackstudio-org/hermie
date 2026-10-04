/**
 * A message that holds a picture in its own text, or names one on the gateway's disk, drawn from a real
 * history row: the handle and the blob never reach the page as words, a picture is a picture, and a chip
 * does something.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { rowsToItems, type TranscriptItem } from '@hermie/transcript'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadedAttachment } from '../../../core/chats/attachment-fetch'
import { resetActiveLocale } from '../../../i18n/active-locale'
import { ChatItem } from './ChatItem'
import { ItemContext } from './item-context'
import { DETACHED_ITEM_HOST, type ItemHost, ItemHostContext } from './item-host'

const saved = vi.hoisted(() => vi.fn())

vi.mock('../../../platform/files', () => ({ saveBlob: saved }))

const BASE = 'http://gateway.test/hermes'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG_URI = `data:image/png;base64,${PNG}`
const PATH = '/root/.hermes/profiles/marketing/images/upload_20261004_160406_1.png'

beforeEach(() => {
  saved.mockClear()
})

afterEach(() => {
  resetActiveLocale()
})

function Frame({ children, host = DETACHED_ITEM_HOST }: { children: ReactNode; host?: ItemHost }) {
  return (
    <ItemContext.Provider value={{ botName: 'Bot', gatewayBaseUrl: BASE, ownAuthorId: undefined, groupChat: false }}>
      <ItemHostContext.Provider value={host}>{children}</ItemHostContext.Provider>
    </ItemContext.Provider>
  )
}

const hostWith = (over: Partial<ItemHost>): ItemHost => ({ ...DETACHED_ITEM_HOST, ...over })

const itemsOf = (role: 'user' | 'assistant', content: string): TranscriptItem[] =>
  rowsToItems([{ role, content }], 'rest')

const draw = (item: TranscriptItem, host?: ItemHost) =>
  render(
    <Frame {...(host ? { host } : {})}>
      <ChatItem row={{ item, presentation: 'full' }} />
    </Frame>
  )

describe('a picture the message holds in its own text', () => {
  const content = `look at this\n\n[Image attached at: ${PATH}]\ndata:image/png;base64,${PNG}`

  it('is a thumbnail from the bytes the row holds, with neither the handle nor the blob on the page', () => {
    const [item] = itemsOf('user', content)
    const { container } = draw(item as TranscriptItem)

    const image = container.querySelector('img') as HTMLImageElement

    expect(image.src).toBe(PNG_URI)
    expect(image.alt).toBe('upload_20261004_160406_1.png')
    expect(container.textContent).toContain('look at this')
    expect(container.textContent).not.toContain('Image attached')
    expect(container.textContent).not.toContain('base64')
    expect(container.textContent).not.toContain('iVBOR')
    // Its frame is the card's size from the first moment: the row does not change height when it decodes.
    expect(container.querySelector('.hm-image')?.getAttribute('data-reserved')).toBe('true')
  })

  it('opens in the viewer when pressed', () => {
    const openImage = vi.fn()
    const [item] = itemsOf('user', content)

    draw(item as TranscriptItem, hostWith({ openImage }))
    fireEvent.click(screen.getByRole('button', { name: 'upload_20261004_160406_1.png' }))

    expect(openImage).toHaveBeenCalledWith({ src: PNG_URI, name: 'upload_20261004_160406_1.png' }, expect.anything())
  })

  it('is drawn in a reply as well', () => {
    const [item] = itemsOf('assistant', `Here you go\n\n![chart](data:image/png;base64,${PNG})`)
    const { container } = draw(item as TranscriptItem)

    expect((container.querySelector('img') as HTMLImageElement).src).toBe(PNG_URI)
    expect(container.textContent).toContain('Here you go')
    expect(container.textContent).not.toContain('base64')
  })

  it('is a compact Image chip, never the blob, when it does not decode', () => {
    const [item] = itemsOf('user', 'data:image/png;base64,AAAAA')
    const { container } = draw(item as TranscriptItem)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('Image')).toBeTruthy()
    expect(container.textContent).not.toContain('AAAAA')
  })

  it('does not put a type the browser cannot draw in an <img>', () => {
    const heic = btoa(String.fromCharCode(0, 0, 0, 0x18, ...[...'ftypheic'].map(c => c.charCodeAt(0)), 0, 0, 0, 0))
    const [item] = itemsOf('user', `data:image/heic;base64,${heic}`)
    const { container } = draw(item as TranscriptItem)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.hm-file')).not.toBeNull()
    expect(container.textContent).not.toContain(heic)
  })
})

describe('the handle of an attached image the gateway kept on its disk', () => {
  const [item] = itemsOf('user', `what is this?\n\n[Image attached at: ${PATH}]`)

  it('is a frame at once and a thumbnail once the gateway hands the file over', async () => {
    let finish: (value: LoadedAttachment | null) => void = () => undefined
    const loadAttachment = vi.fn(
      () =>
        new Promise<LoadedAttachment | null>(resolve => {
          finish = resolve
        })
    )
    const openImage = vi.fn()
    const { container } = draw(item as TranscriptItem, hostWith({ loadAttachment, openImage }))

    expect(container.textContent).not.toContain('Image attached')
    expect(container.querySelector('.hm-image')?.getAttribute('data-state')).toBe('waiting')
    expect(container.querySelector('img')).toBeNull()

    finish({ kind: 'image', src: PNG_URI, name: 'upload_20261004_160406_1.png' })
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())

    expect(loadAttachment).toHaveBeenCalledWith(`@image:${PATH}`)
    expect(container.querySelector('.hm-image')?.getAttribute('data-reserved')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'upload_20261004_160406_1.png' }))
    expect(openImage).toHaveBeenCalledWith({ src: PNG_URI, name: 'upload_20261004_160406_1.png' }, expect.anything())
  })

  it('says so under its name when the gateway refuses it, never the raw handle', async () => {
    const { container } = draw(item as TranscriptItem, hostWith({ loadAttachment: async () => null }))

    await waitFor(() => expect(screen.getByText('The gateway did not hand this file over.')).toBeTruthy())

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('upload_20261004_160406_1.png')).toBeTruthy()
    expect(container.textContent).not.toContain('Image attached')
  })

  it('stays the plain chip where the host has no gateway to ask', () => {
    const { container } = draw(item as TranscriptItem)

    expect(container.querySelector('.hm-file')).not.toBeNull()
    expect(container.querySelector('.hm-file__open')).toBeNull()
    expect(container.textContent).not.toContain('Image attached')
  })
})

describe('a file chip under a message', () => {
  const upload = '/root/.hermes/uploads/hermie/9eh14f1h-Image-2026-10-04-at-16.31.52'

  it('opens a picture with no extension in the viewer, found out by its bytes', async () => {
    const openImage = vi.fn()
    const loadAttachment = vi.fn(async () => ({ kind: 'image', src: PNG_URI, name: '9eh14f1h' }) as const)
    const [item] = rowsToItems([{ role: 'user', content: `@file:${upload}` }], 'rest')

    draw(item as TranscriptItem, hostWith({ loadAttachment, openImage }))
    fireEvent.click(screen.getByRole('button', { name: '9eh14f1h-Image-2026-10-04-at-16.31.52' }))

    await waitFor(() => expect(openImage).toHaveBeenCalledWith({ src: PNG_URI, name: '9eh14f1h' }, null))
    expect(loadAttachment).toHaveBeenCalledWith(`@file:${upload}`)
  })

  it('saves any other file', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' })
    const loadAttachment = vi.fn(async () => ({ kind: 'file', blob, name: 'report.pdf' }) as const)
    const [item] = rowsToItems([{ role: 'user', content: 'here @file:/root/uploads/report.pdf' }], 'rest')

    draw(item as TranscriptItem, hostWith({ loadAttachment }))
    fireEvent.click(screen.getByRole('button', { name: 'report.pdf' }))

    await waitFor(() => expect(saved).toHaveBeenCalledWith(blob, 'report.pdf'))
  })

  it('says it could not be fetched instead of doing nothing', async () => {
    const [item] = rowsToItems([{ role: 'user', content: '@file:/root/uploads/gone.pdf' }], 'rest')

    draw(item as TranscriptItem, hostWith({ loadAttachment: async () => null }))
    fireEvent.click(screen.getByRole('button', { name: 'gone.pdf' }))

    await waitFor(() => expect(screen.getByText('The gateway did not hand this file over.')).toBeTruthy())
    expect(saved).not.toHaveBeenCalled()
  })
})
