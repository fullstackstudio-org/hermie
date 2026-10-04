/**
 * The drop zone over the chat: a drag of files shows a target and says so once,
 * a drop hands the files over in order, a drag of text is left alone, crossing
 * children does not flicker the target off, and a file dropped elsewhere on the
 * page is not opened in place of the app.
 */
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { DropZone } from './DropZone'

function transfer(files: File[], types = files.length ? ['Files'] : ['text/plain']): DataTransfer {
  return { types, files, dropEffect: 'none' } as unknown as DataTransfer
}

function mount(enabled = true) {
  const onFiles = vi.fn()
  const view = render(
    <DropZone className="hm-chat" enabled={enabled} onFiles={onFiles}>
      <p>transcript</p>
      <p>composer</p>
    </DropZone>
  )
  const zone = view.container.firstElementChild as HTMLElement

  return { ...view, onFiles, zone }
}

const report = new File(['a'], 'report.csv', { type: 'text/csv' })
const shot = new File(['b'], 'shot.png', { type: 'image/png' })

const target = (): HTMLElement | null => screen.queryByText('Drop file to attach')

beforeEach(() => {
  resetActiveLocale()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DropZone', () => {
  it('shows and announces the target while files are over the chat, and hands a drop over in order', () => {
    const { zone, onFiles } = mount()
    const data = transfer([report, shot])

    fireEvent.dragEnter(zone, { dataTransfer: data })

    expect(screen.getByText('Drop file to attach')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Drop files here to attach them')
    expect(zone.getAttribute('data-drop-active')).toBe('true')

    const over = createEvent.dragOver(zone, { dataTransfer: data })

    fireEvent(zone, over)
    expect(over.defaultPrevented).toBe(true)

    const drop = createEvent.drop(zone, { dataTransfer: data })

    fireEvent(zone, drop)

    expect(drop.defaultPrevented).toBe(true)
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([report, shot])
    expect(screen.queryByText('Drop file to attach')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('keeps the target while the pointer crosses the chat’s own children, and drops it on leaving', () => {
    const { zone } = mount()
    const data = transfer([report])
    const child = screen.getByText('composer')

    fireEvent.dragEnter(zone, { dataTransfer: data })
    fireEvent.dragEnter(child, { dataTransfer: data })
    fireEvent.dragLeave(zone, { dataTransfer: data })

    expect(screen.getByText('Drop file to attach')).toBeTruthy()

    fireEvent.dragLeave(child, { dataTransfer: data })

    expect(screen.queryByText('Drop file to attach')).toBeNull()
  })

  it('leaves a drag of text alone', () => {
    const { zone, onFiles } = mount()
    const data = transfer([])

    fireEvent.dragEnter(zone, { dataTransfer: data })
    const drop = createEvent.drop(zone, { dataTransfer: data })

    fireEvent(zone, drop)

    expect(screen.queryByText('Drop file to attach')).toBeNull()
    expect(drop.defaultPrevented).toBe(false)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('does nothing in a chat that takes no attachments', () => {
    const { zone, onFiles } = mount(false)

    fireEvent.dragEnter(zone, { dataTransfer: transfer([report]) })
    fireEvent.drop(zone, { dataTransfer: transfer([report]) })

    expect(screen.queryByText('Drop file to attach')).toBeNull()
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('keeps a file dropped elsewhere on the page from replacing the app, while the chat is on screen', () => {
    const view = mount()
    const stray = (): Event => {
      const event = createEvent.drop(document.body, { dataTransfer: transfer([report]) })

      fireEvent(document.body, event)

      return event
    }

    expect(stray().defaultPrevented).toBe(true)

    act(() => view.unmount())

    expect(stray().defaultPrevented).toBe(false)
  })

  it('does not let a file replace the app in a chat that takes no attachments either, and says no with the pointer', () => {
    const { zone, onFiles } = mount(false)
    const data = transfer([report])
    const over = createEvent.dragOver(zone, { dataTransfer: data })
    const drop = createEvent.drop(zone, { dataTransfer: data })

    fireEvent(zone, over)
    fireEvent(zone, drop)

    expect(over.defaultPrevented).toBe(true)
    expect(data.dropEffect).toBe('none')
    expect(drop.defaultPrevented).toBe(true)
    expect(onFiles).not.toHaveBeenCalled()
  })

  it('takes a drop on the transcript and a drop on the composer alike, wherever in the chat it lands', () => {
    const { onFiles } = mount()

    fireEvent.drop(screen.getByText('transcript'), { dataTransfer: transfer([report]) })
    fireEvent.drop(screen.getByText('composer'), { dataTransfer: transfer([shot]) })

    expect(onFiles).toHaveBeenNthCalledWith(1, [report])
    expect(onFiles).toHaveBeenNthCalledWith(2, [shot])
  })

  describe('the target always goes away', () => {
    it('after a drop on the chat', () => {
      const { zone } = mount()
      const data = transfer([report])

      fireEvent.dragEnter(zone, { dataTransfer: data })
      fireEvent.drop(zone, { dataTransfer: data })

      expect(target()).toBeNull()
    })

    it('after a drop on a child, with the counts of the children it crossed still open', () => {
      const { zone } = mount()
      const data = transfer([report])
      const child = screen.getByText('composer')

      fireEvent.dragEnter(zone, { dataTransfer: data })
      fireEvent.dragEnter(child, { dataTransfer: data })
      fireEvent.drop(child, { dataTransfer: data })

      expect(target()).toBeNull()

      // The next drag starts from nothing, not from the count the last one left.
      fireEvent.dragEnter(zone, { dataTransfer: data })
      fireEvent.dragLeave(zone, { dataTransfer: data })

      expect(target()).toBeNull()
    })

    it('after a drop that a child consumes without letting it reach the chat', () => {
      const { zone, onFiles } = mount()
      const data = transfer([report])
      const child = screen.getByText('composer')

      child.addEventListener('drop', event => event.stopPropagation())
      fireEvent.dragEnter(zone, { dataTransfer: data })
      fireEvent.drop(child, { dataTransfer: data })

      expect(target()).toBeNull()
      expect(onFiles).not.toHaveBeenCalled()
    })

    it('after a drag that ends elsewhere (dragend)', () => {
      const { zone } = mount()

      fireEvent.dragEnter(zone, { dataTransfer: transfer([report]) })
      fireEvent.dragEnd(document.body)

      expect(target()).toBeNull()
    })

    it('after a drag that is cancelled or taken out of the window with no leave sent', () => {
      vi.useFakeTimers()

      const { zone } = mount()
      const data = transfer([report])

      fireEvent.dragEnter(zone, { dataTransfer: data })
      fireEvent.dragEnter(screen.getByText('composer'), { dataTransfer: data })

      // Dragging on keeps the target, still pointer or not.
      act(() => {
        vi.advanceTimersByTime(800)
      })
      fireEvent.dragOver(zone, { dataTransfer: data })
      act(() => {
        vi.advanceTimersByTime(800)
      })

      expect(target()).not.toBeNull()

      // Nothing more from the page: the drag is over.
      act(() => {
        vi.advanceTimersByTime(400)
      })

      expect(target()).toBeNull()
    })

    it('after the chat stops taking attachments mid drag', () => {
      const onFiles = vi.fn()
      const view = render(
        <DropZone enabled onFiles={onFiles}>
          <p>chat</p>
        </DropZone>
      )

      fireEvent.dragEnter(view.container.firstElementChild as HTMLElement, { dataTransfer: transfer([report]) })
      expect(target()).not.toBeNull()

      view.rerender(
        <DropZone enabled={false} onFiles={onFiles}>
          <p>chat</p>
        </DropZone>
      )

      expect(target()).toBeNull()
    })

    it('after a drop of words it never showed for', () => {
      const { zone } = mount()

      fireEvent.dragEnter(zone, { dataTransfer: transfer([]) })
      fireEvent.drop(zone, { dataTransfer: transfer([]) })

      expect(target()).toBeNull()
    })
  })
})
