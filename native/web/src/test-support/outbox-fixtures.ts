/**
 * Files a bot shared, built the way the gateway writes them (`contract/outbox/`): a token, the name, and the
 * address that names both. A test that is about what a reply draws says the kind and the name and nothing else.
 */
import type { OutboxAttachment, OutboxKind } from '@hermie/transcript'

let counter = 0

const MIME: Record<OutboxKind, string> = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  pdf: 'application/pdf',
  file: 'application/zip'
}

/** What `urllib.parse.quote` makes of a name (the characters `encodeURIComponent` leaves are left too, bar `!'()*`). */
const quote = (name: string): string =>
  encodeURIComponent(name).replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)

export function sharedFile(kind: OutboxKind, name: string, over: Partial<OutboxAttachment> = {}): OutboxAttachment {
  counter += 1

  const id = `${String(counter).padStart(4, '0')}${'Ab_-'.repeat(7)}`.slice(0, 32)

  return {
    id,
    name,
    mime: MIME[kind],
    kind,
    size: 48_213,
    sha256: 'a3f1c2e4b5d6978812ab34cd56ef7890a1b2c3d4e5f60718293a4b5c6d7e8f90',
    createdAt: 1_791_148_287.08,
    url: `/api/files/outbox/${id}/${quote(name)}`,
    ...over
  }
}
