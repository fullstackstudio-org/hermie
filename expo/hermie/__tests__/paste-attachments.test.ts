/**
 * Sorting a paste's files onto the two roads a chat already takes one on.
 */
import { splitPastedFiles } from '../src/features/chats/paste-attachments'
import type { DroppedFile } from '../src/platform/file-drop'

const dropped = (name: string, mimeType: string): DroppedFile => ({
  mimeType,
  name,
  size: 10,
  uri: `file:///tmp/${name}`
})

describe('splitPastedFiles', () => {
  it('sorts an image onto the resize-and-attach road', () => {
    const { files, images } = splitPastedFiles([dropped('shot.png', 'image/png')])

    expect(images).toHaveLength(1)
    expect(files).toHaveLength(0)
  })

  it('sorts anything else onto the upload road', () => {
    const { files, images } = splitPastedFiles([dropped('report.pdf', 'application/pdf')])

    expect(images).toHaveLength(0)
    expect(files).toHaveLength(1)
  })

  it('keeps every file from one paste, split but in order', () => {
    const input = [dropped('a.png', 'image/png'), dropped('b.pdf', 'application/pdf'), dropped('c.jpg', 'image/jpeg')]

    const { files, images } = splitPastedFiles(input)

    expect(images.map(f => f.name)).toEqual(['a.png', 'c.jpg'])
    expect(files.map(f => f.name)).toEqual(['b.pdf'])
  })

  it('has nothing for an empty paste', () => {
    expect(splitPastedFiles([])).toEqual({ files: [], images: [] })
  })
})
