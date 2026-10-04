/**
 * What this conversation shows: the verbosity, bot-to-bot and thinking.
 *
 * The view half of the Expo app's chat options (`ui/sheets/ChatOptionsSheet.tsx`,
 * "What this conversation shows"); the model, reasoning and fast-mode half talks
 * to the gateway and is not this package's. A switch is instant and loses
 * nothing: all three are read-time decisions of the transcript engine, so the
 * rows come and go as the reader flips one, mid-turn included
 * (`state/chat-view.ts`).
 *
 * A disclosure, not a dialog: a button in the chat's header ("Chat options",
 * `aria-expanded`) shows a panel of native controls right under it, a radio group
 * for the verbosity and two checkboxes, so every control is labelled and the
 * keyboard works the way it works everywhere. Escape closes the panel and puts
 * focus back on the button when focus was in it (or nowhere: Safari does not
 * focus a clicked radio); a press outside it closes it too. Nothing behind it goes
 * inert: the panel asks nothing, and the transcript changing under it while it is
 * open is the point.
 *
 * Once the reader changes anything, this chat has its own view, and the panel
 * says so and offers to follow the default again.
 *
 * Under that, one row talks to the gateway: YOLO mode, which skips this chat's
 * approval requests (`use-yolo.ts`). It asks before turning on; while it is on,
 * the header carries a mark that turns it off (`YoloBadge`).
 *
 * The panel is a module of its own (`ChatOptionsPanel`), loaded the first time
 * the button is pointed at, focused or pressed: the button is on every chat's
 * first screen, the panel is not.
 */
import { lazy, type ReactElement, Suspense, useEffect, useId, useRef, useState } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import type { YoloControl } from './use-yolo'
import './chat-options.css'

export interface ChatOptionsProps {
  /** The bot whose chat this is: the key its own view is kept under. */
  bot: string
  /** YOLO mode of this chat (`use-yolo.ts`); absent where the chat cannot be switched, and the panel then has no such row. */
  yolo?: YoloControl
}

const loadPanel = () => import('./ChatOptionsPanel')
const ChatOptionsPanel = lazy(() => loadPanel().then(module => ({ default: module.ChatOptionsPanel })))

/** Start fetching the panel before it is asked for; a failure is the lazy load's to report. */
const preloadPanel = (): void => {
  void loadPanel().catch(() => undefined)
}

export function ChatOptions({ bot, yolo }: ChatOptionsProps): ReactElement {
  useLocale()

  const panelId = useId()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return undefined
    }

    const doc = button.current?.ownerDocument

    const onPointer = (event: Event): void => {
      const node = event.target as Node | null

      if (node && (panel.current?.contains(node) || button.current?.contains(node))) {
        return
      }

      setOpen(false)
    }

    // Escape from anywhere on the page, not only from inside the panel: Safari does not focus a radio or a
    // checkbox that is clicked, so after a click focus can be on the body and the panel never hears the key.
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }

      const active = doc?.activeElement
      const lost = !active || active === doc?.body || Boolean(panel.current?.contains(active))

      event.preventDefault()
      setOpen(false)

      if (lost || active === button.current) {
        button.current?.focus()
      }
    }

    doc?.addEventListener('pointerdown', onPointer, true)
    doc?.addEventListener('keydown', onKey)

    return () => {
      doc?.removeEventListener('pointerdown', onPointer, true)
      doc?.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="hm-chat-options">
      <button
        ref={button}
        type="button"
        className="hm-chat-options__button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onPointerEnter={preloadPanel}
        onFocus={preloadPanel}
        onClick={() => setOpen(current => !current)}
      >
        <svg aria-hidden="true" focusable="false" width={18} height={18} viewBox="0 0 24 24" fill="none">
          <path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth={2} />
          <circle cx="10" cy="17" r="2" stroke="currentColor" strokeWidth={2} />
        </svg>
        <span>{strings.chat.options.title}</span>
      </button>

      {/* The element the button controls is here while it is open, before the panel's chunk has arrived. */}
      {open ? (
        <div className="hm-chat-options__host" id={panelId}>
          <Suspense fallback={null}>
            <ChatOptionsPanel bot={bot} name={`${panelId}-verbosity`} panelRef={panel} yolo={yolo} />
          </Suspense>
        </div>
      ) : null}
    </div>
  )
}
