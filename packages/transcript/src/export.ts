/**
 * A conversation → a file somebody can keep.
 *
 * ## What is exported is what is on screen
 *
 * The input is the VISIBLE items — whatever the verbosity filter, the
 * bot-to-bot toggle and the thinking toggle left standing — rather than the
 * chat's full state. That is the contract and it is the reason this takes a
 * list instead of a `ChatState`: a reader who has a chat set to Quiet and
 * exports it expects the quiet conversation, and an export that silently
 * carried the rows the screen is hiding would be handing them something they
 * have not read.
 *
 * ## Markdown and plain text are one walk, not two strippers
 *
 * They differ in exactly two ways — whether a speaker's name is bold, and
 * whether a reply's own markdown is kept or left as the characters it is — so
 * one walk emits both rather than a second formatter that agrees with the first
 * until it does not. That is the same argument `plain-text.ts` makes about the
 * preview and the block stripper sharing a pass.
 *
 * A reply's markdown is deliberately NOT stripped for the plain-text file
 * either. It is the text the model wrote; a `#` and a `**` in a `.txt` are the
 * author's characters, while a stripped version is this app's opinion about
 * them, and the one thing an export must not do is quietly edit what it is
 * preserving.
 *
 * ## Pure, and total
 *
 * No React, no theme, no platform, no `Intl` beyond what the caller hands in. A
 * timestamp is formatted by a function the caller supplies, because a file
 * saved on a phone should carry that phone's idea of a clock and this package
 * has no business knowing what it is.
 */
import { authorLabel } from './author'
import type { MessageAuthor, TranscriptItem } from './types'

export interface TranscriptExportOptions {
  /** The bot's display name, as the header and its replies are labelled. */
  botName: string
  /** What the reader's own turns are labelled. Defaults to `You`. */
  selfName?: string
  /**
   * One item's timestamp, as the reader should see it.
   *
   * Supplied rather than formatted here: a file saved on a phone carries that
   * phone's clock and locale, and this package cannot know either. Returning an
   * empty string drops the stamp from that line.
   */
  formatTime?: (seconds: number) => string
  /** When the export was taken, for the header. Same formatter. */
  exportedAt?: number
  /**
   * HERM-83, D6 gate 1: only the canonical GROUP chat may put somebody else's
   * name on a `user` row. Absent — every export before `author` existed —
   * every `user` row stays `selfName`, exactly as today.
   */
  groupChat?: boolean
  /**
   * The reader's own identity, D3's own/foreign gate, compared against
   * `item.author.id`. Absent is the safe default: `selfName` for every row.
   */
  ownAuthorId?: string
  /**
   * Names a foreign author — D4's rungs 2 and 3, or rung 1 when the host has
   * one. This package cannot sanitise a name itself (see the chat kit's
   * `fallbackSenderName`); a caller with no resolver leaves every `user` row
   * `selfName` rather than printing a raw, untrusted id.
   */
  resolveSenderName?: (author: MessageAuthor) => string
}

export interface TranscriptExport {
  markdown: string
  text: string
}

/** The label a tool row carries, which is the call preview when there is one. */
function toolLine(item: Extract<TranscriptItem, { kind: 'tool' }>): string {
  const detail = item.context || item.summary || ''
  const status = item.isError ? ' — failed' : item.status === 'running' ? ' — running' : ''

  return detail ? `${item.name}: ${detail}${status}` : `${item.name}${status}`
}

/** One request's outcome in a line, which is all a file can carry of a sheet. */
function requestLine(item: Extract<TranscriptItem, { kind: 'approval' | 'clarify' }>): string {
  if (item.kind === 'approval') {
    const answered = item.state === 'answered' && item.answer ? `answered ${item.answer}` : item.state
    const subject = item.command || item.toolName || 'a permission request'

    return `Permission request — ${subject} (${answered})`
  }

  const questions = item.questions.map(question => question.question).filter(Boolean)
  const answered = Object.entries(item.answers)
    .map(([qid, answer]) => {
      const question = item.questions.find(candidate => candidate.qid === qid)

      return question ? `${question.question} → ${answer}` : answer
    })
    .filter(Boolean)

  if (answered.length) {
    return `Question — ${answered.join('; ')}`
  }

  return `Question — ${questions.join('; ') || item.state}`
}

/**
 * The name a `user` row is exported under, when it is somebody else's
 * (HERM-83, D3/D6) — the same gate `attributedSenderName` in `preview.ts`
 * applies, restated here because an export walks a plain item list rather
 * than a `ChatState`. `undefined` for the reader's own row, an unattributed
 * one, anywhere the caller has not said is the group chat, or a caller with
 * no resolver — every one of those keeps today's `selfName`.
 */
function foreignSenderWho(author: MessageAuthor | undefined, options: TranscriptExportOptions): string | undefined {
  if (!options.groupChat || !options.ownAuthorId || !options.resolveSenderName || !author) {
    return undefined
  }

  if (author.id === options.ownAuthorId) {
    return undefined
  }

  return options.resolveSenderName(author) || undefined
}

/**
 * A speaker's name, safe inside the `**…**` the Markdown file wraps it in.
 *
 * A name is somebody else's text — a colleague's, an identity provider's, a
 * bot's — and unescaped a `*` closes the bold early, `[x](y)` becomes a link and
 * `<b>` becomes markup wherever the file is rendered with HTML allowed. Each
 * character that can open or close inline Markdown gets a backslash, which
 * CommonMark defines for every ASCII punctuation character, and the name is
 * held to one line. The `.txt` file is plain text and keeps the name as is.
 */
function markdownName(name: string): string {
  return name.replace(/\s+/gu, ' ').replace(/[\\`*_[\]()<>#~|]/gu, '\\$&')
}

/** One line of a row: who spoke, and the body under it. `null` drops the row. */
interface Entry {
  /** The speaker or the row's label. Empty for a row that is not speech. */
  who: string
  body: string
  ts?: number
  /** A row that is about the conversation rather than in it: a notice, a tool. */
  aside: boolean
}

function entryFor(item: TranscriptItem, options: TranscriptExportOptions): Entry | null {
  const self = options.selfName?.trim() || 'You'
  const bot = options.botName.trim() || 'Bot'
  const base = { aside: false, ...(typeof item.ts === 'number' ? { ts: item.ts } : {}) }

  switch (item.kind) {
    case 'user':
      return item.text.trim() || item.attachments?.length
        ? {
            ...base,
            body: [item.text.trim(), ...(item.attachments ?? []).map(reference => `[${reference}]`)]
              .filter(Boolean)
              .join('\n'),
            // An agent's turn carries its marker everywhere: `<name> via <client>`, the name being the
            // person's own label (`selfName`, or the resolved name of a colleague in the group chat).
            who: authorLabel(item.author, foreignSenderWho(item.author, options) || self)
          }
        : null

    case 'assistant':
      // An empty reply is a turn that failed or was interrupted; the error line
      // under it is the whole of what happened, so the row is kept for that and
      // dropped when there is neither.
      if (!item.text.trim() && !item.error) {
        return null
      }

      return {
        ...base,
        body: item.error && !item.text.trim() ? `(${item.error.message})` : item.text.trim(),
        who: bot
      }

    case 'bot_dm_in':
      return item.text.trim()
        ? { ...base, body: item.text.trim(), who: item.senderName || item.senderHandle || 'another bot' }
        : null

    case 'bot_dm_out': {
      const reply = item.reply?.text?.trim()

      return {
        ...base,
        aside: true,
        body: reply
          ? `Message to @${item.targetHandle}: ${item.message.trim()}\nReply: ${reply}`
          : `Message to @${item.targetHandle}: ${item.message.trim()}`,
        who: ''
      }
    }

    case 'cron_delivery':
      return {
        ...base,
        body: item.body.trim(),
        who: item.nameRedacted ? 'Scheduled job' : `Scheduled job “${item.jobName}”`
      }

    case 'tool':
      return { ...base, aside: true, body: toolLine(item), who: '' }

    case 'subagent_group':
      return {
        ...base,
        aside: true,
        body: `Delegated ${item.goals.length} task${item.goals.length === 1 ? '' : 's'} (${item.status})${
          item.goals.length ? `: ${item.goals.join('; ')}` : ''
        }`,
        who: ''
      }

    case 'notice':
      return { ...base, aside: true, body: [item.title, item.body].filter(Boolean).join(' — '), who: '' }

    case 'approval':
    case 'clarify':
      return { ...base, aside: true, body: requestLine(item), who: '' }

    case 'status':
      // Transient by definition — "Compacting…", "Thinking…" — and gone from the
      // screen a second later. A file that carried them would be a file of
      // things that are no longer true.
      return null
  }
}

/** `2026-09-22 14:05 · ` or nothing, for the start of a line. */
function stamp(entry: Entry, options: TranscriptExportOptions): string {
  if (entry.ts === undefined || !options.formatTime) {
    return ''
  }

  const formatted = options.formatTime(entry.ts).trim()

  return formatted ? `${formatted} · ` : ''
}

/**
 * Serialize a visible transcript into both formats at once.
 *
 * Both always end with a newline, so appending to the file or piping it into
 * anything behaves.
 */
export function exportTranscript(items: readonly TranscriptItem[], options: TranscriptExportOptions): TranscriptExport {
  const bot = options.botName.trim() || 'Bot'
  const taken =
    options.exportedAt !== undefined && options.formatTime ? options.formatTime(options.exportedAt).trim() : ''

  const markdown: string[] = [`# ${bot}`]
  const text: string[] = [bot, '='.repeat(bot.length)]

  if (taken) {
    markdown.push('', `_Exported ${taken}_`)
    text.push(`Exported ${taken}`)
  }

  for (const item of items) {
    const entry = entryFor(item, options)

    if (!entry || !entry.body.trim()) {
      continue
    }

    const prefix = stamp(entry, options)

    if (entry.aside) {
      // An aside is a blockquote in Markdown and a bulleted line in the text
      // file: both say "this is about the conversation" without pretending
      // somebody said it.
      //
      // The stamp goes on the FIRST line only. A dispatch and the reply that
      // came back are two lines of one row, and repeating the time on the second
      // would say the reply landed at the moment the message left.
      const lines = entry.body.split('\n')

      markdown.push('', ...lines.map((line, index) => `> ${index === 0 ? prefix : ''}${line}`))
      text.push('', ...lines.map((line, index) => `  ${index === 0 ? `· ${prefix}` : '  '}${line}`))

      continue
    }

    markdown.push(
      '',
      `**${markdownName(entry.who)}** ${prefix ? `· ${prefix.replace(/ · $/u, '')}` : ''}`.trimEnd(),
      '',
      entry.body
    )
    text.push('', `${prefix}${entry.who}:`, entry.body)
  }

  return {
    markdown: `${markdown
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trimEnd()}\n`,
    text: `${text
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trimEnd()}\n`
  }
}

/**
 * A file name for the export: the bot, the day, and the extension.
 *
 * Everything outside `[A-Za-z0-9-]` becomes a hyphen. Not tidiness: this string
 * reaches a file system, a share sheet and — on the web — a `download`
 * attribute, and a bot called `ops/deploy` would otherwise be a path.
 */
export function transcriptFileName(botName: string, extension: 'md' | 'txt', isoDay: string): string {
  const slug =
    botName
      .trim()
      .replace(/[^A-Za-z0-9-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 40) || 'chat'

  return `${slug}-${isoDay}.${extension}`
}
