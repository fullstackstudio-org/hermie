/**
 * The files the fake gateway shares: small, real ones, so the Chromium of an end-to-end run can decode and play
 * them and a person on `npm run fake-gateway` sees what a bot's file looks like.
 *
 * The picture and the PDF are written here (a PNG of one colour, a one-page PDF); the clip and the tone were made
 * once with ffmpeg (a two-second test card, H.264 baseline in MP4, and a 440 Hz sine, MP3 at 16 kbit/s) and are
 * kept as base64. Nothing reads a file from this machine: a scenario names a sample, never a path.
 */
import { deflateSync } from 'node:zlib'

/** The kinds the gateway classifies a shared file as (`contract/outbox`). */
export type OutboxKind = 'image' | 'video' | 'audio' | 'pdf' | 'file'

export interface OutboxSample {
  name: string
  mime: string
  kind: OutboxKind
  body: Buffer
}

const CLIP_MP4 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN6bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAA' +
  'AAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAA' +
  'AqV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAA' +
  'AAAAAAAAAAAAAABAAAAAAMAAAABsAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAIdbWRpYQAAACBtZGhk' +
  'AAAAAAAAAAAAAAAAAAAoAAAAUABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAByG1p' +
  'bmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYhzdGJsAAAAvHN0c2QA' +
  'AAAAAAAAAQAAAKxhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAMAAbABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4' +
  'MjY0AAAAAAAAAAAAAAAAGP//AAAAMmF2Y0MBQsAM/+EAGWdCwAymEQw/7wEQAAADABAAAAMBQPFCoRgBAAZoyEIDEsgAAAAQcGFz' +
  'cAAAAAEAAAABAAAAFGJ0cnQAAAAAAAA+8AAAAAAAAAAYc3R0cwAAAAAAAAABAAAAFAAABAAAAAAYc3RzcwAAAAAAAAACAAAAAQAA' +
  'AAsAAAAcc3RzYwAAAAAAAAABAAAAAQAAABQAAAABAAAAZHN0c3oAAAAAAAAAAAAAABQAAAY5AAAAPQAAAE4AAAA2AAAAQQAAAFkA' +
  'AABPAAAAVgAAAE4AAABkAAAEFAAAADgAAABaAAAAOwAAAGcAAABPAAAASwAAAFgAAABKAAAATQAAABRzdGNvAAAAAAAAAAEAAAOq' +
  'AAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRh' +
  'dGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAAPxG1kYXQAAAJxBgX//23cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUg' +
  'MTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3' +
  'dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MTYgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4' +
  'MToweDEzMSBtZT11bWggc3VibWU9MTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0yNCBjaHJv' +
  'bWFfbWU9MSB0cmVsbGlzPTIgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZz' +
  'ZXQ9LTIgdGhyZWFkcz0zIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJs' +
  'YWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTEwIGtl' +
  'eWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTEwIHJjPWNyZiBtYnRyZWU9MSBjcmY9' +
  'MzguMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAA8BliIIH' +
  '+TFAAEW2eHgcAAmG4gEsQAA2Bv8pE340Vw34N+P/vdQkxhggIQ4D4ffBCuNeAEfVvoK+0hRm/AS9uiEJb8GIgpFAAENeIEAAQIkN' +
  'AAEapHh4HAAJB+IAkiAAGgPPD8dp8UAASNo4AAjvxwABAwnh4HAAJB+IAkiAAGgPPD8doYgkABN6txiKOz/QsoPxnv8Z6ifBJDAg' +
  'QAQ4gaDT7D2K34ASMyzLL6pyNGQeIdMRTL7fw5/gjOKB8MQrDAAKAfrh0Uav8Ct7EwIOAijNz1biWQgBNZDI+pwfQBDKMyArzodf' +
  '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' +
  'gkghPPa7vD1TSyT/OH8/4A=='

const TONE_MP3 =
  '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' +
  'RfMHjIMV5fMHWYCTD8QyswKADoN8XD9Y81oXFowmF1aHPgSX18P//9v5D///8yjE6xDobjVW57aAXp/////6aqAAAHbbZLaAf5Hy' +
  '3LH7XQYxmhoOc7B4OCCXghDKyZRmyHu5uvbp/apPp//6f/3f/b9lCv//8yjE4g5IZlpeHnpG//1EWBKAlkTA4CMJA0xSJDLBfNz0' +
  'g1KuFjsJGsMPIBECGQzZmzEKHMQhItqu5/Y1iBT3///+n//kav//8yjE4wwIXmX+DjpG//7ON8nSFADGQWHQxBgvGA5lmEExGBas' +
  'JRgwwZcYDeBvm5op+hgLWxRJFAqrU2aFyypn///st8l/+rL/8yjE7RCQdiQA7/aAP/////TV///7sQbnADbgoAGFQeYyFRmsynAJ' +
  '4au+QR3ODcGJ6FuZ1TpoTbGKUUYVCaEhlcMRuksAT///8yjE5QzAXm5eDjhG//7v/2VK///9xJkKgRZoBA0wqBjFwZMxkg3tEzV9' +
  'wRO7QWMaIXMKnMyntDCyQMMBUu8w12pSQBn/////8yjE7Q6QbigA57iA///V/////7oACgUDtmXQ08LGiwBLBgg9mA6tyYMAVYUA' +
  'cDABA4EZCBPGFUV8z///////o/////6akj//8yjE7RBIdiQA7/aA//9St9I2/iAcwMCDDohMiFQ1nEzPuslOGUX8w4gjjKxuM3zc' +
  'w8XTBwEUHciN0lOHn//m/2/7P/6KgAD/8yjE5g6YcigA57iADEQPgb///Uy6TDUiS6QOGTIQI0ohPDnDRmeAOWkMgw1gDDCxcMRV' +
  'swCbzAoKTlcKI1tmv6v+yK5v0f//8yjE5g8waigA57iA68lb6/uQY9EQAAADYADCgffLUthl0mEodhwBkKg8GDAtIYd4UxUAZQjO' +
  'IsvWnFCZ68a/19tv//////7/8yjE5AwgZlAeBrwo7///WgIkD///3KH/ijpl7DAoNMMCYx+YTUk0M5/HY3vhqDDXCVMsmkz5HjEp' +
  'SMKgNOh34xT0mAe0/+7/8yjE7g6gbjAQ57iA+r+///XVMD///ux5uq5kUg4JDiYHKprogfU8mpeyGdhwSpiEgXmLTuYPzgMQxgAI' +
  'ppNJiUzUMu//9Mv/8yjE7hE4bjGc37iA///6tv/////QjAACASISADbaUVKoi8S+RkBgYIpi72JnMMojAJqJtQoI0Gesml///67P' +
  'u//9df+xFf//8yjE5A2oZlJeD7Is//whtyHvYwDQOYKDxiMhmUEkbH35iISNaZIqEvmCEAZxnpEGt6qY+MpioDF62CO/Dkbpwz//' +
  '/X+r//3/8yjE6A8IcjBQ57iA6sQAAFuNhPoBXLdBKYdeZjqWREDoGIY3KSwD+cYnAMYAMFWDKo6zKI1rrDXf3M/9Naf//9NvrdsS' +
  '9///8yjE5g94biwQ37iA//RVIAAEDghgYH///ljGndWFSqEAGDRQwZBMz7jGYo6M4UT4wJgNQcWOhvMmbDjy9YGnbQz7vr/xn8//' +
  '8yjE4wwYYl4+F3BKft/qqq////7lIAAEkEQkAHzjV2IOmtALgKYECAZM7IavC8YKgeWTNnkhm3nMzP7tj+n/Ifd//6/o9qH/8yjE' +
  '7Q8YcigA5/iA///7r/tbGAAg4CMCACGAoB0EBAmDyFuYl5cpuMhkngkYcY4wdRgbBoGHYOUFAyDBkAeBQBij614fCoP/8yjE6w8I' +
  'Zk5eD3Ys////+r//qQQyKIgiAAP4igjvAUK+NoVgEJRtSpAAkeQXlhcNNH38fcIDY40AFIwDwwFgAm0TiMd4oAb/8yjE6RAgaj2+' +
  '37SAqMmQMpE8UTH5HEQJgxJ9EyUkv8zMi4YIm6GL6wYIBf/AhALgRn/gMNgkAw2GVYSeNI0jqZlyQUcKnEL/8yjE4wxwYl2+D3BK' +
  'QkJwooW4lztOp5XRpU6dLK3IcElEiSWxRcUFYCmAo7E3oL8JTEFNRTQuMFVVVVVVVVVVVVVVVVVVVVX/8yjE7BBwaiwBXhgAVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjE5RhRCojtm6AAVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjEvgwwhdwBzzABVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU='

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff

  for (const byte of bytes) {
    crc ^= byte

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }

  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)

  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')

  const tail = Buffer.alloc(4)

  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)

  return Buffer.concat([head, data, tail])
}

/** A `width` x `height` PNG: a diagonal gradient from `from` to `to` (RGB), so a thumbnail is not a flat block. */
export function gradientPng(
  width: number,
  height: number,
  from: [number, number, number],
  to: [number, number, number]
): Buffer {
  const row = 1 + width * 3
  const raw = Buffer.alloc(row * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = (x / Math.max(1, width - 1) + y / Math.max(1, height - 1)) / 2

      for (let channel = 0; channel < 3; channel += 1) {
        raw[y * row + 1 + x * 3 + channel] = Math.round(
          (from[channel] as number) + ((to[channel] as number) - (from[channel] as number)) * t
        )
      }
    }
  }

  const header = Buffer.alloc(13)

  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** A one-page PDF with one line of text. */
export function textPdf(line: string): Buffer {
  const stream = `BT /F1 18 Tf 36 96 Td (${line.replace(/[\\()]/g, '')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []

  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xref = out.length

  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`

  return Buffer.from(out, 'latin1')
}

/** The samples a scenario may name (`ScenarioAttachment.sample`). */
export const OUTBOX_SAMPLES = {
  image: (): OutboxSample => ({
    name: 'sunrise.png',
    mime: 'image/png',
    kind: 'image',
    body: gradientPng(240, 160, [250, 170, 90], [90, 80, 160])
  }),
  image2: (): OutboxSample => ({
    name: 'forest.png',
    mime: 'image/png',
    kind: 'image',
    body: gradientPng(240, 160, [40, 120, 80], [200, 230, 140])
  }),
  video: (): OutboxSample => ({
    name: 'test card.mp4',
    mime: 'video/mp4',
    kind: 'video',
    body: Buffer.from(CLIP_MP4, 'base64')
  }),
  audio: (): OutboxSample => ({
    name: 'tone.mp3',
    mime: 'audio/mpeg',
    kind: 'audio',
    body: Buffer.from(TONE_MP3, 'base64')
  }),
  pdf: (): OutboxSample => ({
    name: 'Q3 report.pdf',
    mime: 'application/pdf',
    kind: 'pdf',
    body: textPdf('Quarterly report')
  }),
  html: (): OutboxSample => ({
    name: 'summary <draft>.html',
    mime: 'text/html',
    kind: 'file',
    body: Buffer.from('<!doctype html><title>Summary</title><h1>Summary</h1><script>document.title = "ran"</script>\n')
  }),
  zip: (): OutboxSample => ({
    name: 'archive.zip',
    mime: 'application/zip',
    kind: 'file',
    // An empty archive: the end-of-central-directory record and nothing else.
    body: Buffer.from('504b0506000000000000000000000000000000000000', 'hex')
  })
} as const

export type OutboxSampleName = keyof typeof OUTBOX_SAMPLES
