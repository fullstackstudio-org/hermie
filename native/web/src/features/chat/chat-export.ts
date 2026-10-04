/**
 * The conversation as a file: Markdown or plain text, built here from the rows
 * the reader is looking at, and handed to the browser as a download.
 *
 * Nothing about the serialization is in this file. `exportTranscript`
 * (`@hermie/transcript`) is a pure function with its own suite, shared with the
 * Apple apps; this supplies the two things the package cannot know: what a clock
 * looks like in the reader's language, and how a file reaches the rest of the
 * system (a `download` link, since a browser has no share sheet for text).
 *
 * What is exported is what is on screen: the visible rows, so a chat set to Quiet
 * exports the quiet conversation, and the history that has been paged in. A row
 * the screen has not loaded is not in the file, and the options say so.
 *
 * Its own module so it loads when the reader asks for a file, not with the first
 * screen (`ChatScreen` imports it on demand).
 */
import { exportTranscript, transcriptFileName, type VisibleItem } from '@hermie/transcript'

import { strings } from '../../generated/strings'
import { formatDateTime } from '../../i18n/format'
import { senderName } from '../bots/preview'

export type ExportFormat = 'md' | 'txt'

export interface ConversationExportInput {
  /** The rows on screen, in order (the verbosity filter and the visibility switches already applied). */
  items: readonly VisibleItem[]
  /** The bot's name as the reader sees it. */
  botName: string
  groupChat: boolean
  ownAuthorId?: string | undefined
  format: ExportFormat
  /** The moment of the export: the header's stamp and the file name's day. */
  now: Date
}

export interface ExportedFile {
  /** `<bot>-<yyyy-mm-dd>.md` or `.txt`: a name safe to save under on every system. */
  name: string
  mime: string
  content: string
}

const MIME: Record<ExportFormat, string> = {
  md: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8'
}

/** The file for a conversation. Pure: the same rows and the same moment give the same text. */
export function conversationFile(input: ConversationExportInput): ExportedFile {
  const { markdown, text } = exportTranscript(
    input.items.map(entry => entry.item),
    {
      botName: input.botName,
      exportedAt: Math.floor(input.now.getTime() / 1000),
      // The reader's own language and clock, which is why the formatter is handed in.
      formatTime: seconds => formatDateTime(seconds * 1000),
      groupChat: input.groupChat,
      ...(input.ownAuthorId ? { ownAuthorId: input.ownAuthorId } : {}),
      // The same cleaning resolver the transcript draws somebody else's name with.
      resolveSenderName: senderName,
      selfName: strings.chat.export.self
    }
  )

  return {
    name: transcriptFileName(input.botName, input.format, input.now.toISOString().slice(0, 10)),
    mime: MIME[input.format],
    content: input.format === 'md' ? markdown : text
  }
}

/** How long the object URL lives: long enough for every browser to have started the save. */
const REVOKE_AFTER_MS = 30_000

/** Hand a file to the browser's download. Throws when the browser cannot make one. */
export function downloadFile(file: ExportedFile, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mime }))
  const link = doc.createElement('a')

  link.href = url
  link.download = file.name
  link.rel = 'noopener'
  link.hidden = true
  // In the document, because some browsers ignore a click on a link that is not.
  doc.body.append(link)

  try {
    link.click()
  } finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
  }
}

/** Build the file and download it. */
export function exportConversation(input: ConversationExportInput, doc: Document = document): ExportedFile {
  const file = conversationFile(input)

  downloadFile(file, doc)

  return file
}
