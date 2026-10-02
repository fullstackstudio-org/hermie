/**
 * The two rows that take a conversation out of the app.
 *
 * The serialization itself is `packages/transcript/src/export.test.ts` — a pure
 * function with its own suite. What is left for this side is the wiring: two
 * formats offered rather than one guessed at, the right verb for the platform,
 * and a group that is not drawn at all where nothing can be exported.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { SHARE_FILE_VERB } from '../src/platform/share-text'
import { ChatOptionsSheet } from '../src/ui/sheets'
import { renderScreen } from './support/render'

const OPTIONS = {
  accent: 'default' as const,
  botName: 'Researcher',
  fast: false,
  model: 'example-provider/example-model',
  modelOptions: [],
  mutedUntil: null,
  onChangeAccent: () => undefined,
  onChangeFast: () => undefined,
  onChangeModel: () => undefined,
  onChangeMute: () => undefined,
  onChangeReasoningEffort: () => undefined,
  onChangeShowBotToBot: () => undefined,
  onChangeShowThinking: () => undefined,
  onChangeVerbosity: () => undefined,
  onChangeYolo: () => undefined,
  onClose: () => undefined,
  reasoningEffort: 'medium',
  reasoningOptions: [],
  showBotToBot: true,
  showThinking: false,
  verbosity: 'normal' as const,
  visible: true,
  yolo: false
}

describe('exporting from the chat options sheet', () => {
  it('offers both formats and asks for the one that was pressed', () => {
    const onExport = jest.fn()

    renderScreen(<ChatOptionsSheet {...OPTIONS} onExport={onExport} />)

    fireEvent.press(screen.getByTestId('option-export-markdown'))
    expect(onExport).toHaveBeenLastCalledWith('md')

    fireEvent.press(screen.getByTestId('option-export-text'))
    expect(onExport).toHaveBeenLastCalledWith('txt')

    // Two formats, neither a default. Guessing which one a reader meant is the
    // same mistake as offering only one Copy line.
    expect(onExport).toHaveBeenCalledTimes(2)
  })

  it('names the action with the verb the platform can actually perform', () => {
    renderScreen(<ChatOptionsSheet {...OPTIONS} onExport={() => undefined} />)

    // Under jest this is the native seam, which has a share sheet. The browser
    // build resolves `share-text.web.ts` and says Download instead — the same
    // split the image viewer's button already makes.
    expect(SHARE_FILE_VERB).toBe('share')
    expect(screen.getByText('Share as Markdown')).toBeTruthy()
    expect(screen.getByText('Share as plain text')).toBeTruthy()
  })

  it('draws no export group where there is nothing to export', () => {
    renderScreen(<ChatOptionsSheet {...OPTIONS} />)

    expect(screen.queryByTestId('option-export-markdown')).toBeNull()
    expect(screen.queryByTestId('option-export-text')).toBeNull()
    expect(screen.getByTestId('option-model')).toBeTruthy()
  })

  /**
   * HERM-125: the group's own heading still shouts "EXPORT" — `InsetGroup`
   * uppercases every header at render (HERM-106) — but the export PAGE's
   * title is a `SheetPage` title, which is never transformed. A string still
   * typed in capitals showed through there verbatim, the one row and page
   * left behind when the rest of the sheet was sentence-cased.
   */
  it('shouts the group heading but not the page title', () => {
    renderScreen(<ChatOptionsSheet {...OPTIONS} initialPane="export" onExport={() => undefined} />)

    // The page reached directly, on the title a reader actually reads.
    expect(screen.getByText('Export')).toBeTruthy()
    expect(screen.queryByText('EXPORT')).toBeNull()
  })

  it('still shouts the root group heading, consistent with its siblings', () => {
    renderScreen(<ChatOptionsSheet {...OPTIONS} onExport={() => undefined} />)

    expect(screen.getByText('EXPORT')).toBeTruthy()
  })
})
