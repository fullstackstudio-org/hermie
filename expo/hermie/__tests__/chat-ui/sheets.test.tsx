/**
 * The bottom sheets, and the three rules that matter more than their looks:
 * a tap guard, exactly the server's choices, and a dismissal that answers
 * nothing.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { Modal, Text } from 'react-native'

import { AgentsSheet } from '../../src/chat-ui'
import { approvalItem, clarifyItem, subagentTree } from '../../src/chat-ui/fixtures'
import { BottomSheet } from '../../src/ui/BottomSheet'
import { ApprovalSheet, ChatOptionsSheet, ClarifySheet } from '../../src/ui/sheets'
import { renderScreen, withProviders } from '../support/render'

const MODEL_OPTIONS = [
  { label: 'Gateway default', value: 'default' },
  { expensive: true, label: 'example-model-large', value: 'example-model-large' }
]

const REASONING_OPTIONS = [
  { label: 'High', value: 'high' },
  { label: 'Low', value: 'low' }
]

describe('BottomSheet', () => {
  it('dismisses on a backdrop tap', () => {
    const onRequestClose = jest.fn()

    renderScreen(
      <BottomSheet onRequestClose={onRequestClose} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    fireEvent.press(screen.getByTestId('sheet-backdrop'))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('asks to close rather than answering, which is what a question can allow', () => {
    // Every sheet takes a backdrop tap now, including one carrying an agent's
    // question. ADR-0010 is about ANSWERING — an explicit tap on a named choice
    // — and this is not one: the caller puts the question aside.
    const onRequestClose = jest.fn()

    renderScreen(
      <BottomSheet onRequestClose={onRequestClose} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    fireEvent.press(screen.getByTestId('sheet-backdrop'))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('renders nothing while closed', () => {
    const view = renderScreen(
      <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible={false}>
        <Text>Body</Text>
      </BottomSheet>
    )

    expect(view.queryByTestId('sheet')).toBeNull()
  })

  it('presents through a Modal, which is what puts it above the navigator', () => {
    const view = renderScreen(
      <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    expect(view.UNSAFE_queryAllByType(Modal)).toHaveLength(1)
  })

  it('does not announce the grabber, which is not a control', () => {
    renderScreen(
      <BottomSheet onRequestClose={jest.fn()} testID="sheet" visible>
        <Text>Body</Text>
      </BottomSheet>
    )

    expect(screen.queryByLabelText('Drag handle')).toBeNull()
    // The way out IS announced.
    expect(screen.getByLabelText('Dismiss')).toBeTruthy()
  })
})

describe('ApprovalSheet', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const renderSheet = (props: Record<string, unknown> = {}) => {
    const onRespond = jest.fn()

    const view = renderScreen(
      <ApprovalSheet
        botHandle="researcher"
        item={approvalItem}
        onClose={jest.fn()}
        onRespond={onRespond}
        visible
        {...props}
      />
    )

    return { onRespond, view }
  }

  it('renders exactly the server choices, in the server order', () => {
    renderSheet()

    expect(screen.getByTestId('approval-choice-once')).toBeTruthy()
    expect(screen.getByTestId('approval-choice-session')).toBeTruthy()
    expect(screen.getByTestId('approval-choice-always')).toBeTruthy()
    expect(screen.getByTestId('approval-choice-deny')).toBeTruthy()
  })

  it('offers no choice the server did not send', () => {
    renderSheet({ item: { ...approvalItem, choices: ['once', 'deny'] } })

    expect(screen.queryByTestId('approval-choice-always')).toBeNull()
    expect(screen.queryByTestId('approval-choice-session')).toBeNull()
  })

  it('ignores a tap inside the guard window and accepts one after it', () => {
    const { onRespond } = renderSheet()

    fireEvent.press(screen.getByTestId('approval-choice-once'))
    expect(onRespond).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(400)
    })

    fireEvent.press(screen.getByTestId('approval-choice-once'))
    expect(onRespond).toHaveBeenCalledWith('once')
  })

  it('re-arms the guard when a second question replaces the first', () => {
    const onRespond = jest.fn()

    const view = renderScreen(
      <ApprovalSheet botHandle="researcher" item={approvalItem} onClose={jest.fn()} onRespond={onRespond} visible />
    )

    act(() => {
      jest.advanceTimersByTime(400)
    })

    // A second question arrives into the SAME mounted sheet: `visible` never
    // went false, and a guard keyed only on `visible` would leave "Allow once"
    // live under the finger that just answered the first one.
    view.rerender(
      withProviders(
        <ApprovalSheet
          botHandle="researcher"
          item={{ ...approvalItem, command: 'rm -rf build', id: 'ap-2', requestId: 'srq-9' }}
          onClose={jest.fn()}
          onRespond={onRespond}
          visible
        />
      )
    )

    fireEvent.press(screen.getByTestId('approval-choice-once'))
    expect(onRespond).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(400)
    })

    fireEvent.press(screen.getByTestId('approval-choice-once'))
    expect(onRespond).toHaveBeenCalledWith('once')
  })

  it('passes the choice through verbatim', () => {
    const { onRespond } = renderSheet({ tapGuardMs: 0 })

    fireEvent.press(screen.getByTestId('approval-choice-always'))
    expect(onRespond).toHaveBeenCalledWith('always')
  })

  it('shows the command and the tool that asked', () => {
    renderSheet()

    expect(screen.getByTestId('approval-command').props.children).toBe(approvalItem.command)
    expect(screen.getByTestId('approval-tool-name')).toBeTruthy()
  })

  it('explains a request answered somewhere else', () => {
    renderSheet({ item: { ...approvalItem, cancelReason: 'resolved', state: 'cancelled' } })

    expect(screen.getByText('Answered elsewhere')).toBeTruthy()
    expect(screen.queryByTestId('approval-choice-once')).toBeNull()
  })

  it('explains a request that timed out', () => {
    renderSheet({ item: { ...approvalItem, cancelReason: 'timeout', state: 'cancelled' } })

    expect(screen.getByText('Timed out')).toBeTruthy()
  })

  it('reports the answer once it has one', () => {
    renderSheet({ item: { ...approvalItem, answer: 'once', state: 'answered' } })

    expect(screen.getByText('Answered: Allow once')).toBeTruthy()
  })
})

describe('ClarifySheet', () => {
  const renderSheet = (props: Record<string, unknown> = {}) => {
    const onSubmit = jest.fn()
    const onLock = jest.fn()
    const onSkip = jest.fn()

    renderScreen(
      <ClarifySheet
        item={clarifyItem}
        onClose={jest.fn()}
        onLock={onLock}
        onSkip={onSkip}
        onSubmit={onSubmit}
        visible
        {...props}
      />
    )

    return { onLock, onSkip, onSubmit }
  }

  it('steps through a batch and submits every answer at once', () => {
    const { onSubmit } = renderSheet()

    // The step count rides beside the eyebrow, in the same uppercase micro style.
    expect(screen.getByTestId('clarify-step').props.children).toBe('QUESTION 1 OF 2')

    fireEvent.press(screen.getByTestId('clarify-choice-Warm and direct'))
    fireEvent.press(screen.getByTestId('clarify-next'))

    expect(screen.getByTestId('clarify-step').props.children).toBe('QUESTION 2 OF 2')

    // The second question is multi-select: both choices stay selected.
    fireEvent.press(screen.getByTestId('clarify-choice-Recovery'))
    fireEvent.press(screen.getByTestId('clarify-choice-Routines'))
    fireEvent.press(screen.getByTestId('clarify-submit'))

    expect(onSubmit).toHaveBeenCalledWith({ q1: 'Warm and direct', q2: 'Recovery, Routines' })
  })

  it('locks one answer without submitting the batch', () => {
    const { onLock, onSubmit } = renderSheet()

    fireEvent.press(screen.getByTestId('clarify-choice-Formal'))
    fireEvent.press(screen.getByTestId('clarify-lock'))

    expect(onLock).toHaveBeenCalledWith('q1', 'Formal')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not offer to re-lock a question the server already accepted', () => {
    renderSheet({ item: { ...clarifyItem, answers: { q1: 'Formal' }, locked: ['q1'] } })

    expect(screen.queryByTestId('clarify-lock')).toBeNull()
    expect(screen.getByTestId('clarify-locked')).toBeTruthy()
  })

  it('skips', () => {
    const { onSkip } = renderSheet()

    fireEvent.press(screen.getByTestId('clarify-skip'))
    expect(onSkip).toHaveBeenCalled()
  })

  it('submits straight away for a single question', () => {
    const { onSubmit } = renderSheet({ item: { ...clarifyItem, questions: [clarifyItem.questions[0]] } })

    expect(screen.queryByTestId('clarify-step')).toBeNull()

    fireEvent.press(screen.getByTestId('clarify-choice-Playful'))
    fireEvent.press(screen.getByTestId('clarify-submit'))

    expect(onSubmit).toHaveBeenCalledWith({ q1: 'Playful' })
  })
})

describe('ChatOptionsSheet', () => {
  const renderSheet = (props: Record<string, unknown> = {}) => {
    const handlers = {
      onChangeFast: jest.fn(),
      onChangeModel: jest.fn(),
      onChangeReasoningEffort: jest.fn(),
      onChangeShowBotToBot: jest.fn(),
      onChangeShowThinking: jest.fn(),
      onChangeVerbosity: jest.fn(),
      onChangeYolo: jest.fn(),
      onClose: jest.fn(),
      onPickExpensiveModel: jest.fn()
    }

    renderScreen(
      <ChatOptionsSheet
        botName="Researcher"
        fast
        model="default"
        modelOptions={MODEL_OPTIONS}
        reasoningEffort="high"
        reasoningOptions={REASONING_OPTIONS}
        showBotToBot
        showThinking={false}
        verbosity="normal"
        visible
        yolo={false}
        {...handlers}
        {...props}
      />
    )

    return handlers
  }

  it('reports switch and segment changes', () => {
    const handlers = renderSheet()

    fireEvent.press(screen.getByTestId('option-yolo'))
    expect(handlers.onChangeYolo).toHaveBeenCalledWith(true)

    fireEvent.press(screen.getByTestId('option-verbosity-verbose'))
    expect(handlers.onChangeVerbosity).toHaveBeenCalledWith('verbose')

    fireEvent.press(screen.getByTestId('option-thinking'))
    expect(handlers.onChangeShowThinking).toHaveBeenCalledWith(true)
  })

  it('picks a reasoning effort from its own pane', () => {
    const handlers = renderSheet()

    fireEvent.press(screen.getByTestId('option-reasoning'))
    fireEvent.press(screen.getByTestId('picker-option-low'))

    expect(handlers.onChangeReasoningEffort).toHaveBeenCalledWith('low')
  })

  it('hands an expensive model to the caller instead of switching to it', () => {
    const handlers = renderSheet()

    fireEvent.press(screen.getByTestId('option-model'))
    fireEvent.press(screen.getByTestId('picker-option-example-model-large'))

    expect(handlers.onPickExpensiveModel).toHaveBeenCalledWith('example-model-large')
    expect(handlers.onChangeModel).not.toHaveBeenCalled()
  })

  it('offers a reset only when the chat pins its own view', () => {
    const onResetView = jest.fn()

    renderSheet({ onResetView, viewOverridden: false })
    expect(screen.queryByTestId('option-use-default')).toBeNull()

    renderSheet({ onResetView, viewOverridden: true })
    fireEvent.press(screen.getByTestId('option-use-default'))

    expect(onResetView).toHaveBeenCalled()
  })

  it('asks for confirmation before an expensive model the gateway flagged', () => {
    const onConfirmExpensiveModel = jest.fn()
    const onCancelExpensiveModel = jest.fn()

    renderSheet({
      confirmMessage: 'That model bills at four times the rate.',
      onCancelExpensiveModel,
      onConfirmExpensiveModel,
      pendingExpensiveModel: 'example-model-large'
    })

    expect(screen.getByText('That model bills at four times the rate.')).toBeTruthy()

    fireEvent.press(screen.getByTestId('option-model-confirm'))
    expect(onConfirmExpensiveModel).toHaveBeenCalled()

    fireEvent.press(screen.getByTestId('option-model-cancel'))
    expect(onCancelExpensiveModel).toHaveBeenCalled()
  })

  it('filters the model list', () => {
    renderSheet()

    fireEvent.press(screen.getByTestId('option-model'))
    fireEvent.changeText(screen.getByTestId('picker-search'), 'large')

    expect(screen.queryByTestId('picker-option-default')).toBeNull()
    expect(screen.getByTestId('picker-option-example-model-large')).toBeTruthy()
  })
})

describe('AgentsSheet', () => {
  const render = (props: Partial<React.ComponentProps<typeof AgentsSheet>> = {}) =>
    renderScreen(<AgentsSheet onClose={jest.fn()} tree={subagentTree} visible {...props} />)

  it('draws the tree, parents before their children', () => {
    render()

    expect(screen.getByTestId('agent-row-sa-1')).toBeTruthy()
    expect(screen.getByTestId('agent-row-sa-2')).toBeTruthy()
    // sa-3 is nested under sa-1 and must still be reachable.
    expect(screen.getByTestId('agent-row-sa-3')).toBeTruthy()
  })

  it('shows the stream lines of a running child', () => {
    render()

    expect(screen.getByText('Reading the changelog.')).toBeTruthy()
    expect(screen.getByText('web_search "release changelog"')).toBeTruthy()
  })

  it('steers a running child with the words as typed', () => {
    const onSteer = jest.fn()

    render({ onSteer })

    fireEvent.press(screen.getByTestId('agent-steer-sa-1'))
    fireEvent.changeText(screen.getByTestId('agent-steer-input-sa-1'), 'check the 1.4 notes too')
    fireEvent.press(screen.getByTestId('agent-steer-send-sa-1'))

    expect(onSteer).toHaveBeenCalledWith('sa-1', 'check the 1.4 notes too')
  })

  it('offers Stop only while a child is live', () => {
    const onInterrupt = jest.fn()

    render({ onInterrupt })

    fireEvent.press(screen.getByTestId('agent-stop-sa-1'))
    expect(onInterrupt).toHaveBeenCalledWith('sa-1')
    // sa-2 has completed: there is nothing left to stop.
    expect(screen.queryByTestId('agent-stop-sa-2')).toBeNull()
  })

  it('offers Open transcript only for a child with a session behind it', () => {
    const onOpenTranscript = jest.fn()

    render({ onOpenTranscript })

    fireEvent.press(screen.getByTestId('agent-transcript-sa-2'))
    expect(onOpenTranscript).toHaveBeenCalledWith('sa-2')
    expect(screen.queryByTestId('agent-transcript-sa-1')).toBeNull()
  })

  it('replaces the tree with the transcript panel and says which source it is', () => {
    render({
      transcript: {
        goal: 'Check recovery',
        loading: false,
        source: 'stored',
        subagentId: 'sa-2',
        text: '> Check recovery\n· read_file(README.md)'
      }
    })

    expect(screen.getByTestId('agent-transcript-text')).toHaveTextContent(/read_file\(README\.md\)/u)
    // The transcript is a PAGE of the sheet now, with the same back control every
    // other sheet page has, and the source line is its eyebrow.
    expect(screen.getByText('THE CHILD’S OWN TRANSCRIPT, READ-ONLY.')).toBeTruthy()
    expect(screen.getByTestId('agent-transcript-back')).toBeTruthy()
    expect(screen.queryByTestId('agent-row-sa-1')).toBeNull()
  })

  it('reports the outcome of a steer that came too late', () => {
    render({ notice: 'Too late to steer — the agent had already finished its last batch.' })

    expect(screen.getByTestId('agents-sheet-notice')).toBeTruthy()
  })
})
