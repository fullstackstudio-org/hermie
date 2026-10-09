/**
 * A ```hermie-cards fence, drawn (`contract/markup/README.md`): a stack of cards joined by connectors, or a grid.
 *
 * A lazy chunk (`lazy.ts`). `markup/cards-spec.ts` decides whether the block is a set of cards at all (strict,
 * bounded, held to `contract/markup/examples.json`); what is drawn here is a validated spec and nothing a reply
 * wrote: titles, subtitles, tags and labels are React text children, an icon is a path from the closed vocabulary
 * (`markup/icons.ts`), and a colour is a class. No image is loaded and no link is made, whatever the block says.
 *
 * Reading order, for assistive technology: the block is a list with one item per card, in order, and each item is
 * read as one sentence ("Card 2 of 5, Gateway per klant, k3s, highlighted, tags k3s, Postgres, then: deployt naar",
 * the same as the native apps') while the drawn card, which says the same in pieces, is hidden from the tree. The
 * connectors are part of the sentence (`then:`), so they are drawn and not read. A box that holds a drawing is
 *  a "..." button in its corner (`DrawnBlock.tsx`) has Show source and Copy source.
 */
import { memo, useMemo } from 'react'

import { sheetStrings } from '../i18n/sheet-strings'
import { useLocale } from '../i18n/use-locale'
import { CodeBlock } from './CodeBlock'
import { DrawnBlock } from './DrawnBlock'
import { type CardsWords, cardSpeech, parseCards, type CardsSpec } from './markup/cards-spec'
import { ICON_NAMES, ICON_VIEW_BOX, iconFor } from './markup/icons'

function words(): CardsWords {
  const cards = sheetStrings.markdown.cards

  return {
    card: (position, total, title) => cards.card({ position, total, title }),
    highlighted: cards.highlighted,
    tags: tags => cards.tags({ tags }),
    then: label => cards.then({ label })
  }
}

function Icon({ name }: { name: string }) {
  const icon = iconFor(name)

  return (
    <svg aria-hidden="true" className="md-card-icon" focusable="false" viewBox={ICON_VIEW_BOX}>
      <path d={icon.svg} />
    </svg>
  )
}

/** What joins a card to the next: a line, an arrow or only space, and the label, when there is one. */
function Connector({ kind, label }: { kind: 'arrow' | 'line' | 'none'; label: string | undefined }) {
  return (
    <div aria-hidden="true" className="md-card-link" data-connector={kind}>
      {kind === 'none' ? null : (
        <svg className="md-card-link-line" focusable="false" height="28" viewBox="0 0 12 28" width="12">
          <path d="M6 0V27" />
          {kind === 'arrow' ? <path d="M2 22l4 5 4-5" /> : null}
        </svg>
      )}
      {label === undefined ? null : <span className="md-card-next">{label}</span>}
    </div>
  )
}

function CardsFigure({ spec }: { spec: CardsSpec }) {
  const spoken = words()
  const stack = spec.layout === 'stack'
  const name = spec.title ?? sheetStrings.markdown.cards.label

  return (
    <div className="md-cards" data-layout={spec.layout}>
      {spec.title === undefined ? null : (
        <div aria-hidden="true" className="md-cards-title">
          {spec.title}
        </div>
      )}
      <div aria-label={name} className="md-cards-list" role="list">
        {spec.cards.map((card, index) => {
          const last = index === spec.cards.length - 1

          return (
            <div className="md-cards-step" key={index} role="listitem">
              <span className="md-sr-only">{cardSpeech(spec, index, spoken)}</span>
              <div aria-hidden="true" className="md-card" data-highlight={String(card.highlight)}>
                {card.icon === undefined ? null : <Icon name={card.icon} />}
                <div className="md-card-body">
                  <div className="md-card-title">{card.title}</div>
                  {card.subtitle === undefined ? null : <div className="md-card-subtitle">{card.subtitle}</div>}
                  {card.tags.length === 0 ? null : (
                    <ul className="md-card-tags">
                      {card.tags.map(tag => (
                        <li className="md-card-tag" key={tag}>
                          {tag}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              {stack && !last ? <Connector kind={spec.connector ?? 'arrow'} label={card.next} /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CardsDiagramView({ source, language }: { source: string; language?: string | undefined }) {
  useLocale()

  const result = useMemo(() => parseCards(source, ICON_NAMES), [source])

  if (!result.ok) {
    // Not a set of cards: the block it came from.
    return <CodeBlock code={source} {...(language ? { language } : {})} />
  }

  return <DrawnBlock code={source} drawing={<CardsFigure spec={result.spec} />} kind="cards" />
}

/** Memoised on the source: a settled block of a streaming reply is not validated and drawn again. */
export const CardsDiagram = memo(CardsDiagramView)
