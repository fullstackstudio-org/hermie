/**
 * Hand-written gateway event streams.
 *
 * Shapes come from `tui_gateway/contracts/events.py` as the generated
 * `GatewayEventMap` renders them: `{type, session_id, seq, payload}`.
 */
import type { TranscriptEvent } from '../reducer'

export const SESSION = 'run-1a2b'

const event = (type: string, seq: number, payload?: unknown): TranscriptEvent => ({
  type,
  session_id: SESSION,
  seq,
  ...(payload === undefined ? {} : { payload })
})

/** start → deltas → tool start/complete → interim → deltas → complete. */
export const streamedTurn: TranscriptEvent[] = [
  event('message.start', 1, {}),
  event('reasoning.delta', 2, { text: 'Check the changelog first.' }),
  event('message.delta', 3, { text: 'Let me ' }),
  event('message.delta', 4, { text: 'look that up.' }),
  event('tool.generating', 5, { name: 'read_file' }),
  event('tool.start', 6, {
    tool_id: 'call_1',
    name: 'read_file',
    context: 'read_file(CHANGELOG.md)',
    args: { path: 'CHANGELOG.md' },
    args_text: '{"path":"CHANGELOG.md"}'
  }),
  event('status.update', 7, { kind: 'status', text: 'Reading CHANGELOG.md' }),
  event('tool.complete', 8, {
    tool_id: 'call_1',
    name: 'read_file',
    duration_s: 0.42,
    result: { content: '# 1.2.0' },
    summary: 'read 1 file',
    result_text: '# 1.2.0',
    inline_diff: ''
  }),
  event('message.delta', 9, { text: 'Found it.' }),
  event('message.interim', 10, { text: 'Found it.', already_streamed: true }),
  event('message.delta', 11, { text: 'Version 1.2.0 ships three fixes.' }),
  event('message.complete', 12, {
    text: 'Version 1.2.0 ships three fixes.',
    status: 'complete',
    usage: { input: 120, output: 48, total: 168, calls: 1 }
  })
]

/**
 * A thinking turn as the gateway really streams one: the thought, two previews
 * of the same growing sentence, then the sentence.
 *
 * `message.interim` carries the reply SO FAR — the second frame is not a second
 * message, it is the first one with more of it — which is why appending them
 * put the same sentence on screen three times.
 */
export const thinkingTurn: TranscriptEvent[] = [
  event('message.start', 1, {}),
  event('reasoning.delta', 2, { text: 'The changelog ' }),
  event('reasoning.delta', 3, { text: 'is the place to look.' }),
  event('message.interim', 4, { text: 'Version 1.2.0', already_streamed: true }),
  event('message.interim', 5, { text: 'Version 1.2.0 ships', already_streamed: true }),
  event('message.complete', 6, { text: 'Version 1.2.0 ships three fixes.', status: 'complete' })
]

/**
 * The same thought, summarised after the tool that interrupted it.
 *
 * `reasoning.available` comes out of `tool_progress`, so it arrives once the
 * call has already sealed the bubble the deltas were landing on. This is the
 * stream behind "every thought appears twice".
 */
export const thinkingSummarisedAfterToolTurn: TranscriptEvent[] = [
  event('message.start', 1, {}),
  event('reasoning.delta', 2, { text: 'The changelog ' }),
  event('reasoning.delta', 3, { text: 'is the place to look.' }),
  event('message.delta', 4, { text: 'Let me check.' }),
  event('tool.start', 5, { tool_id: 'call_9', name: 'read_file', args: { path: 'CHANGELOG.md' } }),
  event('reasoning.available', 6, { text: 'Read the changelog.' }),
  event('tool.complete', 7, { tool_id: 'call_9', name: 'read_file', result: { content: '# 1.2.0' } }),
  event('message.delta', 8, { text: 'Version 1.2.0 ships three fixes.' }),
  event('message.complete', 9, { text: 'Version 1.2.0 ships three fixes.', status: 'complete' })
]

export const erroredTurn: TranscriptEvent[] = [
  event('message.start', 1, {}),
  event('message.delta', 2, { text: 'Starting…' }),
  event('message.complete', 3, {
    text: 'Starting…',
    status: 'error',
    error: 'Provider returned 429 after 3 retries',
    partial: true,
    recoverable: true,
    error_surface: { layer: 'provider', code: 'rate_limited', retryable: true }
  })
]

export const dmDispatchTurn: TranscriptEvent[] = [
  event('message.start', 1, {}),
  event('message.delta', 2, { text: 'Asking the writer.' }),
  event('tool.start', 3, {
    tool_id: 'call_dm_1',
    name: 'message_agent',
    context: 'message_agent(writer)',
    args: { target: '@writer', message: 'Can you draft the announcement?' }
  }),
  event('tool.complete', 4, {
    tool_id: 'call_dm_1',
    name: 'message_agent',
    result: JSON.stringify({
      status: 'queued',
      delivery_id: 'dm-2f9c',
      to: '@writer',
      process_id: 'proc-2f9c',
      queued_at: 1_700_000_015
    })
  }),
  event('message.complete', 5, { text: 'Asked the writer to draft it.', status: 'complete' })
]

/** One `delegate_task` fan-out with three children sharing a delegation id. */
export const delegationEvents: TranscriptEvent[] = [
  event('message.start', 1, {}),
  event('tool.start', 2, {
    tool_id: 'call_delegate_1',
    name: 'delegate_task',
    context: 'delegate_task(3 tasks)',
    args: { tasks: [{ goal: 'Audit deps' }, { goal: 'Write tests' }, { goal: 'Update docs' }] }
  }),
  ...[0, 1, 2].flatMap(index => [
    event('subagent.spawn_requested', 10 + index * 4, {
      subagent_id: `child-${index}`,
      parent_id: 'root',
      delegation_id: 'del-9',
      goal: ['Audit deps', 'Write tests', 'Update docs'][index],
      task_index: index,
      task_count: 3,
      status: 'queued'
    }),
    event('subagent.start', 11 + index * 4, {
      subagent_id: `child-${index}`,
      parent_id: 'root',
      delegation_id: 'del-9',
      child_session_id: `sub-${index}`,
      goal: ['Audit deps', 'Write tests', 'Update docs'][index],
      task_index: index,
      task_count: 3,
      model: 'example-small-model',
      status: 'running'
    }),
    event('subagent.progress', 12 + index * 4, {
      subagent_id: `child-${index}`,
      delegation_id: 'del-9',
      goal: ['Audit deps', 'Write tests', 'Update docs'][index],
      task_index: index,
      task_count: 3,
      text: `working on step ${index}`,
      status: 'running'
    }),
    event('subagent.tool', 13 + index * 4, {
      subagent_id: `child-${index}`,
      delegation_id: 'del-9',
      goal: ['Audit deps', 'Write tests', 'Update docs'][index],
      task_index: index,
      task_count: 3,
      tool_name: 'read_file',
      tool_preview: 'package.json',
      status: 'running'
    })
  ]),
  ...[0, 1, 2].map(index =>
    event('subagent.complete', 30 + index, {
      subagent_id: `child-${index}`,
      delegation_id: 'del-9',
      goal: ['Audit deps', 'Write tests', 'Update docs'][index],
      task_index: index,
      task_count: 3,
      status: 'completed',
      summary: `task ${index} done`,
      duration_seconds: 12.5,
      tool_count: 4,
      input_tokens: 900,
      output_tokens: 120,
      files_read: ['package.json'],
      files_written: []
    })
  ),
  event('tool.complete', 40, {
    tool_id: 'call_delegate_1',
    name: 'delegate_task',
    summary: '3 tasks completed',
    duration_s: 41.2
  }),
  event('message.complete', 41, { text: 'All three finished.', status: 'complete' })
]

export const approvalRequest = {
  id: 'srq-7',
  method: 'approval',
  params: {
    session_id: SESSION,
    request_id: 'apr-3',
    command: 'rm -rf build',
    description: 'Delete the build directory',
    choices: ['once', 'session', 'always', 'deny'],
    allow_permanent: true,
    allow_session: true,
    tool_name: 'terminal'
  }
}

export const clarifyRequest = {
  id: 'srq-8',
  method: 'clarify',
  params: {
    session_id: SESSION,
    questions: [
      { qid: 'q1', question: 'Which environment?', choices: ['staging', 'production'], multi_select: false },
      { qid: 'q2', question: 'Notify the team?', choices: ['yes', 'no'], multi_select: false }
    ]
  }
}

/** An interactive form, as the gateway frames it (`contract/requests/examples.json`, trimmed). */
export const inputFormRequest = {
  id: 'srq-9',
  method: 'input.form',
  params: {
    session_id: SESSION,
    v: 1,
    title: 'Hotel booking details',
    summary: 'I found three hotels in Utrecht. Fill this in and I will book the best match.',
    expires_at: 1_791_119_400,
    optional: true,
    fields: [
      { id: 'name', kind: 'text', label: 'Name on the booking', required: true, max_length: 20 },
      { id: 'guests', kind: 'number', label: 'Guests', required: true, min: 1, max: 12, integer: true, default: 2 }
    ]
  }
}

export const inputFileRequest = {
  id: 'srq-10',
  method: 'input.file',
  params: {
    session_id: SESSION,
    v: 1,
    title: 'Receipt',
    summary: 'Take a photo of the parking receipt so I can add it to the expense report.',
    expires_at: 1_791_119_400,
    optional: true,
    accept: 'image',
    capture: 'photo',
    multiple: false,
    upload: {
      dir: '/home/ada/work/uploads/hermie/2026-10-04',
      max_bytes: 10_485_760,
      max_total_bytes: 10_485_760,
      max_files: 1,
      strip_metadata: true
    }
  }
}

/** A diff review, as the gateway frames it (`contract/requests/examples.json`, trimmed): two hunks of one file. */
export const reviewDiffRequest = {
  id: 'srq-12',
  method: 'review.diff',
  params: {
    session_id: SESSION,
    v: 1,
    title: 'Changes to settings.py',
    summary: 'I changed the default currency and the retry limit. Approve or reject each hunk.',
    expires_at: 1_791_119_400,
    optional: false,
    kind: 'modify',
    path: 'app/settings.py',
    hunks: [
      {
        id: 'h1',
        header: '@@ -3,4 +3,4 @@ class Settings:',
        lines: ['     name = "booking"', '-    currency = "USD"', '+    currency = "EUR"', '     locale = "nl-NL"']
      },
      {
        id: 'h2',
        header: '@@ -20,3 +20,4 @@ def retry():',
        lines: ['     attempts = 0', '-    limit = 3', '+    limit = 5', '+    backoff = 2', '     return attempts']
      }
    ]
  }
}

export const reviewDraftRequest = {
  id: 'srq-11',
  method: 'review.draft',
  params: {
    session_id: SESSION,
    v: 1,
    title: 'Reply to Bram',
    summary: 'Here is the reply I would send. Approve, edit or reject it.',
    expires_at: 1_791_119_400,
    optional: false,
    kind: 'mail',
    text: 'Hi Bram,\n\nThe flat is free from 1 November.\n\nKind regards,\nAda',
    subject: 'Re: Flat on the Oudegracht',
    recipients: ['Bram de Vries <bram@example.com>'],
    editable: true
  }
}
