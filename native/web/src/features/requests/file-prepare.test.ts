/**
 * What a file goes through before it is uploaded: is it the kind the request asked for, does a picture lose its
 * metadata (and a picture the page cannot clean is refused, not uploaded), and what are its size and SHA-256 as
 * uploaded. The canvas itself is a browser's: `e2e/requests-interactive.spec.ts` re-encodes a real JPEG with EXIF.
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  acceptAttribute,
  answerMime,
  answerName,
  imageKind,
  isImage,
  matchesAccept,
  PrepareError,
  prepareFile
} from './file-prepare'

const file = (name: string, type: string, body = 'bytes'): File => new File([body], name, { type })

describe('the kind of file a request asks for', () => {
  it('filters the picker by what it says', () => {
    expect(acceptAttribute('image')).toBe('image/*')
    expect(acceptAttribute('audio')).toBe('audio/*')
    expect(acceptAttribute('document')).toContain('application/pdf')
    expect(acceptAttribute('any')).toBeUndefined()
  })

  it('holds a file to it anyway: a system may ignore the filter', () => {
    expect(matchesAccept('image', file('a.png', 'image/png'))).toBe(true)
    expect(matchesAccept('image', file('a.pdf', 'application/pdf'))).toBe(false)
    expect(matchesAccept('image', file('a.heic', ''))).toBe(true)
    expect(matchesAccept('audio', file('a.m4a', 'audio/mp4'))).toBe(true)
    expect(matchesAccept('audio', file('a.m4a', ''))).toBe(true)
    expect(matchesAccept('audio', file('a.png', 'image/png'))).toBe(false)
    expect(matchesAccept('document', file('a.pdf', 'application/pdf'))).toBe(true)
    expect(matchesAccept('document', file('a.txt', 'text/plain'))).toBe(true)
    expect(
      matchesAccept(
        'document',
        file('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      )
    ).toBe(true)
    expect(matchesAccept('document', file('a.xlsx', ''))).toBe(true)
    expect(matchesAccept('document', file('a.png', 'image/png'))).toBe(false)
    expect(matchesAccept('any', file('whatever.bin', ''))).toBe(true)
  })

  it('tells the pictures it can clean from the ones it cannot', () => {
    expect(isImage(file('a.jpg', ''))).toBe(true)
    expect(isImage(file('a.pdf', ''))).toBe(false)
    expect(imageKind(file('a.jpg', 'image/jpeg'))).toBe('jpeg')
    expect(imageKind(file('a.JPEG', ''))).toBe('jpeg')
    expect(imageKind(file('a.png', ''))).toBe('png')
    expect(imageKind(file('a.heic', 'image/heic'))).toBe('other')
    expect(imageKind(file('a.webp', 'image/webp'))).toBe('other')
  })
})

describe('what the answer says of a file', () => {
  it('names it as the person knows it, within the contract’s limits', () => {
    expect(answerName('receipt.jpg')).toBe('receipt.jpg')
    expect(answerName('')).toBe('file')
    expect(answerName('a\u0000b\nc.txt')).toBe('a b c.txt')
    expect(Array.from(answerName('x'.repeat(300)))).toHaveLength(120)
  })

  it('gives a MIME type of the right shape, or the generic one', () => {
    expect(answerMime('image/jpeg')).toBe('image/jpeg')
    expect(answerMime('application/vnd.ms-excel')).toBe('application/vnd.ms-excel')
    expect(answerMime('')).toBe('application/octet-stream')
    expect(answerMime('not a type')).toBe('application/octet-stream')
    expect(answerMime(`text/${'x'.repeat(100)}`)).toBe('application/octet-stream')
  })
})

describe('preparing a file', () => {
  it('quotes the size and the SHA-256 of the bytes, and touches a document never', async () => {
    const prepared = await prepareFile(file('contract.pdf', 'application/pdf', 'pdf bytes'), true)

    expect(prepared).toMatchObject({
      name: 'contract.pdf',
      mime: 'application/pdf',
      bytes: 9,
      sha256: createHash('sha256').update('pdf bytes').digest('hex')
    })
  })

  it('removes the metadata of a JPEG or a PNG when asked, and quotes the bytes that result', async () => {
    const calls: string[] = []
    const strip = async (_source: Blob, kind: 'jpeg' | 'png'): Promise<Blob> => {
      calls.push(kind)

      return new Blob(['clean'], { type: kind === 'jpeg' ? 'image/jpeg' : 'image/png' })
    }

    const jpeg = await prepareFile(file('shot.jpg', 'image/jpeg', 'exif and pixels'), true, { strip })
    const png = await prepareFile(file('shot.png', '', 'exif and pixels'), true, { strip })

    expect(calls).toEqual(['jpeg', 'png'])
    expect(jpeg).toMatchObject({
      mime: 'image/jpeg',
      bytes: 5,
      sha256: createHash('sha256').update('clean').digest('hex')
    })
    expect(png.mime).toBe('image/png')
  })

  it('leaves a picture as it is when the request does not ask for the metadata to go', async () => {
    const strip = async (): Promise<Blob> => {
      throw new Error('must not be called')
    }
    const prepared = await prepareFile(file('shot.jpg', 'image/jpeg', 'exif and pixels'), false, { strip })

    expect(prepared.bytes).toBe(15)
    expect(prepared.sha256).toBe(createHash('sha256').update('exif and pixels').digest('hex'))
  })

  it('refuses a picture it cannot clean rather than send it with its metadata', async () => {
    await expect(prepareFile(file('shot.heic', 'image/heic'), true)).rejects.toMatchObject({
      reason: 'strip_unsupported'
    })
    await expect(
      prepareFile(file('shot.jpg', 'image/jpeg'), true, {
        strip: async () => {
          throw new Error('decode failed')
        }
      })
    ).rejects.toBeInstanceOf(PrepareError)
  })
})
