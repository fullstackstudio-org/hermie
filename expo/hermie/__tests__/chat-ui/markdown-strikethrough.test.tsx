/**
 * Strikethrough, and the terminal paste it swallowed.
 *
 * The owner pasted the output of a `stat` run into a chat. It came back with
 * everything between the two shell prompts crossed out and both `~` characters
 * gone, because GFM — and therefore marked — opens a deletion on a SINGLE tilde
 * pair, and `root@hermes:~#` … `root@hermes:~#` is one.
 *
 * The repair is in the lexer (`src/markdown/marked-compat.ts`), so it holds for
 * every surface at once. These tests render the two that a reader actually
 * looks at, with the pasted text unchanged, and assert on the tree: a struck
 * run is a style, and a string test would pass while the screen stayed wrong.
 */
import { render, screen } from '@testing-library/react-native'
import { StyleSheet, type TextStyle } from 'react-native'

import { AssistantBubble, UserBubble } from '../../src/chat-ui'
import { assistantItem, userItem } from '../../src/chat-ui/fixtures'
import { Markdown } from '../../src/markdown/Markdown'
import { resetBlockCache } from '../../src/markdown/blocks'
import { ThemeProvider } from '../../src/ui/theme'
import { renderScreen } from '../support/render'

/** The paste that reported it, character for character. */
const TERMINAL_PASTE =
  "root@hermes:~# stat -c '%u:%g %n' /usr/bin/sudo /etc/sudo.conf /etc/sudoers\n" +
  '0:0 /usr/bin/sudo\n' +
  '0:0 /etc/sudo.conf\n' +
  '0:0 /etc/sudoers\n' +
  'root@hermes:~#'

interface RenderedNode {
  type: string
  props: { style?: unknown }
  children: (RenderedNode | string)[] | null
}

function descendants(node: RenderedNode | string | null): RenderedNode[] {
  if (!node || typeof node === 'string') {
    return []
  }

  return [node, ...(node.children ?? []).flatMap(descendants)]
}

function textOf(node: RenderedNode | string): string {
  if (typeof node === 'string') {
    return node
  }

  return (node.children ?? []).map(textOf).join('')
}

function struckNodes(nodes: RenderedNode[]): RenderedNode[] {
  return nodes.filter(node => {
    const style = (StyleSheet.flatten(node.props.style as TextStyle) ?? {}) as TextStyle

    return style.textDecorationLine === 'line-through'
  })
}

function renderNodes(text: string): RenderedNode[] {
  const view = render(
    <ThemeProvider>
      <Markdown text={text} />
    </ThemeProvider>
  )

  return descendants(view.toJSON() as unknown as RenderedNode)
}

/** Every character of a bubble's rendered tree, joiners stripped. */
function bubbleText(): string {
  const tree = descendants(screen.toJSON() as unknown as RenderedNode)

  return tree.map(node => textOf(node)).join('')
}

describe('a single tilde', () => {
  beforeEach(resetBlockCache)

  it('leaves the pasted terminal output alone, both prompts intact', () => {
    const nodes = renderNodes(TERMINAL_PASTE)

    expect(struckNodes(nodes)).toHaveLength(0)

    const line = textOf(nodes[0] as RenderedNode)

    expect(line).toContain('root@hermes:~#')
    // The two characters the deletion ate, and the text it crossed out.
    expect(line.match(/~/gu)).toHaveLength(2)
    expect(line).toContain("stat -c '%u:%g %n'")
  })

  it('stays literal in a shell path in the middle of a sentence', () => {
    const nodes = renderNodes('Run it from ~/dir and then check ~/other for the log.')

    expect(struckNodes(nodes)).toHaveLength(0)
    expect(textOf(nodes[0] as RenderedNode)).toContain('~/dir')
    expect(textOf(nodes[0] as RenderedNode)).toContain('~/other')
  })

  it('survives on its own, with no partner anywhere', () => {
    const nodes = renderNodes('About ~50 rows, give or take.')

    expect(struckNodes(nodes)).toHaveLength(0)
    expect(textOf(nodes[0] as RenderedNode)).toContain('~50')
  })
})

describe('a tilde pair', () => {
  beforeEach(resetBlockCache)

  it('still strikes what it wraps', () => {
    const nodes = renderNodes('This part is ~~gone~~ now.')
    const struck = struckNodes(nodes)

    expect(struck).toHaveLength(1)
    expect(textOf(struck[0] as RenderedNode)).toBe('gone')
  })

  it('strikes across a lone tilde inside it', () => {
    const struck = struckNodes(renderNodes('~~cd ~/old~~'))

    expect(struck).toHaveLength(1)
    expect(textOf(struck[0] as RenderedNode)).toBe('cd ~/old')
  })

  it('still nests inside bold', () => {
    const struck = struckNodes(renderNodes('**~~dropped~~**'))

    expect(struck).toHaveLength(1)
    expect(textOf(struck[0] as RenderedNode)).toBe('dropped')
  })
})

/**
 * The same text through both bubbles.
 *
 * The owner's paste arrived in his OWN bubble, which is the half a fix aimed at
 * replies would miss. Both route through the same renderer, and that is the
 * claim worth holding still.
 */
describe('both bubbles', () => {
  beforeEach(resetBlockCache)

  it('leaves the paste unstruck in the owner’s own bubble', () => {
    renderScreen(<UserBubble item={{ ...userItem, text: TERMINAL_PASTE }} />)

    expect(struckNodes(descendants(screen.toJSON() as unknown as RenderedNode))).toHaveLength(0)
    expect(bubbleText()).toContain('root@hermes:~#')
  })

  it('leaves the paste unstruck in a reply', () => {
    renderScreen(<AssistantBubble item={{ ...assistantItem, reasoning: undefined, text: TERMINAL_PASTE }} />)

    expect(struckNodes(descendants(screen.toJSON() as unknown as RenderedNode))).toHaveLength(0)
    expect(bubbleText()).toContain('root@hermes:~#')
  })
})
