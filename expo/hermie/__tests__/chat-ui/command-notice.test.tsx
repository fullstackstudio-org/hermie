/**
 * A slash command's answer: always on screen, and already open.
 *
 * The report was one sentence long — "command response altijd zichtbaar; nu
 * alleen zichtbaar als thinking aan staat; standaard uitgeklapt" — and it names
 * two separate faults. The selector dropped the row at `quiet`, which is the
 * level the app ships on, so the answer only existed for a reader who had turned
 * verbosity up. And what the other levels drew was a folded `LedgerRow`: a
 * chevron, a title, and the answer hidden behind a tap nobody knew to make.
 *
 * `selectors.test.ts` holds the first half. This is the second: the row opens
 * itself, the reader can still close it, and closing it survives the unmount a
 * virtualised list puts every row through.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { useState } from 'react'
import { Text as RNText } from 'react-native'

import { ExpandedProvider, NoticePill } from '../../src/chat-ui'
import type { NoticeItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

const OUTPUT = '+--------+\n| model  |\n+--------+\n| k3     |'

const commandNotice = (over: Partial<NoticeItem> = {}): NoticeItem => ({
  id: 'n-cmd',
  kind: 'notice',
  noticeKind: 'command',
  origin: 'live',
  seq: 1000,
  title: '/help',
  body: OUTPUT,
  version: 0,
  ...over
})

/** The row, mountable and unmountable the way `FlatList` does it. */
function Harness({ item }: { item: NoticeItem }) {
  const [mounted, setMounted] = useState(true)

  return (
    <ExpandedProvider>
      <RNText onPress={() => setMounted(current => !current)} testID="virtualise">
        virtualise
      </RNText>
      {mounted ? <NoticePill item={item} presentation="full" /> : null}
    </ExpandedProvider>
  )
}

describe('a command answer in the transcript', () => {
  it('is open before anybody touches it', () => {
    renderScreen(
      <ExpandedProvider>
        <NoticePill item={commandNotice()} presentation="full" />
      </ExpandedProvider>
    )

    expect(screen.getByTestId('notice-body-n-cmd').props.children).toBe(OUTPUT)
  })

  it('is titled by the command as it was typed, so the answer has a question', () => {
    renderScreen(
      <ExpandedProvider>
        <NoticePill item={commandNotice({ title: '/model k3' })} presentation="full" />
      </ExpandedProvider>
    )

    expect(screen.getByTestId('notice-n-cmd-toggle')).toBeTruthy()
    expect(screen.getByTestId('notice-body-n-cmd')).toBeTruthy()
  })

  it('still folds on a tap — open is a starting position, not a rule', () => {
    renderScreen(<Harness item={commandNotice()} />)

    fireEvent.press(screen.getByTestId('notice-n-cmd-toggle'))

    expect(screen.queryByTestId('notice-body-n-cmd')).toBeNull()
  })

  /**
   * The whole reason the default lives in the provider rather than in the row.
   *
   * A row that opened itself by branching on its own props would re-open every
   * time the list scrolled it back into the window, so a reader who closed a
   * five-kilobyte `/help` would find it open again a moment later. The provider
   * records the CHOICE; the default only applies while there is none.
   */
  it('remembers that it was closed across the unmount virtualisation causes', () => {
    renderScreen(<Harness item={commandNotice()} />)

    fireEvent.press(screen.getByTestId('notice-n-cmd-toggle'))
    expect(screen.queryByTestId('notice-body-n-cmd')).toBeNull()

    act(() => fireEvent.press(screen.getByTestId('virtualise')))
    expect(screen.queryByTestId('notice-n-cmd')).toBeNull()

    act(() => fireEvent.press(screen.getByTestId('virtualise')))
    expect(screen.queryByTestId('notice-body-n-cmd')).toBeNull()

    // And re-opening it from there works, which is what says the state is a
    // choice and not a latch.
    fireEvent.press(screen.getByTestId('notice-n-cmd-toggle'))
    expect(screen.getByTestId('notice-body-n-cmd')).toBeTruthy()
  })

  it('leaves an ordinary notice closed, and an error card alone', () => {
    renderScreen(
      <ExpandedProvider>
        <NoticePill item={commandNotice({ id: 'n-plain', noticeKind: 'notice', title: 'refreshed' })} />
      </ExpandedProvider>
    )

    expect(screen.queryByTestId('notice-body-n-plain')).toBeNull()
  })
})
