/**
 * The panel "Select text" opens.
 *
 * On a Mac it is a native `UITextView` over an `NSAttributedString`, which is
 * the only thing in UIKit that drag-selects rich text — and which nothing here
 * can exercise. What this suite covers is the half the test renderer sees: the
 * fallback tree, which is what an iPhone, an Android device and this process all
 * get, and which has to show the whole message rather than an empty panel.
 *
 * The run → style mapping is asserted directly, because it is the same table the
 * native side applies and a heading that arrives at body size would be the first
 * thing a reader noticed.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { runTextStyle, SelectTextOverlay } from '../src/chat-ui/SelectTextOverlay'
import { copyToClipboard } from '../src/platform/clipboard'
import { HAS_NATIVE_SELECTABLE_TEXT } from '../src/platform/selectable-text'
import { renderScreen } from './support/render'

jest.mock('../src/platform/clipboard', () => ({ copyToClipboard: jest.fn(() => true) }))

const MESSAGE = ['# Findings', '', 'The **socket** reconnects, and `retry` is capped.', '', '- once', '- twice'].join(
  '\n'
)

const PALETTE = { body: 17, codeBackground: '#eee', link: '#06f', muted: '#888', text: '#111' }

beforeEach(() => {
  jest.clearAllMocks()
})

describe('the select-text panel with no native view', () => {
  it('is the path this process, an iPhone and Android all take', () => {
    expect(HAS_NATIVE_SELECTABLE_TEXT).toBe(false)
  })

  it('shows the whole message rather than an empty panel', () => {
    renderScreen(<SelectTextOverlay markdown={MESSAGE} onClose={jest.fn()} />)

    expect(screen.getByTestId('select-text-panel')).toBeTruthy()
    expect(screen.queryByTestId('select-text-native')).toBeNull()

    for (const word of ['Findings', 'socket', 'retry', 'once', 'twice']) {
      expect(screen.getByText(word, { exact: false })).toBeTruthy()
    }
  })

  it('renders the body as ONE selectable text, not one per run', () => {
    // Separate `Text`s would each be their own selection on the platforms that
    // have one, and would break a paragraph's wrapping into boxes.
    renderScreen(<SelectTextOverlay markdown={MESSAGE} onClose={jest.fn()} />)

    expect(screen.getByTestId('select-text-body').props.selectable).toBe(true)
  })

  it('closes on Done', () => {
    const onClose = jest.fn()

    renderScreen(<SelectTextOverlay markdown={MESSAGE} onClose={onClose} />)
    fireEvent.press(screen.getByTestId('select-text-done'))

    expect(onClose).toHaveBeenCalled()
  })

  it('copies the message’s own characters on Copy all', () => {
    // The same string ⌘A then ⌘C would produce, for the platforms with no ⌘.
    renderScreen(<SelectTextOverlay markdown={MESSAGE} onClose={jest.fn()} />)
    fireEvent.press(screen.getByTestId('select-text-copy-all'))

    const copied = (copyToClipboard as jest.Mock).mock.calls[0]?.[0] as string

    expect(copied).toContain('Findings')
    expect(copied).toContain('• once')
    expect(copied).not.toContain('**')
  })
})

describe('a run’s style', () => {
  it('scales a heading and leaves the body alone', () => {
    expect(runTextStyle({ block: 'heading1', text: 'x' }, PALETTE).fontSize).toBeGreaterThan(PALETTE.body)
    expect(runTextStyle({ block: 'heading2', text: 'x' }, PALETTE).fontSize).toBeGreaterThan(PALETTE.body)
    expect(runTextStyle({ block: 'body', text: 'x' }, PALETTE).fontSize).toBe(PALETTE.body)
  })

  it('gives code a monospace family and a sunk background, inline or fenced', () => {
    expect(runTextStyle({ block: 'body', mono: true, text: 'x' }, PALETTE)).toMatchObject({
      backgroundColor: PALETTE.codeBackground
    })
    expect(runTextStyle({ block: 'code', text: 'x' }, PALETTE).fontFamily).toBeTruthy()
  })

  it('draws a quote in the muted ink and a link in the accent', () => {
    expect(runTextStyle({ block: 'quote', text: 'x' }, PALETTE).color).toBe(PALETTE.muted)
    expect(runTextStyle({ block: 'body', href: 'https://x.test', text: 'x' }, PALETTE)).toMatchObject({
      color: PALETTE.link,
      textDecorationLine: 'underline'
    })
  })

  it('strikes through a deletion, and does not also underline it', () => {
    expect(runTextStyle({ block: 'body', strike: true, text: 'x' }, PALETTE).textDecorationLine).toBe('line-through')
  })
})
