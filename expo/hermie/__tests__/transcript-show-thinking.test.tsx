/**
 * Show thinking reaches the transcript the moment it is switched.
 *
 * Found by driving the browser build: flipping the switch in the chat options
 * sheet wrote the setting and did nothing to the conversation. Thoughts stayed
 * on screen after it was switched off, and appeared after it was switched on
 * only once an unrelated frame from the gateway happened to bump an item's
 * version.
 *
 * The cause is one line in `visibleItems`, and it is the kind that hides well:
 * verbosity is answered by handing the row a different `presentation`, which the
 * row's memo key compares — but show thinking is answered by handing the row a
 * COPY of the same item with `reasoning` stripped. Same id, same version, same
 * presentation. `version` is the reducer's counter, so a read-time copy carries
 * the number of the item it was copied from and the memo declares the two
 * identical.
 *
 * So this is asserted at the level where it broke — the rendered transcript
 * after a rerender, not the selector in isolation, which was right all along.
 */
import { screen } from '@testing-library/react-native'

import { TranscriptList } from '../src/chat-ui'
import { assistantItem, userItem } from '../src/chat-ui/fixtures'
import type { VisibleItem } from '../src/chat-ui/types'
import { renderScreen, withProviders } from './support/render'

/** What `visibleItems` hands the list for one assistant row, per switch position. */
const rows = (showThinking: boolean): VisibleItem[] => [
  {
    item: showThinking ? assistantItem : { ...assistantItem, reasoning: undefined, reasoningVerbose: undefined },
    presentation: 'full'
  },
  { item: userItem, presentation: 'full' }
]

const thought = () => screen.queryByTestId(`reasoning-${assistantItem.id}`)

describe('show thinking', () => {
  it('takes the thought away the moment it is switched off', () => {
    const view = renderScreen(<TranscriptList items={rows(true)} />)

    expect(thought()).not.toBeNull()

    view.rerender(withProviders(<TranscriptList items={rows(false)} />))

    expect(thought()).toBeNull()
  })

  it('puts it back the moment it is switched on', () => {
    const view = renderScreen(<TranscriptList items={rows(false)} />)

    expect(thought()).toBeNull()

    view.rerender(withProviders(<TranscriptList items={rows(true)} />))

    expect(thought()).not.toBeNull()
  })
})
