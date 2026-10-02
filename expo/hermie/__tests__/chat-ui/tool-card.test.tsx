/**
 * The tool card: disclosure, the diff it draws for a file edit, and the two
 * cases where it deliberately renders nothing or renders in red.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { ToolCard } from '../../src/chat-ui'
import { parseUnifiedDiff, summarizeDiff } from '../../src/chat-ui/diff'
import {
  failedToolItem,
  patchToolItem,
  riskyToolItem,
  runningToolItem,
  sampleDiff,
  searchToolItem,
  silentToolItem
} from '../../src/chat-ui/fixtures'
import { renderScreen } from '../support/render'

describe('ToolCard', () => {
  it('starts collapsed and expands on tap', () => {
    renderScreen(<ToolCard item={searchToolItem} presentation="collapsed" />)

    expect(screen.queryByTestId(`tool-body-${searchToolItem.id}`)).toBeNull()

    fireEvent.press(screen.getByTestId(`tool-toggle-${searchToolItem.id}`))
    expect(screen.getByTestId(`tool-body-${searchToolItem.id}`)).toBeTruthy()

    fireEvent.press(screen.getByTestId(`tool-toggle-${searchToolItem.id}`))
    expect(screen.queryByTestId(`tool-body-${searchToolItem.id}`)).toBeNull()
  })

  it('opens already at the verbose presentation', () => {
    renderScreen(<ToolCard item={searchToolItem} presentation="full" />)

    expect(screen.getByTestId(`tool-body-${searchToolItem.id}`)).toBeTruthy()
  })

  it('can be driven from outside', () => {
    const onToggleExpanded = jest.fn()

    renderScreen(<ToolCard expanded item={searchToolItem} onToggleExpanded={onToggleExpanded} />)

    expect(screen.getByTestId(`tool-body-${searchToolItem.id}`)).toBeTruthy()

    fireEvent.press(screen.getByTestId(`tool-toggle-${searchToolItem.id}`))
    expect(onToggleExpanded).toHaveBeenCalledWith(false)
    // Controlled: the card did not close itself.
    expect(screen.getByTestId(`tool-body-${searchToolItem.id}`)).toBeTruthy()
  })

  it('renders the inline diff of a file edit', () => {
    renderScreen(<ToolCard item={patchToolItem} presentation="full" />)

    expect(screen.getByTestId(`tool-diff-${patchToolItem.id}`)).toBeTruthy()
    expect(screen.getByText('+Recover interrupted sessions')).toBeTruthy()
    expect(screen.getByText('−Faster sessions')).toBeTruthy()
  })

  it('shows the error branch for a failed call', () => {
    renderScreen(<ToolCard item={failedToolItem} presentation="full" />)

    expect(screen.getByText('The server did not respond (503).')).toBeTruthy()
  })

  it('shows a spinner and no duration while the call runs', () => {
    renderScreen(<ToolCard item={runningToolItem} presentation="collapsed" />)

    expect(screen.getByText('Running…')).toBeTruthy()
  })

  it('banners untrusted output', () => {
    renderScreen(<ToolCard item={riskyToolItem} presentation="full" />)

    expect(screen.getByTestId(`tool-risk-${riskyToolItem.id}`)).toBeTruthy()
    expect(screen.getByText(/Untrusted output/)).toBeTruthy()
  })

  it('renders nothing for a silent tool that succeeded', () => {
    const view = renderScreen(<ToolCard item={silentToolItem} presentation="full" />)

    expect(view.queryByTestId(`tool-card-${silentToolItem.id}`)).toBeNull()
  })

  it('renders a silent tool that failed', () => {
    const view = renderScreen(
      <ToolCard item={{ ...silentToolItem, isError: true, status: 'error' }} presentation="collapsed" />
    )

    expect(view.getByTestId(`tool-card-${silentToolItem.id}`)).toBeTruthy()
  })
})

describe('unified diff parsing', () => {
  it('numbers both sides and classifies every line', () => {
    const lines = parseUnifiedDiff(sampleDiff)

    expect(lines[0]).toEqual({ kind: 'meta', text: '--- a/release-notes.md' })
    expect(lines.find(line => line.kind === 'hunk')).toBeTruthy()

    const added = lines.filter(line => line.kind === 'add')
    const removed = lines.filter(line => line.kind === 'delete')

    expect(added).toHaveLength(2)
    expect(removed).toHaveLength(1)
    // The hunk opens at 12 and its first line is context, so the edit lands on 13.
    expect(added[0]?.newLine).toBe(13)
    expect(removed[0]?.oldLine).toBe(13)
  })

  it('summarises the change count', () => {
    expect(summarizeDiff(sampleDiff)).toBe('3 lines changed')
    expect(summarizeDiff('')).toBe('')
  })
})
