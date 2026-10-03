import { type TranscriptItem, type VisibleItem } from '@hermie/transcript'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { sameRow, TranscriptList } from './TranscriptList'

function userRow(id: string, text: string, version = 0): VisibleItem {
  const item = { id, kind: 'user', origin: 'history', seq: 0, text, version } as TranscriptItem
  return { item, presentation: 'full' }
}

function assistantRow(id: string, text: string, version: number, reasoning?: string): VisibleItem {
  const item = {
    id,
    kind: 'assistant',
    origin: 'live',
    seq: 0,
    text,
    version,
    streaming: true,
    interim: false,
    reasoning
  } as TranscriptItem
  return { item, presentation: 'full' }
}

function history(count: number, prefix = 'r'): VisibleItem[] {
  return Array.from({ length: count }, (_, index) => userRow(`${prefix}${index}`, `message ${prefix}${index}`))
}

/** A `renderItem` that counts what it drew. */
function counting() {
  const drawn: string[] = []
  const renderItem = (row: VisibleItem) => {
    drawn.push(row.item.id)
    return <p>{'text' in row.item ? row.item.text : row.item.id}</p>
  }
  return { drawn, renderItem }
}

describe('TranscriptList', () => {
  it('draws every row in order, in a labelled log', () => {
    const { renderItem } = counting()
    render(<TranscriptList rows={history(120)} renderItem={renderItem} label="Transcript" />)

    const log = screen.getByRole('log', { name: 'Transcript' })
    const keys = [...log.querySelectorAll<HTMLElement>('[data-row-key]')].map(row => row.dataset.rowKey)
    expect(keys).toEqual(history(120).map(row => row.item.id))
    expect(log.querySelector('[data-row-key="r0"]')?.getAttribute('data-kind')).toBe('user')
    expect(log.tabIndex).toBe(0)
  })

  it('re-renders only the row that changed when a reply streams', () => {
    const { drawn, renderItem } = counting()
    const rows = [...history(300), assistantRow('a', 'Hel', 1)]
    const { rerender } = render(<TranscriptList rows={rows} renderItem={renderItem} />)
    drawn.length = 0

    for (let version = 2; version < 32; version += 1) {
      // `visibleItems` hands back new wrappers every time; unchanged items keep their version.
      const next = [
        ...rows.slice(0, -1).map(row => ({ ...row })),
        assistantRow('a', `Hel${'lo'.repeat(version)}`, version)
      ]
      rerender(<TranscriptList rows={next} renderItem={renderItem} />)
    }

    expect(drawn).toEqual(Array.from({ length: 30 }, () => 'a'))
    expect(screen.getByText(`Hel${'lo'.repeat(31)}`)).toBeTruthy()
  })

  it('keeps every row mounted when older rows are prepended and new ones appended', () => {
    const { drawn, renderItem } = counting()
    const rows = history(120)
    const { container, rerender } = render(<TranscriptList rows={rows} renderItem={renderItem} />)
    const before = new Map(
      [...container.querySelectorAll<HTMLElement>('[data-row-key]')].map(row => [row.dataset.rowKey, row])
    )
    drawn.length = 0

    const next = [...history(200, 'o'), ...rows, ...history(3, 'n')]
    rerender(<TranscriptList rows={next} renderItem={renderItem} />)

    for (const [key, element] of before) {
      expect(container.querySelector(`[data-row-key="${key}"]`)).toBe(element)
    }
    expect(drawn).toHaveLength(203)
    expect([...container.querySelectorAll<HTMLElement>('[data-row-key]')].map(row => row.dataset.rowKey)).toEqual(
      next.map(row => row.item.id)
    )
  })

  it('draws a row again when its presentation or its thought changes without a new version', () => {
    const { drawn, renderItem } = counting()
    const thinking = assistantRow('a', 'Answer', 3, 'Because')
    const { rerender } = render(<TranscriptList rows={[thinking]} renderItem={renderItem} />)
    drawn.length = 0

    rerender(<TranscriptList rows={[assistantRow('a', 'Answer', 3, undefined)]} renderItem={renderItem} />)
    rerender(
      <TranscriptList
        rows={[{ ...assistantRow('a', 'Answer', 3, undefined), presentation: 'collapsed' }]}
        renderItem={renderItem}
      />
    )
    expect(drawn).toEqual(['a', 'a'])
  })

  it('asks for older history when the rows do not fill the viewport, once per oldest row', () => {
    const onReachTop = vi.fn()
    const { renderItem } = counting()
    const { rerender } = render(<TranscriptList rows={history(3)} renderItem={renderItem} onReachTop={onReachTop} />)
    expect(onReachTop).toHaveBeenCalledTimes(1)

    rerender(
      <TranscriptList rows={[...history(3), userRow('n', 'new')]} renderItem={renderItem} onReachTop={onReachTop} />
    )
    expect(onReachTop).toHaveBeenCalledTimes(1)

    rerender(
      <TranscriptList rows={[...history(2, 'o'), ...history(3)]} renderItem={renderItem} onReachTop={onReachTop} />
    )
    expect(onReachTop).toHaveBeenCalledTimes(2)
  })

  it('compares rows on what they draw', () => {
    const row = userRow('x', 'one', 4)
    expect(sameRow(row, { ...row })).toBe(true)
    expect(sameRow(row, userRow('x', 'two', 4))).toBe(true)
    expect(sameRow(row, userRow('x', 'two', 5))).toBe(false)
    expect(sameRow(row, { ...row, presentation: 'chip' })).toBe(false)
  })
})
