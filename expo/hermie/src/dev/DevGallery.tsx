/**
 * One gallery section, as the whole app.
 *
 * `--hermieOpen gallery:<id>` lands here, BEFORE the gateway phase is decided —
 * the component kit takes no gateway and no onboarding, so a screenshot of a
 * sheet should not first require a configured connection and a copied keychain.
 * That is most of the value: it makes every component photographable on a clean
 * simulator with one command.
 *
 * The framing is the compact shell's: the wallpaper, and one full-bleed glass
 * panel over it. Full-bleed rather than floating even on a wide window, because
 * the panel is not what is under inspection here and the extra 28pt of width is.
 *
 * `gallery:chat` is the exception, and it is the one that needed fixing. A whole
 * chat screen IS its layout, and on a wide window the real layout is two floating
 * panels with the chat in the right-hand one (`RegularShell`) — so photographed
 * full-bleed it was a screenshot of a phone chat stretched to 1376pt, which is a
 * shape the app never shows anybody. On a wide window it now gets the real shell:
 * the same gaps, the same sidebar width, the same panels.
 *
 * The sidebar there is the REAL `BotsScreen`, over a seeded roster. A fixture
 * copy of the list would be a second chat list to keep in step with the first,
 * and the point of the exercise is that the screenshot shows what the app shows.
 *
 * The panel owns the safe-area inset. `Screen` deliberately does not add one
 * inside a `GlassSurface` (docs/platform-notes.md, 2026-09-20: it was painting
 * the wallpaper over the panel and insetting twice), and in the real app the
 * inset comes from the navigator above or from `RegularShell`'s window padding.
 * Here there is neither, so without this a section's own header sits under the
 * clock — which is what the first cron-detail screenshot showed.
 */
import { useEffect } from 'react'
import { useWindowDimensions, View } from 'react-native'

import { Shell } from '../app/Shell'
import { BotsScreen } from '../features/bots'
import { GalleryScreen, GALLERY_CHAT_SECTION } from '../features/settings/GalleryScreen'
import { isMarkdownFixture, MarkdownFixtureSection } from './markdown-fixtures'
import { useSafeAreaInsets } from '../platform/safe-area'
import { useBotsStore, type Bot } from '../store/bots'
import { useChatLayoutStore } from '../store/chat-layout'
import { GlassSurface, Wallpaper } from '../ui/glass'
import { REGULAR_LAYOUT_MIN_WIDTH, sidebarWidth, WINDOW_GAP } from '../ui/tokens'

/**
 * The roster the wide chat frame's sidebar shows.
 *
 * The fake gateway's two bots plus the two the chat fixtures mention, so the
 * list has enough rows to read as a list and every name in the transcript
 * resolves to somebody. Fixture data only — the same rule the committed
 * screenshots follow (CONTRIBUTING.md).
 */
const FIXTURE_ROSTER: Bot[] = [
  {
    name: 'researcher',
    displayName: 'Researcher',
    description: 'Digs through sources and reports back',
    model: 'example-model-local',
    provider: 'example',
    isDefault: true,
    hasAvatar: false,
    canonical: {
      id: 'session-researcher',
      resolvedId: 'session-researcher',
      preview: 'Latency for the two re-runs, if you want it.',
      lastActive: Math.floor(Date.now() / 1000) - 120,
      messageCount: 24
    },
    uiMetaRevision: 0
  },
  {
    name: 'writer',
    displayName: 'Writer',
    description: 'Turns notes into prose',
    model: 'example-model-local',
    provider: 'example',
    isDefault: false,
    hasAvatar: false,
    canonical: {
      id: 'session-writer',
      resolvedId: 'session-writer',
      preview: 'Draft is ready for your read-through.',
      lastActive: Math.floor(Date.now() / 1000) - 2_400,
      messageCount: 11
    },
    uiMetaRevision: 0
  },
  {
    name: 'bookkeeper',
    displayName: 'Bookkeeper',
    description: 'Reconciles the ledger',
    model: 'example-model-local',
    provider: 'example',
    isDefault: false,
    hasAvatar: false,
    canonical: {
      id: 'session-bookkeeper',
      resolvedId: 'session-bookkeeper',
      preview: 'Approval needed before I move three invoices.',
      lastActive: Math.floor(Date.now() / 1000) - 90_000,
      messageCount: 6
    },
    uiMetaRevision: 0
  },
  {
    name: 'postman',
    displayName: 'Postman',
    description: 'Delivers between the others',
    model: 'example-model-local',
    provider: 'example',
    isDefault: false,
    hasAvatar: false,
    uiMetaRevision: 0
  }
]

/**
 * The chat list, alone, over the fixture roster — the screen the README's first
 * image is.
 *
 * It is the REAL `BotsScreen`, not a drawing of one, for the same reason the wide
 * frame's sidebar is: a fixture copy would be a second chat list to keep in step
 * with the first, and the whole point of photographing it is that the picture
 * shows what the app shows.
 */
export const GALLERY_LIST_SECTION = 'list'

/**
 * The whole wide shell, over the fixture roster and with no gateway.
 *
 * `gallery:chat`'s wide frame is a MIMIC of `RegularShell` — two panels assembled
 * by hand here — and a mimic can only ever be photographed in the states somebody
 * remembered to build into it. It has already lied once: it mounted `BotsScreen`
 * without `onOpenSection`, so it drew a sidebar with no tab strip and the missing
 * strip was reported as a portrait bug in the real shell, which has one at every
 * height (docs/platform-notes.md, 2026-09-20).
 *
 * This section mounts the real thing instead, so the collapse, the rail, the
 * temporary list overlay and the header's sidebar button can be looked at on a
 * device without a gateway, a keychain or a sign-in. The mimic stays where it is:
 * it exists to frame ONE gallery section in the shell's proportions, which is a
 * different job.
 */
export const GALLERY_SHELL_SECTION = 'shell'

/**
 * The diagram and formula fixtures, which are this file's third special case.
 *
 * They live in `markdown-fixtures.tsx` and are reachable by name only —
 * `--hermieOpen gallery:dev-mermaid-pie` and the rest. That module's own comment
 * says why they are not rows in the gallery's registry and what it costs.
 */
export { MARKDOWN_FIXTURE_IDS } from './markdown-fixtures'

/**
 * Enough state for the list to show what a list does.
 *
 * A roster alone draws four idle rows, which is a truthful picture of nothing in
 * particular: no section headings, every bead the same, no unread anywhere. This
 * seeds the three things the list exists to say — an arrangement, a presence and
 * an unread — and it seeds them as the stores' own values rather than as props, so
 * the rows resolve them through exactly the code the app runs.
 */
function seedFixtureState(): void {
  const bots = useBotsStore.getState()

  if (bots.bots.length === 0) {
    bots.setBots(FIXTURE_ROSTER, { fromCache: true })
  }

  // Writer is mid-turn; the other three are not. `running` is keyed by name here
  // because there is no gateway to attribute a session id to one.
  useBotsStore.getState().setRunning(['writer'])

  // Researcher has been read, so the unread marks that remain say something.
  useBotsStore.getState().markSeen('researcher', Math.floor(Date.now() / 1000))

  const layout = useChatLayoutStore.getState()

  if (!layout.entries.some(entry => entry.kind === 'folder')) {
    layout.reconcile(FIXTURE_ROSTER.map(bot => bot.name))
    layout.addFolderAround('bookkeeper', 'Money')
    layout.setAccent('bookkeeper', 'teal')
    layout.setAccent('writer', 'violet')
  }
}

export function DevGallery({ section }: { section: string }) {
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()

  // Only the chat demo is about its layout, and only a wide window has a second
  // layout to be wrong about.
  const wideChat = section === GALLERY_CHAT_SECTION && width >= REGULAR_LAYOUT_MIN_WIDTH
  const list = section === GALLERY_LIST_SECTION
  const shell = section === GALLERY_SHELL_SECTION
  const markdown = isMarkdownFixture(section)

  useEffect(() => {
    if (wideChat || list || shell) {
      seedFixtureState()
    }
  }, [list, shell, wideChat])

  // The real shell, whichever of its two layouts this window is. It draws its own
  // wallpaper and its own window padding, so there is nothing to wrap it in.
  if (shell) {
    return <Shell />
  }

  // A diagram or a formula, in a real bubble. The framing is the fall-through
  // case's — the wallpaper, one full-bleed panel, and the panel owning the
  // safe-area inset for the reason the file's own comment gives — so a screenshot
  // of one of these sits in the app's own chrome rather than in a bespoke frame.
  if (markdown) {
    return (
      <Wallpaper style={{ flex: 1 }} testID="wallpaper">
        <GlassSurface contentStyle={{ flex: 1 }} radius={0} shadow="none" style={{ flex: 1 }} variant="panel">
          <View style={{ flex: 1, paddingBottom: insets.bottom, paddingTop: insets.top }}>
            <MarkdownFixtureSection section={section} />
          </View>
        </GlassSurface>
      </Wallpaper>
    )
  }

  if (list) {
    return (
      <Wallpaper style={{ flex: 1 }} testID="wallpaper">
        <GlassSurface contentStyle={{ flex: 1 }} radius={0} shadow="none" style={{ flex: 1 }} variant="panel">
          <BotsScreen onOpenSection={() => undefined} />
        </GlassSurface>
      </Wallpaper>
    )
  }

  if (wideChat) {
    return (
      <Wallpaper style={{ flex: 1 }} testID="wallpaper">
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            gap: WINDOW_GAP,
            paddingBottom: WINDOW_GAP + insets.bottom,
            paddingLeft: WINDOW_GAP + insets.left,
            paddingRight: WINDOW_GAP + insets.right,
            paddingTop: WINDOW_GAP + insets.top
          }}
          testID="shell-window"
        >
          <GlassSurface
            contentStyle={{ flex: 1 }}
            style={{ width: sidebarWidth(width) }}
            testID="shell-sidebar"
            variant="panel"
          >
            {/*
              `onOpenSection` is what mounts the tab strip, and the strip is the
              whole footer of the sidebar on every layout (§6.8). Without the
              prop this mimic drew a sidebar that simply ended, and the missing
              strip was read as a portrait bug in the real shell — which has one
              at every height. The handler is a no-op on purpose: there is
              nothing behind the gallery to open, and a strip that navigated
              would be a second lie about the layout.
            */}
            <BotsScreen onOpenSection={() => undefined} selectedBot="researcher" variant="sidebar" />
          </GlassSurface>

          <View style={{ flex: 1, minWidth: 0 }} testID="shell-content">
            <GlassSurface contentStyle={{ flex: 1 }} style={{ flex: 1 }} variant="panel">
              <GalleryScreen section={section} />
            </GlassSurface>
          </View>
        </View>
      </Wallpaper>
    )
  }

  return (
    <Wallpaper style={{ flex: 1 }} testID="wallpaper">
      <GlassSurface contentStyle={{ flex: 1 }} radius={0} shadow="none" style={{ flex: 1 }} variant="panel">
        <View style={{ flex: 1, paddingBottom: insets.bottom, paddingTop: insets.top }}>
          <GalleryScreen section={section} />
        </View>
      </GlassSurface>
    </Wallpaper>
  )
}
