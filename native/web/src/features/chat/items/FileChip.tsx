/**
 * A file, as a chip: under a message once it is sent, and in the composer's
 * tray before that (W-19).
 *
 * The parity source is the Expo app's `chat-ui/FileChip.tsx`: a glyph for the
 * family of file, the name middle-truncated, the size, and in the tray a way to
 * take it out again. While it uploads a progress bar stands in for the size; a
 * file the gateway refused says why in the danger ink.
 *
 *  - **The tail of a long name is kept**, because the extension is the most
 *    telling part of it: `...-final-v4.xlsx` says more than `Q3-report-final-...`.
 *    The short form is for the eye; assistive technology is given the whole name.
 *  - **The name is somebody else's text** (a path on the gateway's disk, or a
 *    file name the reader's own system chose), so it is cleaned and bounded
 *    (`displayText`) and isolated in `<bdi>`: a right-to-left name cannot reorder
 *    the size beside it.
 *  - **Opening is the host's to offer.** A file the gateway holds is a path the
 *    page cannot fetch, so a chip under a sent message is not a control unless
 *    the host can actually open it (`onOpen`).
 */
import { memo, type ReactNode, useId } from 'react'

import { strings } from '../../../generated/strings'
import { BOT_NAME_LIMIT, displayText, NAME_LIMIT } from '../../../core/requests/secure-input'
import { formatNumber } from '../../../i18n/format'
import { useLocale } from '../../../i18n/use-locale'
import { VisuallyHidden } from '../../../ui/primitives'
import './media.css'

export interface FileChipProps {
  /** The file's name, as the reference or the picker gave it. */
  name: string
  /** Bytes, when known. */
  size?: number
  /** The upload's state; absent for a file that is simply there. */
  status?: 'uploading' | 'error'
  /** How far the upload is, 0 to 1; absent while that is not known. */
  progress?: number
  /** Why the file was refused, in words the reader can act on. */
  error?: string
  /** Take the file out of the tray. */
  onRemove?: () => void
  /** Open the file; only where the host has something to open. */
  onOpen?: () => void
  /** Inside the reader's own bubble: the ink follows the bubble's. */
  onAccent?: boolean
  /** What the chip offers beside its name: the way to save or open the file it names (`SharedFiles`). */
  trailing?: ReactNode
}

/** How many characters of a name are shown before it is shortened in the middle. */
export const CHIP_NAME_CHARS = 28

/** `a-very-long-report-name.xlsx` to `a-very-lo...name.xlsx`: the head gives way, the tail stays. */
export function middleTruncate(name: string, max: number = CHIP_NAME_CHARS): string {
  const chars = Array.from(name)

  if (chars.length <= max || max < 5) {
    return name
  }

  const tail = Math.ceil((max - 1) * 0.6)
  const head = max - 1 - tail

  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const

/** `1536` to `1.5 kB`, in the reader's language (decimal units, as the gateway's limits are written). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return ''
  }

  let value = bytes
  let unit = 0

  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }

  return formatNumber(value, {
    style: 'unit',
    unit: UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 || value >= 10 ? 0 : 1
  })
}

export type FileFamily = 'image' | 'document'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'svg', 'avif'])

/** Which glyph a file gets. Two shapes on purpose: a picture or not is what the eye is telling apart. */
export function fileFamily(name: string): FileFamily {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''

  return IMAGE_EXTENSIONS.has(extension) ? 'image' : 'document'
}

const GLYPHS: Record<FileFamily, readonly string[]> = {
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.5h.01'],
  document: ['M7 3h7l5 5v13H7z', 'M14 3v5h5', 'M10 13h6', 'M10 17h6']
}

function Glyph({ family }: { family: FileFamily }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="hm-file__glyph"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[family].map(path => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

function FileChipImpl({
  name,
  size,
  status,
  progress,
  error,
  onRemove,
  onOpen,
  onAccent = false,
  trailing
}: FileChipProps) {
  useLocale()

  const nameId = useId()
  const shownName = displayText(name, NAME_LIMIT)
  const short = middleTruncate(shownName)
  const failed = status === 'error' || Boolean(error)
  const uploading = status === 'uploading'
  const known = typeof progress === 'number' && Number.isFinite(progress)
  const detail = error
    ? displayText(error, BOT_NAME_LIMIT * 4)
    : size !== undefined && !uploading
      ? formatBytes(size)
      : ''

  // Only a shortened name needs the long one on hover.
  const tooltip = short === shownName ? undefined : shownName
  const label =
    short === shownName ? (
      <bdi>{shownName}</bdi>
    ) : (
      <>
        <bdi aria-hidden="true">{short}</bdi>
        <VisuallyHidden>{shownName}</VisuallyHidden>
      </>
    )

  return (
    <span
      className="hm-file"
      data-state={failed ? 'error' : uploading ? 'uploading' : 'idle'}
      data-on-accent={onAccent}
    >
      <Glyph family={fileFamily(shownName)} />

      <span className="hm-file__body">
        {onOpen ? (
          <button type="button" className="hm-file__name hm-file__open" id={nameId} onClick={onOpen} title={tooltip}>
            {label}
          </button>
        ) : (
          <span className="hm-file__name" id={nameId} title={tooltip}>
            {label}
          </span>
        )}

        {uploading ? (
          <progress
            className="hm-file__progress"
            max={1}
            aria-labelledby={nameId}
            {...(known ? { value: Math.min(1, Math.max(0, progress)) } : {})}
          />
        ) : null}

        {detail ? <span className="hm-file__detail">{detail}</span> : null}
      </span>

      {trailing}

      {onRemove ? (
        <button
          type="button"
          className="hm-file__remove"
          aria-label={strings.chat.composer.removeAttachment}
          aria-describedby={nameId}
          onClick={onRemove}
        >
          <span aria-hidden="true">{'×'}</span>
        </button>
      ) : null}
    </span>
  )
}

export const FileChip = memo(FileChipImpl)
