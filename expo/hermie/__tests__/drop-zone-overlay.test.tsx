/**
 * What the reader SEES while a file is held over the window, and what is
 * attached once they let go.
 *
 * The drag itself belongs to UIKit and cannot be produced here, so the native
 * view is stood in for: a plain `View` that keeps the three callbacks
 * `HermieDropView` fires. Everything above that line is ours, and all of it is
 * the part the owner reported on —
 *
 *  - an overlay while the file is over the region, saying what letting go does;
 *  - the overlay gone on exit, and gone on drop;
 *  - the files reaching the chat in the order they were dragged;
 *  - and the attachment then sitting INSIDE the composer's field, with the
 *    caret under it and a way to take it off again.
 */
import { fireEvent, screen } from '@testing-library/react-native'
import { Text, View } from 'react-native'

import { chatStrings, Composer } from '../src/chat-ui'
import { DropZone } from '../src/chat-ui/DropZone'
import type { ComposerAttachment } from '../src/chat-ui/types'
import { renderScreen } from './support/render'

type HostProps = {
  children?: React.ReactNode
  onDrop?: (event: { nativeEvent: { files?: unknown } }) => void
  onDropEnter?: () => void
  onDropExit?: () => void
  testID?: string
}

jest.mock('../src/platform/file-drop', () => {
  const actual = jest.requireActual('../src/platform/file-drop')
  const { View: RNView } = jest.requireActual('react-native')

  const Host = ({ children, onDrop, onDropEnter, onDropExit, testID }: HostProps) => (
    <RNView onDrop={onDrop} onDropEnter={onDropEnter} onDropExit={onDropExit} testID={testID}>
      {children}
    </RNView>
  )

  return { ...actual, HAS_NATIVE_FILE_DROP: true, nativeDropView: () => Host }
})

const FILES = [
  { uri: 'file:///tmp/hermie-drop/1/report.pdf', name: 'report.pdf', size: 2048, mimeType: 'application/pdf' },
  { uri: 'file:///tmp/hermie-drop/2/notes.md', name: 'notes.md', size: 90, mimeType: 'text/markdown' }
]

function mount(onFiles = jest.fn()) {
  renderScreen(
    <DropZone onFiles={onFiles}>
      <View testID="chat-body">
        <Text>A conversation</Text>
      </View>
    </DropZone>
  )

  return { onFiles, zone: screen.getByTestId('drop-zone') }
}

describe('the drop target', () => {
  it('shows nothing until a file is actually over the window', () => {
    mount()

    expect(screen.getByTestId('chat-body')).toBeTruthy()
    expect(screen.queryByTestId('drop-zone-overlay')).toBeNull()
  })

  it('says what letting go will do, over a dimmed conversation', () => {
    const { zone } = mount()

    fireEvent(zone, 'dropEnter')

    expect(screen.getByTestId('drop-zone-overlay')).toBeTruthy()
    expect(screen.getByTestId('drop-zone-dim')).toBeTruthy()
    expect(screen.getByText(chatStrings.drop.invitation)).toBeTruthy()
  })

  it('cannot take the drop it is advertising', () => {
    // An overlay that accepted the gesture would swallow the file. Every layer
    // of it is inert, including the label's own box.
    const { zone } = mount()

    fireEvent(zone, 'dropEnter')

    for (const id of ['drop-zone-overlay', 'drop-zone-dim', 'drop-zone-highlight']) {
      expect(screen.getByTestId(id).props.pointerEvents).toBe('none')
    }
  })

  it('takes the overlay off when the drag leaves', () => {
    const { zone } = mount()

    fireEvent(zone, 'dropEnter')
    fireEvent(zone, 'dropExit')

    expect(screen.queryByTestId('drop-zone-overlay')).toBeNull()
  })

  it('takes it off on the drop too, without waiting for an exit', () => {
    // UIKit fires both, and the order is its own; an overlay that waited for the
    // exit could sit on screen over the reply the drop produced.
    const { onFiles, zone } = mount()

    fireEvent(zone, 'dropEnter')
    fireEvent(zone, 'drop', { nativeEvent: { files: FILES } })

    expect(screen.queryByTestId('drop-zone-overlay')).toBeNull()
    expect(onFiles).toHaveBeenCalledWith(FILES)
  })

  it('says nothing to the chat about a drop that carried nothing', () => {
    const { onFiles, zone } = mount()

    fireEvent(zone, 'drop', { nativeEvent: { files: [] } })
    fireEvent(zone, 'drop', { nativeEvent: {} })

    expect(onFiles).not.toHaveBeenCalled()
  })
})

describe('what is attached, in the composer', () => {
  const file: ComposerAttachment = { id: 'f1', kind: 'file', name: 'report.pdf', size: 2048, status: 'ready' }
  const image: ComposerAttachment = { id: 'i1', kind: 'image', name: 'shot.png', uri: 'file:///tmp/shot.png' }

  const composer = (attachments: ComposerAttachment[], onRemoveAttachment = jest.fn()) => {
    renderScreen(
      <Composer
        attachments={attachments}
        onChangeText={jest.fn()}
        onRemoveAttachment={onRemoveAttachment}
        onSend={jest.fn()}
        testID="composer"
        value=""
      />
    )

    return { onRemoveAttachment }
  }

  it('sits INSIDE the field, above the caret', () => {
    // The owner's reference is iMessage: what is attached is part of the message
    // you are typing, not a strip parked above it. So the tray is a descendant
    // of the field, and the input is its sibling.
    composer([file])

    const field = screen.getByTestId('composer-field')
    const within = (testID: string) => field.findAllByProps({ testID }).length > 0

    expect(within('composer-attachments')).toBe(true)
    expect(within('composer-input')).toBe(true)
  })

  it('draws a file as a chip carrying its name', () => {
    composer([file])

    expect(screen.getByText('report.pdf')).toBeTruthy()
  })

  it('draws an image as a thumbnail rather than as its filename', () => {
    composer([image])

    expect(screen.getByTestId('composer-attachment-remove-i1')).toBeTruthy()
    expect(screen.queryByText('shot.png')).toBeNull()
  })

  it('offers a way to take it off again', () => {
    const { onRemoveAttachment } = composer([image])

    fireEvent.press(screen.getByTestId('composer-attachment-remove-i1'))

    expect(onRemoveAttachment).toHaveBeenCalledWith('i1')
  })

  it('shows nothing at all when nothing is attached', () => {
    composer([])

    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })
})

/**
 * The drop zone is not a hover zone.
 *
 * It wraps the whole conversation, so anything it showed on a POINTER event
 * would cover the transcript the moment the mouse entered the window — which is
 * the shape of a separate report about the Mac build. The overlay is bound to
 * the drag session's own callbacks and to nothing else, and this is the
 * JavaScript half of ruling it out: there is no hover handler anywhere in the
 * zone, so no pointer event has anything to reach.
 */
describe('the drop zone and a passing mouse', () => {
  it('carries no hover handler at all', () => {
    renderScreen(
      <DropZone onFiles={jest.fn()}>
        <Text>conversation</Text>
      </DropZone>
    )

    const hovered = screen.UNSAFE_root.findAll(
      node => typeof node.props?.onPointerEnter === 'function' || typeof node.props?.onPointerLeave === 'function'
    )

    expect(hovered).toEqual([])
  })

  it('shows nothing until a DRAG enters, and takes it away when the drag leaves', () => {
    renderScreen(
      <DropZone onFiles={jest.fn()} testID="zone">
        <Text>conversation</Text>
      </DropZone>
    )

    expect(screen.queryByTestId('zone-overlay')).toBeNull()

    fireEvent(screen.getByTestId('zone'), 'dropEnter')
    expect(screen.getByTestId('zone-overlay')).toBeTruthy()

    fireEvent(screen.getByTestId('zone'), 'dropExit')
    expect(screen.queryByTestId('zone-overlay')).toBeNull()
  })
})
