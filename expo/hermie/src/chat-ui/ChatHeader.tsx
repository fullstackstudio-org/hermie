/**
 * The chat's chrome: round glass buttons, and a pill carrying the avatar, the name
 * and what the bot is doing.
 *
 * One rule decides the subtitle and it is the owner's: **it must never say
 * "Connecting…" while the chat is live.** The header therefore takes a resolved
 * `Presence` — Part 1's own function, the same one the chat list uses — rather than
 * a pair of booleans it would have to guess a precedence order for. A row that says
 * "Working…" above a header that says "Online" is two bugs that look like one.
 *
 * ## It is not a bar
 *
 * It was one glass surface spanning the column, and the owner replaced that with a
 * reference: iPadOS 26 Messages, where the buttons and the contact pill are
 * SEPARATE rounded glass elements floating over the conversation, with the messages
 * scrolling underneath and blurring through them. So this component draws no
 * background of its own. It is a transparent row of three floating things — the
 * leading button, the pill, the trailing button — and the chat screen lays it over
 * the transcript rather than above it.
 *
 * Two consequences:
 *
 *  - The row is `pointerEvents="box-none"`, so the gaps between the three elements
 *    pass drags and taps through to the transcript underneath. A transparent view
 *    that swallows touches is worse than an opaque one, because the reader cannot
 *    see what stopped them.
 *  - Nothing here reserves space. `CHAT_CHROME_HEIGHT` is what the transcript pads
 *    its own content by, so the padding and the thing it clears cannot drift apart.
 *
 * The agents bar pins under it (§6.8), which is why the two are siblings in the
 * chat screen rather than one component.
 *
 * ## The pill has ONE width, and its LONGER line is what decides it
 *
 * The status line changes several times a second while a turn runs — `Thinking…`,
 * `Typing…`, `Running terminal…`, `Online` — and a pill that hugs its content is a
 * pill that resizes on every one of them, with the avatar and the name sliding
 * sideways underneath. The name is the only thing in there that does not change
 * while the reader is looking at it, so the name (and a floor, for a bot called
 * `Al`) is the measurement.
 *
 * The status line is therefore laid out in a row of its own that is exactly one
 * `meta` line tall, with the text ABSOLUTELY positioned inside it: an absolute
 * child is outside its parent's intrinsic width, so however long it is it can
 * neither widen the pill nor be measured by it — it is elided at the width the
 * name set. The one thing still trimmed before it gets here is an MCP tool's
 * namespace, which `shortToolName` does, because eliding
 * `Running mcp__terminal__run_…` tells a reader nothing at all.
 *
 * **That was not enough, and the reason is worth writing down.** The owner
 * reported the pill still changing size while a bot thinks, after the status was
 * already out of the intrinsic width. "An absolute child cannot widen its
 * parent" is an argument about Yoga's box model, and this component renders on
 * four targets — one of which composites the pill as a native glass surface and
 * another of which draws the name as a line-clamped `-webkit-box`. An invariant
 * that has to be re-argued per platform is not one.
 *
 * So the column's width is no longer DERIVED. A ruler — the name at the same
 * type token, laid out with nothing around it — reports the name's own width
 * once, and the column is given that number as an explicit `width`
 * (`pillTextWidth`). After that the only thing in the world that can move the
 * pill is the bot being renamed. Not a status, not a font fallback, not a
 * native surface re-measuring itself between two frames.
 *
 * ## …which means the OTHER line has to be measured too
 *
 * R4 measured the name because the name was the only line that stood still. The
 * pill has since grown a second line — the bot's other name, then the state, as
 * `handle · Online` — and sizing the column to the first line alone clipped it:
 * the owner reported `Juno Mar…` over `techsupport · …` with most of the header
 * empty beside it.
 *
 * So there are two rulers and the column takes the WIDER of them, capped at the
 * room actually left between the header's buttons — measured off the centring
 * column, because how much room there is depends on the window, the shell and
 * which buttons this surface put in the row, and a number written here would be
 * wrong on three of the four.
 *
 * R4's rule survives intact, and it is what decides what the second ruler says.
 * A ruler that carried the CURRENT status would move the pill on every frame of
 * a running turn, so it carries the widest status the bot can cycle through
 * (`widestStatus`) and reserves room for that once. Anything longer — a tool
 * name arriving as a `subtitle` — is elided inside the room reserved for it, and
 * the status is the half that gives way: it is the only shrinkable child of the
 * second line, so the handle is never the thing that loses its letters.
 *
 * Changing it cross-fades rather than cutting, over `motion.press`, which is short
 * enough that a reader who is watching the words reads a change and a reader who is
 * not sees nothing flicker. Reduce Motion collapses it to a swap.
 */
import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, View } from 'react-native'

import { GlassGroup, GlassSurface } from '../ui/glass'
import { durationFor, easing, NATIVE_DRIVER } from '../ui/motion'
import { PresenceBead } from '../ui/PresenceBead'
import { RoundIconButton, Text, type RoundIconButtonProps } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { AVATAR_SIZE, BEAD_SIZE, CONTROL_SIZE, type PresenceState } from '../ui/tokens'
import { Avatar } from './primitives/Avatar'
import { formatClock } from './format'
import { chatStrings } from './strings'

export interface ChatHeaderProps {
  /**
   * The large line: whichever of the bot's two names this reader put first.
   *
   * Resolved by the caller (`store/bot-names.ts`), because the choice is one
   * app-wide setting and a header that read it for itself would be a second
   * place the rule lives.
   */
  name: string
  /**
   * The bot's OTHER name, for the line under it. Empty when it has only one.
   *
   * It used to be the handle specifically, drawn as `@handle` and only when no
   * subtitle existed — which `subtitleFor` always produces, so in the real app
   * it was never drawn at all and only the gallery ever saw it. It is now
   * whichever name did not win the top line, plain: the `@` was doing the work
   * of saying "this is the addressable one", and that is no longer reliably
   * true of the name on this line.
   */
  secondaryName?: string
  /** The profile's picture, when the roster has loaded one. */
  avatarUri?: string
  /**
   * The bot's presence, already resolved.
   *
   * Not the gateway's. A chat that is open and streaming is `working`, whatever the
   * socket is doing between frames — which is the whole of the owner's rule about
   * "Connecting…".
   */
  presence?: PresenceState
  /** Only while offline, and only when the roster gave us one. */
  lastSeenAt?: number
  /** Overrides the derived line entirely. */
  subtitle?: string
  /** The chat's colour, for the avatar ring. */
  accentFill?: string
  onBack?: () => void
  onOpenOptions: () => void
  /**
   * Open this bot's profile. Absent on a surface that has nowhere to put a
   * sheet — the gallery — and the pill is then inert rather than a button that
   * does nothing.
   */
  onOpenProfile?: () => void
  /**
   * Open the bot's conversations — the sheet on a phone or a narrow window,
   * the column toggle on a wide one (`ChatScreen`, Task 7). Absent wherever the
   * caller has no entry point to offer: a gateway that named nobody
   * (`canCreate === false`), or a surface with no gateway at all. The round
   * button sits in the trailing group, left of `(…)`.
   */
  onOpenConversations?: () => void
  /**
   * Hide the wide layout's chat list.
   *
   * Absent on the compact shell, which has no sidebar — the leading group there
   * carries Back instead — and absent on the wide one while the list is ALREADY
   * hidden, because the rail that replaces it carries the control to bring it
   * back. Measured on an iPad: with a button in both places, a collapsed window
   * drew two identical sidebar icons about 90pt apart doing the same thing. So
   * this only ever hides, which is why it needs no state to name.
   */
  onToggleSidebar?: () => void
  testID?: string
}

/** The state, in words, next to the bead that shows it as a shape. */
function stateLabel(presence: PresenceState, lastSeenAt?: number): string {
  if (presence === 'offline') {
    const at = formatClock(lastSeenAt)

    return at ? chatStrings.header.offlineAt(at) : chatStrings.header.offline
  }

  if (presence === 'needsInput') {
    return chatStrings.header.needsInput
  }

  return presence === 'working' ? chatStrings.header.running : chatStrings.header.idle
}

/**
 * The header's round buttons, which are the shared ones.
 *
 * They are `opaque` for the reason the pill is, and it has to be all three or
 * none: these are the same row of floating controls over the same scrolling
 * transcript, and a row where one element hides what is behind it and two do
 * not reads as three different materials rather than as one chrome.
 *
 * `RoundIconButton` used to be a copy living here. It moved to `ui/primitives`
 * when the composer's `+` and send turned out to be the same control drawn a
 * fourth and a fifth way — with a CHARACTER in the middle instead of a path,
 * which is what put both of them visibly low in their circles in a browser.
 *
 * The alias stays so every call site in this file still reads as a header
 * button, and so the default ink is stated once: `colors.accentText` used to be
 * one blue per scheme whatever preset was on, so under Lime a chevron was the
 * only blue thing on the screen. It is derived from the theme's accent now.
 */
function RoundButton(props: RoundIconButtonProps) {
  return <RoundIconButton opaque {...props} />
}

/**
 * The sidebar control on its own, for a column that has no header to put it in.
 *
 * The wide layout's empty state — before a chat has been picked — is the case: no
 * chat means no `ChatHeader`, which would leave hiding the list reachable only from
 * a keyboard. It is the same `RoundButton` and the same label rather than a second
 * button that looks like this one, so the two cannot drift apart.
 */
export function SidebarToggleButton({ onPress }: { onPress: () => void }) {
  return (
    <RoundButton
      icon="sidebar"
      label={chatStrings.header.hideSidebar}
      onPress={onPress}
      size={CONTROL_SIZE.regular}
      testID="chat-header-sidebar"
    />
  )
}

/** The pill will not be narrower than this, whatever the bot is called. */
export const PILL_MIN_TEXT_WIDTH = 96

/**
 * The pill's text column, as a NUMBER rather than as whatever Yoga makes of it.
 *
 * The status line has been out of the pill's intrinsic width since it was made
 * absolute, and the owner still reported the pill changing size while a bot
 * thinks. Reasoning about why is the wrong move at that point: "the status
 * cannot widen the pill" is an argument about Yoga's box model, and it has to
 * hold on four targets, one of which composites the surface natively and
 * another of which draws it as a line-clamped `-webkit-box`. An argument that
 * has to be re-made per platform is not an invariant.
 *
 * So the width stops being derived at all. Both lines are measured off copies
 * nothing constrains, and the column is given the wider of them as an EXPLICIT
 * width. From then on the only things that can change it are the bot being
 * renamed and the header changing size — not a status, not a font fallback, not
 * a native surface re-measuring itself between frames.
 *
 * `measuredSecondary` is the second line's ruler and is 0 until it answers,
 * which is also the whole of the case where the bot has no second name: there
 * is no second ruler, so the name decides alone, exactly as R4 had it.
 *
 * `available` is how much room the text column actually has — the space left
 * between the header's buttons, less the pill's own furniture. 0 means nobody
 * has measured yet, and an unmeasured cap is no cap: a column briefly wider
 * than its header is a frame of overflow, while a column clamped to 0 is a pill
 * with no words in it.
 *
 * `floor` is the minimum a pill may be, for a bot called `Al`. Before any
 * measurement lands the answer is the floor, which is what the column already
 * did.
 */
export function pillTextWidth(
  measuredName: number,
  measuredSecondary: number = 0,
  available: number = 0,
  floor: number = PILL_MIN_TEXT_WIDTH
): number {
  const wanted = Math.max(Math.ceil(measuredName), Math.ceil(measuredSecondary), floor)

  return available > 0 ? Math.min(wanted, Math.floor(available)) : wanted
}

/**
 * The status the second line reserves room for: the longest one, once.
 *
 * R4's rule is that the pill does not move while the bot works, and the second
 * line now carries the thing that changes. Measuring whichever status is current
 * would hand that change straight back to the width, so the ruler is given the
 * widest of the labels the bot cycles through and the real line is elided inside
 * it. Longest is counted in CHARACTERS, which is a proxy — but a stable one, and
 * a ruler that is occasionally a few points generous is a pill that is
 * occasionally a few points wide. A ruler that moves is the bug.
 */
export function widestStatus(candidates: readonly string[]): string {
  return candidates.reduce((widest, candidate) => (candidate.length > widest.length ? candidate : widest), '')
}

/** Between the two halves of the second line, and inside the ruler that measures it. */
const SEPARATOR = ' · '

/**
 * The pill's second line: the bot's other name, then what it is doing.
 *
 * The status half is faded out and back when the words change, and the value
 * shown is state rather than the prop, because the swap has to happen at the
 * bottom of the fade and not when the render arrives. Under Reduce Motion both
 * halves are zero-length and the completion still runs, so the words still change —
 * which is the rule `motion.ts` states about a skipped animation being a skipped
 * callback.
 *
 * The `lead` — the handle — is deliberately OUTSIDE the animated view. It does
 * not change when the status does, and fading a word out and back every time a
 * tool starts is a flicker the reader has to explain to themselves.
 */
function StatusLine({ lead, line, reduceMotion }: { lead?: string; line: string; reduceMotion: boolean }) {
  const theme = useTheme()
  const [shown, setShown] = useState(line)
  const fade = useRef(new Animated.Value(1)).current
  const latest = useRef(line)

  latest.current = line

  useEffect(() => {
    if (line === shown) {
      return
    }

    const duration = durationFor('press', reduceMotion) / 2

    Animated.timing(fade, { duration, easing: easing.exit, toValue: 0, useNativeDriver: NATIVE_DRIVER }).start(() => {
      setShown(latest.current)
      Animated.timing(fade, { duration, easing: easing.enter, toValue: 1, useNativeDriver: NATIVE_DRIVER }).start()
    })
  }, [fade, line, reduceMotion, shown])

  return (
    /*
      A row as tall as one `meta` line, holding a row that is absolutely
      positioned inside it. That is what keeps the status out of the pill's width:
      an absolutely positioned child does not contribute to its parent's intrinsic
      size, so the longest tool name in the world cannot widen this.
    */
    <View style={{ height: theme.type.meta.lineHeight }} testID="chat-header-status">
      <View style={{ alignItems: 'center', flexDirection: 'row', left: 0, position: 'absolute', right: 0, top: 0 }}>
        {/*
          The handle does not shrink, and the status does. That is the whole of
          the truncation order: the status is the only child with any give, so a
          line too long for its room loses the end of `Running terminal…` and
          keeps `techsupport` whole. `maxWidth` is what stops a handle longer
          than the pill from running out of it — it ellipsises at the rim
          instead, having already taken every point there was.
        */}
        {lead ? (
          <Text
            color="textFaint"
            numberOfLines={1}
            style={{ flexShrink: 0, maxWidth: '100%' }}
            testID="chat-header-handle"
            variant="meta"
          >
            {lead}
          </Text>
        ) : null}
        <Animated.View style={{ flexShrink: 1, opacity: fade }} testID="chat-header-status-fade">
          <Text color="textFaint" numberOfLines={1} variant="meta">
            {lead && shown ? `${SEPARATOR}${shown}` : shown}
          </Text>
        </Animated.View>
      </View>
    </View>
  )
}

export function ChatHeader({
  name,
  secondaryName,
  avatarUri,
  presence = 'online',
  lastSeenAt,
  subtitle,
  accentFill,
  onBack,
  onOpenOptions,
  onOpenProfile,
  onOpenConversations,
  onToggleSidebar,
  testID = 'chat-header'
}: ChatHeaderProps) {
  const theme = useTheme()
  const ring = accentFill ?? theme.accent().fill
  const size = CONTROL_SIZE.regular
  /*
    The name's own width, measured off a copy nothing constrains.

    It is reset to 0 when the NAME changes, which is the one thing that may
    move the pill: a roster that arrives late renames `researcher` to
    `Researcher`, and a width measured for the old one would clip the new.
    Nothing else resets it, which is the whole point — see `pillTextWidth`.
  */
  const [nameWidth, setNameWidth] = useState(0)
  /*
    The second line's own width, measured the same way — and 0 for a bot with no
    second name, which is also how the pill behaved before it had one.
  */
  const [secondaryWidth, setSecondaryWidth] = useState(0)
  /*
    How much room the text column has, which is not a constant.

    The centring column sits between the leading group and the trailing one and
    takes what is left, so its width IS "the space between the buttons" — for
    this window, this shell, and whichever buttons this surface put in the row.
    Less the pill's own furniture, which is the only part that can be written
    down: the avatar plus the gap in front of it and the padding either side.
  */
  const [roomWidth, setRoomWidth] = useState(0)
  const chrome = theme.space.xs + AVATAR_SIZE.header + theme.space.sm + theme.space.md
  const measuredFor = useRef(name)

  if (measuredFor.current !== name) {
    measuredFor.current = name
  }
  const state = stateLabel(presence, lastSeenAt)
  /*
    The other name AND what the bot is doing, on one line.

    `subtitle` used to replace this line wholesale, and since `subtitleFor`
    answers for every connection state it always did — so the second name was
    unreachable in the app. The override now replaces only the STATE half, which
    is what it was always describing, and the name in front of it survives.
  */
  const status = subtitle ?? state
  /*
    What the second ruler carries: the handle, and room for the widest state the
    bot can reach rather than the one it is in. `subtitle` is deliberately not a
    candidate — it is the half that elides.
  */
  const rulerLine = secondaryName
    ? `${secondaryName}${SEPARATOR}${widestStatus([
        chatStrings.header.idle,
        chatStrings.header.running,
        chatStrings.header.needsInput,
        stateLabel('offline', lastSeenAt)
      ])}`
    : ''
  const measured = nameWidth > 0 || secondaryWidth > 0

  return (
    <View
      pointerEvents="box-none"
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
      testID={testID}
    >
      {/*
        The leading group. Back belongs to a stack and the sidebar control belongs
        to a window, so the two are never both here: the compact shell passes
        `onBack` and no `onToggleSidebar`, and the wide shell the other way round.
      */}
      {onBack ? (
        <RoundButton
          icon="chevronLeft"
          label={chatStrings.header.back}
          onPress={onBack}
          size={size}
          testID="chat-header-back"
        />
      ) : null}

      {onToggleSidebar ? (
        <RoundButton
          icon="sidebar"
          label={chatStrings.header.hideSidebar}
          onPress={onToggleSidebar}
          size={size}
          testID="chat-header-sidebar"
        />
      ) : null}

      {/*
        The pill. It floats CENTRED between the two buttons rather than filling the
        row, which is what makes the gaps on either side of it real gaps that the
        transcript shows through — the whole point of the reference.

        The air around its contents is deliberate and is the other half of what the
        owner asked for: the avatar, the name and the buttons were crowded together
        in the old bar. `space.sm` between the buttons and the pill, `space.sm`
        inside it, and the pill's own horizontal padding is a full `space.md` on the
        trailing side so the name is not against the rim.
      */}
      <View
        onLayout={event => setRoomWidth(event.nativeEvent.layout.width)}
        pointerEvents="box-none"
        style={{ alignItems: 'center', flex: 1 }}
        testID={`${testID}-room`}
      >
        {/*
          The rulers: each line at the same type token, laid out with nothing
          around it and nothing to shrink against, so what they report is each
          line's OWN width rather than the width it was given.

          Absolutely positioned inside the centring column and not inside the
          pill, because a measurement taken inside the box it decides the size
          of is a measurement that measures itself. Invisible, inert and hidden
          from assistive technology: the real lines two levels down are the ones
          that get read out.
        */}
        <View
          accessibilityElementsHidden
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          key={name}
          onLayout={event => setNameWidth(event.nativeEvent.layout.width)}
          pointerEvents="none"
          style={{ left: 0, opacity: 0, position: 'absolute', top: 0 }}
          testID={`${testID}-ruler`}
        >
          <Text variant="chatName">{name}</Text>
        </View>

        {rulerLine ? (
          <View
            accessibilityElementsHidden
            aria-hidden
            importantForAccessibility="no-hide-descendants"
            key={rulerLine}
            onLayout={event => setSecondaryWidth(event.nativeEvent.layout.width)}
            pointerEvents="none"
            style={{ left: 0, opacity: 0, position: 'absolute', top: 0 }}
            testID={`${testID}-ruler-secondary`}
          >
            <Text variant="meta">{rulerLine}</Text>
          </View>
        ) : null}

        {/*
          The pill is the way into the bot's profile, which is why the whole of
          it is the target rather than the avatar alone: the avatar is 38pt, the
          name beside it is the thing a reader points at, and two adjacent
          targets that do the same thing is one target drawn twice.

          `Pressable` OUTSIDE the glass rather than an `onPress` through it: the
          surface draws the blur and the shadow and has no press state of its
          own, and wrapping is what keeps the pressed opacity on everything the
          reader sees move.
        */}
        <Pressable
          accessibilityLabel={chatStrings.header.profile(name)}
          accessibilityRole="button"
          disabled={!onOpenProfile}
          onPress={onOpenProfile}
          style={({ pressed }) => ({ maxWidth: '100%', opacity: pressed ? 0.7 : 1 })}
          testID={`${testID}-profile`}
        >
          {/*
            `opaque`, for the reason `AttachMenu` gives.

            The pill floats over the transcript rather than beside it: the chat
            column scrolls UNDER the header, so whatever bubble is passing
            behind it is the pill's backdrop. At the control wash's own alpha
            that backdrop reaches the ink, and a long reply read through the
            bot's name — two strings of text at the same weight in the same
            place, which is exactly the failure the attach menu had. The solid
            rung under the wash makes the pill's contrast a fixed number
            instead of a function of what happens to be scrolling past.

            The bead already assumed this: its ring is `glass.control.solid`,
            which only matches the surface it sits on once the surface takes
            that rung.
          */}
          <GlassSurface
            contentStyle={{
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.sm,
              paddingLeft: theme.space.xs,
              paddingRight: theme.space.md,
              paddingVertical: theme.space.xs
            }}
            contentTestID={`${testID}-pill-surface`}
            opaque
            radius={theme.radii.pill}
            shadow="float"
            style={{ maxWidth: '100%' }}
            testID={`${testID}-pill`}
            variant="control"
          >
            {/* The ring is the chat's colour; the bead is the bot's state. Two facts,
              two marks, so neither has to carry the other. */}
            <View>
              <Avatar
                name={name}
                size={AVATAR_SIZE.header}
                style={{ borderColor: ring, borderWidth: 2 }}
                {...(avatarUri ? { uri: avatarUri } : {})}
              />
              <View style={{ bottom: -1, position: 'absolute', right: -1 }}>
                <PresenceBead ringColor={theme.glass.control.solid} size={BEAD_SIZE.inline} state={presence} />
              </View>
            </View>

            {/*
            Neither line contributes a width here, which is the whole of the rule
            above: the name is clamped to one line and the second line is
            absolutely positioned. The rulers decide, and `minWidth` is the floor
            under a bot whose two lines are both short.
          */}
            <View
              style={{
                flexShrink: 1,
                minWidth: PILL_MIN_TEXT_WIDTH,
                // Once a ruler has answered, the column stops being sized by its
                // contents at all. A status can no longer reach the width by any
                // route on any platform.
                ...(measured
                  ? { width: pillTextWidth(nameWidth, secondaryWidth, roomWidth > 0 ? roomWidth - chrome : 0) }
                  : {})
              }}
              testID={`${testID}-text`}
            >
              <Text accessibilityRole="header" aria-level={1} numberOfLines={1} variant="chatName">
                {name}
              </Text>
              <StatusLine
                line={status}
                reduceMotion={theme.reduceMotion}
                {...(secondaryName ? { lead: secondaryName } : {})}
              />
            </View>
          </GlassSurface>
        </Pressable>
      </View>

      <GlassGroup spacing={theme.space.sm} style={{ flexDirection: 'row', gap: theme.space.sm }}>
        {/*
          Left of `(…)`, because it is the same kind of control — chrome that
          opens something about this chat — rather than an item inside the
          menu. One meaning, whatever the layout: the sheet below the
          breakpoint (Task 6), the column toggle above it (Task 7).
        */}
        {onOpenConversations ? (
          <RoundButton
            icon="chats"
            label={chatStrings.conversations.columnTitle}
            onPress={onOpenConversations}
            size={size}
            testID="chat-header-conversations"
          />
        ) : null}
        <RoundButton
          icon="ellipsis"
          label={chatStrings.header.options}
          onPress={onOpenOptions}
          size={size}
          testID="chat-header-options"
        />
      </GlassGroup>
    </View>
  )
}
