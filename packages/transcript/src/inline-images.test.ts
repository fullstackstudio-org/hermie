import { describe, expect, it } from 'vitest'

import {
  INLINE_IMAGE_MAX_COUNT,
  scanLongText,
  scanOverTheCap,
  scanTooMany,
  scanUnderTheCap
} from './__fixtures__/inline-images-big'
import { INLINE_IMAGE_VECTORS } from './__fixtures__/inline-images-vectors'
import { scanInlineImages, sniffImageType } from './inline-images'
import { classifyUserRow, rowsToItems, stripUserText } from './rows-to-items'
import type { AssistantItem, UserItem } from './types'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('scanInlineImages: the shared vectors', () => {
  it.each(INLINE_IMAGE_VECTORS)('$name', vector => {
    const scan = scanInlineImages(vector.input)

    expect(scan.text).toBe(vector.text)
    expect(scan.images).toEqual(vector.images)
    expect(scan.references).toEqual(vector.references)
  })
})

describe('scanInlineImages: small limits', () => {
  it('leaves a text with neither a handle nor a blob as it was', () => {
    const text = '  plain words  \n\n\nwith gaps  '

    expect(scanInlineImages(text)).toEqual({ text, images: [], references: [] })
  })

  it('does not treat the base64 alphabet as a way to eat the words after a blob', () => {
    const scan = scanInlineImages(`data:image/png;base64,${PNG} thanks\nLater`)

    expect(scan.text).toBe('thanks\nLater')
    expect(scan.images).toHaveLength(1)
  })
})

describe('sniffImageType', () => {
  it('knows the five by their first bytes', () => {
    expect(sniffImageType([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).toBe('image/png')
    expect(sniffImageType([0xff, 0xd8, 0xff, 0xe0])).toBe('image/jpeg')
    expect(sniffImageType([...'GIF89a'].map(c => c.charCodeAt(0)))).toBe('image/gif')
    expect(sniffImageType([...'RIFF\0\0\0\0WEBP'].map(c => c.charCodeAt(0)))).toBe('image/webp')
    expect(sniffImageType([0, 0, 0, 0x18, ...'ftypheic'].map(c => (typeof c === 'string' ? c.charCodeAt(0) : c)))).toBe(
      'image/heic'
    )
  })

  it('knows nothing else', () => {
    expect(sniffImageType([...'<svg xmlns'].map(c => c.charCodeAt(0)))).toBeNull()
    expect(sniffImageType([])).toBeNull()
  })
})

describe('the transcript uses it', () => {
  const text = `what is this?\n\n[Image attached at: /root/.hermes/images/upload_1.png]\ndata:image/png;base64,${PNG}`

  it('stripUserText lifts the pictures out of a user turn', () => {
    const stripped = stripUserText(text)

    expect(stripped.text).toBe('what is this?')
    expect(stripped.inlineImages).toEqual([{ name: 'upload_1.png', mime: 'image/png', data: PNG }])
    expect(stripped.attachments).toBeUndefined()
  })

  it('a handle alone becomes an attachment reference next to the other references', () => {
    const stripped = stripUserText('look @file:/x/report.pdf\n[Image attached at: /x/shot.png]')

    expect(stripped.text).toBe('look')
    expect(stripped.attachments).toEqual(['@file:/x/report.pdf', '@image:/x/shot.png'])
    expect(stripped.inlineImages).toBeUndefined()
  })

  it('a turn that was nothing but a picture still has a body to show', () => {
    const stripped = stripUserText(`[Image attached at: /x/a.png]\ndata:image/png;base64,${PNG}`)

    expect(stripped.text).toBe('')
    expect(stripped.inlineImages).toHaveLength(1)
  })

  it('classifyUserRow carries them', () => {
    const row = classifyUserRow(text)

    expect(row.kind).toBe('user')
    expect(row.kind === 'user' && row.inlineImages).toHaveLength(1)
  })

  it('a history row becomes a user item with its pictures and no marker in the text', () => {
    const items = rowsToItems([{ role: 'user', content: text }], 'rest')
    const item = items[0] as UserItem

    expect(items).toHaveLength(1)
    expect(item.text).toBe('what is this?')
    expect(item.inlineImages).toEqual([{ name: 'upload_1.png', mime: 'image/png', data: PNG }])
  })

  it('a row of nothing but a picture is kept', () => {
    const items = rowsToItems([{ role: 'user', content: `data:image/png;base64,${PNG}` }], 'rest')

    expect(items).toHaveLength(1)
    expect((items[0] as UserItem).inlineImages).toHaveLength(1)
  })

  it('a reply gets the same treatment', () => {
    const items = rowsToItems(
      [{ role: 'assistant', content: `Here you go\n\n![chart](data:image/png;base64,${PNG})` }],
      'rest'
    )
    const item = items[0] as AssistantItem

    expect(item.text).toBe('Here you go')
    expect(item.inlineImages).toEqual([{ name: 'Image', mime: 'image/png', data: PNG }])
  })
})

// The big inputs run through `__fixtures__/inline-images-big.ts`, so the golden recorder (which
// records only the calls a test file makes itself) does not write tens of megabytes of corpus.
describe('scanInlineImages: huge inputs', () => {
  it('refuses a picture over the size cap, and still keeps the blob out of the text', () => {
    const scan = scanOverTheCap()

    expect(scan.text).toBe('after')
    expect(scan.images).toEqual([])
    expect(scan.references).toEqual(['@image:/x/huge.png'])
  })

  it('keeps a picture just under the cap', () => {
    const { body, scan } = scanUnderTheCap()

    expect(scan.images).toHaveLength(1)
    expect(scan.images[0]?.data.length).toBe(body.length)
  })

  it('reads a very long text in one pass', () => {
    const { scan, fillerLength, elapsedMs } = scanLongText()

    expect(scan.images).toHaveLength(1)
    expect(scan.text.length).toBe(fillerLength * 2 + 1)
    expect(elapsedMs).toBeLessThan(2000)
  })

  it('gives up a message after the cap of pictures, without printing the rest', () => {
    const scan = scanTooMany()

    expect(scan.text).toBe('hi')
    expect(scan.images).toHaveLength(INLINE_IMAGE_MAX_COUNT)
  })
})
