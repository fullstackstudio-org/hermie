/**
 * The vertical rhythm of the transcript, as facts rather than as a look.
 *
 * Three separate bugs share one cause and are therefore pinned together here:
 * the gap belongs to the ROW, the row that draws nothing must not carry one,
 * and the typing bubble is a turn like any other and gets the same gap above it
 * as any other change of speaker.
 */
import { screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { TranscriptList } from '../../src/chat-ui'
import { assistantItem, botDmInItem, botDmOutItem, subagentMap, userItem } from '../../src/chat-ui/fixtures'
import { layoutRows, speakerKey } from '../../src/chat-ui/grouping'
import type { AssistantItem, BotDmOutItem, VisibleItem } from '../../src/chat-ui/types'
import { BUBBLE_GAP } from '../../src/ui/tokens'
import { renderScreen, withProviders } from '../support/render'

/** §6.6's own number, restated here so a change to it has to be deliberate. */
const DM_LINE_GAP = 9

const AT = botDmOutItem.ts ?? 0

const dmRun = (count: number): BotDmOutItem[] =>
  Array.from({ length: count }, (_, index) => ({
    ...botDmOutItem,
    id: `dm${index + 1}`,
    seq: 10 + index,
    ts: (botDmOutItem.ts ?? 0) + index
  }))

const visible = (items: { id: string }[]): VisibleItem[] =>
  items.map(item => ({ item, presentation: 'collapsed' }) as VisibleItem)

function marginOf(id: string): number {
  return (StyleSheet.flatten(screen.getByTestId(`transcript-row-${id}`).props.style) as { marginTop: number }).marginTop
}

describe('the gap a row opens above itself', () => {
  it('marks every dispatch after the first in a run as a ledger run, and nothing else', () => {
    const layout = layoutRows([...visible([userItem]), ...visible(dmRun(3)), ...visible([assistantItem])])

    expect(layout.dm1?.ledgerRun).toBe(false)
    expect(layout.dm2?.ledgerRun).toBe(true)
    expect(layout.dm3?.ledgerRun).toBe(true)
    // The reply AFTER the run starts a turn; it is not part of the ledger.
    expect(layout[assistantItem.id]?.ledgerRun).toBe(false)
  })

  /**
   * The run is about the PAIR, not merely about two rows being adjacent.
   *
   * A message out and the teammate's answer coming back in are the two halves of
   * one exchange, and the owner asked for them to sit tight. A dispatch to a
   * DIFFERENT teammate is a second errand, and running the two together would
   * read as one conversation that never happened.
   */
  it('runs a dispatch and the answer to it together, and breaks on a different teammate', () => {
    const outbound = { ...botDmOutItem, id: 'out1', seq: 10, ts: AT }
    const inbound = { ...botDmInItem, id: 'in1', seq: 11, ts: AT + 1 }
    const elsewhere = { ...botDmOutItem, id: 'out2', seq: 12, target: 'Builder', targetHandle: 'builder', ts: AT + 2 }
    const layout = layoutRows(visible([outbound, inbound, elsewhere]))

    expect(layout.out1?.ledgerRun).toBe(false)
    expect(layout.in1?.ledgerRun).toBe(true)
    expect(layout.out2?.ledgerRun).toBe(false)
  })

  it('leaves an inbound DM out of the speech runs, so it has no tail to draw', () => {
    // It used to key on `dm:<handle>`, which grouped consecutive inbound DMs
    // into a run of bubbles — right while it WAS a bubble, wrong now it is an
    // aside.
    expect(speakerKey({ ...botDmInItem, id: 'in1' })).toBeNull()
  })

  it('gives consecutive bot-to-bot lines nine points and the turn after them the full gap', () => {
    // Three lines: under the roll-up threshold, so every one of them draws.
    renderScreen(<TranscriptList items={[...visible(dmRun(3)), ...visible([assistantItem])]} subagents={subagentMap} />)

    expect(marginOf('dm2')).toBe(DM_LINE_GAP)
    expect(marginOf('dm3')).toBe(DM_LINE_GAP)
    expect(marginOf(assistantItem.id)).toBe(BUBBLE_GAP.separate)
  })

  it('gives a row that draws nothing no gap at all, so a collapsed run stays one line', () => {
    // Five: past the roll-up threshold, so four of them are swallowed.
    renderScreen(<TranscriptList items={[...visible(dmRun(5)), ...visible([assistantItem])]} subagents={subagentMap} />)

    expect(screen.getByTestId('transcript-row-dm1')).toBeTruthy()

    for (const id of ['dm2', 'dm3', 'dm4', 'dm5']) {
      expect(screen.queryByTestId(`transcript-row-${id}`)).toBeNull()
    }

    // Which is the whole point: the bubble under the roll-up is one turn gap
    // away from it, not five.
    expect(marginOf(assistantItem.id)).toBe(BUBBLE_GAP.separate)
  })

  it('does not let a hidden row swallow the day the first visible row belongs to', () => {
    const layout = layoutRows([
      { item: userItem, presentation: 'hidden-placeholder' },
      { item: assistantItem, presentation: 'full' }
    ])

    expect(layout[userItem.id]?.dateStamp).toBeUndefined()
    expect(layout[assistantItem.id]?.dateStamp).toBeTruthy()
  })
})

describe('the typing bubble', () => {
  const streaming: AssistantItem = { ...assistantItem, id: 'a-live', streaming: true, text: '' }

  it('gets the same gap above it as any other change of speaker', () => {
    renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} typing />)

    const row = StyleSheet.flatten(screen.getByTestId('transcript-list-typing-slot').props.style) as {
      marginTop?: number
    }

    expect(screen.getByTestId('typing-indicator')).toBeTruthy()
    // The row's own margin, the way every other row states its gap — the dots
    // are a cell now, not a pinned strip with padding.
    expect(row.marginTop).toBe(BUBBLE_GAP.separate)
  })

  it('is a row only while it is the turn, and hands over to the reply’s own bubble', () => {
    // The row exists for exactly the stretch of a turn that has produced no text.
    // Before it there is nothing at index 0 but the last message; after the first
    // token the streaming bubble holds the dots (§6.2) and the row is gone, so
    // the transcript never shows two sets of them.
    const view = renderScreen(<TranscriptList items={visible([userItem])} subagents={subagentMap} />)

    expect(screen.queryByTestId('transcript-list-typing-slot')).toBeNull()

    view.rerender(withProviders(<TranscriptList items={visible([userItem])} subagents={subagentMap} typing />))
    expect(screen.getByTestId('transcript-list-typing-slot')).toBeTruthy()
    expect(screen.getByTestId('typing-indicator')).toBeTruthy()

    view.rerender(
      withProviders(
        <TranscriptList
          items={[...visible([userItem]), { item: streaming, presentation: 'full' }]}
          subagents={subagentMap}
          typing
        />
      )
    )

    expect(screen.queryByTestId('transcript-list-typing-slot')).toBeNull()
    expect(screen.queryByTestId('typing-indicator')).toBeNull()
    expect(screen.getByTestId('assistant-typing-a-live')).toBeTruthy()
  })

  it('keeps the streaming row under one key from its first token to its last', () => {
    const view = renderScreen(
      <TranscriptList
        items={[...visible([userItem]), { item: streaming, presentation: 'full' }]}
        subagents={subagentMap}
      />
    )

    expect(screen.getByTestId('transcript-row-a-live')).toBeTruthy()

    const settled: AssistantItem = { ...streaming, rowId: 412, streaming: false, text: 'Done.', version: 9 }

    view.rerender(
      withProviders(
        <TranscriptList
          items={[...visible([userItem]), { item: settled, presentation: 'full' }]}
          subagents={subagentMap}
        />
      )
    )

    // Adopting a row id must not rename the row: a new key remounts the cell,
    // and a remounted cell is a new height wherever the list was anchored.
    expect(screen.getByTestId('transcript-row-a-live')).toBeTruthy()
    expect(marginOf('a-live')).toBe(BUBBLE_GAP.separate)
  })
})
