/**
 * The full-screen image viewer: its two gestures, and the chrome around them.
 *
 * The gesture MATHS is tested directly rather than by synthesising touch
 * streams. `PanResponder` resolves through the responder negotiation, which a
 * test renderer does not run, so driving it here would assert the harness. The
 * pure functions are where the rules actually live.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import {
  clampScale,
  DISMISS_FRACTION,
  ImageViewer,
  MAX_SCALE,
  MIN_SCALE,
  pinchDistance,
  shouldDismiss
} from '../../src/chat-ui'
import { renderScreen } from '../support/render'

jest.mock('../../src/platform/share-file', () => ({
  SHARE_FILE_VERB: 'share',
  shareFile: jest.fn(async () => true)
}))

const { shareFile } = jest.requireMock('../../src/platform/share-file') as { shareFile: jest.Mock }

beforeEach(() => shareFile.mockClear())

describe('the pinch', () => {
  it('measures the gap between two fingers', () => {
    expect(
      pinchDistance([
        { pageX: 0, pageY: 0 },
        { pageX: 3, pageY: 4 }
      ])
    ).toBe(5)
  })

  it('has no answer for fewer than two', () => {
    // Which is what makes "two fingers is a pinch, one is a drag" decidable
    // without a recogniser: a zero distance means the gesture is not a pinch.
    expect(pinchDistance([])).toBe(0)
    expect(pinchDistance([{ pageX: 10, pageY: 10 }])).toBe(0)
  })

  it('never zooms out past the fit or in past the cap', () => {
    expect(clampScale(0.2)).toBe(MIN_SCALE)
    expect(clampScale(99)).toBe(MAX_SCALE)
    expect(clampScale(2.5)).toBe(2.5)
  })
})

describe('the dismiss drag', () => {
  const height = 800

  it('closes past a third of the screen', () => {
    expect(shouldDismiss(height * DISMISS_FRACTION + 1, height, 1)).toBe(true)
  })

  it('springs back short of it', () => {
    expect(shouldDismiss(height * DISMISS_FRACTION - 1, height, 1)).toBe(false)
  })

  it('closes on an upward drag too', () => {
    expect(shouldDismiss(-(height * DISMISS_FRACTION + 1), height, 1)).toBe(true)
  })

  it('never closes a zoomed image', () => {
    // At that point one finger is panning the picture. Closing instead would
    // put the corners of a zoomed image permanently out of reach.
    expect(shouldDismiss(height, height, 2)).toBe(false)
  })
})

describe('ImageViewer', () => {
  it('is not in the tree at all without an image', () => {
    renderScreen(<ImageViewer onClose={jest.fn()} uri={null} />)

    expect(screen.queryByTestId('image-viewer')).toBeNull()
  })

  it('shows the image and names it', () => {
    renderScreen(<ImageViewer name="shot.png" onClose={jest.fn()} uri="file:///tmp/shot.png" />)

    expect(screen.getByTestId('image-viewer-image')).toBeTruthy()
    expect(screen.getByText('shot.png')).toBeTruthy()
  })

  it('closes from the button', () => {
    const onClose = jest.fn()

    renderScreen(<ImageViewer onClose={onClose} uri="file:///tmp/shot.png" />)

    fireEvent.press(screen.getByTestId('image-viewer-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes from the backdrop, the way a lightbox does', () => {
    const onClose = jest.fn()

    renderScreen(<ImageViewer onClose={onClose} uri="file:///tmp/shot.png" />)

    fireEvent.press(screen.getByTestId('image-viewer-backdrop'))
    expect(onClose).toHaveBeenCalled()
  })

  it('hands the image to the system, with its name', () => {
    renderScreen(<ImageViewer name="shot.png" onClose={jest.fn()} uri="file:///tmp/shot.png" />)

    fireEvent.press(screen.getByTestId('image-viewer-share'))
    expect(shareFile).toHaveBeenCalledWith('file:///tmp/shot.png', 'shot.png')
  })

  it('calls the share action by the verb this platform actually performs', () => {
    // A browser cannot open a share sheet and downloads instead; labelling that
    // button "Share" would promise a sheet that is not coming.
    renderScreen(<ImageViewer onClose={jest.fn()} uri="file:///tmp/shot.png" />)

    expect(screen.getByTestId('image-viewer-share').props.accessibilityLabel).toBe('Share image')
  })
})
