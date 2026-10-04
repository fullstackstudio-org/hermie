/**
 * The files a bot shared with a reply, one kind at a time (`contract/outbox/`): a picture is a thumbnail that
 * opens the viewer (and several are a grid), a video and a sound are players that seek, a PDF is a card whose action
 * is a download, and any other file is a chip with its name, its size and a download. With the cookie session the address is
 * the element's `src`; with the shared token the page fetches the bytes with the header and hands the element a
 * `blob:` URL. The name is the sender's text and never becomes markup.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { OUTBOX_OFFSCREEN_RELEASE_MS } from './use-outbox-source'

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
/** The page's own `URL.createObjectURL` and `revokeObjectURL` (absent in jsdom), put back after each test. */
const realUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }

beforeEach(() => {
  blobCounter = 0
  saveBlob.mockReset()
  URL.createObjectURL = vi.fn(() => `blob:http://gateway.test/${(blobCounter += 1)}`)
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  // Unmount first: a row gives its blob back as it goes, through the `URL` this file replaced.
  cleanup()
  resetActiveLocale()
  vi.unstubAllGlobals()
  URL.createObjectURL = realUrl.create
  URL.revokeObjectURL = realUrl.revoke
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

describe('with no gateway to ask (a cron run)', () => {
  it('names every file and its size and offers nothing to press, whatever its kind', () => {
    const open = vi.fn()

    vi.stubGlobal('open', open)
    render(
      <ItemContext.Provider
        value={{ botName: 'Cron', gatewayBaseUrl: undefined, ownAuthorId: undefined, groupChat: false }}
      >
        <SharedFiles
          files={[
            sharedFile('image', 'a.png'),
            sharedFile('video', 'b.mp4'),
            sharedFile('audio', 'c.mp3'),
            sharedFile('pdf', 'd.pdf'),
            sharedFile('file', 'e.zip')
          ]}
        />
      </ItemContext.Provider>
    )

    for (const name of ['a.png', 'b.mp4', 'c.mp3', 'd.pdf', 'e.zip']) {
      expect(screen.getByText(name)).toBeTruthy()
    }

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('The file could not be loaded.')).toBeNull()
  })
})

describe('a PDF', () => {
  it('is a card with its name, its size and a download, never a page opened in this origin', () => {
    const file = sharedFile('pdf', 'Q3 report.pdf', { size: 120_000 })
    const open = vi.fn()

    vi.stubGlobal('open', open)
    render(
      <Frame>
        <SharedFiles files={[file]} />
      </Frame>
    )

    const link = screen.getByRole('link', { name: 'Download Q3 report.pdf' })

    // The cookie session: the address is the link, and the route answers it as an attachment.
    expect(link.getAttribute('href')).toBe(`${ORIGIN}/${file.id}/Q3%20report.pdf?profile=researcher`)
    expect(link.getAttribute('download')).toBe('Q3 report.pdf')
    expect(screen.getByText('Q3 report.pdf')).toBeTruthy()
    expect(screen.getByText('120 kB')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /open/iu })).toBeNull()

    // jsdom cannot navigate; the click is only to see that nothing is opened.
    link.addEventListener('click', event => event.preventDefault())
    fireEvent.click(link)

    expect(open).not.toHaveBeenCalled()
  })

  it('is saved from the bytes the page fetched, as opaque bytes, with the shared token', async () => {
    const file = sharedFile('pdf', 'Q3 report.pdf')
    const address = `${ORIGIN}/${file.id}/Q3%20report.pdf?profile=researcher`
    const fetchImpl = fakeFetch({
      [address]: () => new Response(new Blob(['%PDF-1.4'], { type: 'application/pdf' }))
    })
    const open = vi.fn()

    vi.stubGlobal('open', open)
    render(
      <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    expect(screen.queryByRole('link')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download Q3 report.pdf' }))
    })
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1))

    const [blob, name] = saveBlob.mock.calls[0] as [Blob, string]

    expect(name).toBe('Q3 report.pdf')
    expect(blob.type).toBe('application/octet-stream')
    expect(fetchImpl).toHaveBeenCalledWith(
      address,
      expect.objectContaining({ headers: { 'x-hermes-session-token': 'tok' } })
    )
    // No tab, no blob address of a PDF for a viewer to run in this page's origin.
    expect(open).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('says a PDF the gateway no longer has is gone', async () => {
    render(
      <Frame host={hostWith({ outbox: tokenFiles(fakeFetch({})) })}>
        <SharedFiles files={[sharedFile('pdf', 'old.pdf')]} />
      </Frame>
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download old.pdf' }))
    })

    await screen.findByText('This file is no longer available.')
    expect(saveBlob).not.toHaveBeenCalled()
  })

  it('says a PDF too large to hold is too large to save, not that it should be downloaded', async () => {
    const file = sharedFile('pdf', 'big.pdf')
    const address = `${ORIGIN}/${file.id}/big.pdf?profile=researcher`
    const fetchImpl = fakeFetch({
      [address]: () => new Response('x', { headers: { 'content-length': String(300 * 1024 * 1024) } })
    })

    render(
      <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download big.pdf' }))
    })

    await screen.findByText('This file is too large to save from here.')
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

  /** The type of the blob the page made for the one file it fetched. */
  const blobTypeFor = async (kind: 'image' | 'video' | 'audio', name: string, answered: string) => {
    const file = sharedFile(kind, name, { size: 1000 })
    const address = `${ORIGIN}/${file.id}/${encodeURIComponent(name)}?profile=researcher`
    const fetchImpl = fakeFetch({ [address]: () => new Response('x', { headers: { 'content-type': answered } }) })
    const { container } = render(
      <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
        <SharedFiles files={[file]} />
      </Frame>
    )

    if (kind !== 'image') {
      fireEvent.click(screen.getByRole('button', { name: /^Load/u }))
    }

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1))
    expect(container.querySelector(kind === 'image' ? 'img' : kind)).toBeTruthy()

    return (vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob).type
  }

  it.each([
    ['image', 'a.png', 'image/png', 'image/png'],
    ['image', 'a.jpg', 'image/jpeg', 'image/jpeg'],
    ['image', 'a.png', 'image/svg+xml', 'application/octet-stream'],
    ['image', 'a.png', 'text/html', 'application/octet-stream'],
    ['image', 'a.png', 'text/html; charset=utf-8', 'application/octet-stream'],
    ['image', 'a.png', 'video/mp4', 'application/octet-stream'],
    ['image', 'a.png', '', 'application/octet-stream'],
    ['video', 'a.mp4', 'video/mp4', 'video/mp4'],
    ['video', 'a.mp4', 'text/html', 'application/octet-stream'],
    ['video', 'a.mp4', 'image/svg+xml', 'application/octet-stream'],
    ['video', 'a.mp4', 'audio/mpeg', 'application/octet-stream'],
    ['audio', 'a.mp3', 'audio/mpeg', 'audio/mpeg'],
    ['audio', 'a.mp3', 'text/html', 'application/octet-stream'],
    ['audio', 'a.mp3', 'image/svg+xml', 'application/octet-stream'],
    ['audio', 'a.mp3', 'video/mp4', 'application/octet-stream']
  ] as const)('makes the blob of a %s (%s) answered as %j typed %j', async (kind, name, answered, expected) => {
    expect(await blobTypeFor(kind, name, answered)).toBe(expected)
  })

  describe('a picture that has been out of sight for a while', () => {
    type Callback = (entries: { isIntersecting: boolean }[]) => void
    const observers: { callback: Callback; disconnected: boolean }[] = []

    beforeEach(() => {
      observers.length = 0
      vi.useFakeTimers({ shouldAdvanceTime: true })
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          readonly record: { callback: Callback; disconnected: boolean }

          constructor(callback: Callback) {
            this.record = { callback, disconnected: false }
            observers.push(this.record)
          }

          observe() {}

          disconnect() {
            this.record.disconnected = true
          }
        }
      )
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const report = (near: boolean) =>
      act(() => {
        const live = observers.filter(observer => !observer.disconnected).at(-1)

        live?.callback([{ isIntersecting: near }])
      })

    it('gives its blob back, and fetches it again when the row comes near the screen', async () => {
      const file = sharedFile('image', 'sunrise.png')
      const address = `${ORIGIN}/${file.id}/sunrise.png?profile=researcher`
      const fetchImpl = fakeFetch({
        [address]: () => new Response('png', { headers: { 'content-type': 'image/png' } })
      })

      render(
        <Frame host={hostWith({ outbox: tokenFiles(fetchImpl) })}>
          <SharedFiles files={[file]} />
        </Frame>
      )

      // Not asked for while it is far from the screen.
      expect(fetchImpl).not.toHaveBeenCalled()
      report(true)
      await screen.findByRole('img', { name: 'sunrise.png' })
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // Out of sight, but not for long: nothing is given back yet.
      report(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OUTBOX_OFFSCREEN_RELEASE_MS - 1000)
      })
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()

      // Back before the time is up: it is kept, and the wait starts over.
      report(true)
      report(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OUTBOX_OFFSCREEN_RELEASE_MS - 1000)
      })
      expect(URL.revokeObjectURL).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://gateway.test/1')
      expect(screen.queryByRole('img')).toBeNull()

      // Near the screen again: it is asked for again, and drawn from a new blob.
      report(true)
      await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
      expect((await screen.findByRole('img', { name: 'sunrise.png' })).getAttribute('src')).toBe(
        'blob:http://gateway.test/2'
      )
    })
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
    expect(within(screen.getByRole('list')).getByRole('link', { name: 'b.pdf downloaden' })).toBeTruthy()
  })
})
