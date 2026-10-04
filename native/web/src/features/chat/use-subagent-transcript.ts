/**
 * One subagent's transcript, kept fresh while it is open (`AgentsBar.tsx`).
 *
 * A running child is tailed (`subagent.tail`) and read again every `SUBAGENT_TAIL_POLL_MS`; once it has finished
 * and has a session of its own, that stored transcript is read once. The source follows the child, so a transcript
 * that was open while the child finished moves from the live tail to the stored one by itself, and keeps the last
 * text on screen until the stored one is there (the tail answers nothing once the child is gone, and an empty box
 * would say the child had written nothing).
 *
 * One read at a time: a poll that comes round while the last read is still on its way is skipped, so a slow gateway
 * is never asked twice for the same thing. A read that fails says so and leaves the last text; the next poll tries
 * again. Everything read is somebody else's text: the caller draws it as plain characters.
 */
import type { Subagent } from '@hermie/transcript'
import { useEffect, useRef, useState } from 'react'

import {
  isLiveSubagent,
  SUBAGENT_TAIL_POLL_MS,
  type TranscriptSource,
  transcriptSource,
  transcriptText
} from '../../core/chats/subagent-transcript'
import type { ChatScreenController } from './chat-runtime'

export interface SubagentTranscript {
  text: string
  source: TranscriptSource
  /** The first read has not answered yet and there is nothing to show. */
  loading: boolean
  /** The newest read failed: the gateway's words, or the error's. */
  error: string | null
}

type Reader = Pick<ChatScreenController, 'tailSubagent' | 'childTranscript'>

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * @param reader the controller's two reads
 * @param chatKey the chat the child belongs to (the controller's first argument)
 * @param child the child; `undefined` reads nothing
 */
export function useSubagentTranscript(
  reader: Reader | undefined,
  chatKey: string,
  child: Subagent | undefined
): SubagentTranscript {
  const [read, setRead] = useState<{ text: string; error: string | null; settled: boolean }>({
    text: '',
    error: null,
    settled: false
  })
  const id = child?.id
  const childSessionId = child?.childSessionId
  const live = child ? isLiveSubagent(child) : false
  const source: TranscriptSource = child ? transcriptSource(child) : 'tail'
  const last = useRef('')

  // Another child is another transcript: nothing of the last one is shown for it.
  useEffect(() => {
    last.current = ''
    setRead({ text: '', error: null, settled: false })
  }, [id])

  useEffect(() => {
    if (!reader || id === undefined) {
      return
    }

    let cancelled = false
    let inFlight = false

    const take = async (): Promise<void> => {
      if (inFlight) {
        return
      }

      inFlight = true

      try {
        const text =
          source === 'stored' && childSessionId
            ? transcriptText(await reader.childTranscript(chatKey, childSessionId))
            : await reader.tailSubagent(chatKey, id)

        if (!cancelled) {
          // A tail that answers nothing after the child went is not "no output": keep what was read.
          const shown = text === '' && !live ? last.current : text

          last.current = shown
          setRead({ text: shown, error: null, settled: true })
        }
      } catch (error) {
        if (!cancelled) {
          setRead(current => ({ ...current, error: messageOf(error), settled: true }))
        }
      } finally {
        inFlight = false
      }
    }

    void take()

    // A finished child does not change: the stored transcript (or the last tail, for a child with no session of its
    // own) is read once, and only a running child is read again.
    if (source === 'stored' || !live) {
      return () => {
        cancelled = true
      }
    }

    const timer = setInterval(() => void take(), SUBAGENT_TAIL_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [reader, chatKey, id, childSessionId, source, live])

  return { text: read.text, source, loading: !read.settled && read.text === '', error: read.error }
}
