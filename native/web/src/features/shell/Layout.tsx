/**
 * The frame of the app: a skip link, the connection line, the sidebar (a
 * `nav`) and the main pane (a `main`).
 *
 * **Two panes from 900 px, one below.** That is the stylesheet's job
 * (`shell.css`), keyed on `data-pane` here: on a wide window both panes are
 * always shown; on a narrow one the list route shows the sidebar and every other
 * route shows the main pane, with a back link to the list above its heading. No
 * script measures anything, so there is no frame in which the layout is
 * wrong, and a hidden pane is `display: none`, which keeps it out of the tab
 * order and the accessibility tree.
 *
 * **Focus follows the route.** When the route changes (not on first load),
 * focus moves to the main pane's heading, so a screen-reader or keyboard reader
 * is told where they are. On the narrow list route the main pane is not shown, so
 * the heading cannot take focus and the sidebar's own heading does instead.
 *
 * **Who scrolls.** The main pane does, except on a chat route (`data-screen="chat"`
 * on the `main`): there the transcript is the one scroller and the pane around it
 * holds still (`features/chat/chat.css`), because two nested scrollports would
 * move the rows under the transcript's own anchoring.
 *
 * **The skip link** is the first thing a Tab reaches. It points at `#main` (an
 * accessibility checker wants a skip link to name a real element), but the
 * router reads the fragment as a route, so a click never reaches the address: it
 * is handled here and focus is moved by hand. Opened in a tab of its own, `#main`
 * is an unknown route and becomes `#/`, which is harmless.
 */
import { type ReactElement, type ReactNode, useEffect, useRef } from 'react'

import { strings } from '../../generated/strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { Icon } from '../../ui/icons'
import { formatRoute, HOME_HASH, type Route } from './router'
import './shell.css'

export interface LayoutProps {
  route: Route
  /** The connection line, drawn above both panes (it draws nothing while connected). */
  status: ReactNode
  /** The sidebar's body, under its heading. */
  sidebar: ReactNode
  /** The sidebar's footer: who is signed in, sign out, the version. */
  footer: ReactNode
  /** The main pane's heading. */
  heading: string
  /**
   * What a click on the heading does, when it is a way in (a chat's bot name opens the bot's profile). It is for
   * a pointer only, so it is not a control: the keyboard and a screen reader have a link of their own in the
   * chat's header, and a second link named like the heading would be told apart from the row's by nothing.
   */
  headingAction?: { onActivate: () => void; title: string }
  /** The main pane's body. */
  children: ReactNode
}

/** The main pane's id, which the skip link names. */
const MAIN_ID = 'main'

/** Focus the first element that takes it; one inside a hidden pane cannot. */
function focusFirst(candidates: readonly (HTMLElement | null)[]): void {
  for (const element of candidates) {
    if (!element) {
      continue
    }

    element.focus({ preventScroll: true })

    // Not `:focus`: that does not match in a window the browser has not focused, which is no reason to look further.
    if (element.ownerDocument.activeElement === element) {
      return
    }
  }
}

export function Layout({
  route,
  status,
  sidebar,
  footer,
  heading,
  headingAction,
  children
}: LayoutProps): ReactElement {
  useLocale()

  const mainHeading = useRef<HTMLHeadingElement>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)
  const href = formatRoute(route)
  // Compared as text so a re-render of the same route never moves focus.
  const previous = useRef(href)

  useEffect(() => {
    if (previous.current === href) {
      return
    }

    previous.current = href
    focusFirst([mainHeading.current, listHeading.current])
  }, [href])

  return (
    <div className="hm-app" data-pane={route.name === 'home' ? 'list' : 'detail'}>
      <a
        className="hm-skip"
        href={`#${MAIN_ID}`}
        onClick={event => {
          event.preventDefault()
          focusFirst([mainHeading.current, listHeading.current])
        }}
      >
        {webStrings.shell.skipToContent}
      </a>

      {status}

      <div className="hm-panes">
        <div className="hm-sidebar">
          <nav aria-label={strings.app.bots.title} className="hm-sidebar__nav">
            <h2 className="hm-sidebar__title" ref={listHeading} tabIndex={-1}>
              {strings.app.bots.title}
            </h2>
            {sidebar}
          </nav>
          <footer className="hm-sidebar__footer">{footer}</footer>
        </div>

        <main className="hm-main" id={MAIN_ID} data-screen={route.name}>
          <a className="hm-back" href={HOME_HASH}>
            <Icon name="chevronLeft" size={20} />
            {webStrings.shell.backToChats}
          </a>
          <h1
            className="hm-main__title"
            ref={mainHeading}
            tabIndex={-1}
            {...(headingAction
              ? {
                  title: headingAction.title,
                  'data-action': 'true',
                  onClick: () => {
                    // Selecting the name to copy it is not asking for the profile.
                    if (mainHeading.current?.ownerDocument.defaultView?.getSelection()?.isCollapsed !== false) {
                      headingAction.onActivate()
                    }
                  }
                }
              : {})}
          >
            {/* A bot's name is the heading on its chat: isolated, so its own direction cannot reorder the line. */}
            <bdi>{heading}</bdi>
          </h1>
          {children}
        </main>
      </div>
    </div>
  )
}
