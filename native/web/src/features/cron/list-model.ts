/**
 * What the crons list says it is, in one word, from what the store holds.
 *
 * The four answers are four different sentences, and the old single `jobs.length === 0` test could tell none of them
 * apart: a list that has not been read yet is not an empty one, and one that failed to read is not an empty one
 * either.
 *
 *  - `loading`: no read has finished;
 *  - `failed`: the last read failed (the rows it had before are still drawn under the message);
 *  - `empty`: a read finished and there is nothing, or the page has no gateway to ask;
 *  - `ready`: there are crons to draw.
 */
export type CronListState = 'loading' | 'failed' | 'empty' | 'ready'

export function cronState(input: {
  /** The page was given a gateway. Without one nothing will ever load. */
  hasController: boolean
  /** A read has finished, either way. */
  loaded: boolean
  /** Why the last read failed, if it did. */
  error: string | null
  /** How many crons the store holds. */
  count: number
}): CronListState {
  if (input.error !== null) {
    return 'failed'
  }

  if (!input.loaded && input.hasController) {
    return 'loading'
  }

  return input.count === 0 ? 'empty' : 'ready'
}
