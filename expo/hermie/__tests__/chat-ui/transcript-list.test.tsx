/**
 * The transcript renders every item kind and honours every presentation the
 * selectors can hand it.
 *
 * `visibleItems` returns `{item, presentation}` and nothing else, so a kind the
 * list forgets about is a silently blank row in production — hence one case per
 * kind here rather than one happy-path render.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { TranscriptList } from '../../src/chat-ui'
import {
  approvalItem,
  assistantItem,
  botDmInItem,
  botDmOutItem,
  clarifyItem,
  dmRunItems,
  galleryTranscript,
  noticeItem,
  pendingDmOutItem,
  searchToolItem,
  statusItem,
  subagentGroupItem,
  subagentMap,
  userItem
} from '../../src/chat-ui/fixtures'
import type { Presentation, TranscriptItem, VisibleItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

const PRESENTATIONS: Presentation[] = ['full', 'collapsed', 'chip', 'hidden-placeholder']

const KINDS: TranscriptItem[] = [
  userItem,
  assistantItem,
  botDmInItem,
  searchToolItem,
  botDmOutItem,
  subagentGroupItem,
  statusItem,
  noticeItem,
  approvalItem,
  clarifyItem
]

function renderList(items: VisibleItem[], props: Record<string, unknown> = {}) {
  return renderScreen(<TranscriptList items={items} subagents={subagentMap} {...props} />)
}

const FULL_TEST_IDS: Record<string, string | undefined> = {
  approval: `request-${approvalItem.id}`,
  assistant: `assistant-${assistantItem.id}`,
  bot_dm_in: `bot-dm-aside-${botDmInItem.id}`,
  bot_dm_out: `bot-dm-aside-${botDmOutItem.id}`,
  clarify: `request-${clarifyItem.id}`,
  notice: `notice-${noticeItem.id}`,
  status: `status-${statusItem.id}`,
  subagent_group: `subagent-group-${subagentGroupItem.id}`,
  tool: `tool-card-${searchToolItem.id}`,
  user: undefined
}

describe('TranscriptList', () => {
  // One list per kind: `FlatList` only mounts its first window, so a single
  // list of everything would silently skip the rows further up.
  it.each(KINDS.map(item => [item.kind, item] as const))('renders a %s item at full presentation', (kind, item) => {
    const view = renderList([{ item, presentation: 'full' }])
    const testID = FULL_TEST_IDS[kind]

    if (testID) {
      expect(view.getByTestId(testID)).toBeTruthy()
    } else {
      expect(view.getByText(userItem.text)).toBeTruthy()
    }
  })

  it.each(KINDS.map(item => [item.kind, item] as const))('renders a %s item at every presentation', (_kind, item) => {
    for (const presentation of PRESENTATIONS) {
      const view = renderList([{ item, presentation }])

      view.unmount()
    }
  })

  it('renders a hidden placeholder as nothing at all', () => {
    const view = renderList([{ item: searchToolItem, presentation: 'hidden-placeholder' }])

    expect(view.queryByTestId(`tool-card-${searchToolItem.id}`)).toBeNull()
  })

  it('renders a silent tool as nothing, even at full presentation', () => {
    const silent = { ...searchToolItem, id: 'silent', name: 'todo' }
    const view = renderList([{ item: silent, presentation: 'full' }])

    expect(view.queryByTestId('tool-card-silent')).toBeNull()
  })

  it('collapses a demoted DM to a chip that opens the other bot', () => {
    const onOpenBot = jest.fn()

    renderList([{ item: botDmInItem, presentation: 'chip' }], { onOpenBot })

    fireEvent.press(screen.getByTestId(`bot-dm-in-chip-${botDmInItem.id}`))
    // The second argument describes the row to look for on the far side, so the
    // sender's chat opens on the dispatch rather than at its bottom. §6.6 removed
    // navigation as the DEFAULT gesture on a DM line, not the ability to land
    // somewhere useful once the reader has explicitly asked.
    expect(onOpenBot).toHaveBeenCalledWith('writer', expect.objectContaining({ kind: 'bot_dm_out' }))
  })

  it('shows the receipt under the last own bubble only', () => {
    const second = { ...userItem, id: 'u2', seq: 40, text: 'Second question.' }

    renderList(
      [
        { item: userItem, presentation: 'full' },
        { item: assistantItem, presentation: 'full' },
        { item: second, presentation: 'full' }
      ],
      { receipt: 'read' }
    )

    // The receipt is a tick on the metadata line, labelled for anyone who
    // cannot see it. One bubble carries it, not all three.
    expect(screen.getAllByLabelText(/Read$/)).toHaveLength(1)
  })

  it('reports scrolling away from the bottom and shows the jump pill', () => {
    const onScrolledAwayFromBottom = jest.fn()

    renderList(galleryTranscript, { newMessageCount: 3, onScrolledAwayFromBottom })

    fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
      nativeEvent: {
        contentOffset: { x: 0, y: 400 },
        contentSize: { height: 2000, width: 400 },
        layoutMeasurement: { height: 800, width: 400 }
      }
    })

    expect(onScrolledAwayFromBottom).toHaveBeenCalledWith(true)
    expect(screen.getByTestId('jump-to-latest')).toBeTruthy()
    // The pill is glass now and the count is a badge on it rather than the whole
    // label; the label stays readable for anyone who cannot see the badge.
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.getByLabelText(/Jump to latest, 3 new/)).toBeTruthy()
  })

  it('shows the typing bubble while a turn has produced no text', () => {
    renderList(galleryTranscript, { typing: true })

    expect(screen.getByTestId('typing-indicator')).toBeTruthy()
  })
})

describe('answered questions', () => {
  it('leaves a receipt naming the decision AND the command, never a bare duration', () => {
    renderList([
      {
        item: { ...approvalItem, answer: 'once', state: 'answered' },
        presentation: 'full'
      }
    ])

    expect(screen.getByText('Allowed once · git push origin release-notes')).toBeTruthy()
  })

  it('truncates a long command rather than pushing the decision off the row', () => {
    renderList([
      {
        item: {
          ...approvalItem,
          answer: 'deny',
          command: 'rm -rf ./build && rm -rf ./dist && rm -rf ./node_modules/.cache && echo done',
          state: 'answered'
        },
        presentation: 'full'
      }
    ])

    expect(screen.getByText(/^Denied · rm -rf \.\/build/u)).toBeTruthy()
    expect(screen.getByText(/…$/u)).toBeTruthy()
  })

  it('says a question was answered elsewhere rather than inventing an outcome', () => {
    renderList([{ item: { ...approvalItem, state: 'cancelled' }, presentation: 'full' }])

    expect(screen.getByText('Answered elsewhere')).toBeTruthy()
  })
})

describe('bot-to-bot rows are asides, not bubbles', () => {
  /*
    The owner's rule, checked where the list actually assembles a row rather than
    on a component in isolation: neither direction may reach a `Bubble`. A bubble
    leaves `<testID>` and `<testID>-box` behind it, and the inbound row used to
    carry both.
  */
  it('draws no bubble for either direction, at any presentation the selectors give', () => {
    for (const presentation of ['full', 'collapsed'] as const) {
      const view = renderList([
        { item: botDmOutItem, presentation },
        { item: botDmInItem, presentation }
      ])

      expect(view.getByTestId(`bot-dm-aside-${botDmOutItem.id}`)).toBeTruthy()
      expect(view.getByTestId(`bot-dm-aside-${botDmInItem.id}`)).toBeTruthy()
      expect(view.queryByTestId(`bot-dm-in-${botDmInItem.id}`)).toBeNull()
      expect(view.queryByTestId(`bot-dm-in-${botDmInItem.id}-box`)).toBeNull()

      view.unmount()
    }
  })

  it('keeps both directions closed until the reader taps, and remembers the tap', () => {
    const view = renderList([{ item: botDmInItem, presentation: 'full' }])

    expect(view.queryByTestId(`bot-dm-aside-${botDmInItem.id}-body`)).toBeNull()

    fireEvent.press(view.getByTestId(`bot-dm-aside-${botDmInItem.id}-toggle`))
    expect(view.getByTestId(`bot-dm-aside-${botDmInItem.id}-body`)).toBeTruthy()
  })
})

describe('the roll-up boundary', () => {
  /*
    Up to three consecutive asides stay asides; the fourth turns the run into the
    roll-up line, which the owner asked to keep exactly as it is. The pure boundary
    is `dm-rollup.test.ts`'s; this is the rendered one, because the two can
    disagree — `DmAsideRow` decides separately whether a member draws itself.
  */
  const run = (count: number) => dmRunItems.slice(0, count).map(item => ({ item, presentation: 'collapsed' as const }))

  it('draws three in a row as three asides and no roll-up', () => {
    const view = renderList(run(3))

    for (const item of dmRunItems.slice(0, 3)) {
      expect(view.getByTestId(`bot-dm-aside-${item.id}`)).toBeTruthy()
    }

    expect(view.queryByTestId(`bot-dm-rollup-${dmRunItems[0]?.id}`)).toBeNull()
  })

  it('folds an answer standing between dispatches into the same run', () => {
    // Two errands, the answer to one of them, one more errand: four consecutive
    // asides, so one roll-up. Gathering only dispatches left the inbound row
    // drawn on its own between two short runs.
    const entries = [dmRunItems[0]!, dmRunItems[1]!, botDmInItem, dmRunItems[2]!].map(item => ({
      item,
      presentation: 'collapsed' as const
    }))
    const view = renderList(entries)
    const head = dmRunItems[0]?.id ?? ''

    expect(view.getByTestId(`bot-dm-rollup-${head}`)).toBeTruthy()
    expect(view.queryByTestId(`bot-dm-aside-${botDmInItem.id}`)).toBeNull()

    fireEvent.press(view.getByTestId(`bot-dm-rollup-${head}`))

    expect(view.getByTestId(`bot-dm-aside-${botDmInItem.id}`)).toBeTruthy()
  })

  it('draws four in a row as the roll-up, and the asides only once it is opened', () => {
    const view = renderList(run(4))
    const head = dmRunItems[0]?.id ?? ''

    expect(view.getByTestId(`bot-dm-rollup-${head}`)).toBeTruthy()

    for (const item of dmRunItems.slice(1, 4)) {
      expect(view.queryByTestId(`bot-dm-aside-${item.id}`)).toBeNull()
    }

    fireEvent.press(view.getByTestId(`bot-dm-rollup-${head}`))

    for (const item of dmRunItems.slice(0, 4)) {
      expect(view.getByTestId(`bot-dm-aside-${item.id}`)).toBeTruthy()
      // Opening the run opens the run, not the messages in it.
      expect(view.queryByTestId(`bot-dm-aside-${item.id}-body`)).toBeNull()
    }
  })
})

describe('a dispatch whose recipient is answering', () => {
  it('says so under the card while the reply has not landed', () => {
    renderList([{ item: pendingDmOutItem, presentation: 'collapsed' }], { typingHandles: ['builder'] })

    // It refines the WAITING marker rather than adding a fourth one: the line's
    // right-hand side is always exactly one indicator.
    expect(screen.getByTestId(`bot-dm-out-typing-${pendingDmOutItem.id}`)).toBeTruthy()
    expect(screen.getByText('@builder is writing…')).toBeTruthy()
  })

  it('stays quiet for a dispatch that already has its reply', () => {
    renderList([{ item: botDmOutItem, presentation: 'collapsed' }], { typingHandles: ['writer'] })

    expect(screen.queryByTestId(`bot-dm-out-typing-${botDmOutItem.id}`)).toBeNull()
  })
})
