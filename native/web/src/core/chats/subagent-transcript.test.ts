/**
 * What the Agents panel reads of a child: which source its transcript comes from, how a stored row becomes a line,
 * and where the bar's clock starts.
 */
import type { TranscriptItem } from '@hermie/transcript'
import { describe, expect, it } from 'vitest'

import { assistantItem, statusItem, toolItem, userItem } from '../../test-support/chat-fixtures'
import {
  isLiveSubagent,
  oldestStartMs,
  SUBAGENT_TAIL_POLL_MS,
  transcriptLine,
  transcriptSource,
  transcriptText
} from './subagent-transcript'

describe('which source', () => {
  it('tails a child that is queued or running', () => {
    expect(transcriptSource({ status: 'running', childSessionId: 'c1' })).toBe('tail')
    expect(transcriptSource({ status: 'queued', childSessionId: 'c1' })).toBe('tail')
  })

  it('reads the stored transcript of a child that is over and has a session of its own', () => {
    for (const status of ['completed', 'failed', 'interrupted'] as const) {
      expect(transcriptSource({ status, childSessionId: 'c1' })).toBe('stored')
    }
  })

  it('has only the tail to read for a child with no session of its own', () => {
    expect(transcriptSource({ status: 'completed' })).toBe('tail')
  })

  it('counts queued and running children as live, and no others', () => {
    expect(isLiveSubagent({ status: 'running' })).toBe(true)
    expect(isLiveSubagent({ status: 'queued' })).toBe(true)
    expect(isLiveSubagent({ status: 'completed' })).toBe(false)
    expect(isLiveSubagent({ status: 'failed' })).toBe(false)
    expect(isLiveSubagent({ status: 'interrupted' })).toBe(false)
  })

  it('polls a live tail every three seconds', () => {
    expect(SUBAGENT_TAIL_POLL_MS).toBe(3_000)
  })
})

describe('a stored row as a line', () => {
  it('prefixes what the child was asked, writes what it said, and marks a tool call', () => {
    expect(transcriptLine(userItem('Audit the lockfile.'))).toBe('> Audit the lockfile.')
    expect(transcriptLine(assistantItem('Two packages are behind.'))).toBe('Two packages are behind.')
    expect(transcriptLine(toolItem('read_file', { context: 'package-lock.json' }))).toBe('· package-lock.json')
    expect(transcriptLine(toolItem('read_file', { summary: 'read it' }))).toBe('· read it')
    expect(transcriptLine(toolItem('read_file'))).toBe('· read_file')
  })

  it('leaves the rest out, and an empty row with it', () => {
    expect(transcriptLine(statusItem('compressing') as TranscriptItem)).toBe('')
    expect(transcriptLine(userItem(''))).toBe('')
  })

  it('joins the rows that have something to say, one a line', () => {
    expect(
      transcriptText([userItem('Go'), userItem(''), toolItem('ls', { context: 'ls -la' }), assistantItem('Done')])
    ).toBe('> Go\n· ls -la\nDone')
  })
})

describe('the clock', () => {
  it('starts at the earliest start that has one', () => {
    expect(oldestStartMs([{ startedAt: 5_000 }, { startedAt: 2_000 }, { startedAt: 0 }])).toBe(2_000)
  })

  it('has nowhere to start from when no child has a start', () => {
    expect(oldestStartMs([])).toBeUndefined()
    expect(oldestStartMs([{ startedAt: 0 }])).toBeUndefined()
  })
})
