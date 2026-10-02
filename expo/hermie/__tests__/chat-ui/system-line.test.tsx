/**
 * The system line: what the transcript draws for something that happened TO the
 * conversation rather than IN it.
 *
 * Two things are being asserted, and they are both about what is NOT there. No
 * fold, because the sentence is the whole content and a chevron would promise a
 * payload that does not exist. No bubble and no card, because nobody said it —
 * the row Sebas photographed had a model-switch marker sitting in the transcript
 * dressed as speech, opening `[System: The active model for th…`.
 */
import { screen } from '@testing-library/react-native'

import { NoticePill, systemLineText } from '../../src/chat-ui'
import { processNoticeItem } from '../../src/chat-ui/fixtures'
import type { NoticeItem } from '../../src/chat-ui/types'
import { renderScreen } from '../support/render'

/** The marker as `_append_model_switch_marker` writes it, wrapper already off. */
const MARKER =
  'The active model for this chat has changed to k3 via provider moonshot. From this point forward, use this ' +
  'runtime metadata when answering questions about what model/provider is active.'

/** Only the opening sentence is addressed to the reader; the rest is for the model. */
const SENTENCE = 'The active model for this chat has changed to k3 via provider moonshot.'

const notice = (over: Partial<NoticeItem> = {}): NoticeItem => ({
  id: 'n-sys',
  kind: 'notice',
  noticeKind: 'model_switch',
  origin: 'history',
  seq: 1000,
  title: 'Model changed',
  version: 0,
  body: MARKER,
  ...over
})

describe('a system line', () => {
  it('shows the sentence the gateway wrote, with no wrapper left on it', () => {
    renderScreen(<NoticePill item={notice()} presentation="collapsed" />)

    const line = screen.getByTestId('notice-n-sys')

    expect(line.props.children).toBe(SENTENCE)
    expect(String(line.props.children)).not.toContain('[System:')
  })

  it('stops at the first sentence, because the rest is addressed to the model', () => {
    // A real model-switch marker says which model is active and then instructs
    // the model what to do with that fact. Only the first half is for a reader.
    expect(systemLineText(notice())).toBe(SENTENCE)
    expect(systemLineText(notice())).not.toContain('From this point forward')
  })

  it('keeps a note that is one sentence exactly as it is', () => {
    const one = 'The user has cleared the personality overlay.'

    expect(systemLineText(notice({ body: one }))).toBe(one)
    expect(systemLineText(notice({ body: 'Switched to k3' }))).toBe('Switched to k3')
  })

  it('keeps the whole text when there is no sentence boundary to cut at', () => {
    // A full stop inside a word is not one — `v1.4` must not cut the line in two.
    const version = 'The active model for this chat has changed to k3-v1.4-preview via provider moonshot'

    expect(systemLineText(notice({ body: version }))).toBe(version)
  })

  it('cuts at a question or an exclamation as readily as at a full stop', () => {
    expect(systemLineText(notice({ body: 'Did the run finish? I could not tell from the log.' }))).toBe(
      'Did the run finish?'
    )
  })

  it('leaves the body itself whole, because that is what the row is paired on', () => {
    // The trim is a display decision. If it reached the item, the live and the
    // persisted projection would disagree and the row would be drawn twice.
    expect(notice().body).toBe(MARKER)
  })

  it('centres it and leaves it free to wrap, rather than clipping to one line', () => {
    renderScreen(<NoticePill item={notice()} presentation="collapsed" />)

    const line = screen.getByTestId('notice-n-sys')
    const style = Array.isArray(line.props.style) ? Object.assign({}, ...line.props.style.flat()) : line.props.style

    expect(style.textAlign).toBe('center')
    expect(line.props.numberOfLines).toBeUndefined()
  })

  it('offers no fold, because there is nothing underneath to open', () => {
    renderScreen(<NoticePill item={notice()} presentation="collapsed" />)

    expect(screen.queryByTestId('notice-n-sys-toggle')).toBeNull()
    expect(screen.queryByTestId('notice-n-sys-card')).toBeNull()
  })

  it('draws the same line at verbose, because folding it at one level and not the other says nothing', () => {
    renderScreen(<NoticePill item={notice()} presentation="full" />)

    expect(screen.getByTestId('notice-n-sys').props.children).toBe(SENTENCE)
    expect(screen.queryByTestId('notice-n-sys-toggle')).toBeNull()
  })

  it.each(['model_switch', 'personality_switch', 'auto_continue', 'system_note'] as const)(
    'covers %s, so a marker does not change shape with the transport that carried it',
    noticeKind => {
      renderScreen(<NoticePill item={notice({ noticeKind })} presentation="collapsed" />)

      expect(screen.getByTestId('notice-n-sys').props.children).toBe(SENTENCE)
      expect(screen.queryByTestId('notice-n-sys-toggle')).toBeNull()
    }
  )

  it('keeps its title when it arrived without a sentence to show', () => {
    renderScreen(<NoticePill item={notice({ body: undefined })} presentation="collapsed" />)

    expect(screen.getByTestId('notice-n-sys').props.children).toBe('Model changed')
  })

  it('leaves the bigger families on their folded card', () => {
    // A background process carries output worth opening; that is the whole
    // difference between the two presentations.
    renderScreen(<NoticePill item={processNoticeItem} presentation="collapsed" />)

    expect(screen.getByTestId(`notice-${processNoticeItem.id}-toggle`)).toBeTruthy()
  })
})
