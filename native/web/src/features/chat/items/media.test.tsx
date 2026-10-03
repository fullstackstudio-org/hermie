/**
 * What a message carries besides its words, one view at a time: a diff, a file,
 * a picture and the gallery that lays them out. All of it is the gateway's or a
 * file system's text, so most of what is checked is what reaches the page and
 * what does not: no markup, no request to a host the reader did not choose.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../../../i18n/active-locale'
import { userItem } from '../../../test-support/chat-fixtures'
import { AttachmentGallery, gridColumns } from './AttachmentGallery'
import { ChatItem } from './ChatItem'
import { diffCounts, parseUnifiedDiff } from './diff'
import { DiffView } from './DiffView'
import { fileFamily, FileChip, formatBytes, middleTruncate } from './FileChip'
import { gatewayImageSrc, ImageCard } from './ImageCard'
import { ItemContext } from './item-context'
import { DETACHED_ITEM_HOST, type ItemHost, ItemHostContext } from './item-host'

const BASE = 'http://gateway.test/hermes'

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

const DIFF = [
  'diff --git a/notes.md b/notes.md',
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -3,3 +3,4 @@ heading',
  ' kept',
  '-gone <b>bold</b>',
  '+new one',
  '+new two',
  ' tail',
  '\\ No newline at end of file',
  ''
].join('\n')

describe('reading a unified diff', () => {
  it('numbers both sides from the hunk header and tells headers from code', () => {
    const lines = parseUnifiedDiff(DIFF)

    expect(lines.map(line => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'delete',
      'add',
      'add',
      'context',
      'meta'
    ])
    expect(lines[4]).toMatchObject({ oldLine: 3, newLine: 3, text: 'kept' })
    expect(lines[5]).toMatchObject({ oldLine: 4, text: 'gone <b>bold</b>' })
    expect(lines[6]).toMatchObject({ newLine: 4, text: 'new one' })
    expect(lines[8]).toMatchObject({ oldLine: 5, newLine: 6 })
    expect(diffCounts(lines)).toEqual({ added: 2, removed: 1 })
  })

  it('drops the empty tail a diff ends on, and only that', () => {
    expect(parseUnifiedDiff(' a\n\n')).toHaveLength(2)
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('a diff view', () => {
  it('marks added and removed lines for assistive technology, not only by colour', () => {
    const { container } = render(<DiffView diff={DIFF} />)

    const added = [...container.querySelectorAll('ins')].map(node => node.textContent)
    const removed = [...container.querySelectorAll('del')].map(node => node.textContent)

    expect(added).toEqual(['Added: new one', 'Added: new two'])
    expect(removed).toEqual(['Removed: gone <b>bold</b>'])
    // The bot's text is characters: the angle brackets are text, not an element.
    expect(container.querySelector('b')).toBeNull()
    // The gutter and the markers are decoration.
    for (const node of container.querySelectorAll('.hm-diff__gutter, .hm-diff__marker')) {
      expect(node.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('names its scroll area by what it holds (a group, not a landmark: a chat holds many diffs), and the region takes the keyboard', () => {
    render(<DiffView diff={DIFF} />)

    const region = screen.getByRole('group', { name: '2 lines added, 1 removed' })

    expect(region.tabIndex).toBe(0)
    expect(screen.getByText('2 lines added, 1 removed').tagName).toBe('FIGCAPTION')
  })

  it('counts the lines it left out, in the reader’s language', () => {
    setActiveLocale('nl')
    render(<DiffView diff={DIFF} maxLines={4} />)

    expect(screen.getByText('6 regels meer niet getoond')).toBeTruthy()
    expect(screen.getByRole('group', { name: '2 regels toegevoegd, 1 verwijderd' })).toBeTruthy()
  })

  it('draws nothing for an empty diff', () => {
    const { container } = render(<DiffView diff="" />)

    expect(container.textContent).toBe('')
  })
})

describe('a file chip', () => {
  it('keeps the tail of a long name for the eye and gives assistive technology the whole name', () => {
    const name = 'quarterly-report-of-the-finance-team-final-v4.xlsx'
    const { container } = render(<FileChip name={name} />)

    const short = container.querySelector('bdi[aria-hidden="true"]')?.textContent ?? ''

    expect(short.endsWith('final-v4.xlsx')).toBe(true)
    expect(short).toContain('…')
    expect(container.querySelector('.hm-sr')?.textContent).toBe(name)
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(name)
    expect(middleTruncate('short.txt')).toBe('short.txt')
  })

  it('shows a short name whole, isolated, with no tooltip and its size in the reader’s units', () => {
    const { container } = render(<FileChip name="report.pdf" size={1536} />)

    expect(container.querySelector('bdi')?.textContent).toBe('report.pdf')
    expect(container.querySelector('[title]')).toBeNull()
    expect(screen.getByText(formatBytes(1536))).toBeTruthy()
    expect(formatBytes(1536)).toMatch(/1[.,]5/u)
    expect(formatBytes(999)).toMatch(/999/u)
    expect(formatBytes(-1)).toBe('')
  })

  it('cleans a name of control and format characters before it is drawn', () => {
    const { container } = render(<FileChip name={'evil‮txt.exe\u0007'} />)

    expect(container.querySelector('bdi')?.textContent).toBe('eviltxt.exe')
  })

  it('tells a picture from a document by its extension', () => {
    expect(fileFamily('shot.PNG')).toBe('image')
    expect(fileFamily('notes.md')).toBe('document')
    expect(fileFamily('no-extension')).toBe('document')
  })

  it('shows an upload’s progress, named by the file, determinate or not', () => {
    const { container, rerender } = render(<FileChip name="big.zip" size={10} status="uploading" progress={0.4} />)

    const bar = screen.getByRole('progressbar', { name: 'big.zip' }) as HTMLProgressElement

    expect(bar.value).toBeCloseTo(0.4)
    // The size gives way to the bar while it uploads.
    expect(container.querySelector('.hm-file__detail')).toBeNull()

    rerender(<FileChip name="big.zip" status="uploading" />)
    expect(screen.getByRole('progressbar', { name: 'big.zip' }).hasAttribute('value')).toBe(false)
  })

  it('says why a file was refused, in the danger state', () => {
    const { container } = render(<FileChip name="huge.mov" status="error" error="Too large · 20 MB max" />)

    expect(container.querySelector('.hm-file')?.getAttribute('data-state')).toBe('error')
    expect(screen.getByText('Too large · 20 MB max')).toBeTruthy()
  })

  it('offers to take the file out, the button described by the file it removes', () => {
    const onRemove = vi.fn()

    render(<FileChip name="a.txt" onRemove={onRemove} />)

    const remove = screen.getByRole('button', { name: 'Remove attachment' })

    expect(remove.getAttribute('aria-describedby')).toBe(screen.getByText('a.txt').closest('[id]')?.id)
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('is a control only where the host can open the file', () => {
    const onOpen = vi.fn()
    const { rerender } = render(<FileChip name="a.txt" />)

    expect(screen.queryByRole('button')).toBeNull()

    rerender(<FileChip name="a.txt" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'a.txt' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('where a picture may come from', () => {
  it('loads from the gateway’s origin, under its base path, and nowhere else', () => {
    // A path is the gateway's: joined onto the base, prefix and all, as a picture in a message is.
    expect(gatewayImageSrc('/api/media/a.png', BASE)).toBe('http://gateway.test/hermes/api/media/a.png')
    expect(gatewayImageSrc('api/media/a.png', BASE)).toBe('http://gateway.test/hermes/api/media/a.png')
    expect(gatewayImageSrc('http://gateway.test/hermes/x.png', BASE)).toBe('http://gateway.test/hermes/x.png')

    for (const refused of [
      'http://gateway.test/other/x.png',
      'https://elsewhere.example/x.png',
      '//elsewhere.example/x.png',
      'http://user:pw@gateway.test/hermes/x.png',
      'javascript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'data:text/html;base64,PGI+',
      'data:image/png,not-base64',
      '/../admin/x.png',
      'file:///etc/passwd',
      '',
      undefined
    ]) {
      expect(gatewayImageSrc(refused, BASE), String(refused)).toBeNull()
    }

    expect(gatewayImageSrc('/api/a.png', undefined)).toBeNull()
  })

  it('takes a raster thumbnail the page made of a picked file', () => {
    expect(gatewayImageSrc('data:image/png;base64,iVBORw0KGgo=', BASE)).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(gatewayImageSrc('data:image/jpeg;base64,/9j/4AAQ', BASE)).toBe('data:image/jpeg;base64,/9j/4AAQ')
  })

  it('takes a blob URL this page made, and refuses one of another origin', () => {
    expect(gatewayImageSrc('blob:http://gateway.test/1234-5678', BASE)).toBe('blob:http://gateway.test/1234-5678')
    expect(gatewayImageSrc('blob:https://elsewhere.example/1234', BASE)).toBeNull()
    expect(gatewayImageSrc('blob:null/1234', BASE)).toBeNull()
  })
})

describe('an image card', () => {
  it('is a button named by the file that hands itself to the opener', () => {
    const onOpen = vi.fn()

    render(
      <Frame>
        <ImageCard src="/api/media/shot.png" name="shot.png" onOpen={onOpen} />
      </Frame>
    )

    const button = screen.getByRole('button', { name: 'shot.png' })
    const image = within(button).getByRole('img', { name: 'shot.png' }) as HTMLImageElement

    expect(image.src).toBe('http://gateway.test/hermes/api/media/shot.png')
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith(button)
  })

  it('is the file chip for a source off the gateway, and requests nothing', () => {
    const { container } = render(
      <Frame>
        <ImageCard src="https://tracker.example/pixel.png" name="pixel.png" onOpen={vi.fn()} />
      </Frame>
    )

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('pixel.png')).toBeTruthy()
  })

  it('becomes the file chip when the picture does not load', () => {
    const { container } = render(
      <Frame>
        <ImageCard src="/api/media/gone.png" name="gone.png" />
      </Frame>
    )

    fireEvent.error(container.querySelector('img') as HTMLImageElement)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.hm-file')).not.toBeNull()
  })
})

describe('the attachment gallery', () => {
  it('lays out pictures two, three or one across, by how many there are', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(gridColumns)).toEqual([1, 1, 2, 3, 2, 3, 3])
  })

  it('draws every attachment as a chip when the host has nothing to load', () => {
    render(
      <Frame>
        <AttachmentGallery
          attachments={[
            { reference: '@image:/srv/a.png', name: 'a.png' },
            { reference: '@file:/srv/b.pdf', name: 'b.pdf', size: 2048 }
          ]}
        />
      </Frame>
    )

    const list = screen.getByRole('list', { name: 'Attachments' })

    expect(list.getAttribute('data-columns')).toBe('1')
    expect(within(list).queryByRole('img')).toBeNull()
    expect(
      within(list)
        .getAllByRole('listitem')
        .map(item => item.getAttribute('data-kind'))
    ).toEqual(['file', 'file'])
  })

  it('draws a picture where the host has one on the gateway, opens it in the viewer, and keeps files in a row of their own', () => {
    const openImage = vi.fn()
    const host = hostWith({
      attachmentSrc: reference =>
        reference.endsWith('.png') ? `http://gateway.test/hermes/api/media/${reference.split('/').pop()}` : undefined,
      openImage
    })

    render(
      <Frame host={host}>
        <AttachmentGallery
          attachments={[
            { reference: '@image:/srv/a.png', name: 'a.png' },
            { reference: '@image:/srv/b.png', name: 'b.png' },
            { reference: '@file:/srv/c.pdf', name: 'c.pdf' }
          ]}
        />
      </Frame>
    )

    const list = screen.getByRole('list', { name: 'Attachments' })

    expect(list.getAttribute('data-columns')).toBe('2')
    expect(
      within(list)
        .getAllByRole('listitem')
        .map(item => item.getAttribute('data-kind'))
    ).toEqual(['image', 'image', 'file'])

    const first = screen.getByRole('button', { name: 'a.png' })

    fireEvent.click(first)
    expect(openImage).toHaveBeenCalledWith({ src: 'http://gateway.test/hermes/api/media/a.png', name: 'a.png' }, first)
  })

  it('refuses a source the host offers from somewhere else', () => {
    const host = hostWith({ attachmentSrc: () => 'https://elsewhere.example/a.png' })
    const { container } = render(
      <Frame host={host}>
        <AttachmentGallery attachments={[{ reference: '@image:/srv/a.png', name: 'a.png' }]} />
      </Frame>
    )

    expect(container.querySelector('img')).toBeNull()
  })

  it('is what a user bubble draws its attachments with, in the bubble’s own ink', () => {
    const { container } = render(
      <Frame>
        <ChatItem row={{ item: userItem('see', { attachments: ['@file:/srv/report.pdf'] }), presentation: 'full' }} />
      </Frame>
    )

    expect(container.querySelector('.hm-gallery .hm-file')?.getAttribute('data-on-accent')).toBe('true')
  })
})
