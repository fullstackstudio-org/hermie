/**
 * A sentence of the app's with a name in it (a bot's, as the roster names it),
 * the name isolated in `<bdi>`: whatever direction the name's own characters
 * run, it cannot reorder the words around it. The name is cleaned and bounded by
 * the caller (`displayText`); this only places it.
 *
 * The catalogue's sentences are functions of the name, so the sentence is built
 * once with a marker where the name goes and split there: every language keeps
 * its own word order.
 */
import { Fragment, type ReactElement } from 'react'

/** Never in a catalogue sentence, and dropped from every name by `displayText`. */
const MARK = '\u0000'

export function WithName({ phrase, name }: { phrase: (name: string) => string; name: string }): ReactElement {
  const parts = phrase(MARK).split(MARK)

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <bdi>{name}</bdi> : null}
          {part}
        </Fragment>
      ))}
    </>
  )
}
