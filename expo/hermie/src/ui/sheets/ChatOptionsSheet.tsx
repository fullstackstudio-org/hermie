/**
 * Chat options: toggles and pickers that are commands underneath.
 *
 * Every control is fully controlled from props. The sheet never sends anything
 * itself — `config.set`, `slash.exec` and the local verbosity filter live in
 * three different places, and a sheet that decided which one to use would have
 * to know all three.
 *
 * The verbosity, bot-to-bot and thinking controls are the CLIENT-side filter
 * (ADR-0008); the gateway's own `display.tool_progress` is deliberately not
 * here, because changing it writes global config shared with other surfaces.
 */
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

import { prettyModelName, type ContextUsage } from '@hermie/transcript'

import { ContextMeter } from '../../chat-ui/ContextMeter'
import { chatStrings } from '../../chat-ui/strings'
import type { PickerOption, Verbosity } from '../../chat-ui/types'
import type { PushType } from '@hermie/gateway-client/push'
import { formatMuteUntil, MUTE_DURATIONS, MUTE_FOREVER, muteUntil, type MuteDuration } from '../../store/mute'
import { DICTATION_AUTO, RATE_STEPS } from '../../features/voice/voice-settings'
import { strings } from '../../i18n/strings'
import { AccentSwatches } from '../AccentSwatches'
import { BottomSheet, SheetEyebrow } from '../BottomSheet'
import { SHARE_FILE_VERB } from '../../platform/share-text'
import { Button, InsetButtonRow, InsetGroup, Text } from '../primitives'
import { useTheme } from '../theme'
import { TAP_SLOP, type AccentName } from '../tokens'
import { useEscapeKey } from '../useEscapeKey'
import { DisclosureRow, SegmentedRow, SwitchRow } from './controls'
import { PickerPage as Page, PickerPane } from './PickerPane'

export interface ChatOptionsSheetProps {
  visible: boolean
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
  botName: string

  yolo: boolean
  onChangeYolo: (value: boolean) => void

  fast: boolean
  onChangeFast: (value: boolean) => void

  reasoningEffort: string
  reasoningOptions: PickerOption[]
  onChangeReasoningEffort: (value: string) => void

  model: string
  modelOptions: PickerOption[]
  onChangeModel: (value: string) => void
  /**
   * Called instead of `onChangeModel` when the catalogue already flags the
   * picked model as expensive; the caller runs the confirmation itself.
   */
  onPickExpensiveModel?: (value: string) => void

  /**
   * This chat's colour, and a way to change it.
   *
   * It is the same value the row menu sets, from the same store (ADR-0012), so
   * picking here retints the header ring, the selected row and the outgoing
   * bubbles as soon as the store writes — no reload, and no second copy of the
   * colour held by the sheet.
   */
  accent: AccentName
  onChangeAccent: (value: AccentName) => void

  /**
   * When this chat's silence lapses, `0` for never, `null` when it is not muted.
   *
   * The same value the row menu reads, from the same store, so muting from the
   * header and muting from the list are one decision with one home.
   */
  mutedUntil: number | null
  /** `null` unmutes; a number is the second the silence lapses, `0` for never. */
  onChangeMute: (until: number | null) => void

  /**
   * Per-type notification settings for this chat, where the gateway can honour
   * them.
   *
   * Absent removes the row and the page entirely, the way `onExport` removes
   * the export group: a gateway with no notifier has nothing to set, and a
   * switch that writes a preference nothing reads is worse than no switch.
   */
  notifications?: ChatNotificationSettings

  /**
   * How full this session's context window is, or nothing.
   *
   * Absent means the gateway did not report a window size, and the row is then
   * not drawn at all — not drawn empty, and never drawn as an error. A gateway
   * without `session.usage` is a gateway with one fewer row in this sheet, which
   * is the whole of the capability gate.
   */
  contextUsage?: ContextUsage | null

  /**
   * Write the conversation out as a file and hand it to the platform.
   *
   * The sheet does not build the file: it has the transcript nowhere near it,
   * and the serializer is a pure function in `@hermie/transcript` that the
   * screen owns. Absent removes the group, which is what a surface with no
   * transcript behind it — the developer gallery — gets.
   */
  onExport?: (format: 'md' | 'txt') => void

  /**
   * Speaking and listening, or nothing at all.
   *
   * Absent removes the whole group, which is the case on a platform with no
   * synthesiser — a browser without `speechSynthesis`. The same rule `onExport`
   * follows: a group whose controls cannot act is worse than a missing group.
   *
   * The two halves are deliberately different in scope and the footer says so.
   * `autoRead` belongs to THIS chat — a phone in a car and a Mac in an office
   * want different answers for the same bot — while the rate is one voice for
   * the whole app, because a reader who finds the default too slow finds it too
   * slow everywhere.
   */
  voice?: {
    autoRead: boolean
    onChangeAutoRead: (value: boolean) => void
    /** Engine multiplier, 1 being the platform's normal. One of `RATE_STEPS`. */
    rate: number
    onChangeRate: (rate: number) => void
    /** Something is being read right now, so there is something to stop. */
    reading: boolean
    onStopReading: () => void
    /**
     * Voice mode: the hands-free loop, where the platform can do both halves.
     *
     * This sheet is the primary way in, and deliberately so. The composer's mic
     * cannot carry it on a long press — a long press is how you hold the mic to
     * talk — so a row here and an accessibility action on the button are the two
     * doors. Absent where the platform can speak but not listen, or the reverse.
     */
    onOpenVoiceMode?: () => void
    /** Show what was heard for a moment before voice mode sends it. */
    confirmBeforeSending: boolean
    onChangeConfirmBeforeSending: (value: boolean) => void
    /**
     * The dictation half, or nothing where the platform cannot listen.
     *
     * Separate from the speaking half because the two capabilities really are
     * separate: a browser with `speechSynthesis` and no `SpeechRecognition` is
     * the common case, and it should get the reading rows and not a language
     * picker for a microphone it does not have.
     */
    dictation?: {
      /** `auto`, or a BCP-47 tag. */
      language: string
      onChangeLanguage: (language: string) => void
      /**
       * Tags this device can recognise offline, from the platform itself.
       *
       * Empty is the ordinary case rather than a failure — Android below API 31
       * will not say and the web has no way to ask — and it means the picker
       * offers the device's own language alone.
       */
      languages: readonly string[]
    }
  }

  verbosity: Verbosity
  onChangeVerbosity: (value: Verbosity) => void

  showBotToBot: boolean
  onChangeShowBotToBot: (value: boolean) => void

  showThinking: boolean
  onChangeShowThinking: (value: boolean) => void

  /**
   * True when this chat pins its own verbosity/toggles rather than following
   * the global default. Only then is there anything to reset.
   */
  viewOverridden?: boolean
  /** Drop this chat's override so it follows the Settings default again. */
  onResetView?: () => void

  /** The gateway answered `confirm_required` for the model just picked. */
  /**
   * Which page the sheet opens on.
   *
   * It began as a development lever — a page behind a tap cannot be photographed
   * on a simulator this machine can only launch, see `src/dev/launch-intent.ts`
   * — and it is now also how the POPOVER hands over. The first level of the
   * chat's options is a popover in the chat (`ChatOptionsPopover`); a row that
   * leads to a page closes it and opens this sheet already on that page, so the
   * reader gets the picker they asked for rather than the root they have just
   * left. A tap still navigates normally from wherever it puts you, and Escape
   * still goes back exactly one level.
   */
  initialPane?: ChatOptionsPane

  pendingExpensiveModel?: string | null
  confirmMessage?: string
  onCancelExpensiveModel?: () => void
  onConfirmExpensiveModel?: () => void
}

/**
 * Every page under the root, which is also every page the popover can hand to.
 *
 * Exported because two surfaces now name the same set: the popover's rows say
 * which page they lead to, and this sheet says which page it opened on. One
 * union rather than two, so a page added here cannot be a page the popover
 * quietly cannot reach.
 */
export type ChatOptionsPane =
  'reasoning' | 'model' | 'colour' | 'mute' | 'export' | 'notifications' | 'rate' | 'dictationLanguage'

type Pane = 'root' | ChatOptionsPane

/**
 * What the chat's own notification page needs.
 *
 * `types` is the EFFECTIVE answer — the global switches with this chat's
 * overrides folded in — because that is the question the reader is asking: will
 * this chat wake me for a failed turn. `overridden` is what makes the footer
 * honest, and it is separate precisely because an effective `true` can mean
 * either "the global says so" or "this chat says so".
 */
export interface ChatNotificationSettings {
  types: Record<PushType, boolean>
  /** True when this chat pins any type rather than following the global set. */
  overridden: boolean
  /** `null` puts the type back to following the global switch. */
  onChangeType: (type: PushType, on: boolean | null) => void
  onUseGlobal: () => void
}

/**
 * The events a reader recognises, in the order they matter.
 *
 * Not every `PushType`: `message` is what mute already covers and is the one
 * switch a per-chat page would duplicate, so the page names the EVENTS a reader
 * would answer differently per bot. The wire keeps all of them.
 *
 * The three cron rows sit together and in that order because they are the
 * reason this page exists: a bot whose nightly routine chatters is exactly the
 * bot whose routine FAILING is worth a buzz, and the only way to say that is to
 * have the delivery and the two outcomes as separate switches.
 */
/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
const chatNotificationTypes = (): { type: PushType; label: string }[] => [
  { type: 'turn_done', label: chatStrings.notifications.types.turnDone as string },
  { type: 'turn_failed', label: chatStrings.notifications.types.turnFailed as string },
  { type: 'request', label: chatStrings.notifications.types.needsInput as string },
  { type: 'cron', label: chatStrings.notifications.types.cron as string },
  { type: 'cron_done', label: chatStrings.notifications.types.cronDone as string },
  { type: 'cron_failed', label: chatStrings.notifications.types.cronFailed as string }
]

/**
 * A language tag, in the reader's own words where the platform knows them.
 *
 * `Intl.DisplayNames` is in every engine this app runs on and is still wrapped:
 * it throws on a tag it cannot parse, and the tags here come from the device's
 * recognizer rather than from this repository. The tag itself is the fallback,
 * which is worse to read and never wrong.
 */
export function languageLabel(tag: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

/**
 * The five speaking rates, named rather than numbered.
 *
 * "0.75×" is a number about an engine; "Slow" is what a person means. The values
 * behind them are `RATE_STEPS` and the labels are `chatStrings.voice.rateOptions`,
 * zipped here so the two lists cannot drift in length — a sixth step with no name
 * would draw a row with an empty label.
 */
const RATE_LABELS = ['slowest', 'slow', 'normal', 'fast', 'fastest'] as const

const RATE_OPTIONS: PickerOption[] = RATE_STEPS.map((value, index) => ({
  value: String(value),
  label: chatStrings.voice.rateOptions[RATE_LABELS[index] ?? 'normal']
}))

/**
 * The picker's id for "stop being quiet".
 *
 * Not one of `MUTE_DURATIONS`, and deliberately not a value the duration parser
 * would take: the picker hands back one string and this is the one that means
 * the opposite of the other four.
 */
const UNMUTE = 'unmute'

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * What a disclosure row SAYS, as three functions rather than as three
 * expressions inside one component.
 *
 * The popover draws the same four rows as the sheet's root and has to say the
 * same words on them, and a second copy of "which label does this model id
 * have" is a second copy that goes stale when a gateway stops listing a model.
 * Pure, so both surfaces read one answer.
 */
export function optionRowLabel(options: readonly PickerOption[], value: string): string {
  return options.find(option => option.value === value)?.label ?? value
}

/**
 * The model row, which has a fallback the others do not.
 *
 * A chat can sit on a model the inventory has since dropped, and that row must
 * not be the one place a wire id shows through.
 */
export function modelRowLabel(options: readonly PickerOption[], value: string): string {
  return options.find(option => option.value === value)?.label ?? prettyModelName(value)
}

/**
 * The picker's rows, from the gateway's inventory and the chat's own model.
 *
 * Beside `modelRowLabel` rather than inside the screen, because the two are one
 * decision seen from two ends: this builds the labels and that reads one of them
 * back out. Splitting them is what let them disagree — the row's fallback
 * formatted a wire id, and the option list did not, so the ONE model guaranteed
 * to be in the list was the one whose label was raw.
 *
 * Two rules, both of them the owner's:
 *
 *  - **The name on top, the wire id underneath.** The id has to stay readable —
 *    it is what goes into a config or a `--model` flag — and the picker's search
 *    matches on it, because `value` is one of the three fields it looks in.
 *  - **The chat's own model always appears**, even when the inventory is empty or
 *    no longer lists it. A picker that cannot show what you are on is a lie.
 *
 * The provider becomes the option's `group`, so the pane cuts the list into
 * headed sections. A model whose provider the inventory did not name keeps no
 * group, and the chat's own model — which is synthesised from an id and nothing
 * else — never has one: it belongs above the sections, not inside whichever one
 * happens to be first.
 */
export function modelPickerOptions(
  models: readonly { id: string; provider?: string }[],
  current: string | undefined | null
): PickerOption[] {
  const options = models.map(model => ({
    value: model.id,
    label: prettyModelName(model.id),
    detail: model.id,
    ...(model.provider ? { group: model.provider } : {})
  }))

  if (current && !options.some(option => option.value === current)) {
    return [{ value: current, label: prettyModelName(current), detail: current }, ...options]
  }

  return options
}

/** The mute row, which says the STATE — a deadline — rather than the action. */
export function muteRowLabel(mutedUntil: number | null, now: number): string {
  if (mutedUntil === null) {
    return chatStrings.options.notMuted
  }

  return mutedUntil === MUTE_FOREVER
    ? strings.layout.muted
    : strings.layout.mutedUntil(formatMuteUntil(mutedUntil, now, strings.layout.muteWeekdays))
}

/**
 * The context-window row.
 *
 * Not a `DisclosureRow` and not pressable: there is nowhere for it to go. A row
 * that looks like the four above it and does nothing when tapped is worse than a
 * row that plainly does not invite one, so it carries no chevron and no press
 * state.
 */
function ContextRow({ usage }: { usage: ContextUsage }) {
  const theme = useTheme()

  return (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.sm,
        minHeight: 44,
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.sm
      }}
      testID="option-context"
    >
      <View style={{ flex: 1 }}>
        <Text>{chatStrings.context.label}</Text>
        {usage.estimated ? (
          <Text color="textMuted" variant="meta">
            {chatStrings.context.estimated}
          </Text>
        ) : null}
      </View>
      <ContextMeter detail usage={usage} />
    </View>
  )
}

export function ChatOptionsSheet(props: ChatOptionsSheetProps) {
  const theme = useTheme()
  const [pane, setPane] = useState<Pane>(props.initialPane ?? 'root')

  /**
   * Escape goes back exactly ONE level.
   *
   * `useEscapeKey` delivers to whoever registered LAST, and effects flush
   * child-first — so the `BottomSheet` inside this component registers its
   * "close the sheet" handler before this one does. A page therefore wins
   * Escape while it is open, pops itself, unregisters, and hands the key back
   * to the sheet. Nothing coordinates that beyond mount order, which is the
   * whole reason the stack is a stack.
   */
  useEscapeKey(() => setPane('root'), props.visible && pane !== 'root')

  // The sheet is mounted for the life of the screen, so `useState`'s initial
  // value ran long before anyone asked for a page. Re-reading it as the sheet
  // BECOMES visible is what makes `initialPane` mean anything — and it is right
  // for an ordinary open too, which should never land on the page the last
  // reader happened to leave.
  const { visible, initialPane } = props

  useEffect(() => {
    if (visible) {
      setPane(initialPane ?? 'root')
    }
  }, [visible, initialPane])

  const close = () => {
    setPane('root')
    props.onClose()
  }

  const modelLabel = modelRowLabel(props.modelOptions, props.model)
  const reasoningLabel = optionRowLabel(props.reasoningOptions, props.reasoningEffort)
  const muteLabel = muteRowLabel(props.mutedUntil, nowSeconds())
  // The named stop, or the bare multiplier for a value no step produces — which
  // only an older build or a hand-edited preference file can supply, and which
  // is still better shown than silently redrawn as "Normal".
  const rateLabel =
    RATE_OPTIONS.find(option => option.value === String(props.voice?.rate))?.label ?? String(props.voice?.rate ?? 1)

  if (props.pendingExpensiveModel) {
    // A confirmation replaces the sheet's body rather than stacking a second
    // modal on it: two sheets deep is where a `Modal` stops behaving the same
    // on all four targets.
    return (
      <BottomSheet
        accessibilityLabel={chatStrings.options.expensiveTitle}
        onClosed={props.onClosed}
        onRequestClose={() => props.onCancelExpensiveModel?.()}
        testID="chat-options-sheet"
        visible={props.visible}
      >
        <Text variant="sheetTitle">{chatStrings.options.expensiveTitle}</Text>
        <Text color="textMuted">{props.confirmMessage || props.pendingExpensiveModel}</Text>
        <Button
          onPress={() => props.onConfirmExpensiveModel?.()}
          testID="option-model-confirm"
          title={chatStrings.options.expensiveConfirm}
        />
        <Button
          onPress={() => props.onCancelExpensiveModel?.()}
          testID="option-model-cancel"
          title={chatStrings.options.cancel}
          variant="secondary"
        />
      </BottomSheet>
    )
  }

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.options.title}
      onClosed={props.onClosed}
      // One level, the same rule Escape follows above. `onRequestClose` is the
      // platform's dismiss request, and on Android that is the hardware back
      // button — the only surface here that HAS one, and the one Escape cannot
      // reach because `useEscapeKey` is wired to a Mac keyboard. Without this a
      // back press from a page closed the whole sheet and skipped the level.
      onRequestClose={() => (pane === 'root' ? close() : setPane('root'))}
      testID="chat-options-sheet"
      visible={props.visible}
    >
      {pane === 'notifications' && props.notifications ? (
        /*
          Per TYPE, on top of mute rather than instead of it.

          Mute is "say nothing at all" and these are "say this but not that",
          which is why they are a page of their own and why the footer says
          which of the two states a switch is in: a switch that is on because
          the global setting is on and one that is on because this chat says so
          look identical, and only one of them moves when Settings moves.
        */
        <Page onBack={() => setPane('root')} title={chatStrings.notifications.title}>
          <Text color="textMuted" variant="preview">
            {chatStrings.notifications.subtitle(props.botName)}
          </Text>
          <InsetGroup
            footer={
              props.notifications.overridden
                ? chatStrings.notifications.overridden
                : chatStrings.notifications.following
            }
          >
            {chatNotificationTypes().map(entry => (
              <SwitchRow
                key={entry.type}
                label={entry.label}
                onChange={value => props.notifications?.onChangeType(entry.type, value)}
                testID={`option-notify-${entry.type}`}
                value={props.notifications?.types[entry.type] === true}
              />
            ))}
          </InsetGroup>
          <Text color="textMuted" variant="meta">
            {chatStrings.notifications.hint}
          </Text>
          {props.notifications.overridden ? (
            <Button
              onPress={props.notifications.onUseGlobal}
              testID="option-notify-global"
              title={chatStrings.notifications.useDefault}
              variant="secondary"
            />
          ) : null}
        </Page>
      ) : pane === 'export' ? (
        /*
          Export as a page of its own, because the popover has to be able to
          reach it. It was a group on the root and it still is — the root below
          draws it too — so a reader who opened the sheet the long way round
          finds it where it always was and one who came through the popover
          lands straight on it.
        */
        <Page onBack={() => setPane('root')} title={chatStrings.export.header}>
          <Text color="textMuted" variant="preview">
            {chatStrings.export.hint}
          </Text>
          <InsetGroup>
            <InsetButtonRow
              onPress={() => props.onExport?.('md')}
              testID="option-export-markdown-page"
              title={
                SHARE_FILE_VERB === 'download' ? chatStrings.export.downloadMarkdown : chatStrings.export.shareMarkdown
              }
            />
            <InsetButtonRow
              onPress={() => props.onExport?.('txt')}
              testID="option-export-text-page"
              title={SHARE_FILE_VERB === 'download' ? chatStrings.export.downloadText : chatStrings.export.shareText}
            />
          </InsetGroup>
        </Page>
      ) : pane === 'mute' ? (
        /*
          The four spans, and Unmute when there is something to undo.

          A picker rather than a switch, because "mute" is not a boolean the
          reader is toggling — it is a span they are choosing. Nothing is
          ticked: the stored value is a DEADLINE, and a deadline cannot say
          which of the four buttons produced it once an hour has passed.
        */
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            props.onChangeMute(option.value === UNMUTE ? null : muteUntil(option.value as MuteDuration, nowSeconds()))
            setPane('root')
          }}
          options={[
            ...MUTE_DURATIONS.map(duration => ({
              value: duration,
              label: strings.layout.muteFor[duration]
            })),
            ...(props.mutedUntil === null ? [] : [{ value: UNMUTE, label: strings.layout.unmute }])
          ]}
          title={strings.layout.mute}
          value=""
        />
      ) : pane === 'colour' ? (
        <Page onBack={() => setPane('root')} title={strings.layout.colour}>
          <Text color="textMuted" variant="preview">
            {chatStrings.options.colourHint}
          </Text>
          {/*
            The page stays open after a pick, unlike the model and reasoning
            pages. A colour is judged against the chat behind it, so closing on
            the first tap would make comparing two of them four taps each.
          */}
          <AccentSwatches accent={props.accent} onSelect={props.onChangeAccent} testIDPrefix={props.botName} />
        </Page>
      ) : pane === 'rate' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            props.voice?.onChangeRate(Number(option.value))
            setPane('root')
          }}
          options={RATE_OPTIONS}
          title={chatStrings.voice.rate}
          // Stringified, because a picker deals in ids and 1 and 1.0 are the
          // same rate but not the same string. `RATE_STEPS` is the only source
          // of these values, so the round trip through `String` is exact.
          value={String(props.voice?.rate ?? 1)}
        />
      ) : pane === 'dictationLanguage' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            props.voice?.dictation?.onChangeLanguage(option.value)
            setPane('root')
          }}
          options={[
            { value: DICTATION_AUTO, label: chatStrings.voice.dictationAuto },
            ...(props.voice?.dictation?.languages ?? []).map(tag => ({
              value: tag,
              label: languageLabel(tag),
              detail: tag
            }))
          ]}
          // A list of installed models can be long on a phone that has collected
          // a few, and it is the same shape as the model list next door.
          searchable
          title={chatStrings.voice.dictationLanguage}
          value={props.voice?.dictation?.language ?? DICTATION_AUTO}
        />
      ) : pane === 'reasoning' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            props.onChangeReasoningEffort(option.value)
            setPane('root')
          }}
          options={props.reasoningOptions}
          title={chatStrings.options.reasoning}
          value={props.reasoningEffort}
        />
      ) : pane === 'model' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            if (option.expensive && props.onPickExpensiveModel) {
              props.onPickExpensiveModel(option.value)
            } else {
              props.onChangeModel(option.value)
            }

            setPane('root')
          }}
          options={props.modelOptions}
          searchable
          searchLabel={chatStrings.options.modelSearch}
          title={chatStrings.options.model}
          value={props.model}
        />
      ) : (
        <View style={{ gap: theme.space.lg }}>
          <View style={{ gap: theme.space.xs }}>
            <SheetEyebrow>{chatStrings.options.eyebrow}</SheetEyebrow>
            <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="sheetTitle">{chatStrings.options.title}</Text>
              <Pressable accessibilityRole="button" hitSlop={TAP_SLOP} onPress={close} testID="chat-options-done">
                <Text color="accentText">{chatStrings.options.done}</Text>
              </Pressable>
            </View>
            <Text color="textMuted" variant="preview">
              {chatStrings.options.subtitle(props.botName)}
            </Text>
          </View>

          {/*
            Four groups, each with a heading. Without them the sheet is eight
            controls in a column and the reader has to infer which two belong
            together — and the two verbosity/visibility groups in particular are
            about different things (what the model does, what this screen shows).
          */}
          <InsetGroup header={chatStrings.options.howHeader}>
            <SwitchRow
              hint={chatStrings.options.yoloHint}
              label={chatStrings.options.yolo}
              onChange={props.onChangeYolo}
              testID="option-yolo"
              value={props.yolo}
            />
            <SwitchRow
              hint={chatStrings.options.fastHint}
              label={chatStrings.options.fast}
              onChange={props.onChangeFast}
              testID="option-fast"
              value={props.fast}
            />
          </InsetGroup>

          <InsetGroup header={chatStrings.options.thisChatHeader}>
            <DisclosureRow
              label={chatStrings.options.reasoning}
              onPress={() => setPane('reasoning')}
              testID="option-reasoning"
              value={reasoningLabel}
            />
            <DisclosureRow
              label={chatStrings.options.model}
              onPress={() => setPane('model')}
              testID="option-model"
              value={modelLabel}
            />
            <DisclosureRow
              label={strings.layout.colour}
              onPress={() => setPane('colour')}
              testID="option-colour"
              value={strings.layout.accents[props.accent]}
            />
            {/*
              The row says the STATE, not the action: "Muted until Thu 09:00" is
              the only place a reader who set this on another device two days
              ago can find out when the chat comes back.
            */}
            <DisclosureRow
              label={strings.layout.mute}
              onPress={() => setPane('mute')}
              testID="option-mute"
              value={muteLabel}
            />
            {props.notifications ? (
              <DisclosureRow
                label={chatStrings.notifications.label}
                onPress={() => setPane('notifications')}
                testID="option-notifications"
              />
            ) : null}
            {/*
              Read-only, and the only row here that is. Everything else in this
              group is a decision the reader makes; this is a fact they check one
              of those decisions against — whether there is room for another long
              turn before the session has to compact.
            */}
            {props.contextUsage ? <ContextRow usage={props.contextUsage} /> : null}
          </InsetGroup>

          {/*
            Verbosity and the two visibility switches are ONE group: all three
            are the client-side view filter (ADR-0008), they share the override
            footer, and split across two cards the footer looked like it only
            applied to the switches.
          */}
          <InsetGroup
            footer={props.viewOverridden ? chatStrings.options.usingOverride : chatStrings.options.usingDefault}
            header={chatStrings.options.viewHeader}
          >
            <SegmentedRow
              label={chatStrings.options.verbosity}
              onChange={props.onChangeVerbosity}
              options={[
                { label: chatStrings.options.verbosityOptions.quiet, value: 'quiet' },
                { label: chatStrings.options.verbosityOptions.normal, value: 'normal' },
                { label: chatStrings.options.verbosityOptions.verbose, value: 'verbose' }
              ]}
              testID="option-verbosity"
              value={props.verbosity}
            />
            <SwitchRow
              label={chatStrings.options.showBotToBot}
              onChange={props.onChangeShowBotToBot}
              testID="option-bot-to-bot"
              value={props.showBotToBot}
            />
            <SwitchRow
              label={chatStrings.options.showThinking}
              onChange={props.onChangeShowThinking}
              testID="option-thinking"
              value={props.showThinking}
            />
          </InsetGroup>

          {props.voice ? (
            <InsetGroup footer={chatStrings.voice.autoReadHint} header={chatStrings.voice.header}>
              <SwitchRow
                label={chatStrings.voice.autoRead}
                onChange={props.voice.onChangeAutoRead}
                testID="option-auto-read"
                value={props.voice.autoRead}
              />
              <DisclosureRow
                label={chatStrings.voice.rate}
                onPress={() => setPane('rate')}
                testID="option-voice-rate"
                value={rateLabel}
              />
              {/*
                Only while there is something to stop.

                A permanently present Stop row would be a control that does
                nothing almost all of the time, and the sheet already has a rule
                about those — see the context row above, and `onExport`. It is
                here rather than in the message menu because this is the one
                surface that can stop a read the reader did not start from a
                row: an automatic one.
              */}
              {props.voice.dictation ? (
                <DisclosureRow
                  label={chatStrings.voice.dictationLanguage}
                  onPress={() => setPane('dictationLanguage')}
                  testID="option-dictation-language"
                  value={
                    props.voice.dictation.language === DICTATION_AUTO
                      ? chatStrings.voice.dictationAuto
                      : languageLabel(props.voice.dictation.language)
                  }
                />
              ) : null}
              {/*
                Under the two settings it depends on, not above them: a reader
                who has just turned the confirmation off should see the row it
                affects rather than having already passed it.
              */}
              {props.voice.onOpenVoiceMode ? (
                <>
                  <SwitchRow
                    hint={chatStrings.voice.confirmBeforeSendingHint}
                    label={chatStrings.voice.confirmBeforeSending}
                    onChange={props.voice.onChangeConfirmBeforeSending}
                    testID="option-voice-confirm"
                    value={props.voice.confirmBeforeSending}
                  />
                  <InsetButtonRow
                    onPress={props.voice.onOpenVoiceMode}
                    testID="option-voice-mode"
                    title={chatStrings.voice.modeStart}
                  />
                </>
              ) : null}
              {props.voice.reading ? (
                <InsetButtonRow
                  onPress={props.voice.onStopReading}
                  testID="option-stop-reading"
                  title={chatStrings.menu.stopReading}
                />
              ) : null}
            </InsetGroup>
          ) : null}

          {props.onExport ? (
            <InsetGroup footer={chatStrings.export.hint} header={chatStrings.export.header}>
              {/*
                Two formats rather than one, and neither is a default. A
                Markdown file is for somewhere that renders it and a .txt is for
                somewhere that does not, and guessing which a reader meant is
                the same mistake offering only one Copy line would be — which is
                the argument `message-menu.ts` already makes about exactly this.
              */}
              <InsetButtonRow
                onPress={() => props.onExport?.('md')}
                testID="option-export-markdown"
                title={
                  SHARE_FILE_VERB === 'download'
                    ? chatStrings.export.downloadMarkdown
                    : chatStrings.export.shareMarkdown
                }
              />
              <InsetButtonRow
                onPress={() => props.onExport?.('txt')}
                testID="option-export-text"
                title={SHARE_FILE_VERB === 'download' ? chatStrings.export.downloadText : chatStrings.export.shareText}
              />
            </InsetGroup>
          ) : null}

          {props.viewOverridden && props.onResetView ? (
            <View style={{ gap: theme.space.xs }}>
              <Button
                onPress={props.onResetView}
                testID="option-use-default"
                title={chatStrings.options.useDefault}
                variant="secondary"
              />
              {/*
                What the button above does, in full — the same footer style an
                `InsetGroup` draws under its own card, so a reader who does not
                already know what "reset" clears here can read it before tapping.
              */}
              <Text color="textMuted" style={{ textAlign: 'center' }} variant="meta">
                {chatStrings.options.useDefaultHint}
              </Text>
            </View>
          ) : null}

          <Button onPress={close} title={chatStrings.options.done} variant="secondary" />
        </View>
      )}
    </BottomSheet>
  )
}
