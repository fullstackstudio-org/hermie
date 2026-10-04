/**
 * The shapes `scanInlineImages` has to answer, as input and expected output. The golden corpus
 * (`contract/transcript/golden/inline-images.json`) records them, which is how the Swift port is
 * held to the same answers.
 */
export interface InlineImageVector {
  name: string
  input: string
  text: string
  images: { name: string; mime: string; data: string }[]
  references: string[]
}

export const PNG_BODY =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export const JPEG_BODY =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/'

const PATH = '/root/.hermes/profiles/marketing/images/upload_20261004_160406_1.png'

export const INLINE_IMAGE_VECTORS: InlineImageVector[] = [
  {
    name: 'marker only',
    input: `[Image attached at: ${PATH}]`,
    text: ``,
    images: [],
    references: [`@image:${PATH}`]
  },
  {
    name: 'data url only',
    input: `data:image/png;base64,${PNG_BODY}`,
    text: ``,
    images: [{ name: 'Image', mime: 'image/png', data: PNG_BODY }],
    references: []
  },
  {
    name: 'marker and data url',
    input: `[Image attached at: ${PATH}]\ndata:image/png;base64,${PNG_BODY}`,
    text: ``,
    images: [{ name: 'upload_20261004_160406_1.png', mime: 'image/png', data: PNG_BODY }],
    references: []
  },
  {
    name: 'two pictures',
    input: `[Image attached at: /x/a.png]\ndata:image/png;base64,${PNG_BODY}\n[Image attached at: /x/b.jpg]\ndata:image/jpeg;base64,${JPEG_BODY}`,
    text: ``,
    images: [
      { name: 'a.png', mime: 'image/png', data: PNG_BODY },
      { name: 'b.jpg', mime: 'image/jpeg', data: JPEG_BODY }
    ],
    references: []
  },
  {
    name: 'text before and after',
    input: `look at this\n\n[Image attached at: /x/a.png]\ndata:image/png;base64,${PNG_BODY}\n\nand tell me what you see`,
    text: `look at this\n\nand tell me what you see`,
    images: [{ name: 'a.png', mime: 'image/png', data: PNG_BODY }],
    references: []
  },
  {
    name: 'handle with a space in its path',
    input: `[Image attached at: /x/my shot.png]`,
    text: ``,
    images: [],
    references: [`@image:"/x/my shot.png"`]
  },
  {
    name: 'handle with an address',
    input: `[Image attached: https://example.com/a.png?x=1]`,
    text: ``,
    images: [],
    references: [`@image:https://example.com/a.png?x=1`]
  },
  {
    name: 'handle and a blob that cannot decode',
    input: `[Image attached at: /x/a.png]\ndata:image/png;base64,AAAAA`,
    text: ``,
    images: [],
    references: [`@image:/x/a.png`]
  },
  {
    name: 'blob that cannot decode, no handle',
    input: `data:image/png;base64,AAAAA`,
    text: ``,
    images: [],
    references: [`@image:Image`]
  },
  {
    name: 'type outside the list',
    input: `caption\ndata:image/svg+xml;base64,PHN2Zz48L3N2Zz4=`,
    text: `caption`,
    images: [],
    references: [`@image:Image`]
  },
  {
    name: 'bytes that are not a picture',
    input: `data:image/png;base64,aGVsbG8gd29ybGQgaGVsbG8gd29ybGQ=`,
    text: ``,
    images: [],
    references: [`@image:Image`]
  },
  {
    name: 'declared type wrong, bytes decide',
    input: `data:image/png;base64,${JPEG_BODY}`,
    text: ``,
    images: [{ name: 'Image', mime: 'image/jpeg', data: JPEG_BODY }],
    references: []
  },
  {
    name: 'markdown image around a blob',
    input: `see\n![shot](data:image/png;base64,${PNG_BODY})\nok`,
    text: `see\nok`,
    images: [{ name: 'Image', mime: 'image/png', data: PNG_BODY }],
    references: []
  },
  {
    name: 'other data urls stay',
    input: `data:text/plain;base64,SGVsbG8=`,
    text: `data:text/plain;base64,SGVsbG8=`,
    images: [],
    references: []
  },
  {
    name: 'no handle at all',
    input: `hello [Image attached] there`,
    text: `hello [Image attached] there`,
    images: [],
    references: []
  },
  {
    name: 'same handle twice',
    input: `[Image attached at: /x/a.png]\n[Image attached at: /x/a.png]`,
    text: ``,
    images: [],
    references: [`@image:/x/a.png`]
  }
]
