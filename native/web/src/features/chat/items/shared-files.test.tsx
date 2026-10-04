/**
 * The files a bot shared with a reply, one kind at a time (`contract/outbox/`): a picture is a thumbnail that
 * opens the viewer (and several are a grid), a video and a sound are players that seek, a PDF opens in a tab of its
 * own, and any other file is a chip with its name, its size and a download. With the cookie session the address is
 * the element's `src`; with the shared token the page fetches the bytes with the header and hands the element a
 * `blob:` URL. The name is the sender's text and never becomes markup.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createOutboxFiles, type OutboxFiles } from '../../../core/chats/outbox-files'
import { resetActiveLocale, setActiveLocale } from '../../../i18n/active-locale'
import { assistantItem } from '../../../test-support/chat-fixtures'
import { sharedFile } from '../../../test-support/outbox-fixtures'
import { AssistantBubble } from './AssistantBubble'
import { ItemContext } from './item-context'
import { DETACHED_ITEM_HOST, type ItemHost, ItemHostContext } from './item-host'
import { SharedFiles } from './SharedFiles'

const saveBlob = vi.hoisted(() => vi.fn())

vi.mock('../../../platform/files', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveBlob
}))

const BASE = 'http://gateway.test/hermes'
const ORIGIN = 'http://gateway.test/hermes/api/files/outbox'

function Frame({ children, host = DETACHED_ITEM_HOST }: { children: ReactNode; host?: ItemHost }) {
  return (
    <ItemContext.Provider
      value={{ botName: 'Bot', gatewayBaseUrl: BASE, profile: 'researcher', ownAuthorId: undefined, groupChat: false }}
    >
      <ItemHostContext.Provider value={host}>{children}</ItemHostContext.Provider>
    </ItemContext.Provider>
  )
}

const hostWith = (over: Partial<ItemHost>): ItemHost => ({ ...DETACHED_ITEM_HOST, ...over })

/** The page's fetch, answering by address. */
function fakeFetch(answers: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const answer = answers[String(input)]

    return answer ? answer() : new Response('not found', { status: 404 })
  })
}

/** The shared-token gateway: the page fetches, with the header, what an element cannot. */
function tokenFiles(fetchImpl: ReturnType<typeof fakeFetch>): OutboxFiles {
  return createOutboxFiles({
    headers: () => Promise.resolve({ 'x-hermes-session-token': 'tok' }),
    gated: false,
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
}

let blobCounter = 0

beforeEach(() => {
  blobCounter = 0
  saveBlob.mockReset()
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:http://gateway.test/${(blobCounter += 1)}`),
      revokeObjectURL: vi.fn()
    })
  )
})

afterEach(() => {
  resetActiveLocale()
  vi.unstubAllGlobals()
})

describe('a picture', () => {
  it('is a thumbnail of the file’s address, with the profile, named by the file', () => {
    const file = sharedFile('image', 'sunrise.png')

    render(
      <Frame>
        <SharedFiles files={[file]} />
      </Frame>
    )

    const picture = screen.getByRole('img', { name: 'sunrise.png' })

    expect(picture.getAttribute('src')).toBe(`${ORIGIN}/${file.id}/sunrise.png?profile=researcher`)
    expect(picture.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(screen.getByRole('list', { name: 'Attachments' })).toBeTruthy()
  })

  it('opens the viewer with that address, and hands it the card to give focus back to', () => {
    const file = sharedFile('image', 'sunrise.png')
    const openImage = vi.fn()

    render(
      <Frame host={hostWith({ openImage })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    const card = screen.getByRole('button', { name: 'sunrise.png' })

    fireEvent.click(card)

    expect(openImage).toHaveBeenCalledWith(
      { src: `${ORIGIN}/${file.id}/sunrise.png?profile=researcher`, name: 'sunrise.png' },
      card
    )
  })

  it('goes two across for two, and three across for three or more, with a file on a row of its own', () => {
    const two = [sharedFile('image', 'a.png'), sharedFile('image', 'b.png')]
    const { container, rerender } = render(
      <Frame>
        <SharedFiles files={two} />
      </Frame>
    )

    expect(container.querySelector('.hm-gallery')?.getAttribute('data-columns')).toBe('2')
    expect(screen.getAllByRole('img')).toHaveLength(2)

    rerender(
      <Frame>
        <SharedFiles files={[...two, sharedFile('image', 'c.png'), sharedFile('file', 'x.zip')]} />
      </Frame>
    )

    expect(container.querySelector('.hm-gallery')?.getAttribute('data-columns')).toBe('3')
    expect(container.querySelector('[data-kind="file"]')?.textContent).toContain('x.zip')
  })

  it('becomes the file’s chip when the browser cannot draw it, never an empty frame', () => {
    render(
      <Frame>
        <SharedFiles files={[sharedFile('image', 'scan.heic')]} />
      </Frame>
    )

    fireEvent.error(screen.getByRole('img', { name: 'scan.heic' }))

    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('scan.heic')).toBeTruthy()
  })
})

describe('a video', () => {
  it('is a player that reads its metadata and seeks by ranges, with its name and size under it', () => {
    const file = sharedFile('video', 'test card.mp4', { size: 4966 })
    const { container } = render(
      <Frame>
        <SharedFiles files={[file]} />
      </Frame>
    )

    const video = container.querySelector('video') as HTMLVideoElement

    expect(video.controls).toBe(true)
    expect(video.getAttribute('preload')).toBe('metadata')
    expect(video.getAttribute('src')).toBe(`${ORIGIN}/${file.id}/test%20card.mp4?profile=researcher`)
    expect(video.getAttribute('aria-label')).toBe('Video: test card.mp4')
    expect(screen.getByText('test card.mp4')).toBeTruthy()
    expect(screen.getByText('5 kB')).toBeTruthy()
  })
})

describe('a sound', () => {
  it('is a compact player with its name', () => {
    const file = sharedFile('audio', 'tone.mp3', { size: 4400 })
    const { container } = render(
      <Frame>
        <SharedFiles files={[file]} />
      </Frame>
    )

    const audio = container.querySelector('audio') as HTMLAudioElement

    expect(audio.controls).toBe(true)
    expect(audio.getAttribute('preload')).toBe('metadata')
    expect(audio.getAttribute('src')).toBe(`${ORIGIN}/${file.id}/tone.mp3?profile=researcher`)
    expect(audio.getAttribute('aria-label')).toBe('Audio: tone.mp3')
    expect(screen.getByText('tone.mp3')).toBeTruthy()
  })
})

describe('any other file', () => {
  it('is a chip with its name as text, its size, and a download of its address', () => {
    const file = sharedFile('file', 'Q3 report.html', { mime: 'text/html', size: 10_422 })
    const { container } = render(
      <Frame>
        <SharedFiles files={[file]} />
      </Frame>
    )

    const download = screen.getByRole('link', { name: 'Download Q3 report.html' })

    expect(download.getAttribute('href')).toBe(`${ORIGIN}/${file.id}/Q3%20report.html?profile=researcher`)
    expect(download.hasAttribute('download')).toBe(true)
    expect(screen.getByText('Q3 report.html')).toBeTruthy()
    expect(screen.getByText('10 kB')).toBeTruthy()
    // Never drawn in this page: no frame, no object, no picture, no player.
    expect(container.querySelector('iframe, object, embed, img, video, audio')).toBeNull()
  })

  it('shows a name with markup as the text it is', () => {
    const name = '<img src=x onerror=alert(1)>.png'
    const file = sharedFile('file', name)
    const { container } = render(
      <Frame>
        <SharedFiles files={[file]} />
      </Frame>
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain(name)
    // The address is the one the gateway wrote (its `quote` encodes the brackets too), with the profile.
    expect(screen.getByRole('link', { name: `Download ${name}` }).getAttribute('href')).toBe(
      `http://gateway.test/hermes${file.url}?profile=researcher`
    )
  })

  it('keeps a name with a right-to-left run from reordering the size beside it', () => {
    const { container } = render(
      <Frame>
        <SharedFiles files={[sharedFile('file', 'מסמך.zip')]} />
      </Frame>
    )

    expect(container.querySelector('bdi')?.textContent).toBe('מסמך.zip')
  })

  it('draws nothing it cannot ask the gateway for: an address outside the gateway is a chip that says so', () => {
    const file = sharedFile('file', 'x.zip', { url: 'https://evil.test/api/files/outbox/x/x.zip' })

    render(
      <Frame>
        <SharedFiles files={[file]} />
      </Frame>
    )

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('x.zip')).toBeTruthy()
  })
})

describe('a PDF', () => {
  const pdfBytes = () => new Response('%PDF-1.4\n%%EOF', { headers: { 'content-type': 'application/pdf' } })

  it('opens in a tab of its own, from the bytes the page fetched and checked', async () => {
    const file = sharedFile('pdf', 'Q3 report.pdf')
    const address = `${ORIGIN}/${file.id}/Q3%20report.pdf?profile=researcher`
    const fetchImpl = fakeFetch({ [address]: pdfBytes })
    const target = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    const open = vi.fn(() => target)

    vi.stubGlobal('open', open)
    render(
      <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open Q3 report.pdf in a new tab' }))

    await waitFor(() => expect(target.location.href).toMatch(/^blob:/u))
    // The tab is opened in the press itself, and cut off from this page before anything is loaded in it.
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(target.opener).toBeNull()
    expect(fetchImpl).toHaveBeenCalledWith(
      address,
      expect.objectContaining({ headers: { 'x-hermes-session-token': 'tok' } })
    )
    expect(target.close).not.toHaveBeenCalled()
  })

  it('does not hand a file that says it is a PDF and is not to the browser’s viewer', async () => {
    const file = sharedFile('pdf', 'fake.pdf')
    const address = `${ORIGIN}/${file.id}/fake.pdf?profile=researcher`
    const target = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }

    vi.stubGlobal(
      'open',
      vi.fn(() => target)
    )
    render(
      <Frame host={hostWith({ outbox: tokenFiles(fakeFetch({ [address]: () => new Response('<html>') })) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open fake.pdf in a new tab' }))

    await screen.findByText('This file is not a PDF, so it was not opened.')
    expect(target.location.href).toBe('')
    expect(target.close).toHaveBeenCalled()
  })

  it('offers the download when the browser would not open a tab', async () => {
    vi.stubGlobal(
      'open',
      vi.fn(() => null)
    )
    render(
      <Frame host={hostWith({ outbox: tokenFiles(fakeFetch({})) })}>
        <SharedFiles files={[sharedFile('pdf', 'a.pdf')]} />
      </Frame>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open a.pdf in a new tab' }))

    await screen.findByText('The browser blocked the new tab. Allow it, or download the file.')
    expect(screen.getByRole('button', { name: 'Download a.pdf' })).toBeTruthy()
  })

  it('says a PDF the gateway no longer has is gone', async () => {
    const target = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }

    vi.stubGlobal(
      'open',
      vi.fn(() => target)
    )
    render(
      <Frame host={hostWith({ outbox: tokenFiles(fakeFetch({})) })}>
        <SharedFiles files={[sharedFile('pdf', 'old.pdf')]} />
      </Frame>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open old.pdf in a new tab' }))

    await screen.findByText('This file is no longer available.')
    expect(target.close).toHaveBeenCalled()
  })
})

describe('with the shared token (an element cannot send the header)', () => {
  it('fetches a picture with the header once it is near the screen and draws the blob', async () => {
    const file = sharedFile('image', 'sunrise.png')
    const address = `${ORIGIN}/${file.id}/sunrise.png?profile=researcher`
    const fetchImpl = fakeFetch({ [address]: () => new Response(new Blob(['png'], { type: 'image/png' })) })

    render(
      <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    const picture = await screen.findByRole('img', { name: 'sunrise.png' })

    expect(picture.getAttribute('src')).toBe('blob:http://gateway.test/1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'x-hermes-session-token': 'tok' },
      credentials: 'same-origin',
      redirect: 'manual'
    })
  })

  it('waits to be asked for a video, says what it costs, and plays what it fetched', async () => {
    const file = sharedFile('video', 'clip.mp4', { size: 5_000_000 })
    const address = `${ORIGIN}/${file.id}/clip.mp4?profile=researcher`
    const fetchImpl = fakeFetch({ [address]: () => new Response(new Blob(['mp4'], { type: 'video/mp4' })) })
    const { container } = render(
      <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    expect(container.querySelector('video')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Load (5 MB)' }))

    await waitFor(() =>
      expect(container.querySelector('video')?.getAttribute('src')).toBe('blob:http://gateway.test/1')
    )
    expect(container.querySelector('video')?.hasAttribute('controls')).toBe(true)
  })

  it('does not fetch what is too big to hold: a video that large is a download', () => {
    const file = sharedFile('video', 'huge.mp4', { size: 300 * 1024 * 1024 })
    const fetchImpl = fakeFetch({})

    render(
      <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    expect(screen.getByText('This file is too large to show here. Download it instead.')).toBeTruthy()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('saves a file by fetching it with the header, as a download of opaque bytes', async () => {
    const file = sharedFile('file', 'summary.html', { mime: 'text/html' })
    const address = `${ORIGIN}/${file.id}/summary.html?profile=researcher`
    const fetchImpl = fakeFetch({
      [address]: () => new Response(new Blob(['<script>x</script>'], { type: 'text/html' }))
    })

    render(
      <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    expect(screen.queryByRole('link')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download summary.html' }))
    })

    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1))

    const [blob, name] = saveBlob.mock.calls[0] as [Blob, string]

    expect(name).toBe('summary.html')
    expect(blob.type).toBe('application/octet-stream')
  })

  it('says a picture the gateway no longer has is gone, under its name', async () => {
    render(
      <Frame host={hostWith({ outbox: tokenFiles(fakeFetch({})) })}>
        <SharedFiles files={[sharedFile('image', 'old.png')]} />
      </Frame>
    )

    expect(await screen.findByText('This file is no longer available.')).toBeTruthy()
    expect(screen.getByText('old.png')).toBeTruthy()
  })

  it('gives the blob back when the row goes', async () => {
    const file = sharedFile('image', 'sunrise.png')
    const address = `${ORIGIN}/${file.id}/sunrise.png?profile=researcher`
    const { unmount } = render(
      <Frame host={hostWith({ outbox: tokenFiles(fakeFetch({ [address]: () => new Response(new Blob(['png'])) })) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    await screen.findByRole('img')
    unmount()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://gateway.test/1')
  })
})

describe('in the reply', () => {
  it('draws the files under the words, and a reply of nothing but a file is still a reply', () => {
    const file = sharedFile('audio', 'tone.mp3')
    const { container, rerender } = render(
      <Frame>
        <AssistantBubble item={assistantItem('Here is the recording.', { outbox: [file] })} presentation="full" />
      </Frame>
    )

    expect(screen.getByText('Here is the recording.')).toBeTruthy()
    expect(container.querySelector('audio')).toBeTruthy()

    rerender(
      <Frame>
        <AssistantBubble item={assistantItem('', { outbox: [file] })} presentation="full" />
      </Frame>
    )

    expect(container.querySelector('audio')).toBeTruthy()
    expect(container.querySelector('.hm-dots')).toBeNull()
  })

  it('shows the note about a file that could not be shared as the words it is', () => {
    render(
      <Frame>
        <AssistantBubble item={assistantItem('Here.\n\n(1 file could not be shared.)')} presentation="full" />
      </Frame>
    )

    expect(screen.getByText('(1 file could not be shared.)')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull()
  })

  it('keeps what it shows after the history comes back over the live reply', () => {
    const file = sharedFile('file', 'archive.zip')
    const live = assistantItem('Here.', { outbox: [file] }, 'a1')
    const { rerender } = render(
      <Frame>
        <AssistantBubble item={live} presentation="full" />
      </Frame>
    )

    // The same reply, as a reload of the history makes it.
    rerender(
      <Frame>
        <AssistantBubble
          item={{ ...assistantItem('Here.', { outbox: [{ ...file }] }, 'a1'), version: 2 }}
          presentation="full"
        />
      </Frame>
    )

    expect(screen.getByRole('link', { name: 'Download archive.zip' })).toBeTruthy()
  })
})

describe('in the reader’s language', () => {
  it('says what it says in Dutch', () => {
    setActiveLocale('nl')
    render(
      <Frame>
        <SharedFiles files={[sharedFile('file', 'a.zip'), sharedFile('pdf', 'b.pdf')]} />
      </Frame>
    )

    expect(screen.getByRole('list', { name: 'Bijlagen' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'a.zip downloaden' })).toBeTruthy()
    expect(
      within(screen.getByRole('list')).getByRole('button', { name: 'b.pdf openen in een nieuw tabblad' })
    ).toBeTruthy()
  })
})
