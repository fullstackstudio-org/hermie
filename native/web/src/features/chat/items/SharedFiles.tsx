/**
 * The files a bot shared with a reply (`contract/outbox/`), under its words.
 *
 *  - **A picture** is a thumbnail that opens the viewer, and several are a grid, as a picture the reader sent is
 *    (`AttachmentGallery`: one fills the width, two and four go two across, three or more three).
 *  - **A video** and **a sound** are players (`controls`, `preload="metadata"`): the route answers byte ranges,
 *    so they seek without the whole file. With the shared token an element cannot carry the credential, so the
 *    player waits for a press and plays the bytes the page fetched (`use-outbox-source.ts`).
 *  - **A PDF** is a card with a button that opens it in a tab of its own, from bytes the page fetched and checked
 *    (`openPdf`): the route will not hand a browser's own viewer the file as a page.
 *  - **Any other file** is a chip: its name as text, its size, and a download. It is never rendered in this page's
 *    origin: a `file` is HTML, SVG, a script, an archive or something unknown, and it is saved, not opened.
 *
 * The name is the sender's text and goes through React as text only, never as markup. Unknown kinds arrive as
 * `file` (`parseOutboxAttachments`). It is a list named "Attachments", one item per file, in the order the reply
 * holds them; a file that is gone says so under its name.
 */
import type { OutboxAttachment } from '@hermie/transcript'
import { memo, useCallback, useState } from 'react'

import {
  asDownload,
  createOutboxFiles,
  type OutboxFailure,
  type OutboxFiles,
  OUTBOX_FILE_FETCH_MAX,
  OUTBOX_IMAGE_FETCH_MAX,
  OUTBOX_MEDIA_FETCH_MAX,
  openPdf,
  outboxHref
} from '../../../core/chats/outbox-files'
import { BOT_NAME_LIMIT, displayText, NAME_LIMIT } from '../../../core/requests/secure-input'
import { sheetStrings } from '../../../i18n/sheet-strings'
import { useLocale } from '../../../i18n/use-locale'
import { saveBlob } from '../../../platform/files'
import { gridColumns } from './AttachmentGallery'
import { FileChip, formatBytes } from './FileChip'
import { ImageCard } from './ImageCard'
import { useItemContext } from './item-context'
import { useItemHost } from './item-host'
import { useOutboxSource } from './use-outbox-source'
import './media.css'

/** The words under a name for a file that did not arrive. */
function failureText(reason: OutboxFailure | 'invalid' | 'blocked' | 'not-a-pdf'): string {
  switch (reason) {
    case 'missing':
      return sheetStrings.shared.unavailable
    case 'too-large':
      return sheetStrings.shared.tooLarge
    case 'blocked':
      return sheetStrings.shared.popupBlocked
    case 'not-a-pdf':
      return sheetStrings.shared.notPdf
    default:
      return sheetStrings.shared.failed
  }
}

const reasonOf = (cause: unknown): OutboxFailure =>
  cause && typeof cause === 'object' && 'reason' in cause
    ? ((cause as { reason: OutboxFailure }).reason ?? 'unreachable')
    : 'unreachable'

/** The page's own `fetch` with the cookie, for a host that gave none (a gallery, a test of one view). */
let cookieFiles: OutboxFiles | undefined

function filesOf(host: { outbox?: OutboxFiles }): OutboxFiles {
  cookieFiles ??= createOutboxFiles({ headers: () => Promise.resolve({}), gated: true })

  return host.outbox ?? cookieFiles
}

const nameOf = (file: OutboxAttachment): string =>
  displayText(file.name, NAME_LIMIT) || displayText(file.name, BOT_NAME_LIMIT) || file.kind

type Action =
  { state: 'idle' } | { state: 'working' } | { state: 'failed'; reason: OutboxFailure | 'blocked' | 'not-a-pdf' }

/** The save of a file: a link where the address works on its own, a button that fetches and saves where it does not. */
function useSave(file: OutboxAttachment): {
  href: string | null
  direct: boolean
  run: () => void
  action: Action
} {
  const host = useItemHost()
  const { gatewayBaseUrl, profile } = useItemContext()
  const href = outboxHref(file, gatewayBaseUrl, profile)
  const files = filesOf(host)
  const [action, setAction] = useState<Action>({ state: 'idle' })
  const run = useCallback(() => {
    if (!href) {
      return
    }

    setAction({ state: 'working' })
    files
      .fetch(href, { maxBytes: OUTBOX_FILE_FETCH_MAX })
      .then(bytes => {
        saveBlob(asDownload(bytes), file.name)
        setAction({ state: 'idle' })
      })
      .catch((cause: unknown) => setAction({ state: 'failed', reason: reasonOf(cause) }))
  }, [files, href, file.name])

  return { href, direct: files.direct, run, action }
}

function DownloadAction({ file, save }: { file: OutboxAttachment; save: ReturnType<typeof useSave> }) {
  const name = nameOf(file)
  const label = sheetStrings.shared.downloadName({ name })

  if (!save.href) {
    return null
  }

  if (save.direct) {
    // The same origin as the page, with the cookie it already holds: the route answers `attachment`.
    return (
      <a
        className="hm-shared__action"
        href={save.href}
        download={file.name}
        rel="noopener noreferrer"
        aria-label={label}
      >
        {sheetStrings.shared.download}
      </a>
    )
  }

  return (
    <button
      type="button"
      className="hm-shared__action"
      onClick={save.run}
      disabled={save.action.state === 'working'}
      aria-label={label}
    >
      {save.action.state === 'working' ? sheetStrings.shared.loading : sheetStrings.shared.download}
    </button>
  )
}

/** Any file the page does not show: its name, its size, a download. */
function SharedFileChip({ file, problem }: { file: OutboxAttachment; problem?: string }) {
  const save = useSave(file)
  const error = problem ?? (save.action.state === 'failed' ? failureText(save.action.reason) : undefined)

  return (
    <FileChip
      name={file.name}
      size={file.size}
      {...(error ? { error } : {})}
      trailing={<DownloadAction file={file} save={save} />}
    />
  )
}

/** A PDF: opened in a tab of its own, from fetched bytes. */
function SharedPdf({ file }: { file: OutboxAttachment }) {
  const host = useItemHost()
  const { gatewayBaseUrl, profile } = useItemContext()
  const href = outboxHref(file, gatewayBaseUrl, profile)
  const files = filesOf(host)
  const save = useSave(file)
  const [action, setAction] = useState<Action>({ state: 'idle' })
  const name = nameOf(file)
  const open = useCallback(() => {
    if (!href) {
      return
    }

    setAction({ state: 'working' })
    openPdf(files, href, { maxBytes: OUTBOX_FILE_FETCH_MAX })
      .then(result => setAction(result === 'opened' ? { state: 'idle' } : { state: 'failed', reason: result }))
      .catch((cause: unknown) => setAction({ state: 'failed', reason: reasonOf(cause) }))
  }, [files, href])

  if (!href) {
    return <FileChip name={file.name} size={file.size} error={failureText('invalid')} />
  }

  return (
    <FileChip
      name={file.name}
      size={file.size}
      {...(action.state === 'failed' ? { error: failureText(action.reason) } : {})}
      trailing={
        <>
          <button
            type="button"
            className="hm-shared__action"
            onClick={open}
            disabled={action.state === 'working'}
            aria-label={sheetStrings.shared.openPdfName({ name })}
          >
            {action.state === 'working' ? sheetStrings.shared.loading : sheetStrings.shared.openPdf}
          </button>
          {action.state === 'failed' && (action.reason === 'blocked' || action.reason === 'too-large') ? (
            <DownloadAction file={file} save={save} />
          ) : null}
        </>
      }
    />
  )
}

/** A picture: the thumbnail that opens the viewer, in a frame the size of its card from the first moment. */
function SharedImage({ file, layout }: { file: OutboxAttachment; layout: 'solo' | 'cell' }) {
  const host = useItemHost()
  const { source, watch } = useOutboxSource(file, { on: 'visible', maxBytes: OUTBOX_IMAGE_FETCH_MAX })

  if (source.state === 'ready') {
    return (
      <ImageCard
        src={source.src}
        name={file.name}
        layout={layout}
        reserve
        onOpen={opener => host.openImage({ src: source.src, name: file.name }, opener)}
      />
    )
  }

  if (source.state === 'failed') {
    return <SharedFileChip file={file} problem={failureText(source.reason)} />
  }

  return (
    <span
      ref={watch}
      className="hm-image"
      data-layout={layout}
      data-reserved="true"
      data-state="waiting"
      aria-busy="true"
    />
  )
}

/** What stands where a video or a sound will be, until the reader asks for it (a gateway with a shared token). */
function PressToLoad({ file, load, loading }: { file: OutboxAttachment; load: () => void; loading: boolean }) {
  return (
    <button type="button" className="hm-shared__load" onClick={load} disabled={loading}>
      {loading ? sheetStrings.shared.loading : sheetStrings.shared.load({ size: formatBytes(file.size) })}
    </button>
  )
}

function SharedVideo({ file }: { file: OutboxAttachment }) {
  const { source, load } = useOutboxSource(file, { on: 'press', maxBytes: OUTBOX_MEDIA_FETCH_MAX })
  const name = nameOf(file)

  if (source.state === 'failed') {
    return <SharedFileChip file={file} problem={failureText(source.reason)} />
  }

  return (
    <figure className="hm-shared hm-shared--video">
      {source.state === 'ready' ? (
        // The sender's file, played by the browser's own player; the caption below says what it is.
        <video
          className="hm-shared__video"
          src={source.src}
          controls
          preload="metadata"
          playsInline
          aria-label={sheetStrings.shared.videoName({ name })}
        />
      ) : (
        <div className="hm-shared__stage">
          <PressToLoad file={file} load={load} loading={source.state === 'loading'} />
        </div>
      )}
      <figcaption className="hm-shared__caption">
        <bdi className="hm-shared__name">{name}</bdi>
        <span className="hm-shared__size">{formatBytes(file.size)}</span>
      </figcaption>
    </figure>
  )
}

function SharedAudio({ file }: { file: OutboxAttachment }) {
  const { source, load } = useOutboxSource(file, { on: 'press', maxBytes: OUTBOX_MEDIA_FETCH_MAX })
  const name = nameOf(file)

  if (source.state === 'failed') {
    return <SharedFileChip file={file} problem={failureText(source.reason)} />
  }

  return (
    <figure className="hm-shared hm-shared--audio">
      <figcaption className="hm-shared__caption">
        <bdi className="hm-shared__name">{name}</bdi>
        <span className="hm-shared__size">{formatBytes(file.size)}</span>
      </figcaption>
      {source.state === 'ready' ? (
        <audio
          className="hm-shared__audio"
          src={source.src}
          controls
          preload="metadata"
          aria-label={sheetStrings.shared.audioName({ name })}
        />
      ) : (
        <PressToLoad file={file} load={load} loading={source.state === 'loading'} />
      )}
    </figure>
  )
}

export interface SharedFilesProps {
  files: readonly OutboxAttachment[]
}

function SharedFilesImpl({ files }: SharedFilesProps) {
  useLocale()

  if (files.length === 0) {
    return null
  }

  const pictures = files.filter(file => file.kind === 'image').length
  const columns = gridColumns(pictures)
  const layout = columns > 1 ? 'cell' : 'solo'

  return (
    <ul className="hm-gallery hm-shared-list" data-columns={columns} aria-label={sheetStrings.chat.attachments}>
      {files.map(file => (
        <li
          key={file.id}
          className="hm-gallery__entry"
          data-kind={file.kind === 'image' ? 'image' : 'file'}
          data-shared={file.kind}
        >
          {file.kind === 'image' ? (
            <SharedImage file={file} layout={layout} />
          ) : file.kind === 'video' ? (
            <SharedVideo file={file} />
          ) : file.kind === 'audio' ? (
            <SharedAudio file={file} />
          ) : file.kind === 'pdf' ? (
            <SharedPdf file={file} />
          ) : (
            <SharedFileChip file={file} />
          )}
        </li>
      ))}
    </ul>
  )
}

export const SharedFiles = memo(SharedFilesImpl)
