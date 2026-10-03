/**
 * A streaming reply: the same message grows delta by delta, and the blocks
 * that are already settled must not be rendered again.
 *
 * `contract/markdown/streaming.json` records every prefix of a few replies. Each
 * document is replayed prefix by prefix through one mounted `Markdown`. Three
 * things must hold at every step:
 *  - what is on the page is the structure the corpus records for that prefix;
 *  - a block whose source did not change is the same DOM element as before;
 *  - no inline content of an earlier step is rendered again, which is what
 *    "a delta re-renders only the last block" means in terms of work done.
 */
import type { Block, Token } from '@hermie/markdown'
import { preprocessMarkdown, resetBlockCache, splitBlocks } from '@hermie/markdown'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import streamingSource from '../../../../contract/markdown/streaming.json?raw'
import { expectedBlocks, readBlocks } from '../test-support/markdown-structure'

import type { InlineProps } from './Inline'
import { Markdown } from './Markdown'

/** Every `tokens` array an `Inline` was rendered with, in the order of the renders. */
const renders = vi.hoisted(() => ({ tokens: [] as Token[][] }))

vi.mock('./Inline', async importOriginal => {
  const original = await importOriginal<{ Inline: (props: InlineProps) => ReactNode }>()

  return {
    ...original,
    Inline: (props: InlineProps) => {
      renders.tokens.push(props.tokens)

      return original.Inline(props)
    }
  }
})

interface Recorded {
  name: string
  input: string
  blocks: Block[]
}

const STEPS = JSON.parse(streamingSource) as Recorded[]

/** The recorded prefixes of each document, in order. */
const DOCUMENTS = new Map<string, Recorded[]>()

for (const step of STEPS) {
  const name = step.name.replace(/ @\d+$/, '')

  DOCUMENTS.set(name, [...(DOCUMENTS.get(name) ?? []), step])
}

beforeEach(() => {
  resetBlockCache()
  renders.tokens.length = 0
})

const blockElements = (root: Element): Element[] => Array.from(root.children)

describe('contract/markdown/streaming.json', () => {
  it('has documents to replay', () => {
    expect(DOCUMENTS.size).toBeGreaterThan(0)

    for (const steps of DOCUMENTS.values()) {
      expect(steps.length).toBeGreaterThan(5)
    }
  })

  it.each([...DOCUMENTS.entries()])('%s: only the last block is rendered again', (_name, steps) => {
    const first = steps[0]

    if (!first) {
      throw new Error('a document without steps')
    }

    const { container, rerender } = render(<Markdown text={first.input} />)
    const root = container.firstElementChild as Element

    const seen = new Set<Token[]>(renders.tokens)
    let previous = splitBlocks(preprocessMarkdown(first.input)).filter(raw => raw.trim())
    let previousElements = blockElements(root)

    expect(readBlocks(root)).toEqual(expectedBlocks(first.blocks))

    for (const step of steps.slice(1)) {
      renders.tokens.length = 0
      rerender(<Markdown text={step.input} />)

      // The page is what the corpus records for this prefix.
      expect(readBlocks(root), step.name).toEqual(expectedBlocks(step.blocks))

      // Nothing that was rendered before is rendered again.
      for (const tokens of renders.tokens) {
        expect(seen.has(tokens), `${step.name}: a settled block rendered again`).toBe(false)
        seen.add(tokens)
      }

      // A block with the same source keeps its element.
      const current = splitBlocks(preprocessMarkdown(step.input)).filter(raw => raw.trim())
      const elements = blockElements(root)
      let settled = 0

      while (settled < Math.min(previous.length, current.length) && previous[settled] === current[settled]) {
        settled += 1
      }

      // Each block is one element here, so the shared prefix is the first elements.
      for (let at = 0; at < Math.min(settled, previousElements.length, elements.length); at += 1) {
        expect(elements[at], `${step.name}: block ${at} was replaced`).toBe(previousElements[at])
      }

      previous = current
      previousElements = elements
    }
  })
})
