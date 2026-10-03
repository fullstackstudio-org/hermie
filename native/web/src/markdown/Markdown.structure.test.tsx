/**
 * The renderer against the recorded corpus: for every input of
 * `contract/markdown/blocks.json` and `inline.json`, the elements on the page
 * read back as the block structure the corpus records, in type and order.
 *
 * The reader (`test-support/markdown-structure.ts`) knows only the allow-listed
 * elements, so a case that rendered anything else would not read back at all.
 */
import type { Block } from '@hermie/markdown'
import { resetBlockCache } from '@hermie/markdown'
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import blocksSource from '../../../../contract/markdown/blocks.json?raw'
import inlineSource from '../../../../contract/markdown/inline.json?raw'
import { expectedBlocks, readBlocks } from '../test-support/markdown-structure'

import { Markdown } from './Markdown'

interface Recorded {
  name: string
  input: string
  blocks: Block[]
}

const BLOCK_CASES = JSON.parse(blocksSource) as Recorded[]
const INLINE_CASES = JSON.parse(inlineSource) as Recorded[]

function structureOf(input: string): Block[] {
  const { container } = render(<Markdown text={input} />)
  const root = container.firstElementChild

  if (!root) {
    throw new Error('nothing was rendered')
  }

  return readBlocks(root)
}

beforeEach(() => {
  resetBlockCache()
})

describe('the corpus has what the tests need', () => {
  it('has inputs', () => {
    expect(BLOCK_CASES.length).toBeGreaterThan(50)
    expect(INLINE_CASES.length).toBeGreaterThan(30)
  })
})

describe('the comparison', () => {
  it('tells structures apart, and refuses an element it has no meaning for', () => {
    expect(structureOf('# one')).not.toEqual(structureOf('one'))
    expect(structureOf('- a\n- b')).not.toEqual(structureOf('1. a\n2. b'))
    expect(structureOf('**a**')).not.toEqual(structureOf('*a*'))

    const stray = document.createElement('div')
    stray.append(document.createElement('script'))

    expect(() => readBlocks(stray)).toThrow('unexpected block element <script>')
  })
})

describe('contract/markdown/blocks.json', () => {
  it.each(BLOCK_CASES.map(entry => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(structureOf(entry.input)).toEqual(expectedBlocks(entry.blocks))
  })
})

describe('contract/markdown/inline.json', () => {
  it.each(INLINE_CASES.map(entry => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(structureOf(entry.input)).toEqual(expectedBlocks(entry.blocks))
  })
})
