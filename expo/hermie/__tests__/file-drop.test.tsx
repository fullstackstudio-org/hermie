/**
 * Files dragged onto the chat, on the half that can be checked here.
 *
 * Nobody in this process can drag a file out of a Finder, so the native half of
 * `modules/hermie-drop` is unverified by construction — see the drag-and-drop
 * section of docs/platform-notes.md for what has to be tried in a Mac window.
 * What IS checkable is everything between the bridge and the upload:
 *
 *  - the payload normalisation, which takes `[[String: Any]]` — that is, anything
 *    — and must never throw while a chat is open;
 *  - the mapping onto the shape the document picker already produces, so the drop
 *    feeds the pipeline the `+` menu built rather than a second one;
 *  - and that a platform with no native view renders its children bare, which is
 *    every platform but an iPad and a Mac.
 */
import { render, screen } from '@testing-library/react-native'
import { Text, View } from 'react-native'

import { DropZone } from '../src/chat-ui/DropZone'
import { droppedFile } from '../src/features/chats/file-attachments'
import { HAS_NATIVE_FILE_DROP, normaliseDroppedFiles } from '../src/platform/file-drop'
import { ThemeProvider } from '../src/ui/theme'

describe('reading a drop payload back', () => {
  it('takes the four fields the native side promises', () => {
    expect(
      normaliseDroppedFiles([
        { uri: 'file:///tmp/hermie-drop/1/report.pdf', name: 'report.pdf', size: 2048, mimeType: 'application/pdf' }
      ])
    ).toEqual([
      { uri: 'file:///tmp/hermie-drop/1/report.pdf', name: 'report.pdf', size: 2048, mimeType: 'application/pdf' }
    ])
  })

  it('keeps the order the files were dropped in', () => {
    const files = normaliseDroppedFiles([
      { uri: 'file:///a', name: 'a' },
      { uri: 'file:///b', name: 'b' },
      { uri: 'file:///c', name: 'c' }
    ])

    expect(files.map(file => file.name)).toEqual(['a', 'b', 'c'])
  })

  it('falls back rather than dropping a file with a thin payload', () => {
    // A provider that named nothing still handed over bytes, and the upload can
    // find out the size for itself.
    expect(normaliseDroppedFiles([{ uri: 'file:///tmp/x/notes%20v2.txt' }])).toEqual([
      { uri: 'file:///tmp/x/notes%20v2.txt', name: 'notes v2.txt', size: 0, mimeType: 'application/octet-stream' }
    ])
  })

  it('drops an item with no URI, because there is nothing to upload', () => {
    expect(normaliseDroppedFiles([{ name: 'ghost.txt', size: 10 }])).toEqual([])
  })

  it('never throws on a payload that is not what it should be', () => {
    // The bridge carries `Any`. A drop is a gesture somebody made with a file
    // they care about; the failure that matters is a shape that takes the chat
    // down, not a field that is missing.
    expect(normaliseDroppedFiles(undefined)).toEqual([])
    expect(normaliseDroppedFiles(null)).toEqual([])
    expect(normaliseDroppedFiles('file:///a')).toEqual([])
    expect(normaliseDroppedFiles([null, 7, 'x', { uri: 'file:///a', size: Number.NaN }])).toEqual([
      { uri: 'file:///a', name: 'a', size: 0, mimeType: 'application/octet-stream' }
    ])
  })
})

describe('a dropped file as an attachment', () => {
  it('is the same shape the document picker produces', () => {
    const picked = droppedFile({
      uri: 'file:///tmp/hermie-drop/1/report.pdf',
      name: 'report.pdf',
      size: 2048,
      mimeType: 'application/pdf'
    })

    expect(picked).toEqual({
      name: 'report.pdf',
      size: 2048,
      mimeType: 'application/pdf',
      uri: 'file:///tmp/hermie-drop/1/report.pdf',
      // What `FormData` appends; React Native streams from the URI rather than
      // reading the bytes into JavaScript.
      body: { uri: 'file:///tmp/hermie-drop/1/report.pdf', name: 'report.pdf', type: 'application/pdf' }
    })
  })

  it('names an unnamed file from its URI rather than refusing it', () => {
    expect(droppedFile({ uri: 'file:///tmp/x/draft.md', name: '', size: 0, mimeType: '' })).toMatchObject({
      name: 'draft.md',
      mimeType: 'application/octet-stream'
    })
  })
})

describe('the drop zone with no native view', () => {
  it('is what the test renderer, Android and the web all get', () => {
    expect(HAS_NATIVE_FILE_DROP).toBe(false)
  })

  it('renders its children, and adds nothing around them', () => {
    render(
      <ThemeProvider>
        <DropZone onFiles={jest.fn()}>
          <View testID="chat-body">
            <Text>A conversation</Text>
          </View>
        </DropZone>
      </ThemeProvider>
    )

    expect(screen.getByTestId('chat-body')).toBeTruthy()
    // No host view means no wrapper and no highlight: a screen's tree does not
    // change shape because a native module exists on another platform.
    expect(screen.queryByTestId('drop-zone')).toBeNull()
    expect(screen.queryByTestId('drop-zone-highlight')).toBeNull()
  })
})
