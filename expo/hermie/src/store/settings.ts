/**
 * Display preferences for chats.
 *
 * Verbosity, the bot-to-bot toggle and the thinking toggle are read-time
 * decisions in `@hermie/transcript` — nothing here changes what is stored, only
 * what is shown — so they live in a plain preference store and are safe to flip
 * mid-turn.
 *
 * There is one global default and an optional per-chat override. A chat without
 * an override follows the default as the default moves; an override pins that
 * chat until it is reset. Both are persisted through the `KeyValueStore`.
 *
 * The appearance preference lives in this store and in a key of its own. One
 * store, because a second one would mean a second first-paint flash; two keys,
 * because everything else here belongs to a gateway account and light-or-dark
 * belongs to the device. Both are read in the same pass, so the flash the
 * single blob was avoiding is still avoided.
 */
import type { Verbosity } from '@hermie/transcript'
import { create } from 'zustand'

import type { GatewayNamespace } from '../gateway/namespace'
import { keyValueStore } from '../platform/key-value-store'
import { asNameOrder, DEFAULT_NAME_ORDER, type NameOrder } from './bot-names'
import { asTextSize, DEFAULT_TEXT_SIZE, type TextSize } from './text-size'
import {
  DEFAULT_THEME_CHOICE,
  isThemePresetName,
  THEME_PRESETS,
  type ThemeChoice,
  type ThemePresetName,
  type UserTheme,
  type UserThemeFace
} from '../ui/themes'

/** `system` follows the OS; the other two pin the app regardless of it. */
export type Appearance = 'system' | 'light' | 'dark'

export const DEFAULT_APPEARANCE: Appearance = 'system'

export interface ChatViewSettings {
  level: Verbosity
  showBotToBot: boolean
  showThinking: boolean
}

/** The defaults: Quiet, bot-to-bot traffic visible, thinking folded away. Quiet is what a
 * messenger looks like; the tool cards are one tap away in the chat options. */
export const DEFAULT_CHAT_VIEW: ChatViewSettings = {
  level: 'quiet',
  showBotToBot: true,
  showThinking: false
}

/**
 * The per-account half, keyed by gateway.
 *
 * Everything under it either follows the account through ADR-0016's
 * `hermie-app:<user_id>` — the defaults, the name order, the theme — or is
 * keyed by bot name, which is a gateway's own namespace. `perChat` is the one
 * that decides it: two gateways can both have a `researcher`, and one of them
 * pinning that chat to Verbose must not turn the other one verbose too.
 */
export const CHAT_VIEW_KEY = 'hermie.chat.view'

/**
 * Light or dark, on this device, whatever gateway is live.
 *
 * The one field pulled OUT of the blob above, because it is the one that is not
 * about an account at all: it is about the eyes in front of the screen and the
 * room they are in. A reader whose phone went light because they switched to
 * their work gateway would have found a bug, not a feature.
 */
export const APPEARANCE_KEY = 'hermie.appearance'

/**
 * Whether a named bot's handle is hidden everywhere it would otherwise show
 * beside the display name (HERM-110).
 *
 * Device-local and defaulted ON, and it lives beside `appearance` rather than
 * in the per-account half for the same reason: it is a statement about how
 * THIS READER wants a name they cannot see the gateway's copy of to be drawn,
 * not something a second device signed into the same account should inherit.
 */
export const DEFAULT_HIDE_HANDLE_WHEN_NAMED = true

interface PersistedAppearance {
  appearance?: Appearance
  hideHandleWhenNamed?: boolean
}

interface PersistedChatView {
  defaults: ChatViewSettings
  perChat: Record<string, Partial<ChatViewSettings>>
  botNameOrder?: NameOrder
  themeChoice?: ThemeChoice
  userThemes?: UserTheme[]
  textSize?: TextSize
  /** What Part 2 wrote before a theme was a theme. Read, never written. */
  wallpaper?: string
}

const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark']

const asAppearance = (value: unknown): Appearance | undefined =>
  typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value) ? (value as Appearance) : undefined

const asHideHandleWhenNamed = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/**
 * What a wallpaper name from an older build becomes.
 *
 * `warm` had no successor and falls back to Blue. `slate` becomes Graphite, which
 * is the same composition it was: a matte floor whose panels sit a step above it,
 * neutral now rather than grey-blue. Anything unrecognised is ignored, which
 * leaves the default.
 */
const RETIRED_WALLPAPERS: Record<string, ThemePresetName> = {
  blue: 'blue',
  warm: 'blue',
  graphite: 'graphite',
  slate: 'graphite'
}

const asFace = (value: unknown): UserThemeFace | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  const raw = value as Record<string, unknown>
  const hex = (input: unknown): string | undefined =>
    typeof input === 'string' && /^#[0-9a-f]{6}$/iu.test(input) ? input : undefined

  const face: UserThemeFace = {
    ...(hex(raw.background) ? { background: hex(raw.background) as string } : {}),
    ...(hex(raw.accentFill) ? { accentFill: hex(raw.accentFill) as string } : {}),
    ...(hex(raw.accentBubble) ? { accentBubble: hex(raw.accentBubble) as string } : {})
  }

  return Object.keys(face).length ? face : undefined
}

/** Read the reader's own themes defensively: they arrive from disk AND from a gateway. */
export function asUserThemes(value: unknown): UserTheme[] {
  const out: UserTheme[] = []
  const seen = new Set<string>()

  for (const entry of Array.isArray(value) ? value : []) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const raw = entry as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : ''

    // An id is how a choice points at a theme, so a row without one — or a
    // duplicate, which would make the pointer ambiguous — is not a theme.
    if (!id || seen.has(id) || !isThemePresetName(raw.base)) {
      continue
    }

    seen.add(id)

    const light = asFace(raw.light)
    const dark = asFace(raw.dark)

    out.push({
      id,
      name: typeof raw.name === 'string' ? raw.name : '',
      base: raw.base,
      ...(light ? { light } : {}),
      ...(dark ? { dark } : {})
    })
  }

  return out
}

/** Read a stored theme choice, folding the retired wallpaper names into it. */
export function asThemeChoice(value: unknown, legacyWallpaper?: unknown): ThemeChoice | undefined {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>

    if (raw.kind === 'preset' && isThemePresetName(raw.name)) {
      return { kind: 'preset', name: raw.name }
    }

    if (raw.kind === 'user' && typeof raw.id === 'string' && raw.id) {
      return { kind: 'user', id: raw.id }
    }
  }

  if (typeof legacyWallpaper === 'string' && RETIRED_WALLPAPERS[legacyWallpaper]) {
    return { kind: 'preset', name: RETIRED_WALLPAPERS[legacyWallpaper] as ThemePresetName }
  }

  return undefined
}

const VERBOSITY: readonly Verbosity[] = ['quiet', 'normal', 'verbose']

const asVerbosity = (value: unknown): Verbosity | undefined =>
  typeof value === 'string' && (VERBOSITY as readonly string[]).includes(value) ? (value as Verbosity) : undefined

/** Read a stored blob defensively: an older build may have written anything. */
function asPatch(value: unknown): Partial<ChatViewSettings> {
  if (!value || typeof value !== 'object') {
    return {}
  }

  const raw = value as Record<string, unknown>
  const level = asVerbosity(raw.level)

  return {
    ...(level ? { level } : {}),
    ...(typeof raw.showBotToBot === 'boolean' ? { showBotToBot: raw.showBotToBot } : {}),
    ...(typeof raw.showThinking === 'boolean' ? { showThinking: raw.showThinking } : {})
  }
}

export interface SettingsState {
  defaults: ChatViewSettings
  perChat: Record<string, Partial<ChatViewSettings>>
  appearance: Appearance
  /**
   * Which of a bot's two names is the large one. See `store/bot-names.ts`.
   *
   * App-wide rather than per chat, and deliberately so: it is a statement about
   * how this reader thinks about their bots, and a list where four rows lead
   * with a handle and two with a label is a list that has to be read twice.
   */
  botNameOrder: NameOrder
  /**
   * Hide a named bot's handle everywhere it would otherwise show beside the
   * display name. See `DEFAULT_HIDE_HANDLE_WHEN_NAMED` and `store/bot-names.ts`.
   */
  hideHandleWhenNamed: boolean
  /** Which theme the glass floats over: a preset, or one of the reader's own. */
  themeChoice: ThemeChoice
  /** Themes the reader made. App-wide, and ADR-0016's `hermie-app` carries them. */
  userThemes: UserTheme[]
  /**
   * How big the words in a transcript are (`store/text-size.ts`).
   *
   * One setting for the whole account rather than one per chat, and the same
   * argument `botNameOrder` makes: it is a statement about this reader's eyes,
   * and eyes do not change between conversations. It is reachable from two
   * places — Settings › Appearance and the chat's own popover — because the
   * moment a reader notices they want it is while they are reading, and a
   * setting they have to go and look for is one they turn up once and never
   * adjust again.
   */
  textSize: TextSize
  /** False until the first disk read finishes; screens paint the defaults meanwhile. */
  loaded: boolean
  /**
   * The same, for the appearance alone.
   *
   * Its own flag because its read happens at a different moment and above a
   * different provider: `ThemeProvider` sits over the whole app, including the
   * lock and the wizard, and has no gateway to key anything by. One flag for
   * both would leave it either waiting for a gateway that may never be
   * configured or re-reading on every render.
   */
  appearanceLoaded: boolean
  /** The gateway the per-account half belongs to; null before the first read. */
  namespace: GatewayNamespace | null
  hydrate: (ns: GatewayNamespace) => Promise<void>
  /** Read the device-level appearance. No gateway needed; see `appearanceLoaded`. */
  hydrateAppearance: () => Promise<void>
  setDefaults: (patch: Partial<ChatViewSettings>) => void
  setChatView: (botName: string, patch: Partial<ChatViewSettings>) => void
  resetChatView: (botName: string) => void
  setAppearance: (appearance: Appearance) => void
  setHideHandleWhenNamed: (hideHandleWhenNamed: boolean) => void
  setBotNameOrder: (order: NameOrder) => void
  setTextSize: (size: TextSize) => void
  setThemeChoice: (choice: ThemeChoice) => void
  /** Copy a preset into a theme of the reader's own, and return its id. */
  createUserTheme: (base: ThemePresetName, name: string) => string
  renameUserTheme: (id: string, name: string) => void
  /** Patch one scheme's face. A colour of `null` goes back to following the preset. */
  editUserTheme: (id: string, scheme: 'light' | 'dark', patch: Record<string, string | null>) => void
  deleteUserTheme: (id: string) => void
  /**
   * Replace the app-wide half wholesale, with the gateway's copy.
   *
   * ADR-0016's reconcile hands that copy straight in. It is written to DISK like
   * any other change — the device's own store is what the UI paints from, and a
   * theme that only ever lived in memory was a theme the next launch showed the
   * old one of, offline for as long as the socket stayed down. What it is
   * deliberately not is a write back to the GATEWAY: the bridge is deaf while
   * this runs, so the arriving value is not read back as a local change and sent
   * home again.
   */
  applyAppSettings: (patch: {
    defaults?: ChatViewSettings
    botNameOrder?: NameOrder
    themeChoice?: ThemeChoice
    userThemes?: UserTheme[]
    textSize?: TextSize
  }) => void
  reset: () => void
}

let writeQueue: Promise<void> = Promise.resolve()

/** Serialise the writes: two toggles flipped in the same tick must not race. */
function persist(ns: GatewayNamespace, state: PersistedChatView): void {
  writeQueue = writeQueue
    .then(() => keyValueStore.setJson(ns.key(CHAT_VIEW_KEY), state))
    .catch(() => {
      // A preference that failed to persist is a preference that resets on the
      // next launch, which is not worth surfacing as an error.
    })
}

/**
 * Both device-level fields under `APPEARANCE_KEY`, written together.
 *
 * One key, two fields that change independently — `setAppearance` and
 * `setHideHandleWhenNamed` both call this with the CURRENT value of the field
 * they did not just change, so neither write clobbers the other's.
 */
function persistAppearance(blob: PersistedAppearance): void {
  writeQueue = writeQueue
    .then(() => keyValueStore.setJson(APPEARANCE_KEY, blob))
    .catch(() => {
      // A preference that failed to persist is a preference that resets on the
      // next launch, which is not worth surfacing as an error.
    })
}

/**
 * A user theme's id, unique enough for a set of themes one person made.
 *
 * It has to survive travelling to a second device through `hermie-app`, so it is
 * a value rather than an index: two phones both appending a theme would otherwise
 * both call it number three.
 */
let themeCounter = 0

function newThemeId(): string {
  themeCounter += 1

  return `t${Date.now().toString(36)}${themeCounter.toString(36)}`
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  /** Write whatever is in the store now; every setter calls this after its `set`. */
  const save = (): void => {
    const { namespace: ns, defaults, perChat, botNameOrder, themeChoice, userThemes, textSize } = get()

    // Nothing before a gateway is known. These are somebody's settings ON a
    // gateway, and a blob under a key nobody owns is one the next launch will
    // not find. The appearance is the exception and is not here at all: it has
    // a device-level key of its own and `persistAppearance` writes it.
    if (ns) {
      persist(ns, { defaults, perChat, botNameOrder, themeChoice, userThemes, textSize })
    }
  }

  const writeThemes = (userThemes: UserTheme[]): void => {
    set({ userThemes })
    save()
  }

  return {
    defaults: DEFAULT_CHAT_VIEW,
    perChat: {},
    appearance: DEFAULT_APPEARANCE,
    botNameOrder: DEFAULT_NAME_ORDER,
    hideHandleWhenNamed: DEFAULT_HIDE_HANDLE_WHEN_NAMED,
    themeChoice: DEFAULT_THEME_CHOICE,
    userThemes: [],
    textSize: DEFAULT_TEXT_SIZE,
    loaded: false,
    appearanceLoaded: false,
    namespace: null,

    async hydrateAppearance() {
      const stored = await keyValueStore.getJson<PersistedAppearance>(APPEARANCE_KEY)

      set({
        appearance: asAppearance(stored?.appearance) ?? DEFAULT_APPEARANCE,
        hideHandleWhenNamed: asHideHandleWhenNamed(stored?.hideHandleWhenNamed) ?? DEFAULT_HIDE_HANDLE_WHEN_NAMED,
        appearanceLoaded: true
      })
    },

    async hydrate(ns) {
      const stored = await keyValueStore.getJson<PersistedChatView>(ns.key(CHAT_VIEW_KEY))
      const perChat: Record<string, Partial<ChatViewSettings>> = {}

      for (const [bot, patch] of Object.entries(stored?.perChat ?? {})) {
        const parsed = asPatch(patch)

        if (Object.keys(parsed).length) {
          perChat[bot] = parsed
        }
      }

      set({
        namespace: ns,
        defaults: { ...DEFAULT_CHAT_VIEW, ...asPatch(stored?.defaults) },
        perChat,
        botNameOrder: asNameOrder(stored?.botNameOrder) ?? DEFAULT_NAME_ORDER,
        themeChoice: asThemeChoice(stored?.themeChoice, stored?.wallpaper) ?? DEFAULT_THEME_CHOICE,
        userThemes: asUserThemes(stored?.userThemes),
        textSize: asTextSize(stored?.textSize) ?? DEFAULT_TEXT_SIZE,
        loaded: true
      })
    },

    setDefaults(patch) {
      set({ defaults: { ...get().defaults, ...patch } })
      save()
    },

    setChatView(botName, patch) {
      set({ perChat: { ...get().perChat, [botName]: { ...get().perChat[botName], ...patch } } })
      save()
    },

    resetChatView(botName) {
      const perChat = { ...get().perChat }

      delete perChat[botName]
      set({ perChat })
      save()
    },

    setAppearance(appearance) {
      set({ appearance })
      // Its own key, and therefore its own write: it is the one preference here
      // that does not belong to a gateway.
      persistAppearance({ appearance, hideHandleWhenNamed: get().hideHandleWhenNamed })
    },

    setHideHandleWhenNamed(hideHandleWhenNamed) {
      set({ hideHandleWhenNamed })
      // Beside `appearance` under the same key, for the reason on the field.
      persistAppearance({ appearance: get().appearance, hideHandleWhenNamed })
    },

    setBotNameOrder(botNameOrder) {
      set({ botNameOrder })
      save()
    },

    setTextSize(textSize) {
      set({ textSize })
      save()
    },

    setThemeChoice(themeChoice) {
      set({ themeChoice })
      save()
    },

    createUserTheme(base, name) {
      const id = newThemeId()
      const preset = THEME_PRESETS[base]

      // The new theme starts as a COPY of the preset's two backgrounds rather
      // than as an empty shell, so the editor has something to show and an edit
      // to one face cannot look like it moved the other.
      writeThemes([
        ...get().userThemes,
        {
          id,
          name,
          base,
          light: { background: preset.light.background },
          dark: { background: preset.dark.background }
        }
      ])

      return id
    },

    renameUserTheme(id, name) {
      writeThemes(get().userThemes.map(theme => (theme.id === id ? { ...theme, name } : theme)))
    },

    editUserTheme(id, scheme, patch) {
      writeThemes(
        get().userThemes.map(theme => {
          if (theme.id !== id) {
            return theme
          }

          const face: Record<string, string> = { ...(theme[scheme] ?? {}) }

          for (const [key, value] of Object.entries(patch)) {
            if (value === null) {
              delete face[key]
            } else {
              face[key] = value
            }
          }

          return { ...theme, [scheme]: face as UserThemeFace }
        })
      )
    },

    deleteUserTheme(id) {
      const userThemes = get().userThemes.filter(theme => theme.id !== id)
      const choice = get().themeChoice

      // Deleting the theme that is ON must leave a window that can still be read,
      // so the choice falls back to the base it was built from rather than to a
      // pointer at nothing. `resolveThemeFace` would survive the dangling id on
      // its own; this is so the picker agrees with what is on screen.
      const removed = get().userThemes.find(theme => theme.id === id)

      set({
        userThemes,
        ...(choice.kind === 'user' && choice.id === id
          ? { themeChoice: { kind: 'preset' as const, name: removed?.base ?? 'blue' } }
          : {})
      })
      save()
    },

    applyAppSettings(patch) {
      set({
        ...(patch.defaults ? { defaults: patch.defaults } : {}),
        ...(patch.botNameOrder ? { botNameOrder: patch.botNameOrder } : {}),
        ...(patch.themeChoice ? { themeChoice: patch.themeChoice } : {}),
        ...(patch.userThemes ? { userThemes: patch.userThemes } : {}),
        // Absent is not wrong: a section written before this field leaves the
        // reader on their own size rather than being read as "they chose
        // Default".
        ...(patch.textSize ? { textSize: patch.textSize } : {})
      })
      save()
    },

    reset() {
      set({
        defaults: DEFAULT_CHAT_VIEW,
        perChat: {},
        appearance: DEFAULT_APPEARANCE,
        botNameOrder: DEFAULT_NAME_ORDER,
        hideHandleWhenNamed: DEFAULT_HIDE_HANDLE_WHEN_NAMED,
        themeChoice: DEFAULT_THEME_CHOICE,
        userThemes: [],
        textSize: DEFAULT_TEXT_SIZE,
        loaded: false,
        appearanceLoaded: false,
        namespace: null
      })
    }
  }
})

/** True when this chat pins its own view rather than following the default. */
export function hasChatViewOverride(state: SettingsState, botName: string): boolean {
  return Object.keys(state.perChat[botName] ?? {}).length > 0
}

/** The effective view for one chat: the global default with its override folded in. */
export function chatViewFor(state: SettingsState, botName: string): ChatViewSettings {
  return { ...state.defaults, ...state.perChat[botName] }
}

/** Hook form of `chatViewFor`, for a screen that only cares about one chat. */
export function useChatView(botName: string): ChatViewSettings {
  const defaults = useSettingsStore(state => state.defaults)
  const override = useSettingsStore(state => state.perChat[botName])

  return { ...defaults, ...override }
}
