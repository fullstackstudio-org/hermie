/**
 * Hand-written transcript rows in both wire shapes.
 *
 * The RPC rows mirror `tui_gateway/session_history.py::_history_to_messages`
 * (`text`, `row_id`, projected tool rows without a result); the REST rows mirror
 * `GET /api/sessions/{id}/messages` (`content` / `display_content`, numeric
 * `id`). Every `display_kind` the gateway can emit appears at least once.
 */
import type { TranscriptRow } from '../rows-to-items'

export const DM_DELIVERY_COMMAND =
  '/usr/bin/python3 /opt/hermes/tools/bot_mode_dm.py --run-delivery query-file ' +
  '/root/.hermes/dm/2f9c.json hermes -p writer chat -c "Bot Chat" -Q -q @/root/.hermes/dm/2f9c.json'

export const LEGACY_DELIVERY_COMMAND =
  'hermes -p writer chat -c "Bot Chat" --create-if-missing -Q -q "Message from 🤖 Researcher (@researcher): ping"'

export const dmReplyProcessText = [
  '[IMPORTANT: Background process proc-2f9c completed (exit code 0).',
  `Command: ${DM_DELIVERY_COMMAND}`,
  'Output:',
  'Message from 🤖 Writer (@writer): Draft is ready, I pushed it to the shared folder.]'
].join('\n')

export const plainProcessText = [
  '[IMPORTANT: Background process proc-aa01 exited (exit code 1).',
  'Command: npm run build',
  'Output:',
  'error TS2345: Argument of type string is not assignable.]'
].join('\n')

/**
 * The header `cron/scheduler_delivery.py::_deliver_to_bot_chat` splices in front
 * of a report it injects into a bot's chat, verbatim at upstream b9c2660. The em
 * dash, the quotes around the name and the BLANK line before the body are all
 * part of it.
 */
export const cronBotChatHeader = (jobName: string) =>
  `[Cronjob "${jobName}" output — scheduled job, not the user. Review it, act on ` +
  'anything that needs action, and summarize for the chat.]'

export const cronBotChatBody = [
  '## Inbox scan',
  '',
  '- 3 threads waiting on a reply',
  '- 1 invoice past due',
  '',
  'Nothing needs you before tomorrow.'
].join('\n')

export const cronBotChatText = `${cronBotChatHeader('Inbox scan')}\n\n${cronBotChatBody}`

/** The second, different shape: `_cron_mirror_message`, one newline, no instruction. */
export const cronMirrorText = '[Cron delivery: Morning Brief]\nTwo deploys overnight, both green.'

/**
 * A `delegate_task` fan-out reporting back, as
 * `tools/process_registry_notifications.py::_format_batch_delegation` (line 204)
 * writes it: the header alone on the first line, then the intro, the dispatch
 * accounting, and one block per task.
 */
export const delegationBatchText = [
  '[ASYNC DELEGATION BATCH COMPLETE — deleg_1bd47ada]',
  'A background fan-out unit you dispatched earlier — 3 subagent(s) — has finished; its consolidated results are ' +
    'below. Any other units from the same delegate_task call report separately as they finish.',
  '',
  'Dispatched: 2026-09-21 20:44:11 (14m ago)',
  'Role: leaf   Model: gpt-5   Total duration: 812s',
  '',
  '--- ✓ TASK 1/3: Audit deps  (status=completed, 41s) ---',
  'No drift.',
  '',
  '--- ✓ TASK 2/3: Write tests  (status=completed, 190s) ---',
  'Nine cases, all green.',
  '',
  '--- ✗ TASK 3/3: Update docs  (status=failed) ---',
  '(no summary — status=failed: the page was locked)'
].join('\n')

/**
 * The compaction handoff (`agent/context_compressor.py`, lines 428–429). Its
 * header is a line of its own and the block names its own end.
 */
export const priorContextText = [
  '[PRIOR CONTEXT — for reference only; not a new message]',
  'The owner asked for the release notes and then went quiet.',
  '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]'
].join('\n')

/**
 * The model-switch marker, verbatim from
 * `tui_gateway/server.py::_append_model_switch_marker` (line 1705). Persisted
 * with `display_kind: "model_switch"` where the gateway can, and with nothing at
 * all where it cannot — which is why the text has to be readable on its own.
 */
export const modelSwitchMarkerText =
  '[System: The active model for this chat has changed to k3 via provider moonshot. From this point forward, use ' +
  'this runtime metadata when answering questions about what model/provider is active.]'

/** The personality counterpart, `tui_gateway/agent_callbacks.py` (line 270). */
export const personalitySwitchMarkerText =
  '[System: The user has cleared the personality overlay. From this point forward, respond in your normal default ' +
  'style.]'

/** `tools/todo_tool.py::TODO_INJECTION_HEADER` with the list it preserved. */
export const todoInjectionText = [
  '[Your active task list was preserved across context compression]',
  '[>] Rotate the staging certificate',
  '[ ] Write the release notes'
].join('\n')

/** The planning half of the same compaction handoff. */
export const planningPreservedText = [
  '[Planning state preserved across context compression]',
  'Step 2 of 4: draft the migration.'
].join('\n')

/**
 * `cron/scheduler_delivery.py`'s platform-delivery wrapper (line 1958): the
 * name, the job id, a rule of dashes, then the report and the how-to-stop line.
 */
export const cronjobResponseText = [
  'Cronjob Response: daily-report',
  '(job_id: job_9f21)',
  '-------------',
  '',
  'Three deploys, all green.',
  '',
  'To stop or manage this job, send me a new message (e.g. "stop reminder daily-report").'
].join('\n')

/** One kanban event as `_format_kanban_event_text` (line 331) renders it. */
export const kanbanNotificationText = '✔ [ops] @researcher Kanban task-4412 done — Rotate the staging certificate'

/**
 * A mid-turn steer, wrapped for the model by
 * `agent/prompt_builder.py::format_steer_marker` (lines 535–549) and persisted
 * with `display_kind: "steer"`. Only the middle line is the user speaking.
 */
export const steerWrapperText = [
  '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output ' +
    'and not a new delivery when replayed from conversation history]',
  'lees over shared memory skill',
  '[/OUT-OF-BAND USER MESSAGE]'
].join('\n')

export const steerWrapperBody = 'lees over shared memory skill'

/** A full canonical Bot Chat as `session.history` projects it. */
export const rpcHistoryRows: TranscriptRow[] = [
  { role: 'user', text: 'Summarise the release notes.', timestamp: 1_700_000_000, row_id: 1 },
  {
    role: 'assistant',
    text: 'Reading them now.',
    reasoning: 'The user wants a summary; read the file first.',
    timestamp: 1_700_000_001,
    row_id: 2
  },
  { role: 'tool', name: 'read_file', context: 'read_file(CHANGELOG.md)', args: { path: 'CHANGELOG.md' } },
  { role: 'assistant', text: 'Three fixes and one feature.', timestamp: 1_700_000_005, row_id: 3 },
  { role: 'user', text: 'Switched model', timestamp: 1_700_000_006, row_id: 4, display_kind: 'model_switch' },
  {
    role: 'user',
    text: 'Switched personality',
    timestamp: 1_700_000_007,
    row_id: 5,
    display_kind: 'personality_switch'
  },
  { role: 'user', text: 'Resuming', timestamp: 1_700_000_008, row_id: 6, display_kind: 'auto_continue' },
  { role: 'user', text: '/release-notes', timestamp: 1_700_000_009, row_id: 7, display_kind: 'skill_invocation' },
  { role: 'user', text: 'actually make it shorter', timestamp: 1_700_000_010, row_id: 8, display_kind: 'steer' },
  {
    role: 'user',
    text: 'Bot roster refreshed',
    timestamp: 1_700_000_011,
    row_id: 9,
    display_kind: 'internal_notification'
  },
  { role: 'user', text: 'Something new', timestamp: 1_700_000_012, row_id: 10, display_kind: 'brand_new_kind' },
  { role: 'user', text: 'Hidden scaffolding', timestamp: 1_700_000_013, row_id: 11, display_kind: 'hidden' },
  {
    role: 'tool',
    name: 'message_agent',
    tool_id: 'call_dm_1',
    context: 'message_agent(writer)',
    args: { target: '@writer', message: 'Can you draft the announcement?' }
  },
  {
    role: 'user',
    text: dmReplyProcessText,
    timestamp: 1_700_000_020,
    row_id: 12,
    display_kind: 'process_complete',
    display_metadata: { display_text: 'Background Process Finished: bot_mode_dm.py' }
  },
  {
    role: 'tool',
    name: 'delegate_task',
    tool_id: 'call_delegate_1',
    context: 'delegate_task(3 tasks)',
    args: { tasks: [{ goal: 'Audit deps' }, { goal: 'Write tests' }, { goal: 'Update docs' }] }
  },
  {
    role: 'user',
    text: '[ASYNC DELEGATION BATCH COMPLETE]\n--- ✓ TASK 1/3: Audit deps  (status=completed) ---\nNo drift.',
    timestamp: 1_700_000_030,
    row_id: 13,
    display_kind: 'async_delegation_complete',
    display_metadata: { task_count: 3 }
  },
  {
    role: 'user',
    text: 'Message from 🤖 Writer (@writer): The announcement draft is in docs/announce.md.',
    timestamp: 1_700_000_040,
    row_id: 14
  },
  { role: 'assistant', text: 'Thanks — I will fold that in.', timestamp: 1_700_000_041, row_id: 15 },
  // No `display_kind`, no metadata: a cron delivery is indistinguishable from the
  // owner speaking except for its header.
  { role: 'user', text: cronBotChatText, timestamp: 1_700_000_050, row_id: 16 }
]

/** The same conversation as the REST transcript prefetch ships it. */
export const restHistoryRows: TranscriptRow[] = [
  { role: 'user', content: 'Summarise the release notes.', timestamp: 1_700_000_000, id: 1 },
  {
    role: 'assistant',
    content: 'Reading them now.',
    reasoning_content: 'Read the file first.',
    timestamp: 1_700_000_001,
    id: 2
  },
  { role: 'tool', name: 'read_file', tool_id: 'call_read_1', context: 'read_file(CHANGELOG.md)' },
  {
    role: 'user',
    content: 'raw stored body',
    display_content: 'Message from 🤖 Writer (@writer): The announcement draft is in docs/announce.md.',
    timestamp: 1_700_000_040,
    id: 14
  },
  { role: 'assistant', content: 'Thanks — I will fold that in.', timestamp: 1_700_000_041, id: 15 },
  // The REST transport prefers `display_content`, so the same delivery reaches us
  // under the other alias and has to project to the same item and the same id.
  { role: 'user', content: 'raw stored body', display_content: cronBotChatText, timestamp: 1_700_000_050, id: 16 }
]

/** A user turn persisted with the model-facing scaffolding still attached. */
export const attachedContextRow: TranscriptRow = {
  role: 'user',
  row_id: 42,
  text: [
    'Look at @image:/tmp/shot.png and tell me what broke.',
    '',
    '--- Attached Context ---',
    '@file:/srv/app/server.ts',
    '@image:/tmp/shot.png',
    '',
    '--- Context Warnings ---',
    'one file was too large to inline'
  ].join('\n')
}

/** An assistant row whose reply only survives in the Responses-API sidecar. */
export const codexSidecarRow: TranscriptRow = {
  role: 'assistant',
  row_id: 77,
  text: '',
  codex_message_items: [
    {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'thinking out loud' }]
    },
    { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: 'Recovered reply.' }] }
  ]
}

/**
 * `display_metadata.author` (HERM-83, D1/D2) in every shape `rowsToItems` must
 * tell apart: a real author beside another unrelated key, and the ways a stamp
 * can be malformed — a string instead of an object, an empty or non-string id,
 * a non-string name. Every one of the malformed rows must project no author at
 * all rather than half of one.
 */
export const authoredRow: TranscriptRow = {
  role: 'user',
  row_id: 60,
  text: 'lunch at noon?',
  timestamp: 1_700_000_100,
  display_metadata: { author: { id: 'oidc:user-a', name: 'Robin' }, display_text: 'unrelated key, left alone' }
}

/** The same row as the REST transport ships it — `content`/`id`, same metadata. */
export const authoredRowRest: TranscriptRow = {
  role: 'user',
  id: 60,
  content: 'lunch at noon?',
  timestamp: 1_700_000_100,
  display_metadata: { author: { id: 'oidc:user-a', name: 'Robin' }, display_text: 'unrelated key, left alone' }
}

export const authorlessRows: Record<string, TranscriptRow> = {
  stringAuthor: {
    role: 'user',
    row_id: 61,
    text: 'string, not an object',
    display_metadata: { author: 'oidc:user-a' }
  },
  emptyAuthor: {
    role: 'user',
    row_id: 62,
    text: 'empty object',
    display_metadata: { author: {} }
  },
  blankId: {
    role: 'user',
    row_id: 63,
    text: 'blank id',
    display_metadata: { author: { id: '' } }
  },
  numericId: {
    role: 'user',
    row_id: 64,
    text: 'numeric id',
    display_metadata: { author: { id: 7 } }
  },
  numericName: {
    role: 'user',
    row_id: 65,
    text: 'numeric name',
    display_metadata: { author: { id: 'oidc:user-a', name: 7 } }
  },
  nonObjectMetadata: {
    role: 'user',
    row_id: 66,
    text: 'metadata is a bare string',
    display_metadata: 'not an object'
  }
}

/**
 * A turn an agent sent on a person's behalf (the gateway's MCP endpoint): the author is still the person,
 * and `author.via` names the agent. The extra keys, in `via` and beside it, are ones a later gateway may
 * add; a reader ignores them.
 */
export const viaRow: TranscriptRow = {
  role: 'user',
  row_id: 70,
  text: 'summarise the open pull requests',
  timestamp: 1_700_000_200,
  display_metadata: {
    author: {
      id: 'oidc:user-a',
      name: 'Robin',
      via: { kind: 'mcp', client: 'Claude Code', version: '2.1', scopes: ['bots'] },
      locale: 'nl'
    },
    turn_id: 'turnvia70'
  }
}

/** A retry an agent pressed on somebody else's turn: `replayed_by` carries `via`, the author does not. */
export const viaReplayedRow: TranscriptRow = {
  role: 'user',
  row_id: 71,
  text: 'lunch at noon?',
  timestamp: 1_700_000_300,
  display_metadata: {
    author: { id: 'oidc:user-a', name: 'Robin' },
    replayed_by: { id: 'oidc:user-b', name: 'Sam', via: { kind: 'mcp', client: 'Claude Code' } }
  }
}

/** A `via` that is not well formed is left out; the person's identity beside it is kept. */
export const viaMalformedRows: Record<string, TranscriptRow> = {
  stringVia: {
    role: 'user',
    row_id: 72,
    text: 'via is a string',
    display_metadata: { author: { id: 'oidc:user-a', name: 'Robin', via: 'mcp' } }
  },
  blankClient: {
    role: 'user',
    row_id: 73,
    text: 'client is blank',
    display_metadata: { author: { id: 'oidc:user-a', name: 'Robin', via: { kind: 'mcp', client: '  \u200b ' } } }
  },
  numericClient: {
    role: 'user',
    row_id: 74,
    text: 'client is a number',
    display_metadata: { author: { id: 'oidc:user-a', name: 'Robin', via: { kind: 'mcp', client: 7 } } }
  },
  missingKind: {
    role: 'user',
    row_id: 75,
    text: 'kind is missing',
    display_metadata: { author: { id: 'oidc:user-a', name: 'Robin', via: { client: 'Claude Code' } } }
  },
  noAuthor: {
    role: 'user',
    row_id: 76,
    text: 'via without a person',
    display_metadata: { author: { via: { kind: 'mcp', client: 'Claude Code' } } }
  },
  unclean: {
    role: 'user',
    row_id: 77,
    text: 'client with invisible characters and a long tail',
    display_metadata: {
      author: {
        id: 'oidc:user-a',
        via: { kind: 'mcp', client: `  Claude\u202e \u200bCode\n*Pro*  ${'x'.repeat(120)}` }
      }
    }
  }
}
