/**
 * A system notice: a model switch, an auto-continue, a background process that
 * finished.
 *
 * §6.4 puts these in the ledger with everything else the machine says. An `error`
 * notice is the exception and keeps a danger tint, because it is the one kind that
 * survives every verbosity level and the one a reader must not skim past.
 *
 * A `command` notice is the other exception, and it is not the machine speaking at
 * all: it is the answer to a line the owner typed. It survives every level too
 * (`selectors.ts`) and it opens itself, because a disclosure the reader has to
 * find and tap is indistinguishable from a command that did nothing. The fold
 * stays — `useExpanded`'s `defaultOpen` is the row's starting position, not a
 * rule — so closing one is a choice that survives virtualisation like any other.
 *
 * The other exception is the system-line family — a model switch, a personality
 * change, an auto-continue, a bare `[System: …]` note. Those carry a sentence and
 * nothing under it, so a fold would reveal what the line already says; they are
 * drawn as centred muted text by `SystemLine` instead. Everything with a payload
 * worth opening stays a ledger row here.
 *
 * Its open/closed state is keyed on the item's id and held above the list, so a
 * notice the reader opened does not close itself when the row is virtualised out.
 */
import { Text } from '../ui/primitives'
import { useExpanded } from './expanded'
import { LedgerRow } from './primitives/LedgerRow'
import { Chip } from './primitives/Chip'
import { isSystemLineNotice, SystemLine } from './SystemLine'
import type { NoticeItem, Presentation } from './types'

export interface NoticePillProps {
  item: NoticeItem
  presentation?: Presentation
}

/** One glyph per family, so the eye can tell them apart without reading. */
function glyphFor(kind: NoticeItem['noticeKind']): string {
  switch (kind) {
    case 'error':
      return '!'
    case 'command':
      return '/'
    case 'model_switch':
    case 'personality_switch':
      return '⇄'
    case 'auto_continue':
      return '↻'
    case 'process_complete':
    case 'async_delegation_complete':
      return '✓'
    default:
      return 'i'
  }
}

export function NoticePill({ item, presentation = 'collapsed' }: NoticePillProps) {
  const command = item.noticeKind === 'command'
  const [expanded, toggle] = useExpanded(item.id, { defaultOpen: command })

  if (presentation === 'hidden-placeholder') {
    return null
  }

  // At every level that shows it at all. `quiet` does not reach here — the
  // selector drops this family before the renderer sees it — so `normal` and
  // `verbose` draw the same line, which is the point: the sentence is short
  // enough that folding it at one level and not the other would be a difference
  // with nothing behind it.
  if (isSystemLineNotice(item)) {
    return <SystemLine item={item} />
  }

  const error = item.noticeKind === 'error'
  const hasBody = Boolean(item.body?.trim())

  // A command answer is never a chip: the selector hands it back as `full` at
  // every level, and demoting the one row the owner asked for to a label would
  // undo the whole exemption.
  if (!error && !command && presentation === 'chip') {
    return <Chip centered label={item.title} testID={`notice-${item.id}`} />
  }

  return (
    <LedgerRow
      expanded={expanded}
      glyph={glyphFor(item.noticeKind)}
      onToggle={hasBody ? toggle : undefined}
      testID={`notice-${item.id}`}
      title={item.title}
      tone={error ? 'danger' : 'neutral'}
    >
      <Text color="textMuted" selectable testID={`notice-body-${item.id}`} variant="preview">
        {item.body}
      </Text>
    </LedgerRow>
  )
}
