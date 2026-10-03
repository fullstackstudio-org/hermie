import { afterEach, describe, expect, it, vi } from 'vitest'

import { AttachmentTray, type PickedFile } from './attachments'
import { clearSentPreviews, MAX_SENT_PREVIEWS, rememberSentPreviews, sentPreviewFor } from './sent-previews'

afterEach(() => {
  clearSentPreviews()
})

const picked = (name: string, type: string, bytes = 'xx'): PickedFile =>
  Object.assign(new Blob([bytes], { type }), { name, lastModified: 0 }) as unknown as PickedFile

describe('the pictures the reader sent from this page', () => {
  it('are kept per chat and file name', () => {
    rememberSentPreviews('researcher', [{ name: 'shot.png', previewUrl: 'data:image/png;base64,AAAA' }])

    expect(sentPreviewFor('researcher', 'shot.png')).toBe('data:image/png;base64,AAAA')
    expect(sentPreviewFor('writer', 'shot.png')).toBeUndefined()
    expect(sentPreviewFor(undefined, 'shot.png')).toBeUndefined()
    expect(sentPreviewFor('researcher', '')).toBeUndefined()
  })

  it('keep the newest when there are too many', () => {
    for (let index = 0; index <= MAX_SENT_PREVIEWS; index += 1) {
      rememberSentPreviews('bot', [{ name: `${index}.png`, previewUrl: `data:image/png;base64,${index}` }])
    }

    expect(sentPreviewFor('bot', '0.png')).toBeUndefined()
    expect(sentPreviewFor('bot', `${MAX_SENT_PREVIEWS}.png`)).toBeDefined()
  })

  it('come from the tray as a send takes its images, before the send paints its bubble', async () => {
    const onTake = vi.fn()
    const tray = new AttachmentTray({
      upload: async () => ({ path: '/srv/notes.md', name: 'notes.md', size: 2 }) as never,
      readBase64: async () => 'iVBORw0KGgo=',
      newId: (() => {
        let id = 0

        return () => `a${(id += 1)}`
      })(),
      onTake
    })

    tray.add([picked('shot.png', 'image/png'), picked('notes.md', 'text/markdown')])
    await vi.waitFor(() => expect(tray.blocked).toBe(false))

    const taken = tray.take()

    expect(taken).not.toBeNull()
    expect(onTake).toHaveBeenCalledTimes(1)
    expect(onTake).toHaveBeenCalledWith([{ name: 'shot.png', previewUrl: 'data:image/png;base64,iVBORw0KGgo=' }])
  })
})
