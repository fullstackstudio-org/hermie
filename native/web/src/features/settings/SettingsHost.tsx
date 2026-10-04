/**
 * Settings, as the main pane draws it for `#/settings` and `#/settings/<section>`: the home (a link to
 * each section with what is in it), or one section under a way back to the home.
 *
 * This module is the Settings chunk. The entry fetches it when a settings route is opened, or earlier,
 * when a pointer or the focus reaches the link to Settings (`load.ts`); every section is a chunk of its
 * own inside it, fetched when it is opened or when its link on the home is pointed at or focused. So the
 * first load carries none of it, and a reader who opens Appearance does not fetch the chat list's
 * drag and drop.
 *
 * An unknown section (`#/settings/nothing`) is the home: the address is rewritten to `#/settings` in
 * place, as the router does for a route that does not exist, rather than a page that says "no such page".
 *
 * The main pane's heading is "Settings" on every one of these routes (the layout's `h1`); a section's
 * own title is its `h2`.
 *
 * On a gateway without sign-in (`SettingsRuntime.gated` false) the sections that belong to a person,
 * Passkeys and MCP, say in one sentence that they need sign-in, and their chunks are not fetched: there
 * is nobody to read them for.
 */
import { lazy, type ReactElement, Suspense, useEffect } from 'react'

import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import type { HashRouter } from '../../platform/hash-router'
import { Icon } from '../../ui/icons'
import { formatRoute } from '../shell/router'
import {
  isSettingsSection,
  listedSections,
  preloadSection,
  SECTION_LOADERS,
  sectionBlurb,
  sectionTitle
} from './sections'
import type { SettingsSection } from './sections'
import { SettingsPage } from './controls'
import { useSettingsRuntime } from './settings-runtime'
import './settings.css'

const Account = lazy(() => SECTION_LOADERS.account().then(module => ({ default: module.Account })))
const Gateway = lazy(() => SECTION_LOADERS.gateway().then(module => ({ default: module.Gateway })))
const Passkeys = lazy(() => SECTION_LOADERS.passkeys().then(module => ({ default: module.Passkeys })))
const Mcp = lazy(() => SECTION_LOADERS.mcp().then(module => ({ default: module.Mcp })))
const Memory = lazy(() => SECTION_LOADERS.memory().then(module => ({ default: module.Memory })))
const Chats = lazy(() => SECTION_LOADERS.chats().then(module => ({ default: module.Chats })))
const Notifications = lazy(() => SECTION_LOADERS.notifications().then(module => ({ default: module.Notifications })))
const Arrangement = lazy(() => SECTION_LOADERS['chat-list']().then(module => ({ default: module.Arrangement })))
const Appearance = lazy(() => SECTION_LOADERS.appearance().then(module => ({ default: module.Appearance })))
const Voice = lazy(() => SECTION_LOADERS.voice().then(module => ({ default: module.Voice })))
const About = lazy(() => SECTION_LOADERS.about().then(module => ({ default: module.About })))

const sectionHref = (section: SettingsSection): string => formatRoute({ name: 'settings', section })

function Home(): ReactElement {
  return (
    <ul className="hm-settings-home">
      {listedSections().map(section => {
        const blurb = `hm-settings-blurb-${section}`

        return (
          <li key={section} className="hm-settings-home__item">
            <a
              className="hm-settings-home__link"
              href={sectionHref(section)}
              aria-describedby={blurb}
              onPointerEnter={() => preloadSection(section)}
              onFocus={() => preloadSection(section)}
            >
              {sectionTitle(section)}
              <Icon name="chevronRight" size={18} />
            </a>
            <p className="hm-settings-home__blurb" id={blurb}>
              {sectionBlurb(section)}
            </p>
          </li>
        )
      })}
    </ul>
  )
}

/** A person's section on a gateway without sign-in: what it would need, and nothing to act on. */
function NeedsSignIn({ section }: { section: 'passkeys' | 'mcp' }): ReactElement {
  return (
    <SettingsPage
      title={sectionTitle(section)}
      lead={section === 'passkeys' ? sheetStrings.passkeys.settings.needsSignIn : sheetStrings.mcp.settings.needsSignIn}
    >
      {null}
    </SettingsPage>
  )
}

function Page({ section, gated }: { section: SettingsSection; gated: boolean }): ReactElement {
  if (!gated && (section === 'passkeys' || section === 'mcp')) {
    return <NeedsSignIn section={section} />
  }

  switch (section) {
    case 'account':
      return <Account />
    case 'gateway':
      return <Gateway />
    case 'passkeys':
      return <Passkeys />
    case 'mcp':
      return <Mcp />
    case 'memory':
      return <Memory />
    case 'chats':
      return <Chats />
    case 'notifications':
      return <Notifications />
    case 'chat-list':
      return <Arrangement />
    case 'appearance':
      return <Appearance />
    case 'voice':
      return <Voice />
    case 'about':
      return <About />
  }
}

export interface SettingsHostProps {
  /** The route's section, if it names one. */
  section?: string | undefined
  router: HashRouter
}

export function SettingsHost({ section, router }: SettingsHostProps): ReactElement {
  useLocale()

  // A shell rendered without a runtime (a test of the frame) is taken as gated: it draws what it can.
  const gated = useSettingsRuntime()?.gated ?? true
  const known = isSettingsSection(section)
  const unknown = section !== undefined && !known

  useEffect(() => {
    if (unknown) {
      router.replace('#/settings')
    }
  }, [unknown, router])

  if (!known) {
    return (
      <div className="hm-settings">
        <Home />
      </div>
    )
  }

  return (
    <div className="hm-settings">
      <a className="hm-settings__back" href="#/settings">
        <Icon name="chevronLeft" size={18} />
        {strings.app.settings.licencesBack}
      </a>
      <Suspense fallback={<div className="hm-settings__loading" aria-busy="true" />}>
        <Page section={section} gated={gated} />
      </Suspense>
    </div>
  )
}
