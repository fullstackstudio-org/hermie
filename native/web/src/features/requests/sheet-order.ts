/**
 * Which request has the dialog: the order the layer shows the open ones in.
 *
 * The store's queue is oldest first (`state/requests.ts`), but the dialog is one at a time, and a question that stops a
 * bot (an approval, a clarify, a passkey confirmation, a secret or a sudo password, a connector authorisation) must
 * not sit behind a form that was opened an hour ago: nobody is looking at the form, and the bot is stopped. So the
 * questions come first, in the order they were first seen, and the three interactive sheets (a form, a file request, a
 * draft to review) come after them, in theirs.
 *
 * The one thing that is not given way is an interactive sheet that is in the middle of something: an answer on its way
 * or files being uploaded (`holding`). The question waits until that is done, so what is under way is not cut off. It
 * is the same rule as the native apps' (`ChatSheetOrder`, `InteractiveModel.yield()` and its `canYield`), with one
 * difference that is in the web's favour: a sheet that steps aside here is only parked, so what was typed in it is kept.
 */
import type { OpenRequest } from '../../state/requests'

/**
 * The requests that can be shown, in the order they are shown.
 *
 * @param shown the queue without the sheets the person put away (Later), oldest first
 * @param holding the key of the interactive sheet on screen that is sending or uploading, if there is one
 */
export function orderSheets(shown: readonly OpenRequest[], holding: string | undefined): OpenRequest[] {
  const questions = shown.filter(entry => entry.kind !== 'interactive')
  const sheets = shown.filter(entry => entry.kind === 'interactive')
  const held = holding === undefined ? undefined : sheets.find(entry => entry.key === holding)

  return held ? [held, ...questions, ...sheets.filter(entry => entry !== held)] : [...questions, ...sheets]
}
