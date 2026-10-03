/**
 * The image viewer as a dialog: named by the file, focus in and back out,
 * Escape and the backdrop close it, the page behind it is inert, and a source
 * off the gateway is never shown.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { downloadName, ImageViewer } from './ImageViewer'

const BASE = 'http://gateway.test'

function open(src = 'http://gateway.test/api/media/shot.png', name = 'shot.png') {
  const onClose = vi.fn()
  const opener = document.createElement('button')

  opener.textContent = 'the card'
  document.body.append(opener)

  const page = render(
    <main>
      <p>The chat behind it.</p>
      <ImageViewer image={{ src, name }} gatewayBaseUrl={BASE} onClose={onClose} opener={opener} />
    </main>
  )

  return { ...page, onClose, opener }
}

describe('the image viewer', () => {
  it('is a modal dialog named by the file, with the picture and a download under the same name', () => {
    open()

    const dialog = screen.getByRole('dialog', { name: 'shot.png' })

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect((screen.getByRole('img', { name: 'shot.png' }) as HTMLImageElement).src).toBe(
      'http://gateway.test/api/media/shot.png'
    )

    const download = screen.getByRole('link', { name: 'Download image' })

    expect(download.getAttribute('href')).toBe('http://gateway.test/api/media/shot.png')
    expect(download.getAttribute('download')).toBe('shot.png')
  })

  it('takes focus to Close, keeps Tab inside, and leaves the rest of the page inert', () => {
    const { container } = open()

    const close = screen.getByRole('button', { name: 'Close image' })
    const download = screen.getByRole('link', { name: 'Download image' })

    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(download)
    fireEvent.keyDown(download, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)

    // Portalled to the body: the app's own root is what goes inert.
    expect(container.hasAttribute('inert')).toBe(true)
  })

  it('closes on Escape, on Close and on the backdrop, and not on the picture', () => {
    const { onClose } = open()

    fireEvent.click(screen.getByRole('img', { name: 'shot.png' }))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close image' }))
    fireEvent.click(document.querySelector('.hm-viewer') as HTMLElement)

    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('gives focus back to the card that opened it, and the page its life back', () => {
    const { unmount, opener, container } = open()

    unmount()

    expect(document.activeElement).toBe(opener)
    expect(container.hasAttribute('inert')).toBe(false)
    opener.remove()
  })

  it('shows nothing for a source off the gateway', () => {
    open('https://elsewhere.example/shot.png')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })

  it('cleans the name it is titled and saved under', () => {
    open('http://gateway.test/api/media/x.png', 'a‮b<c>.png')

    expect(screen.getByRole('dialog', { name: 'ab<c>.png' })).toBeTruthy()
    expect(downloadName('dir/a<b>:c.png')).toBe('a_b__c.png')
    expect(downloadName('')).toBe('image')
  })
})
