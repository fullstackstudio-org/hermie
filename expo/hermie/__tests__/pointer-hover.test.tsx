/**
 * What the pointer says about a control, on the Mac and in a browser.
 *
 * Two signs, and a control needs both: a **cursor** that turns into a hand, and
 * a **tint** while the pointer is over it. The cursor answers "is this a thing
 * at all" before the reader commits to moving there; the tint answers "is this
 * the one I am on" once they have. A row with neither is a row people click
 * twice because they could not tell the first one landed.
 *
 * `transcript-pointer-hover.test.tsx` is the other half of this and pulls the
 * opposite way: nothing in the CONVERSATION may light up, because a highlight as
 * wide as the window following the mouse across running text is the bug the
 * owner reported. The line between them is size and purpose — a 44pt control
 * says it is pressable, a message does not.
 *
 * The surfaces pinned here are the ones the round found bare:
 *
 *  - the chat popover's rows, wrapped once so a switch, a disclosure and a
 *    segmented control all answer the same way;
 *  - every `Button`, which is what the memory rows and the inline approval
 *    answers are made of — a hover added per screen is a hover missing from the
 *    next screen somebody writes.
 *
 * The drag grip used to be a fourth. It is gone with the chat list's edit mode:
 * a row is held and moved now, so there is no 26pt column for a pointer to
 * announce itself over.
 *
 * `onPointerEnter` / `onPointerLeave` are view props on every platform in React
 * Native 0.81 and simply never fire where there is no pointer, so none of this
 * needs a platform check and none of it costs a phone anything.
 */
import { fireEvent, render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { ToolCard } from '../src/chat-ui/ToolCard'
import { searchToolItem } from '../src/chat-ui/fixtures'
import { Button } from '../src/ui/primitives'
import { ChatOptionsPopover } from '../src/ui/sheets'
import { renderScreen, withProviders } from './support/render'

/** The flattened style of one node, whatever shape its `style` prop is in. */
function styleOf(testID: string): Record<string, unknown> {
  return (StyleSheet.flatten(screen.getByTestId(testID).props.style) ?? {}) as Record<string, unknown>
}

/** Move the pointer onto a node and off it again. */
const enter = (testID: string) => fireEvent(screen.getByTestId(testID), 'pointerEnter')
const leave = (testID: string) => fireEvent(screen.getByTestId(testID), 'pointerLeave')

describe('a button', () => {
  it('tints itself under the pointer, and clears when it leaves', () => {
    renderScreen(<Button onPress={jest.fn()} testID="answer" title="Allow" />)

    const washes = () => screen.getByTestId('answer').findAllByProps({ pointerEvents: 'none' })

    expect(washes()).toHaveLength(0)

    enter('answer')
    expect(washes().length).toBeGreaterThan(0)

    leave('answer')
    expect(washes()).toHaveLength(0)
  })

  /**
   * A control that lights up and then does nothing is a lie.
   *
   * The cursor was already taught not to tell it — a disabled button falls back
   * to `auto` rather than a hand — and the tint has to agree, or the two signs
   * say opposite things about the same button.
   */
  it('stays dark while it is disabled', () => {
    renderScreen(<Button disabled onPress={jest.fn()} testID="answer" title="Allow" />)

    enter('answer')

    expect(screen.getByTestId('answer').findAllByProps({ pointerEvents: 'none' })).toHaveLength(0)
    expect(styleOf('answer').cursor).toBe('auto')
  })

  it('is what an inline approval answer is made of', () => {
    // The point of asserting this here: the approval buttons get their pointer
    // behaviour from `Button` rather than from a rule written out on the card,
    // so there is nothing on the card that can be forgotten.
    renderScreen(<ToolCard approval={{ choices: ['allow', 'deny'], onRespond: jest.fn() }} item={searchToolItem} />)

    const answer = `tool-approval-${searchToolItem.id}-allow`

    expect(styleOf(answer).cursor).toBe('pointer')

    enter(answer)
    expect(screen.getByTestId(answer).findAllByProps({ pointerEvents: 'none' }).length).toBeGreaterThan(0)
  })
})

describe('the chat popover rows', () => {
  const props = {
    accent: 'default' as const,
    botName: 'Researcher',
    fast: false,
    model: 'sonnet',
    modelLabel: 'Sonnet',
    modelOptions: [{ value: 'sonnet', label: 'Sonnet' }],
    muteLabel: 'Off',
    onChangeAccent: jest.fn(),
    onChangeFast: jest.fn(),
    onChangeModel: jest.fn(),
    onChangeReasoningEffort: jest.fn(),
    onChangeShowBotToBot: jest.fn(),
    onChangeShowThinking: jest.fn(),
    onChangeTextSize: jest.fn(),
    onChangeVerbosity: jest.fn(),
    onChangeYolo: jest.fn(),
    onClose: jest.fn(),
    onOpenPage: jest.fn(),
    reasoningEffort: 'medium',
    reasoningLabel: 'Medium',
    reasoningOptions: [{ value: 'medium', label: 'Medium' }],
    showBotToBot: true,
    showThinking: false,
    textSize: 'default' as const,
    verbosity: 'normal' as const,
    visible: true,
    yolo: false
  }

  it('tints a row under the pointer and clears it again', () => {
    render(withProviders(<ChatOptionsPopover {...props} />))

    const row = 'chat-options-popover-row-model'

    expect(styleOf(row).cursor).toBe('pointer')
    const before = styleOf(row).backgroundColor

    enter(row)
    expect(styleOf(row).backgroundColor).not.toBe(before)

    leave(row)
    expect(styleOf(row).backgroundColor).toBe(before)
  })

  /**
   * The keyboard's selection wins.
   *
   * A reader driving the menu with ↓ has a mouse sitting somewhere over the
   * list, and a hover painted over the selection would leave them unable to see
   * where Return is going. Row 0 is the one ↓ starts on.
   */
  it('does not let a hover repaint the row the keyboard is on', () => {
    render(withProviders(<ChatOptionsPopover {...props} />))

    const focused = 'chat-options-popover-row-yolo'
    const ring = styleOf(focused).backgroundColor

    enter(focused)

    expect(styleOf(focused).backgroundColor).toBe(ring)
  })
})
