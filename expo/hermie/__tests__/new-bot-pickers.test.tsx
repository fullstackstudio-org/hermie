/**
 * The New-bot sheet's two choices, which used to be segmented strips.
 *
 * The owner's report was that the model choice "is a horizontal bar" and that
 * "nothing is readable now", and that the clone choice was the same. A strip
 * divides ONE width between its options, so the failure is a function of how
 * many a gateway offers — which is why the fixture here is deliberately eight
 * models across three providers rather than the two a smaller fixture would
 * have got away with.
 *
 * What is asserted is what a reader can actually do: every option is on the
 * page with its full label, the current one is marked, the provider names the
 * section it heads, a long list can be searched, and picking sends the wire
 * pair rather than the label. The last of those is the bug the strip carried
 * silently — its option identity was the LABEL, so two providers offering one
 * model name would have collided.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { NewBotSheet, type ModelChoice } from '../src/features/profiles/NewBotSheet'
import { profileStrings } from '../src/features/profiles/strings'
import { strings } from '../src/i18n/strings'
import type { NewBotDraft } from '../src/features/profiles/profiles-controller'
import { renderScreen } from './support/render'

const MODELS: ModelChoice[] = [
  { label: 'Opus 4.1', model: 'acme/opus-4-1', provider: 'acme', providerName: 'Acme', detail: 'acme/opus-4-1' },
  { label: 'Sonnet 4.5', model: 'acme/sonnet-4-5', provider: 'acme', providerName: 'Acme', detail: 'acme/sonnet-4-5' },
  { label: 'Haiku 4.5', model: 'acme/haiku-4-5', provider: 'acme', providerName: 'Acme', detail: 'acme/haiku-4-5' },
  {
    label: 'Thinker 2.1',
    model: 'globex/thinker-2-1',
    provider: 'globex',
    providerName: 'Globex',
    detail: 'globex/thinker-2-1'
  },
  {
    label: 'Thinker 2.1 Turbo',
    model: 'globex/thinker-2-1-turbo',
    provider: 'globex',
    providerName: 'Globex',
    detail: 'globex/thinker-2-1-turbo'
  },
  {
    label: 'Scribe 1',
    model: 'globex/scribe-1',
    provider: 'globex',
    providerName: 'Globex',
    detail: 'globex/scribe-1'
  },
  // The same model NAME under two providers, which is what a label-keyed strip
  // could not tell apart.
  {
    label: 'Scribe 1',
    model: 'initech/scribe-1',
    provider: 'initech',
    providerName: 'Initech',
    detail: 'initech/scribe-1'
  },
  {
    label: 'Ledger 9',
    model: 'initech/ledger-9',
    provider: 'initech',
    providerName: 'Initech',
    detail: 'initech/ledger-9'
  }
]

const CLONEABLE = ['researcher', 'writer', 'scheduler']

function renderSheet(onCreate: (draft: NewBotDraft) => void = jest.fn()) {
  return renderScreen(
    <NewBotSheet cloneable={CLONEABLE} models={MODELS} onCancel={jest.fn()} onCreate={onCreate} taken={[]} visible />
  )
}

/** Open the model page, which is behind the row that says what is chosen now. */
function openModelPage() {
  fireEvent.press(screen.getByTestId('new-bot-model'))
}

describe('the New-bot sheet picks a model on a page', () => {
  it('shows the current choice on the row rather than a strip of segments', () => {
    renderSheet()

    // Nothing is pinned yet, so the row says so in words — and the page it
    // opens is not on the screen until it is asked for.
    expect(screen.getByTestId('new-bot-model')).toHaveTextContent(new RegExp(profileStrings.new.modelInherit))
    expect(screen.queryByTestId('picker-option-acme/opus-4-1')).toBeNull()
  })

  it('puts every model on the page under its own provider', () => {
    renderSheet()
    openModelPage()

    for (const choice of MODELS) {
      // Label and wire id both, which is what "readable" means here: the row
      // has room for the name AND the id a strip could fit neither of.
      expect(screen.getByTestId(`picker-option-${choice.model}`)).toHaveTextContent(
        `${choice.label}${choice.detail ?? ''}`
      )
    }

    // The provider heads a section instead of being repeated on every row.
    // `InsetGroup` uppercases every header at render (HERM-106), whatever the
    // section's own name is stored as.
    for (const provider of ['ACME', 'GLOBEX', 'INITECH']) {
      expect(screen.getByText(provider)).toBeTruthy()
    }

    // And "Inherit" is on the page too, above the sections rather than inside
    // whichever provider happens to come first.
    expect(screen.getByTestId('picker-option-')).toHaveTextContent(new RegExp(profileStrings.new.modelInherit))
  })

  it('shows the wire id under the name, because that is what a config file takes', () => {
    renderSheet()
    openModelPage()

    expect(screen.getByTestId('picker-option-initech/scribe-1')).toHaveTextContent(/initech\/scribe-1/)
  })

  it('searches once the list is long enough to need it', () => {
    renderSheet()
    openModelPage()

    const field = screen.getByTestId('picker-search')

    fireEvent.changeText(field, 'globex')

    expect(screen.getByTestId('picker-option-globex/thinker-2-1')).toBeTruthy()
    expect(screen.queryByTestId('picker-option-acme/opus-4-1')).toBeNull()

    // A needle nothing matches says so rather than showing an empty card.
    fireEvent.changeText(field, 'nothing-here')
    expect(screen.getByTestId('picker-empty')).toHaveTextContent(strings.common.noMatches)
  })

  it('stores the provider/model pair, not the label, and ticks it afterwards', () => {
    const onCreate = jest.fn()

    renderSheet(onCreate)
    openModelPage()

    // The SECOND of the two "Scribe 1" rows: a label-keyed control could not
    // have addressed it at all.
    fireEvent.press(screen.getByTestId('picker-option-initech/scribe-1'))

    // Back on the root, and the row now says the model rather than "Inherit".
    expect(screen.getByTestId('new-bot-model')).toHaveTextContent(/Scribe 1/)

    fireEvent.changeText(screen.getByTestId('new-bot-handle'), 'scout')
    fireEvent.press(screen.getByTestId('new-bot-create'))

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'scout', model: 'initech/scribe-1', provider: 'initech' })
    )
  })

  it('goes back to inheriting when the headless first row is picked again', () => {
    renderSheet()

    openModelPage()
    fireEvent.press(screen.getByTestId('picker-option-acme/opus-4-1'))
    expect(screen.getByTestId('new-bot-model')).toHaveTextContent(/Opus 4\.1/)

    openModelPage()
    fireEvent.press(screen.getByTestId('picker-option-'))
    expect(screen.getByTestId('new-bot-model')).toHaveTextContent(new RegExp(profileStrings.new.modelInherit))
  })

  it('leaves the page by the back control without changing anything', () => {
    renderSheet()

    openModelPage()
    fireEvent.press(screen.getByTestId('picker-back'))

    expect(screen.getByTestId('new-bot-model')).toHaveTextContent(new RegExp(profileStrings.new.modelInherit))
    expect(screen.queryByTestId('picker-option-acme/opus-4-1')).toBeNull()
  })
})

describe('the New-bot sheet picks what to clone on the same page', () => {
  it('lists every bot in full and sends the one that was picked', () => {
    const onCreate = jest.fn()

    renderSheet(onCreate)

    expect(screen.getByTestId('new-bot-clone')).toHaveTextContent(new RegExp(profileStrings.new.cloneNone))

    fireEvent.press(screen.getByTestId('new-bot-clone'))

    for (const name of CLONEABLE) {
      expect(screen.getByTestId(`picker-option-${name}`)).toHaveTextContent(name)
    }

    // Three bots is under the threshold, so the page does not spend a row on a
    // search field it does not need.
    expect(screen.queryByTestId('picker-search')).toBeNull()

    fireEvent.press(screen.getByTestId('picker-option-writer'))
    expect(screen.getByTestId('new-bot-clone')).toHaveTextContent(/writer/)

    fireEvent.changeText(screen.getByTestId('new-bot-handle'), 'scout')
    fireEvent.press(screen.getByTestId('new-bot-create'))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ cloneFrom: 'writer' }))
  })

  it('starts fresh again when the first row is picked', () => {
    renderSheet()

    fireEvent.press(screen.getByTestId('new-bot-clone'))
    fireEvent.press(screen.getByTestId('picker-option-researcher'))
    expect(screen.getByTestId('new-bot-clone')).toHaveTextContent(/researcher/)

    fireEvent.press(screen.getByTestId('new-bot-clone'))
    fireEvent.press(screen.getByTestId('picker-option-'))
    expect(screen.getByTestId('new-bot-clone')).toHaveTextContent(new RegExp(profileStrings.new.cloneNone))
  })
})
