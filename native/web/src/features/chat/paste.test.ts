/**
 * Which pastes attach files: a screenshot or a copied file does, text that comes
 * with a picture of itself (a spreadsheet's cells, a word processor's passage)
 * does not, and plain text never reaches the tray.
 */
import { describe, expect, it } from 'vitest'

import { filesFromPaste } from './paste'

function clipboard(options: { files?: File[]; text?: string; onlyOnFiles?: boolean }): DataTransfer {
  const files = options.files ?? []
  const items = [
    ...(options.text ? [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] : []),
    ...(options.onlyOnFiles ? [] : files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })))
  ]

  return {
    items,
    files,
    getData: (type: string) => (type === 'text/plain' ? (options.text ?? '') : '')
  } as unknown as DataTransfer
}

const png = new File(['x'], 'image.png', { type: 'image/png' })
const pdf = new File(['%PDF'], 'contract.pdf', { type: 'application/pdf' })

describe('filesFromPaste', () => {
  it('attaches a screenshot pasted with no text', () => {
    expect(filesFromPaste(clipboard({ files: [png] }))).toEqual([png])
  })

  it('attaches files copied in a file manager, whose text is only their names', () => {
    expect(filesFromPaste(clipboard({ files: [pdf, png], text: 'contract.pdf\nimage.png' }))).toEqual([pdf, png])
    expect(filesFromPaste(clipboard({ files: [pdf], text: '/Users/ada/contract.pdf' }))).toEqual([pdf])
  })

  it('leaves text that comes with a picture of itself to the field', () => {
    expect(filesFromPaste(clipboard({ files: [png], text: 'Revenue\t2026\nQ1\t12' }))).toEqual([])
  })

  it('never attaches anything for plain text', () => {
    expect(filesFromPaste(clipboard({ text: 'hello there' }))).toEqual([])
    expect(filesFromPaste(null)).toEqual([])
  })

  it('reads the files an engine lists only on `files`', () => {
    expect(filesFromPaste(clipboard({ files: [png], onlyOnFiles: true }))).toEqual([png])
  })
})
