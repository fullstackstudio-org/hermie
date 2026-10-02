/**
 * Attachments in a bubble: pictures as image cards, everything else as a chip,
 * and the grid the pictures share.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { StyleSheet } from 'react-native'

import { AttachmentGallery, GALLERY_GRID_HEIGHT, gridColumns, UserBubble } from '../../src/chat-ui'
import type { UserItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

const userItem = (attachments: string[], text = ''): UserItem => ({
  id: 'u1',
  kind: 'user',
  origin: 'history',
  seq: 1,
  text,
  attachments,
  ts: 1_767_000_001,
  version: 1
})

const picture = (name: string) => ({ name, reference: `@image:/srv/${name}`, uri: `file:///tmp/${name}` })

describe('gridColumns', () => {
  it('gives a lone picture the whole width', () => {
    expect(gridColumns(0)).toBe(1)
    expect(gridColumns(1)).toBe(1)
  })

  it('puts a pair two across and a trio three across', () => {
    expect(gridColumns(2)).toBe(2)
    expect(gridColumns(3)).toBe(3)
  })

  it('keeps four as two rows of two rather than three and a widow', () => {
    expect(gridColumns(4)).toBe(2)
  })

  it('settles at three across beyond that', () => {
    expect(gridColumns(5)).toBe(3)
    expect(gridColumns(9)).toBe(3)
  })
})

describe('AttachmentGallery', () => {
  it('draws a picture the app can load as an image card', () => {
    renderScreen(<AttachmentGallery attachments={[picture('shot.png')]} testID="g" />)

    expect(screen.getByTestId('g-0-image')).toBeTruthy()
  })

  it('draws a picture it cannot load as a chip instead of a grey rectangle', () => {
    // No `uri`: the reference is a path on the gateway's disk and nothing here
    // can fetch it. A chip says something true; an <Image> would draw a hole.
    renderScreen(
      <AttachmentGallery attachments={[{ name: 'shot.png', reference: '@image:/srv/shot.png' }]} testID="g" />
    )

    expect(screen.queryByTestId('g-0-image')).toBeNull()
    expect(screen.getByText('shot.png')).toBeTruthy()
  })

  it('lays three pictures out three across', () => {
    renderScreen(<AttachmentGallery attachments={[picture('a.png'), picture('b.png'), picture('c.png')]} testID="g" />)

    expect(screen.getByTestId('g-0-image')).toBeTruthy()
    expect(screen.getByTestId('g-2-image')).toBeTruthy()
  })

  it('keeps a file on a full-width row beside the pictures', () => {
    // A filename squeezed into a third of a bubble is a filename nobody can
    // read, so only pictures are cut into columns.
    renderScreen(
      <AttachmentGallery
        attachments={[picture('a.png'), picture('b.png'), { name: 'report.pdf', reference: '@file:/srv/report.pdf' }]}
        testID="g"
      />
    )

    expect(screen.queryByTestId('g-2-image')).toBeNull()
    expect(screen.getByText('report.pdf')).toBeTruthy()
  })

  it('opens a picture when it is given somewhere to open it', () => {
    const onOpen = jest.fn()

    renderScreen(<AttachmentGallery attachments={[picture('shot.png')]} onOpen={onOpen} testID="g" />)

    fireEvent.press(screen.getByTestId('g-0'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'shot.png' }))
  })

  it('opens a file through the same handler', () => {
    const onOpen = jest.fn()

    renderScreen(
      <AttachmentGallery
        attachments={[{ name: 'report.pdf', reference: '@file:/srv/report.pdf' }]}
        onOpen={onOpen}
        testID="g"
      />
    )

    fireEvent.press(screen.getByTestId('g-0-open'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'report.pdf' }))
  })

  it('draws nothing at all for a message with no attachments', () => {
    renderScreen(<AttachmentGallery attachments={[]} testID="g" />)

    expect(screen.queryByTestId('g')).toBeNull()
  })
})

describe('UserBubble attachments', () => {
  it('shows a chip, never the raw reference the gateway needs', () => {
    renderScreen(<UserBubble item={userItem(['@file:/srv/uploads/report.pdf'], 'Have a look')} />)

    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(screen.queryByText(/@file:/)).toBeNull()
  })

  it('draws the picture once the screen says it still has the bytes', () => {
    renderScreen(
      <UserBubble
        attachmentUri={reference => (reference.endsWith('shot.png') ? 'file:///tmp/shot.png' : undefined)}
        item={userItem(['@image:/srv/uploads/shot.png'])}
      />
    )

    expect(screen.getByTestId('user-file-u1-0-image')).toBeTruthy()
  })

  it('falls back to a chip when the bytes are gone', () => {
    // The ordinary case for anything not sent from this device this session.
    renderScreen(<UserBubble attachmentUri={() => undefined} item={userItem(['@image:/srv/uploads/shot.png'])} />)

    expect(screen.queryByTestId('user-file-u1-0-image')).toBeNull()
    expect(screen.getByText('shot.png')).toBeTruthy()
  })

  it('matches the reference the gateway echoes back, not the one sent', () => {
    // An optimistic bubble carries `@image:shot.png`; the persisted row carries
    // the full path. Both have to resolve to the same local picture.
    const resolve = (reference: string) => (reference.endsWith('shot.png') ? 'file:///tmp/shot.png' : undefined)

    renderScreen(<UserBubble attachmentUri={resolve} item={userItem(['@image:shot.png'])} />)

    expect(screen.getByTestId('user-file-u1-0-image')).toBeTruthy()
  })
})

/**
 * The two card shapes, which is the difference between a grid and a picture.
 *
 * iMessage crops in a grid and contains on its own, and the reason is not
 * taste: uniform cells are what makes a grid read as a grid, while a lone
 * screenshot cropped to a card's aspect loses the part it was attached to show.
 */
describe('the image card shape', () => {
  const styleOf = (testID: string) =>
    StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as Record<string, unknown>

  it('crops a grid cell to a fixed height', () => {
    renderScreen(<AttachmentGallery attachments={[picture('a.png'), picture('b.png')]} testID="g" />)

    expect(styleOf('g-0-frame').height).toBe(GALLERY_GRID_HEIGHT)
    expect(screen.getByTestId('g-0-image').props.resizeMode).toBe('cover')
  })

  it('contains a lone picture and caps how tall it may grow', () => {
    renderScreen(<AttachmentGallery attachments={[picture('a.png')]} testID="g" />)

    expect(screen.getByTestId('g-0-image').props.resizeMode).toBe('contain')
    expect(styleOf('g-0-frame').maxHeight).toBeDefined()
  })

  it('takes the pictures own ratio once the image reports it', () => {
    renderScreen(<AttachmentGallery attachments={[picture('a.png')]} testID="g" />)

    // Before the load event there is no ratio, so the card sits at its ceiling
    // rather than collapsing to nothing.
    expect(styleOf('g-0-frame').aspectRatio).toBeUndefined()

    fireEvent(screen.getByTestId('g-0-image'), 'load', { nativeEvent: { source: { height: 200, width: 400 } } })

    expect(styleOf('g-0-frame').aspectRatio).toBe(2)
  })

  it('ignores a load event that reports nothing usable', () => {
    renderScreen(<AttachmentGallery attachments={[picture('a.png')]} testID="g" />)

    fireEvent(screen.getByTestId('g-0-image'), 'load', { nativeEvent: { source: { height: 0, width: 0 } } })

    expect(styleOf('g-0-frame').aspectRatio).toBeUndefined()
  })
})
