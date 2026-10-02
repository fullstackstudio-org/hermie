/**
 * The bottom of the chat list: who you are signed in as, and — where the list
 * owns the four destinations — the tab strip under it.
 *
 * The strip is drawn only when somebody hands in `onOpenSection`, which on the
 * compact shell nobody does any more: the four destinations are a real tab
 * navigator there and the shell draws one bar under every tab root. The strip
 * itself lives in `ui/chrome/TabBar.tsx` with the bar it is the other half of.
 *
 * The compose button the mockup does not have is deliberate — there is one
 * canonical chat per bot and you never create a conversation (ADR-0007), so the
 * place a compose button would take is occupied by the one thing you DO create
 * from this screen, a cron.
 *
 * A gateway card used to sit under the strip on the wide layout, carrying the
 * host and the connection state. It is gone: the state it showed is the global
 * connection, which now speaks from ONE component on every layout
 * (`ConnectionLine`, under the title) and says nothing at all while the
 * connection is healthy. The host belongs in Settings → Gateway, where it is
 * looked up rather than glanced at.
 *
 * What came back above the strip is something else, and it is a PERSON rather
 * than a connection: who the gateway says this is, with a way out
 * ([ADR-0025](../../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
 * `SidebarIdentity` draws itself or nothing, so a gateway with no accounts —
 * and every screen that has no gateway in scope at all — is unchanged.
 */
import { View } from 'react-native'

import { strings } from '../../i18n/strings'
import { TabStrip } from '../../ui/chrome'
import { type IconName } from '../../ui/Icon'
import { SidebarIdentity } from './SidebarIdentity'

export type BotsSection = 'activity' | 'cron' | 'settings'

/** `chats` is where the strip already is; the other three open a destination. */
export type TabKey = 'chats' | BotsSection

/**
 * Four drawn icons at one size, which four Unicode glyphs could not be.
 *
 * The strip used to carry a filled circle, a pair of exchange arrows, a clock and
 * a gear as CHARACTERS, and the owner reported the obvious consequence: chats and
 * crons drew visibly smaller than activity and settings. Nothing was wrong with
 * the `fontSize` — the four characters come from four different fonts that
 * disagree about how much of the em box a mark should fill, and no font metric
 * reconciles that. There was a second cost in the same place: one of them needed
 * a trailing U+FE0E to stop iOS drawing it as a colourful emoji sticker in the
 * middle of a monochrome strip. `src/ui/Icon.tsx` carries the full reasoning.
 *
 * Exported so a test can walk the same four entries the strip renders, rather
 * than repeating the list and then agreeing with itself.
 */
/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
export const tabs = (): { key: TabKey; label: string; icon: IconName }[] => [
  { key: 'chats', label: strings.tabs.chats, icon: 'chats' },
  { key: 'activity', label: strings.tabs.activity, icon: 'activity' },
  { key: 'cron', label: strings.tabs.routines, icon: 'crons' },
  { key: 'settings', label: strings.tabs.settings, icon: 'settings' }
]

export function SidebarFooter({
  current = 'chats',
  onOpenSection,
  onSignOut
}: {
  current?: TabKey
  /**
   * Where a tab goes. ABSENT on the compact shell, and that absence is the
   * whole of "BotsScreen stops rendering the strip": the four destinations are
   * a real tab navigator there and the shell draws one bar under every tab
   * root, so a second strip inside the list would be the same four places
   * twice. The identity row above it stays, because who you are signed in as
   * is a property of this list rather than of the tabs.
   */
  onOpenSection?: ((section: BotsSection) => void) | undefined
  /** Passed through to the identity row; absent means it draws no way out. */
  onSignOut?: (() => void) | undefined
}) {
  return (
    <View>
      <SidebarIdentity onSignOut={onSignOut} />
      {onOpenSection ? (
        <TabStrip
          current={current}
          items={tabs()}
          // `chats` is where the strip already is, so it opens nothing.
          onSelect={key => (key === 'chats' ? undefined : onOpenSection(key as BotsSection))}
        />
      ) : null}
    </View>
  )
}
