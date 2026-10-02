/**
 * The parked messages, as a strip over the composer.
 *
 * They were bubbles at the end of the transcript, on the argument that "your
 * message is waiting" is not a system notice and must not look like one. The
 * other half of that argument is why they are not bubbles any more: a bubble is
 * a thing that HAPPENED, and a parked message has not.
 *
 * Four facts are asserted, and the last is the reason the component keeps state
 * of its own at all: a queued message stops being queued on the same frame its
 * bubble arrives, so the strip has to outlive its own data or there is no exit
 * to see.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'

import { QueuedStrip, QUEUE_STRIP_LIMIT } from '../../src/chat-ui'
import { renderScreen, withProviders } from '../support/render'

const entry = (n: number) => ({ id: `q-${n}`, text: `message number ${n}` })

const mount = (queued: { id: string; text: string; attachments?: string[] }[], handlers = {}) =>
  renderScreen(<QueuedStrip queued={queued} {...handlers} />)

describe('the queued strip', () => {
  it('draws nothing at all when nothing is parked', () => {
    mount([])

    expect(screen.queryByTestId('queued-strip')).toBeNull()
  })

  it('names the message on one line, and opens it on a tap', () => {
    mount([entry(1)])

    const text = screen.getByText('message number 1')

    expect(text.props.numberOfLines).toBe(1)

    fireEvent.press(screen.getByTestId('queued-strip-text-q-1'))

    // Opened in place: a queued message is short enough that sending the reader
    // somewhere else to read it costs more than the two lines it takes.
    expect(screen.getByText('message number 1').props.numberOfLines).toBeUndefined()
  })

  it('names an attachment beside the text, because the file goes with the message', () => {
    mount([{ id: 'q-9', text: 'look at this', attachments: ['@image:shot.png'] }])

    expect(screen.getByText('look at this · shot.png')).toBeTruthy()
  })

  it('stacks three and counts the rest, because six strips are a panel', () => {
    mount([entry(1), entry(2), entry(3), entry(4), entry(5)])

    for (let n = 1; n <= QUEUE_STRIP_LIMIT; n += 1) {
      expect(screen.getByTestId(`queued-strip-text-q-${n}`)).toBeTruthy()
    }

    expect(screen.queryByTestId('queued-strip-text-q-4')).toBeNull()
    expect(screen.getByTestId('queued-strip-more')).toHaveTextContent('+2 more')
  })

  it('keeps the oldest at the top, which is the order they will go out in', () => {
    mount([entry(1), entry(2)])

    const order = screen.getAllByTestId(/^queued-strip-slot-/).map(node => node.props.testID as string)

    expect(order).toEqual(['queued-strip-slot-q-1', 'queued-strip-slot-q-2'])
  })

  it('reports each action against its own message', () => {
    const onSteer = jest.fn()
    const onEdit = jest.fn()
    const onDelete = jest.fn()

    mount([entry(1), entry(2)], { onSteer, onEdit, onDelete })

    fireEvent.press(screen.getByTestId('queued-steer-q-2'))
    fireEvent.press(screen.getByTestId('queued-edit-q-1'))
    fireEvent.press(screen.getByTestId('queued-delete-q-2'))

    expect(onSteer).toHaveBeenCalledWith('q-2')
    expect(onEdit).toHaveBeenCalledWith('q-1')
    expect(onDelete).toHaveBeenCalledWith('q-2')
  })

  it('withholds Edit from a message carrying a file, which the field cannot take back', () => {
    mount([{ id: 'q-7', text: 'here', attachments: ['@image:shot.png'] }], {
      onSteer: jest.fn(),
      onEdit: jest.fn(),
      onDelete: jest.fn()
    })

    expect(screen.getByTestId('queued-steer-q-7')).toBeTruthy()
    expect(screen.getByTestId('queued-delete-q-7')).toBeTruthy()
    expect(screen.queryByTestId('queued-edit-q-7')).toBeNull()
  })

  it('outlives the message it was drawing, so the send has an exit to watch', () => {
    const view = mount([entry(1), entry(2)])

    act(() => {
      view.rerender(withProviders(<QueuedStrip queued={[entry(2)]} />))
    })

    // Still mounted on the frame after it stopped being queued: that frame is
    // the strip leaving while the bubble arrives. Without it the two changes
    // land together and the reader cannot see that one caused the other.
    const slot = screen.getByTestId('queued-strip-slot-q-1')

    expect(slot).toBeTruthy()
    expect(slot.props.pointerEvents).toBe('none')
  })
})
