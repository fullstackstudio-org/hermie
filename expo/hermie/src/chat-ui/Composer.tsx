/**
 * The message composer: "+" on the left, a rounded multiline field, and one
 * round button on the right that is blue-send while idle and red-stop while a
 * turn runs.
 *
 * Three deliberate choices:
 *   - The draft is controlled from outside. A chat's draft belongs to the chat,
 *     survives navigating away, and is what the store persists.
 *   - Keyboard avoidance uses `KeyboardAvoidingView`, not a keyboard-controller
 *     library: ADR-0010 keeps every gesture library out of the chat surface.
 *   - The slash popover is fed by props. The composer asks (`onQuerySlash`) and
 *     paints what it is given; it never calls the gateway itself.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  Image,
  KeyboardAvoidingView,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  type TextInputKeyPressEventData,
  type TextInputSelectionChangeEventData,
  type TextInputSubmitEditingEventData,
  TextInput,
  View
} from 'react-native'

import { attachPasteListener } from '../platform/composer-paste'
import type { DroppedFile } from '../platform/file-drop'
import { hasHardwareKeyboard, isShiftDown } from '../platform/keyboard-modifiers'
import { HAS_NATIVE_PASTEBOARD, readPasteboardAttachment } from '../platform/native-paste'
import { RUNS_ON_MAC } from '../platform/runs-on-mac'
import { growToContent, ONE_ROW } from '../platform/text-field-web'
import { GlassGroup, GlassSurface } from '../ui/glass'
import { Appear } from '../ui/Appear'
import { Icon, ICON_SIZE } from '../ui/Icon'
import { KEYBOARD_AVOID_BEHAVIOR } from '../ui/keyboard'
import { RoundIconButton, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { CONTROL_SIZE, TAP_SLOP } from '../ui/tokens'
import { useEscapeKey } from '../ui/useEscapeKey'
import { useFocusRing } from '../ui/useFocusRing'
import { useShortcut } from '../ui/useShortcut'
import { AttachMenu } from './AttachMenu'
import { FileChip } from './FileChip'
import { QueuedChip } from './QueuedChip'
import { revertStrayPasteText, type PasteSnapshot } from './paste-revert'
import { SEND_ECHO_WINDOW_MS, withoutSentText } from './send-echo'
import { shouldSend } from './send-key'
import { chatStrings } from './strings'
import type { AttachChoice, ComposerAttachment, ComposerDictation, SlashFailure, SlashSuggestion } from './types'

export interface ComposerProps {
  /** Controlled draft. */
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => void
  /** A turn is running: the send button becomes a stop square. */
  running?: boolean
  /**
   * The gateway cannot carry a send yet, so the round button is dimmed.
   *
   * Everything ELSE stays live: the field takes text, the draft is kept, the
   * slash list still answers. That asymmetry is the point — a reconnect is a
   * good moment to write the next message and a bad moment to try to send it,
   * and a composer that refuses the keyboard as well says "come back later" to
   * somebody who is already here.
   *
   * It does not disable STOP. A turn that was running when the socket went is
   * still the reader's to interrupt the moment it comes back.
   */
  sendBlocked?: boolean
  onStop?: () => void
  onAttach?: () => void
  /**
   * Attach an arbitrary FILE rather than an image.
   *
   * Reached from the `+` menu's second entry, not from a long press. A long press
   * was a placeholder and it was the wrong shape twice over: it is invisible, so
   * it had to be announced in an accessibility hint nobody hears, and it made the
   * two roads a file and an image travel by (an HTTP upload the prompt references
   * versus base64 over the socket) look like one control with a secret.
   */
  onAttachFile?: () => void
  /**
   * An image or a file arrived on the general pasteboard while the field held
   * the caret — ⌘V in a browser tab, or the same chord read off the hardware
   * keyboard's HID state on the Mac and on an iPad in a case. Absent leaves both
   * seams wired to nothing, which is the honest state for a caller with nowhere
   * to put an attachment.
   *
   * Never fired for a plain-text paste: both platforms decide that BEFORE this
   * would run, and text lands in the field the ordinary way either time.
   */
  onPasteFiles?: (files: DroppedFile[]) => void
  /**
   * The system picker is being presented.
   *
   * The caller sets it around its own `await`, because only the caller knows when
   * the picker is actually up. The chosen menu entry stays busy until then — see
   * `AttachMenu` for the two seconds this exists to account for.
   */
  attachBusy?: 'photo' | 'file' | null
  attachments?: ComposerAttachment[]
  onRemoveAttachment?: (id: string) => void
  /** Slash candidates for the current prefix; the caller fetches them. */
  suggestions?: SlashSuggestion[]
  onQuerySlash?: (prefix: string) => void
  /**
   * The completion call that would not answer, when the last one did not.
   *
   * The popover used to open only on `suggestions.length > 0`, so a gateway
   * that refused `commands.catalog` and `complete.slash` drew NOTHING: the
   * owner typed `/` on his phone, saw an empty composer, and the same build
   * showed the list on the web and on the simulator. An empty list and a
   * refused call look identical from the outside and they are not the same
   * thing, so the refused one says so.
   */
  slashFailure?: SlashFailure | null
  /**
   * A first catalogue fetch is still in the air.
   *
   * Only the FIRST: every later keystroke is answered from a catalogue that is
   * already in memory, and a row that blinked on each of them would be noise.
   * The composer waits `SLASH_SLOW_MS` before drawing anything, so a gateway
   * that answers promptly never shows it at all — which is what makes the row
   * mean "this one is slow" rather than "this one is loading".
   */
  slashLoading?: boolean
  /** A prompt the backend parked behind the running turn. */
  queuedText?: string
  placeholder?: string
  botName?: string
  /**
   * The microphone, as data. Absent removes the control entirely.
   *
   * Everything behind it — the recognizer, the permission dialog, hold-to-talk
   * versus tap-to-toggle, and where the words land in the draft — is
   * `features/voice`, which may import this kit and not the other way round.
   * What is here is a button, a lit state and one line of explanation.
   */
  dictation?: ComposerDictation
  /**
   * A bare Return sends instead of inserting a newline.
   *
   * Defaults to "a Mac window, OR a keyboard is actually attached". It used to be
   * the Mac alone, and the owner's report is what that costs: on an iPad in a
   * keyboard case Enter did nothing useful, while the same build on a Mac sent.
   *
   * The OS is the wrong question and only ever was — it is a proxy for "is there
   * a keyboard". `RUNS_ON_MAC` stays as the first half because a Mac window
   * always has one whether or not GameController has noticed it yet; the second
   * half is the honest question, asked of the HID state (see
   * `src/platform/keyboard-modifiers.ts`). A phone with nothing attached answers
   * false to both and keeps a Return that breaks the line, which is the only way
   * a touch user can write a second one.
   *
   * Evaluated per render rather than once, so a keyboard connected mid-session is
   * picked up on the composer's next render — which is the next keystroke, the
   * next focus or the next turn.
   */
  hardwareKeyboard?: boolean
  /**
   * Wrap the composer in its own `KeyboardAvoidingView`.
   *
   * Off by default. A chat screen already has one around the whole transcript,
   * and two nested avoiding views each add the keyboard's height, which lifted
   * the composer roughly twice as far as it needed to go. The gallery, where
   * the composer stands on its own, is the caller that wants one.
   */
  keyboardAvoiding?: boolean
  testID?: string
}

/**
 * The geometry, and how it stopped being fragile.
 *
 * The first version put all three controls INSIDE one bordered pill: a circle, a
 * "+" and the input, each sized independently under a 28pt corner radius, so the
 * circle sat in the corner's curve and visibly crossed the border. The fix then was
 * to make all three agree on one line box and assert the arithmetic.
 *
 * The mockup's answer is better than the arithmetic: **the buttons are not inside
 * the field at all.** A separate round `+`, a pill field, a separate round send
 * (§6.7 and §4's "round glass controls 38 on the wide layout, 40 on phone"). A
 * button that is not inside the field cannot overflow it, in any theme, at any
 * text size — so the invariant is structural rather than checked.
 *
 * What is left to get right is the FIELD: `COMPOSER_LINE_HEIGHT` is one line of
 * input, and the radius is half the single-line height so the field is a true pill
 * at one line and keeps those same caps as it grows. Not `radii.pill`: a 999pt
 * radius on a four-line field makes both ends full semicircles.
 */
export const COMPOSER_FIELD_INSET = 4
export const COMPOSER_LINE_HEIGHT = 32

/**
 * The leading the field's own text takes.
 *
 * 22, not the body's 25. 25 is a READING leading — chosen so that paragraphs of a
 * reply breathe — and a composer is one line at a time; 22 is the leading a control
 * gets. It is also the number that makes the vertical padding below a WHOLE point,
 * `(32 − 22) / 2`, which matters more than it sounds: the Mac renders this build
 * scaled, so a half-point more space above a line of text than below it is a
 * visibly off-centre placeholder rather than a rounding detail.
 *
 * Stating it at all is the point. Without an explicit leading the field's line box
 * is whatever the platform's font metrics produce — about 20.3pt for 17pt San
 * Francisco, and something else on Android — so the padding that was supposed to
 * centre one line was centring a box nobody had measured.
 */
export const COMPOSER_TEXT_LINE_HEIGHT = 22

/**
 * What iOS adds at the TOP of a MULTILINE field, over and above the padding asked
 * for.
 *
 * A multiline `TextInput` is a `UITextView`, and a `UITextView` lays its text out
 * from the top of its container rather than centring it in the box — so on a field
 * with a `minHeight` the platform's own container inset lands entirely above the
 * first line and the single-line placeholder sits low in the pill. That is the
 * owner's report, and it is why the vertical padding here is not symmetric in the
 * STYLE: the visible gaps are what have to match, and the style has to compensate
 * for the inset to make them.
 *
 * Measured on the iOS 27 simulator during the 2026-09-20 pass — see
 * `docs/platform-notes.md`. A number rather than a guess, and zero would be a
 * perfectly good answer for a platform that adds nothing.
 */
export const COMPOSER_IOS_TOP_INSET = 2

/**
 * Symmetric vertical padding for ONE line in the field.
 *
 * `(field height − line height) / 2` on both sides, with the platform's own top
 * inset taken off the top so that what a reader SEES is even. The field still grows:
 * these are paddings, not a height, so a second line makes the pill taller by
 * exactly one leading and the buttons beside it stay on its bottom edge
 * (`alignItems: 'flex-end'`).
 *
 * A pure function because the assertion is arithmetic — `paddingTop + inset ===
 * paddingBottom` — and arithmetic asserted against a rendered style is the version
 * of this test that passed while the placeholder was visibly low.
 */
export function composerFieldPadding(iosTopInset: number): { paddingBottom: number; paddingTop: number } {
  const even = (COMPOSER_LINE_HEIGHT - COMPOSER_TEXT_LINE_HEIGHT) / 2

  return { paddingBottom: even, paddingTop: Math.max(0, even - iosTopInset) }
}

/**
 * The round controls flanking the field.
 *
 * A Mac window is the wide layout, so it takes the 38pt control; everything else
 * gets the 40pt one, because a phone's primary controls are 44pt targets and 40
 * plus the slop is how the kit reaches that.
 */
export const COMPOSER_ROUND_SIZE = RUNS_ON_MAC ? CONTROL_SIZE.regular : CONTROL_SIZE.compact

/** Half the single-line field height. See the note above. */
export const COMPOSER_FIELD_RADIUS = (COMPOSER_LINE_HEIGHT + 2 * COMPOSER_FIELD_INSET) / 2

/**
 * How tall the field is allowed to grow before it scrolls: six lines.
 *
 * A number rather than a `style` literal because the web has to be TOLD it —
 * a `<textarea>` does not size itself to its content, so the same cap that is a
 * `maxHeight` natively is also the clamp `growToContent` measures against.
 */
export const COMPOSER_MAX_HEIGHT = 132

/**
 * How much composer the attach POPOVER needs before it stops being the right shape.
 *
 * Two round buttons, their labels, the popover's own padding and the gap between
 * them, plus enough composer left over that the popover reads as anchored to one end
 * of it rather than as filling it. Below this the stacked list is the honest answer —
 * which is the owner's own allowance for the phone.
 */
export const ATTACH_POPOVER_MIN_WIDTH = 260

/**
 * How far above the composer the `+` menu's tap catcher reaches.
 *
 * A number rather than `flex: 1` because the catcher is an absolutely
 * positioned child of the composer, which is only as tall as the composer: it
 * has to be told how much of the screen above it to cover. Taller than any
 * phone or tablet in portrait, and off the top of the screen costs nothing
 * because nothing is drawn in it.
 */
export const MENU_BACKDROP_REACH = 4000

/**
 * How long a first catalogue fetch may take before the popover says so.
 *
 * Long enough that a gateway on the same machine — which answers in single
 * milliseconds — never draws the row at all, and short enough that a reader who
 * typed `/` and is staring at nothing gets an answer before they conclude the
 * feature is broken. The report this serves is exactly that conclusion: the
 * same build showed the list on the web and on the simulator and nothing on the
 * owner's phone, and a silent composer gives a reader no way to tell a slow
 * gateway from a refusing one.
 */
export const SLASH_SLOW_MS = 400

/**
 * How long the composer keeps looking for UIKit's own paste to land.
 *
 * The two things that have to agree here are on different clocks and neither
 * one can be waited on: `readPasteboardAttachment` answers over a native
 * bridge, and the field's new value arrives through a React render commit. One
 * look at the moment the bridge answers therefore decides nothing — it is a
 * coin toss on which of the two got there first, and half the time it sees a
 * field UIKit has not touched yet and concludes there was nothing to undo. So
 * the look is repeated until the insertion shows up or this runs out.
 *
 * A hard cap and not a promise of eventual delivery, because the window is a
 * window on the READER too: for as long as it is open, a file reference typed
 * into the field is indistinguishable from one UIKit inserted. Long enough for
 * a bridge hop and a render on a busy machine, short enough that nobody is
 * still inside it by the time they have finished a word.
 */
export const PASTE_REVERT_WINDOW_MS = 300

/**
 * How often it looks, inside that window.
 *
 * Roughly a frame. There is nothing to subscribe to — the value arrives as a
 * prop, and a prop that has not changed does not re-run the handler that is
 * waiting for it — so this polls, and polls cheaply: a string comparison
 * against a ref, stopping the moment it has an answer rather than running the
 * window out.
 */
export const PASTE_REVERT_POLL_MS = 16

/**
 * How tall the completion popover is allowed to get.
 *
 * A constant rather than a `style` literal because the keyboard has to be able
 * to do arithmetic with it: bringing the highlighted row into view is "where is
 * its box, and how much of the list can I see", and the second half of that is
 * this number until the list has been laid out and can report its own.
 */
export const SLASH_POPOVER_MAX_HEIGHT = 220

/**
 * The line the completion list is for, or `null` while there is no list.
 *
 * A LEADING slash and nothing else: `/` in the middle of a sentence is a slash,
 * and `run /clean` is prose. It is the whole typed line rather than the command
 * name, because `complete.slash` completes the ARGUMENT as well once there is
 * one — `/model exa` has to reach the gateway intact for it to answer with the
 * models. A newline ends it: a multi-line draft is a message.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith('/') || text.includes('\n')) {
    return null
  }

  return text
}

export function Composer({
  value,
  onChangeText,
  onSend,
  running = false,
  sendBlocked = false,
  onStop,
  onAttach,
  onAttachFile,
  onPasteFiles,
  attachBusy = null,
  attachments = [],
  onRemoveAttachment,
  suggestions = [],
  onQuerySlash,
  slashFailure = null,
  slashLoading = false,
  queuedText,
  placeholder,
  botName,
  dictation,
  hardwareKeyboard = RUNS_ON_MAC || hasHardwareKeyboard(),
  keyboardAvoiding = false,
  testID = 'composer'
}: ComposerProps) {
  const theme = useTheme()
  const inputRef = useRef<TextInput>(null)
  /*
    The pill draws the focus ring, not the field inside it.

    Same report as the chat list's search box: a browser rings the `<textarea>`,
    which is the text line rather than the control, so the indicator was a
    square-cornered rectangle inside a rounded pill in the system's accent. Both
    halves are no-ops on iOS and Android.
  */
  const fieldFocus = useFocusRing()

  /*
    A browser's own paste event, bound straight to the field's DOM node.

    A no-op everywhere else — `attachPasteListener` is `composer-paste.ts`'s
    native half there, which has no node to bind to — so this runs unconditionally
    rather than behind a platform check of its own. `[onPasteFiles]` rather than
    `[]`: a caller that has not wired an attachment handler gets no listener at
    all, which matters on the platforms where binding one is not free.
  */
  useEffect(() => {
    if (!onPasteFiles) {
      return
    }

    return attachPasteListener(inputRef.current, onPasteFiles)
  }, [onPasteFiles])

  /*
    The field grows with what is in it, on the platform that will not do it.

    A `<textarea>` keeps the height it was given and scrolls; a native
    `TextInput` re-measures itself. So this drives the height from the content
    on every change of the value, and is a no-op everywhere else — see
    `platform/text-field-web.ts`. `useLayoutEffect` rather than `useEffect`
    because the alternative is one painted frame at the old height per keystroke
    that wraps, which is the flicker this is supposed to remove.
  */
  useLayoutEffect(() => {
    growToContent(inputRef.current, COMPOSER_MAX_HEIGHT)
  }, [attachments.length, value])
  const query = useRef(onQuerySlash)

  query.current = onQuerySlash

  /**
   * `value`, read through a ref rather than the prop closed over at render
   * time.
   *
   * The paste shortcut below snapshots `value` the instant ⌘V fires, then asks
   * the pasteboard something asynchronously — and by the time that answer
   * comes back, `value` may already have moved on to a LATER render, the way
   * it does the instant UIKit's own paste inserts a file's path. Reading the
   * prop straight from that handler's closure would still see the value as of
   * ⌘V, which is the snapshot, not the answer to "what does the field say
   * right now" the revert needs. Kept in sync on every render, the same way
   * `query` above is.
   */
  const latestValue = useRef(value)

  latestValue.current = value

  /** The open revert window's next look, or `null` while no window is open. */
  const revertPoll = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Which ⌘V the open revert window belongs to.
   *
   * A counter rather than a flag, because the thing that has to be superseded is
   * sometimes still a promise: a second ⌘V can land before the first one's
   * `readPasteboardAttachment` has answered, and that first answer must not then
   * open a window against a snapshot two pastes old. Every ⌘V takes the next
   * number and everything downstream of one checks the number is still its own,
   * so cancelling is the same act as making the old number stale.
   */
  const pasteGeneration = useRef(0)

  /**
   * Close whatever revert window is open, and disown anything still in flight.
   *
   * Every caller is the same fact said a different way: the field this window
   * was opened against is not the field in front of the reader any more —
   * because the composer is gone, because a second ⌘V replaced the question, or
   * because the draft was sent.
   */
  const closeRevertWindow = useCallback(() => {
    pasteGeneration.current += 1

    if (revertPoll.current !== null) {
      clearTimeout(revertPoll.current)
      revertPoll.current = null
    }
  }, [])

  /*
    A window that outlived the composer would call `onChangeText` for a draft
    nothing is showing any more.
  */
  useEffect(() => closeRevertWindow, [closeRevertWindow])

  /*
    An emptied field is a send: the draft this window was measuring against has
    gone to the gateway, and whatever appears next is a NEW draft. Without this
    a paste whose file reference never landed would keep looking, and a reader
    who starts the next message with a path — or whose next message happens to
    begin the way the sent one did — would watch it be undone into the message
    they already sent.
  */
  useEffect(() => {
    if (value === '') {
      closeRevertWindow()
    }
  }, [closeRevertWindow, value])

  /**
   * The draft as this component knows it right now, which inside one group of
   * events is AHEAD of `value`.
   *
   * Every event in a group runs against the handlers of the render before the
   * group, so a key and a Return that arrive together see a `value` without
   * that key — and sending `value` lost it. Every write this component makes
   * goes through here first, a send empties it (every caller clears its draft
   * in `onSend`), and each commit puts the owner's `value` back as the truth,
   * which also covers an owner that kept the draft or rewrote it.
   */
  const draft = useRef(value)

  useLayoutEffect(() => {
    draft.current = value
  })

  /** Hand the owner a new draft, and remember it until the owner's commit says otherwise. */
  const write = (text: string) => {
    draft.current = text
    onChangeText(text)
  }

  /**
   * The message that just went, while the text view may still report it.
   *
   * A send empties `value` straight away and the `UITextView` only later, and
   * React Native's own event counter can drop that later clear altogether when
   * a key beats it to the view — see `send-echo.ts` for both orderings. Inside
   * this window a change report may still be `sent + expected` with the next
   * key on the end, and `onFieldChangeText` takes the sent part back off.
   *
   * `expected` is what the field should hold, as far as this component has
   * asked for it since the send; `until` is `SEND_ECHO_WINDOW_MS` after the
   * commit that pushed the clear, or the last rewrite, out to the view (see
   * `restartAtCommit` below). Armed on iOS alone — the iPhone, the iPad
   * and the Mac build — because that is the one text view with the counter. A
   * browser's `<textarea>` is written synchronously and Android's field has no
   * such race to lose, so there nothing is ever second-guessed.
   *
   * One known cost, left as it is: a rewrite reaches the view as a new
   * attributed string, and a view that is mid-composition in an input method
   * (Japanese, Chinese) ends that composition when it takes one. That needs a
   * dropped clear AND a composition begun inside the window, and the text
   * itself survives — only the candidate window closes early.
   */
  const echo = useRef<{ sent: string; expected: string; until: number } | null>(null)

  /** The window if it is still open, closing it on the way if it has run out. */
  const openEcho = () => {
    if (echo.current && Date.now() > echo.current.until) {
      echo.current = null
    }

    return echo.current
  }

  /**
   * The field's own `onChangeText`: every report from the text view, taken as
   * an edit — unless it is an echo of the message that just went.
   *
   * The first report that is NOT an echo proves the view has cleared, and from
   * then on nothing is second-guessed until the next send. A rewritten report
   * goes to the owner of the draft like any edit; React Native then pushes it
   * to the view with the newer count, which the view accepts — and if yet
   * another key has beaten that push too, the next report is rewritten the
   * same way, so the two copies converge the moment the reader pauses.
   */
  const onFieldChangeText = (text: string) => {
    const open = openEcho()

    if (open) {
      const rest = withoutSentText(open.sent, open.expected, text)

      if (rest !== null) {
        echo.current = { ...open, expected: rest, until: Date.now() + SEND_ECHO_WINDOW_MS }
        restartAtCommit.current = true
        write(rest)

        return
      }

      echo.current = null
    }

    write(text)
  }

  /*
    A draft this component did not write is the owner's word on what the field
    holds — a failed send putting the message back, a slash command's prefill,
    a dictated sentence, an accepted suggestion, or an owner that kept the draft
    rather than clearing it — and none of those is an empty field with an echo
    still to come. Checked after EVERY commit, because "the owner kept it" is a
    commit in which `value` did not change at all; and in a layout effect rather
    than a passive one, so it has run before the next event can arrive.
  */
  useLayoutEffect(() => {
    if (echo.current && value !== '' && value !== echo.current.expected) {
      echo.current = null
    }
  })

  /**
   * The window counts from the commit that sends the clear (or the rewrite)
   * out, not from the event that asked for it.
   *
   * The push to the view happens in the field's own layout effect, which runs
   * before this one — a child's before its parent's. Counting from the event
   * instead would charge the render in between to the window, and a render
   * slower than the window would close it before the key that raced the clear
   * had even been reported.
   */
  const restartAtCommit = useRef(false)

  useLayoutEffect(() => {
    const current = echo.current

    if (current && current.until === Number.POSITIVE_INFINITY) {
      // A send's window, on the commit `send` forces: its clock starts now.
      echo.current = { ...current, until: Date.now() + SEND_ECHO_WINDOW_MS }
    } else {
      // A rewrite's request is only honoured while its window is still open.
      // Nothing forces a commit after a rewrite — one to the draft the owner
      // already holds changes no state — so the request can outlive it, and a
      // later, unrelated commit must not bring a window that has since run out
      // back to life.
      const open = restartAtCommit.current ? openEcho() : null

      if (open) {
        echo.current = { ...open, until: Date.now() + SEND_ECHO_WINDOW_MS }
      }
    }

    restartAtCommit.current = false
  })

  /**
   * A commit after every send, whatever the owner did with the draft.
   *
   * The two effects above are how the owner's answer to a send is read: a
   * cleared draft, or one it kept. An owner that kept it changes no state, so
   * without this nothing would commit, neither effect would run, and the
   * window would stay open over a field that never emptied — where the next
   * key would read as an echo and take the whole message off.
   */
  const [, committed] = useReducer((count: number) => count + 1, 0)

  /*
    A new owner is a new draft. The wide layout keeps one composer mounted and
    hands it the next chat's draft and setter, so a window opened in one chat
    must not reach the first thing typed in another.
  */
  useLayoutEffect(() => {
    echo.current = null
  }, [onChangeText])

  /**
   * Where the caret is, so a newline can be inserted at it rather than appended.
   *
   * A ref and not state: it changes on every keystroke and nothing renders from
   * it. It starts at the end of the draft, which is where a field opens.
   */
  const selection = useRef({ start: value.length, end: value.length })

  /**
   * A caret position to hand back to the field, until the field has taken it.
   *
   * Setting `value` programmatically moves the caret to the end on iOS, which is
   * wrong for a newline inserted mid-sentence, so `selection` is controlled just
   * long enough to put it where it belongs. It is released on the next
   * `onSelectionChange` — which the field fires BECAUSE the selection changed —
   * so control lasts one round trip rather than for good. A permanently
   * controlled selection fights the caret on every keystroke.
   */
  const [caret, setCaret] = useState<{ start: number; end: number } | undefined>(undefined)

  const prefix = useMemo(() => slashQuery(value), [value])
  const [popoverDismissed, setPopoverDismissed] = useState(false)

  /**
   * Which row the keyboard is on.
   *
   * Back to the first whenever the candidates change, which is on every
   * keystroke that narrows them: keeping an index across two different lists
   * would move the highlight to whatever happened to land in that position.
   */
  const [active, setActive] = useState(0)

  /**
   * The `+` menu, as local state and nothing else.
   *
   * No await, no layout measurement, no animation to wait on: opening it is one
   * `setState`, so it paints in the same frame as the tap. That is the whole
   * requirement — the owner measured 1.5–2 s between tapping `+` and the system
   * picker appearing on the Mac, and a menu that took any of that time would just
   * move the dead air.
   */
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * The composer's own width, for the popover-or-list decision.
   *
   * Measured rather than read off the window: on the wide layout the composer IS the
   * chat column, whose width a collapsed sidebar and an open sheet both change, and
   * a popover that fits the window can still not fit the column. Nothing depends on
   * it before the first layout pass, because the menu only exists after a tap.
   */
  const [rowWidth, setRowWidth] = useState(0)
  /**
   * The composer row's height, which is where the popover's bottom edge goes.
   *
   * The menu used to be an ordinary child ABOVE the row, so opening it added its
   * own height to the composer — and a composer that grows pushes the transcript
   * up, which is the reader's place moving because they tapped `+`. It floats
   * over the transcript now, and floating needs one number: how far up from the
   * composer's bottom edge its own top edge is.
   */
  const [rowHeight, setRowHeight] = useState(0)

  /**
   * Close the menu once the picker has been and gone.
   *
   * It deliberately stays open WHILE `attachBusy` is set — the busy mark on the
   * entry is the only feedback during the second or two UIKit takes to present a
   * picker. It is the falling edge that closes it, so a cancelled picker does not
   * leave the menu standing over the composer.
   */
  const wasBusy = useRef(false)

  useEffect(() => {
    if (attachBusy) {
      wasBusy.current = true

      return
    }

    if (wasBusy.current) {
      wasBusy.current = false
      setMenuOpen(false)
    }
  }, [attachBusy])

  // A dismissed popover stays dismissed only for the prefix it was dismissed on;
  // typing on re-opens it.
  useEffect(() => {
    setPopoverDismissed(false)
  }, [prefix])

  /**
   * A slow first fetch, which is a different fact from an empty list.
   *
   * The timer runs only while a query is genuinely outstanding, and it is torn
   * down on every change of either input — so a gateway that answers inside the
   * window never sets the flag, and one that answers just after it clears it on
   * the same render that fills the list.
   */
  const [slashSlow, setSlashSlow] = useState(false)

  useEffect(() => {
    if (!slashLoading || prefix === null) {
      setSlashSlow(false)

      return
    }

    const timer = setTimeout(() => setSlashSlow(true), SLASH_SLOW_MS)

    return () => clearTimeout(timer)
  }, [prefix, slashLoading])

  /*
    Three reasons to open, and only the first of them is selectable.

    A failure and a slow fetch both open a popover with nothing to accept in it,
    which is why `submit()` and the arrow keys below all read `suggestions`
    rather than this flag: an open popover with no rows must not swallow the
    Return that would have sent the line.
  */
  const slashNotice = prefix !== null && !popoverDismissed && (Boolean(slashFailure) || slashSlow)
  const showSuggestions = prefix !== null && suggestions.length > 0 && !popoverDismissed
  const showPopover = showSuggestions || slashNotice

  useEffect(() => setActive(0), [suggestions])

  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1))

  /**
   * Bringing the highlighted row into view, which the arrow keys could not do.
   *
   * ↑ and ↓ moved the highlight and nothing else, so on a real gateway's
   * thirty-four commands the selection walked straight out of the bottom of the
   * popover and the reader was driving a list they could no longer see. A
   * `ScrollView` cannot be asked to scroll to a CHILD, so the rows report their
   * own boxes and this does the arithmetic.
   *
   * All three are refs: nothing renders from any of them, and a measurement
   * that re-rendered the list would re-measure it.
   */
  const listRef = useRef<ScrollView>(null)
  /** Each row's `{ y, height }` inside the scrolled content, by index. */
  const rowBoxes = useRef<Record<number, { y: number; height: number }>>({})
  /** How much of the list is on screen, from its own layout. */
  const listHeight = useRef(SLASH_POPOVER_MAX_HEIGHT)
  /** Where the list is scrolled to, as the reader or this effect last left it. */
  const listOffset = useRef(0)

  /*
    A new set of candidates is a new set of boxes.

    Index 3 of `/mo` and index 3 of `/model` are different rows at different
    heights, and keeping the old measurement would scroll to where a row used to
    be. `setActive(0)` above already puts the highlight back to the first row on
    the same change, so the pair is consistent: new list, first row, no boxes.
  */
  useEffect(() => {
    rowBoxes.current = {}
    listOffset.current = 0
  }, [suggestions])

  useEffect(() => {
    const box = rowBoxes.current[activeIndex]

    // Before the first layout pass there is nothing to aim at. The next
    // keystroke has boxes, and the row it lands on is the one that matters.
    if (!box || !showSuggestions) {
      return
    }

    const viewport = listHeight.current
    const offset = listOffset.current
    /*
      Two cases and no third. Above the fold, put the row's TOP at the top;
      below it, put the row's BOTTOM at the bottom. A row already fully inside
      the window is left exactly where it is, which is what keeps holding ↓
      through the middle of a long list from scrolling on every step.
    */
    const next = box.y < offset ? box.y : box.y + box.height > offset + viewport ? box.y + box.height - viewport : null

    if (next === null) {
      return
    }

    const y = Math.max(0, next)

    listOffset.current = y
    // Reduce Motion asks for the destination rather than the journey, which is
    // the same call every other animated path in the app makes.
    listRef.current?.scrollTo({ y, animated: !theme.reduceMotion })
  }, [activeIndex, showSuggestions, theme.reduceMotion])

  // The caller decides where the candidates come from (`commands.catalog`,
  // `complete.slash`, a cache); the composer only says which prefix it is on.
  useEffect(() => {
    if (prefix !== null) {
      query.current?.(prefix)
    }
  }, [prefix])

  /**
   * Is there something to send, AND somewhere to send it?
   *
   * Both halves in one value on purpose: `canSend` is already what dims the
   * button, what `press` checks and what the Return key checks, so a blocked
   * connection folded in here reaches all three and cannot be forgotten in one
   * of them.
   */
  const sendable = (text: string, trayUnsent = true) =>
    (Boolean(text.trim()) || (trayUnsent && attachments.length > 0)) && !sendBlocked
  const canSend = sendable(value)

  /**
   * Whether the handlers running now are asking to send what the draft holds
   * NOW, or also the tray.
   *
   * Every handler in one group of events sees the props of the render before
   * the group — the tray included, which the owner only empties once its send
   * has been accepted. So a second send in the same group (a Return and a tap
   * on the button, two Returns around a key) must not count the tray: the
   * first one took it, and counting it again sent the attachments twice. Set
   * by a send and put back by the next commit, which is when the props are
   * the owner's again.
   */
  const sentSinceCommit = useRef(false)

  useLayoutEffect(() => {
    sentSinceCommit.current = false
  })

  /** What a handler can send right now: the draft, and the tray unless this group already sent it. */
  const sendableNow = () => sendable(draft.current, !sentSinceCommit.current)

  /**
   * Put the highlighted candidate in the field.
   *
   * `insert` is the whole line the caller worked out from the gateway's
   * `replace_from`; the fallback is a bare command, which is all that can be
   * assumed without one.
   */
  const accept = (suggestion: SlashSuggestion) => {
    write(suggestion.insert ?? `/${suggestion.name} `)
    inputRef.current?.focus()
  }

  /**
   * Hand the draft over, and shut any open paste-revert window first.
   *
   * The window is also closed when `value` empties, which is what a send
   * normally does to this component — but a send of an attachment with no text
   * at all leaves `value` at the empty string on both sides of it, so that
   * effect never runs and the window would outlive the message. This is the one
   * seam that knows a send happened regardless of what the draft looked like.
   *
   * It is also where the draft is marked as consumed, for the things that
   * could otherwise write it back or send it twice: a change report the text
   * view made before it heard about the send (`echo`, above), a Return it took
   * in the same moment (`onSubmitEditing`), and a dictation session still
   * anchored to it (`ComposerDictation.onSent`). Every caller clears the draft
   * in `onSend` itself, in the same event; one that keeps it is noticed on the
   * next commit, which closes the window before anything is taken off anything.
   *
   * A send from inside an open window stacks onto it: a view that has not
   * heard about the first message holds both, so the new window's `sent` is
   * the two together.
   */
  const send = (text: string = draft.current) => {
    const open = openEcho()

    closeRevertWindow()
    // No deadline yet: the clock starts on the commit this send forces (the
    // `restartAtCommit` effect), however long the render before it takes.
    echo.current =
      Platform.OS === 'ios' && text !== ''
        ? { expected: '', sent: `${open?.sent ?? ''}${text}`, until: Number.POSITIVE_INFINITY }
        : null
    sentSinceCommit.current = true
    draft.current = ''
    dictation?.onSent?.()
    onSend(text)
    committed()
  }

  /**
   * What Enter does: take the highlighted suggestion, or send, or nothing.
   *
   * The list first, and only while it is open — which is the rule every editor
   * has and the one thing that makes a list navigable by keyboard worth having.
   *
   * It deliberately does NOT stop a running turn. On a Mac a bare Return is the
   * send key, and while a reply streamed that same key cancelled the turn — so
   * typing the next message and pressing Return killed the answer being written
   * instead of queueing the message. Sending mid-turn parks the message in the
   * queue; only the red button, and Escape, stop anything.
   *
   * What it sends is `draft`, not `value`: when the last key and the Return
   * reach JavaScript in one group of events, `value` is still a key behind, and
   * sending it lost that key while the field went on to clear.
   */
  const submit = () => {
    if (showSuggestions) {
      const suggestion = suggestions[activeIndex]

      if (suggestion) {
        accept(suggestion)

        return
      }
    }

    if (!sendableNow()) {
      return
    }

    send()
  }

  /**
   * Shift+Return: put a newline where the caret is, by hand.
   *
   * It has to be by hand because the platform was told not to insert one — see
   * `submitBehavior` below — and because iOS cannot tell us which Return this
   * was until we ask the keyboard directly. A selected range is replaced rather
   * than kept, which is what typing any other character would do.
   */
  const insertNewline = () => {
    const current = draft.current
    const start = Math.max(0, Math.min(selection.current.start, current.length))
    const end = Math.max(start, Math.min(selection.current.end, current.length))
    const next = `${current.slice(0, start)}\n${current.slice(end)}`

    write(next)
    selection.current = { start: start + 1, end: start + 1 }
    setCaret({ start: start + 1, end: start + 1 })
  }

  /**
   * The one Return handler, and the only place the two chords are told apart.
   *
   * Cmd+Return sends: nothing here special-cases it, which is the point — the
   * only branch is Shift, so a Return arriving with any other modifier falls
   * through to the send. Whether macOS delivers Cmd+Return to a text view as a
   * Return at all is unverified; if it does, it sends.
   *
   * The decision itself is `shouldSend`, shared with `onKeyPress` below. Only
   * the ACTION differs: here `submitBehavior: 'submit'` already suppressed the
   * insertion, so a newline has to be put in by hand.
   *
   * ## A Return the view took before it heard about the send
   *
   * A second Return — a bouncing key, an impatient double press — can reach the
   * text view before the clear does. It carries the text the view still holds,
   * which is exactly the sent message with nothing typed since, and it is not a
   * request to send anything new: it is dropped, attachments and all. With
   * something typed since, it goes on to `submit`, and what is sent is `draft`
   * — the rewritten next message, never the stale text the event carries.
   */
  const onSubmitEditing = (event?: NativeSyntheticEvent<TextInputSubmitEditingEventData>) => {
    const typed = event?.nativeEvent?.text
    const open = openEcho()

    const decision = shouldSend('Enter', {
      // Reaching this handler at all IS the platform having decided to submit
      // (`submitBehavior`), so the hardware-keyboard half of the table is
      // already answered here and only the modifier is open. Passing the prop
      // through instead would turn a software keyboard's Return — which has
      // ALREADY inserted its newline — into a second one.
      hardwareKeyboard: true,
      shift: hardwareKeyboard && isShiftDown()
    })

    if (decision === 'newline') {
      insertNewline()

      return
    }

    if (open && open.expected === '' && typed === open.sent) {
      return
    }

    submit()
  }

  const onSelectionChange = (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    selection.current = event.nativeEvent.selection
    // Dictation inserts at the caret, so it needs to know where the caret is —
    // and this is the only event that reports it. Told rather than asked,
    // because the binding lives outside the kit.
    dictation?.onSelection(event.nativeEvent.selection.start, event.nativeEvent.selection.end)
    // The field has reported a position of its own, so stop overriding it.
    setCaret(undefined)
  }

  /*
    Where a dictated result leaves the caret.

    Applied on the OBJECT's identity rather than on its numbers: two results in
    a row can land the caret in the same place — a revision of the same length —
    and both are still events that have to move it back off the end of the
    field. The binding allocates one object per result for exactly this.

    It goes through the same `caret` state a Shift+Return does, so control of
    the selection lasts one round trip and is handed back on the next
    `onSelectionChange`. A permanently controlled selection fights the caret on
    every keystroke.
  */
  const dictatedCaret = dictation?.caret

  useEffect(() => {
    if (!dictatedCaret) {
      return
    }

    selection.current = dictatedCaret
    setCaret(dictatedCaret)
  }, [dictatedCaret])

  /**
   * The round button: send whenever there is something to send, stop otherwise.
   *
   * It used to stop the turn whenever one was running, whatever was in the
   * field — so the only way to say something mid-turn was the Return key, and
   * the button under the words you had just typed threw away the reply instead.
   * Sending is always possible; the message is parked behind the running turn
   * (see `QueuedStrip`) and the stop square is what an EMPTY field offers.
   */
  const press = () => {
    if (running && !canSend) {
      onStop?.()

      return
    }

    /*
      SEND, not `submit()`.

      `submit()` puts the slash list first, which is right for a Return — the key
      is ambiguous and the list is what is in front of the caret. A tap on this
      button is not ambiguous: it is the one control in the composer whose only
      meaning is "send this".

      It used to call `submit()`, and on a touch device that was a dead end. Type
      `/model` in full and the list stays open on the exact match, so the button
      re-accepted a suggestion that was already accepted and the message never
      went — with no way out, because the only thing that dismisses the popover is
      Escape and a phone has no Escape. Watched on an iPhone simulator.

      And `draft`, not `value`, for whether there is anything left to send. The
      check above stays on `value` because it is about which button was drawn;
      this one is about the draft, which a Return in the same group of events
      may already have sent — and a tap that then sent the empty string would
      send the tray's attachments a second time (see `sentSinceCommit`).
    */
    if (!sendableNow()) {
      return
    }

    send()
  }

  /** Stop, rather than send: a running turn and nothing typed. */
  const stopping = running && !canSend

  /**
   * Modifier chords, for any platform that reports them.
   *
   * Read this together with `submitBehavior` below, because "Enter sends" is
   * spread over three places and none of them is obvious on its own.
   *
   * `onKeyPress` cannot carry a bare Return on iOS. React Native derives its
   * `key` from the text a `UITextView` is about to insert, and the payload it
   * builds (`TextInputEventEmitter::keyPressMetricsPayload`) is exactly
   * `{ key, eventCount }` — **no `shiftKey`, `metaKey` or `ctrlKey`**. Those
   * flags only ever arrived from react-native-macos, so on the platforms Hermie
   * ships the branches below are a contract rather than a live path: correct if a
   * modifier ever shows up, inert while it does not. `preventDefault` is not what
   * stops a Return landing either — by the time this fires the insertion has been
   * accepted.
   *
   * Escape is NOT handled here. It inserts no text, so it never reaches a text
   * field's delegate on iOS at all; it comes from the keyboard seam instead, via
   * `useEscapeKey` below.
   */
  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const native = event.nativeEvent as TextInputKeyPressEventData & {
      shiftKey?: boolean
      metaKey?: boolean
      ctrlKey?: boolean
    }

    // The same table `onSubmitEditing` uses. Where it says `newline` this site
    // does NOTHING: the insertion has already been accepted, so letting it land
    // IS the newline — which is the one difference between the two callers.
    if (
      shouldSend(native.key, {
        ctrl: native.ctrlKey === true,
        hardwareKeyboard,
        meta: native.metaKey === true,
        shift: native.shiftKey === true
      }) !== 'send'
    ) {
      return
    }

    event.preventDefault?.()
    submit()
  }

  /**
   * Escape, in priority order.
   *
   * The popover is registered second, so while it is open it takes the key and
   * the running turn does not. That ordering is the whole reason `useEscapeKey`
   * is a stack rather than one handler per screen: a sheet opened over this
   * composer registers later still and outranks both.
   */
  useEscapeKey(() => onStop?.(), running)
  /*
    `showPopover`, not `showSuggestions`: a popover holding only the failure row
    is still a popover in front of the caret, and on a Mac Escape is the only
    thing that puts it away. The ORDER is unchanged — the list still outranks
    the running turn — and so is what the key means at each level.
  */
  useEscapeKey(() => setPopoverDismissed(true), showPopover)

  /*
    ↑, ↓ and Tab, from the keyboard seam rather than from the field.

    A `TextInput` only reports keys that insert text — React Native builds its
    `onKeyPress` payload from the text a `UITextView` is about to insert — so an
    arrow key never reaches it at all. These three come down the same road as
    Escape and the desktop shortcuts, and they are registered only while the
    list is open, so nothing else in the app loses an arrow key to them.
  */
  useShortcut('suggestionDown', () => setActive(index => Math.min(index + 1, suggestions.length - 1)), showSuggestions)
  useShortcut('suggestionUp', () => setActive(index => Math.max(index - 1, 0)), showSuggestions)
  useShortcut(
    'suggestionAccept',
    () => {
      const suggestion = suggestions[activeIndex]

      if (suggestion) {
        accept(suggestion)
      }
    },
    showSuggestions
  )
  // Registered last, so while the attach menu is open Escape closes IT and
  // neither the popover nor the running turn sees the key. Esc goes back exactly
  // one level.
  useEscapeKey(() => setMenuOpen(false), menuOpen)

  /**
   * ⌘V on the Mac and on an iPad in a case: the same chord `keyboard-modifiers.ts`
   * reads Shift and Escape off, reported below the responder chain and therefore
   * never intercepting anything — the field's own `UITextView` still runs the
   * ordinary paste for plain text, which is why this never checks `showSuggestions`
   * or any other "is something else open" gate the way the list keys do.
   *
   * `fieldFocus.focused` rather than the event's own `typing`, which only says
   * SOME field has the caret: pasting into a rename dialog or a search box must
   * not pull an image into a different chat's draft. `HAS_NATIVE_PASTEBOARD`
   * keeps this from ever firing on the web, where `attachPasteListener` above is
   * the whole story and a second read of a pasteboard that does not exist here
   * would only be wasted work.
   *
   * ## The snapshot, and why it is taken here rather than never
   *
   * "The ordinary paste for plain text" above is not only for words: a file
   * has a string representation too, once you ask `UIPasteboard` for one — see
   * `paste-revert.ts`'s module comment for why, and why nothing on this seam
   * can stop UIKit from inserting it before this handler's `await` even
   * returns. `before` is the field the instant ⌘V fired, taken synchronously
   * so nothing else can have touched it yet. Once the pasteboard answers with
   * a file, `revertStrayPasteText` is asked what changed since — and only when
   * that span reads as exactly one file reference does it come back out,
   * leaving a plain-text paste, a field nothing touched, and anything the
   * reader typed themselves alone.
   *
   * ## Why it looks more than once
   *
   * The pasteboard answering and the field reporting UIKit's insertion are two
   * independent arrivals, and this handler is downstream of only one of them:
   * `latestValue` moves when React commits a render from `onChangeText`, which
   * has no relationship to when a native bridge call resolves. Asking once, at
   * the moment the bridge answers, therefore gets the right answer only for the
   * ordering where the render won the race — and in the other ordering it sees
   * an untouched field, concludes there is nothing to undo, and leaves the path
   * on screen. That is the reported bug, not a rare edge of it.
   *
   * So the look is repeated over `PASTE_REVERT_WINDOW_MS`, and it is the shape
   * guard in `revertStrayPasteText` rather than the timing that keeps repeating
   * it safe: every look that finds anything other than one bare file reference
   * declines, so a reader typing through the window is never the thing that
   * satisfies it. The window stops at the first revert rather than running out,
   * and `closeRevertWindow` above shuts it on every event that makes its
   * snapshot meaningless — unmount, the next ⌘V, and a send — so it can never
   * reach a later draft.
   */
  useShortcut(
    'paste',
    () => {
      if (!onPasteFiles) {
        return
      }

      // This ⌘V supersedes the one before it, whether that one was still
      // looking or still waiting on the bridge.
      closeRevertWindow()

      const generation = pasteGeneration.current
      const before: PasteSnapshot = { end: selection.current.end, start: selection.current.start, value }

      /** When the window opened, which is when the pasteboard answered. */
      let opened = 0

      const look = () => {
        revertPoll.current = null

        if (pasteGeneration.current !== generation) {
          return
        }

        const reverted = revertStrayPasteText(before, latestValue.current)

        if (reverted) {
          write(reverted.value)
          selection.current = { start: reverted.caret, end: reverted.caret }
          setCaret({ start: reverted.caret, end: reverted.caret })

          return
        }

        if (Date.now() - opened >= PASTE_REVERT_WINDOW_MS) {
          return
        }

        revertPoll.current = setTimeout(look, PASTE_REVERT_POLL_MS)
      }

      void readPasteboardAttachment().then(files => {
        if (!files.length) {
          return
        }

        // The files are attached whatever happened to the window: the reader
        // did paste them, and a superseding ⌘V is a second paste rather than a
        // correction of this one.
        onPasteFiles(files)

        if (pasteGeneration.current !== generation) {
          return
        }

        // The window opens when the pasteboard answers, not when ⌘V fired:
        // before that there is no reason to believe a file was involved at all,
        // and every look would be measuring a plain-text paste.
        opened = Date.now()
        look()
      })
    },
    HAS_NATIVE_PASTEBOARD && fieldFocus.focused
  )

  /**
   * What a bare Return does, decided one layer below `onKeyPress`.
   *
   * `submitBehavior` is a real native prop, and on a multiline iOS field it is
   * the ONLY thing that can stop a Return from becoming a newline.
   * `RCTBackedTextInputDelegateAdapter` intercepts a replacement text of exactly
   * `"\n"`, asks the delegate whether to submit, and on `'submit'` fires
   * `onSubmitEditing` and returns `NO` — no newline, no `onKeyPress`, and no
   * blur (only `'blurAndSubmit'` blurs). On `'newline'`, the multiline default,
   * it falls through and the newline lands.
   *
   * So the two modes are mutually exclusive by construction, which is what
   * makes a double send impossible: where Return submits it never reaches
   * `onKeyPress`, and where it inserts a newline `hardwareKeyboard` is false.
   *
   * Shift+Return is what this cannot answer on its own: it inserts the same
   * `"\n"` as Return, so both arrive here identically. `onSubmitEditing` asks the
   * keyboard which one it was — see `insertNewline` above.
   *
   * ## And while the slash list is open, on ANY keyboard
   *
   * `submit()` has always put the list first — take the highlighted suggestion,
   * then send — and on a phone it was never reached: `submitBehavior` was
   * `'newline'`, so Return inserted one and `onKeyPress` declined it, and the
   * only way to take a suggestion without a hardware keyboard was to tap it.
   * Watched on an iPhone simulator: `/mo` narrowed to `/model`, Return put a
   * line break in the field.
   *
   * The list is the thing in front of the caret while it is open, which is why
   * every editor gives it the key. Nothing is taken away from a touch reader:
   * the list only opens on a leading `/`, Escape dismisses it (registered above)
   * and the Return after that breaks the line as it always did.
   */
  const submitBehavior = hardwareKeyboard || showSuggestions ? 'submit' : 'newline'

  /**
   * The two entries, in the order this platform wants them.
   *
   * `Choose file` first on a Mac: a Mac window has a filesystem in front of it and
   * a photo library somewhere behind it, which is the opposite of a phone.
   */
  const choices: AttachChoice[] = (
    RUNS_ON_MAC
      ? ([
          { id: 'file', label: chatStrings.composer.chooseFile },
          { id: 'photo', label: chatStrings.composer.photoLibrary }
        ] as const)
      : ([
          { id: 'photo', label: chatStrings.composer.photoLibrary },
          { id: 'file', label: chatStrings.composer.chooseFile }
        ] as const)
  )
    .filter(choice => (choice.id === 'photo' ? Boolean(onAttach) : Boolean(onAttachFile)))
    .map(choice => ({ ...choice, ...(attachBusy === choice.id ? { busy: true } : {}) }))

  const choose = (id: AttachChoice['id']) => {
    // The menu stays OPEN while the picker is being presented, because the busy
    // mark on the entry is the only feedback there is during those two seconds.
    // It closes when the caller reports the picker is no longer coming up.
    if (id === 'photo') {
      onAttach?.()

      return
    }

    onAttachFile?.()
  }

  // The picker is up or it failed; either way the menu has said all it can.
  const menuVisible = menuOpen && choices.length > 0

  const round = COMPOSER_ROUND_SIZE

  /**
   * Popover or list.
   *
   * Two round buttons with a label under each need about `ATTACH_POPOVER_MIN_WIDTH`
   * of composer to sit in without the labels having to shrink. Below that the old
   * stacked rows are the honest answer rather than a squeezed popover — the owner's
   * own allowance for the phone. It is the COMPOSER's width that decides, not the
   * window's: on the wide layout the composer is the chat column, which a collapsed
   * sidebar and an open sheet both change.
   */
  const menuLayout = rowWidth > 0 && rowWidth < ATTACH_POPOVER_MIN_WIDTH ? 'list' : 'popover'

  return (
    // Without `behavior` a `KeyboardAvoidingView` is a plain `View`, which is
    // exactly what the composer wants inside a screen that already has one.
    // Declaring the component conditionally instead would give React a new
    // type on every render and remount the text field under the caret.
    <KeyboardAvoidingView behavior={keyboardAvoiding ? KEYBOARD_AVOID_BEHAVIOR : undefined} testID={testID}>
      {/*
        It drops DOWN onto the field it belongs to — a negative rise — because it
        is anchored above the composer and a list that rose from below would
        appear to come out of the wrong control.
      */}
      <Appear exit="cut" rise={-8} visible={showPopover}>
        <GlassSurface
          contentStyle={{ maxHeight: SLASH_POPOVER_MAX_HEIGHT }}
          radius={theme.radii.card}
          shadow="float"
          style={{ marginBottom: theme.space.sm, marginHorizontal: theme.space.md }}
          testID="composer-slash-popover"
          variant="float"
        >
          <ScrollView
            keyboardShouldPersistTaps="handled"
            onLayout={event => {
              listHeight.current = event.nativeEvent.layout.height
            }}
            // The reader's own scrolling counts too: the next arrow key has to
            // reason from where the list actually is, not from where this
            // component last put it.
            onScroll={event => {
              listOffset.current = event.nativeEvent.contentOffset.y
            }}
            ref={listRef}
            scrollEventThrottle={16}
            testID="composer-slash-list"
          >
            {/*
              Not a `Pressable`, and deliberately so: there is nothing to accept
              here, and a row that highlighted under a finger would be offering
              one. It is a plain `View` with the danger tint's readable ink, which
              is the same hierarchy decision §3 makes about a danger TINT versus
              the saturated fill — this is a sentence, not a status mark.
            */}
            {slashFailure ? (
              <View
                style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm + 2 }}
                testID="slash-failure"
              >
                <Text color="dangerText" variant="name">
                  {chatStrings.composer.slashUnavailable(slashFailure.method)}
                </Text>
                <Text color="textFaint" variant="meta">
                  {slashFailure.reason}
                </Text>
              </View>
            ) : null}

            {/*
              Only while nothing has arrived. A failure is the more specific
              answer to the same question, so the two never draw together.
            */}
            {!slashFailure && slashSlow ? (
              <View
                style={{ paddingHorizontal: theme.space.lg, paddingVertical: theme.space.sm + 2 }}
                testID="slash-loading"
              >
                <Text color="textMuted" variant="name">
                  {chatStrings.composer.slashLoading}
                </Text>
              </View>
            ) : null}

            {suggestions.map((suggestion, index) => (
              <Pressable
                accessibilityRole="button"
                // The keyboard's own place in the list, announced rather than
                // only drawn: the row is selected in the same sense a picker's
                // row is.
                aria-selected={index === activeIndex}
                key={suggestion.name}
                // Its own box, so the keyboard can bring it into view. Measured
                // rather than assumed: a row is a command and a description,
                // and a description that wraps makes it taller than its
                // neighbours.
                onLayout={event => {
                  const { height, y } = event.nativeEvent.layout

                  rowBoxes.current[index] = { height, y }
                }}
                onPress={() => accept(suggestion)}
                style={({ pressed }) => ({
                  backgroundColor: pressed || index === activeIndex ? theme.tintSunk : 'transparent',
                  gap: 1,
                  paddingHorizontal: theme.space.lg,
                  paddingVertical: theme.space.sm + 2
                })}
                testID={`slash-option-${suggestion.name}`}
              >
                <Text variant="name">{`/${suggestion.name}`}</Text>
                <Text color="textFaint" variant="meta">
                  {suggestion.description}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </GlassSurface>
      </Appear>

      {/*
        A tap anywhere else puts the menu away, and "anywhere else" is mostly the
        transcript — which is not this component's to listen to. So the catcher
        is a transparent sheet of this component's own, parked above the composer
        and reaching further up than any phone is tall.

        It is rendered BEFORE the popover and behind it, so the popover's own
        buttons are still the ones that get the tap.
      */}
      {menuVisible ? (
        <Pressable
          accessibilityElementsHidden
          // `aria-hidden` is the web's spelling of the two props around it; react-native-web
          // honours neither of those. See `ui/Icon.tsx`.
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => setMenuOpen(false)}
          style={{ bottom: rowHeight, height: MENU_BACKDROP_REACH, left: 0, position: 'absolute', right: 0 }}
          testID="composer-attach-backdrop"
        />
      ) : null}

      {/*
        Absolute, so it is drawn over the transcript rather than laid out above
        it. `bottom` is the row's measured height, which puts the popover's lower
        edge — and the pointer hanging off it — exactly on the row's top edge,
        over the `+`.

        `box-none` on the wrapper: it spans the whole width and would otherwise
        swallow the taps the backdrop underneath it exists to catch.
      */}
      <View
        pointerEvents="box-none"
        style={{ bottom: rowHeight, left: 0, paddingHorizontal: theme.space.md, position: 'absolute', right: 0 }}
        testID="composer-attach-layer"
      >
        {/*
          It comes UP out of the button it belongs to, and it sinks back into it.

          The travel is the whole of what says where this menu came from, now that
          the popover has no tail — so unlike the slash list, which `cut`s because
          its reason has resolved, this one animates BOTH ways. A menu that vanishes
          on the frame it is dismissed leaves the reader's eye with nowhere to go
          back to, which is the same complaint the tail was there to answer.

          `exit` is therefore the default `fade`, which keeps the surface mounted
          for one exit and forces its `pointerEvents` to `none` while it leaves, so
          the tap that dismissed it cannot be taken twice. Under Reduce Motion the
          duration is zero on both sides (`usePresence`), which puts the hard cut
          back for the reader who asked for one.
        */}
        <Appear rise={8} testID="composer-attach-appear" visible={menuVisible}>
          <AttachMenu choices={choices} layout={menuLayout} onChoose={choose} />
        </Appear>
      </View>

      <View
        onLayout={event => {
          setRowWidth(event.nativeEvent.layout.width)
          setRowHeight(event.nativeEvent.layout.height)
        }}
        style={{ paddingBottom: theme.space.sm, paddingHorizontal: theme.space.md, paddingTop: theme.space.sm }}
        testID="composer-row"
      >
        {/*
          Three separate controls, not one box: a round `+`, the pill field, and
          the round send. `GlassGroup` is what lets iOS 26 merge them where they
          are close enough, the way its own toolbars do.
        */}
        <GlassGroup
          spacing={theme.space.sm}
          style={{ alignItems: 'flex-end', flexDirection: 'row', gap: theme.space.sm }}
        >
          {/*
            The `+` is a drawn path now, and the button is the shared one.

            It was a `Text` holding the character, centred by its LINE BOX —
            which is not where the ink is: a font places a glyph by its ascent
            and descent, so `+` sat about two points low in a 40pt circle. In a
            browser that is plainly visible. `src/ui/Icon.tsx` opens with the
            same argument about the tab strip.
          */}
          <RoundIconButton
            disabled={choices.length === 0}
            expanded={menuVisible}
            icon="plus"
            label={chatStrings.composer.attach}
            onPress={() => setMenuOpen(current => !current)}
            size={round}
            testID="composer-attach"
            tint={theme.colors.textMuted}
          />

          <GlassSurface
            contentStyle={{
              // A COLUMN now, not a row: whatever is attached sits above the
              // caret inside the same pill. The row that used to be here is the
              // inner one below, so the field's own geometry is unchanged for a
              // message with no attachments.
              paddingHorizontal: COMPOSER_FIELD_INSET + 6,
              paddingVertical: COMPOSER_FIELD_INSET
            }}
            radius={COMPOSER_FIELD_RADIUS}
            shadow="float"
            style={{ flex: 1, ...fieldFocus.ringStyle }}
            testID={`${testID}-field`}
            variant="float"
          >
            {/*
              The tray, INSIDE the field.

              It used to sit above the composer row, as a strip of its own. The owner's
              reference is iMessage: what is attached is attached to the MESSAGE, and a
              message is the pill you are typing in — so a thumbnail or a chip sits at
              the top of the field with the caret under it, and the whole thing grows
              and shrinks as one control. A tray floating above the pill reads as a
              staging area beside the message rather than as part of it.

              Images are thumbnails, files are chips, and they sit side by side —
              §6.7. A chip carries its own upload state, which is how a rejected file
              says "Too large · 100 MB max" instead of vanishing.
            */}
            {attachments.length ? (
              /*
                "Not sent yet".

                The tray's cards are deliberately the SAME cards a sent message
                shows, which is what made the state ambiguous: the owner could
                not tell an attached file from one already on its way. So the
                tray says which it is, in words, and carries an accent rule down
                its left edge — a state marker, not a container. It stays inside
                the field: the tray belongs to the message being written, and
                lifting it back out into a strip of its own is the shape this
                composer deliberately moved away from.
              */
              <View
                style={{
                  borderLeftColor: theme.colors.accentText,
                  borderLeftWidth: 2,
                  gap: theme.space.xs,
                  marginBottom: theme.space.xs,
                  paddingLeft: theme.space.sm
                }}
                testID="composer-attachments-pending"
              >
                <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
                  <Text style={{ color: theme.colors.accentText, fontSize: 12, lineHeight: 14 }}>{'📎'}</Text>
                  <Text style={{ color: theme.colors.accentText, fontWeight: '600' }} variant="micro">
                    {chatStrings.composer.notSentYet}
                  </Text>
                  <Text color="textFaint" variant="micro">
                    {`· ${chatStrings.composer.pendingCount(attachments.length)}`}
                  </Text>
                </View>

                <ScrollView
                  // No horizontal padding of its own: the field's inset already places
                  // it, and a second one would step the thumbnails in from the caret
                  // below them.
                  contentContainerStyle={{ alignItems: 'flex-end', gap: theme.space.sm }}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  // A horizontal ScrollView defaults to `flexGrow: 1`, which inside a
                  // column makes it as tall as the viewport. Learned on the gallery.
                  style={{ flexGrow: 0, maxHeight: 76 }}
                  testID="composer-attachments"
                >
                  {attachments.map(attachment =>
                    attachment.kind === 'image' && attachment.uri ? (
                      <View key={attachment.id} style={{ height: 64, width: 64 }}>
                        <Image
                          source={{ uri: attachment.uri }}
                          style={{ borderRadius: theme.radii.thumb, height: 64, width: 64 }}
                        />

                        <Pressable
                          accessibilityLabel={chatStrings.composer.removeAttachment}
                          accessibilityRole="button"
                          hitSlop={TAP_SLOP}
                          onPress={() => onRemoveAttachment?.(attachment.id)}
                          style={{
                            alignItems: 'center',
                            backgroundColor: 'rgba(8,20,44,0.62)',
                            borderRadius: 11,
                            height: 22,
                            justifyContent: 'center',
                            position: 'absolute',
                            right: 2,
                            top: 2,
                            width: 22
                          }}
                          testID={`composer-attachment-remove-${attachment.id}`}
                        >
                          <Text color="onAccent" style={{ fontSize: 14, lineHeight: 16 }}>
                            {'×'}
                          </Text>
                        </Pressable>
                      </View>
                    ) : (
                      <FileChip
                        key={attachment.id}
                        name={attachment.name}
                        {...(attachment.error ? { error: attachment.error } : {})}
                        onRemove={() => onRemoveAttachment?.(attachment.id)}
                        {...(attachment.progress !== undefined ? { progress: attachment.progress } : {})}
                        {...(attachment.size !== undefined ? { size: attachment.size } : {})}
                        {...(attachment.status ? { status: attachment.status } : {})}
                        testID={`composer-attachment-${attachment.id}`}
                      />
                    )
                  )}
                </ScrollView>
              </View>
            ) : null}

            <View style={{ alignItems: 'flex-end', flexDirection: 'row' }}>
              <TextInput
                accessibilityLabel={
                  botName ? chatStrings.composer.messageTo(botName) : chatStrings.composer.placeholder
                }
                multiline
                onChangeText={onFieldChangeText}
                onKeyPress={onKeyPress}
                onSelectionChange={onSelectionChange}
                // Only reached where `submitBehavior` is 'submit', i.e. on a Mac.
                onSubmitEditing={onSubmitEditing}
                placeholder={placeholder ?? chatStrings.composer.placeholder}
                placeholderTextColor={theme.colors.textFaint}
                ref={inputRef}
                selection={caret}
                onBlur={fieldFocus.fieldProps.onBlur}
                onFocus={fieldFocus.fieldProps.onFocus}
                /*
                  One row, for the one platform that has a default.

                  A `<textarea>` with no `rows` is two lines tall, which is why
                  the field was 54pt in a tab and 32 on a phone with the same
                  one line of text in it. `undefined` everywhere else, where a
                  multiline field measures its own content.
                */
                {...ONE_ROW}
                style={[
                  {
                    color: theme.colors.text,
                    flex: 1,
                    fontSize: theme.type.body.fontSize,
                    // An explicit leading, so the box the padding centres is a box
                    // this app chose rather than one the platform's font metrics
                    // happened to produce. See `COMPOSER_TEXT_LINE_HEIGHT`.
                    lineHeight: COMPOSER_TEXT_LINE_HEIGHT,
                    maxHeight: COMPOSER_MAX_HEIGHT,
                    // No `minHeight`: the padding below already makes one line exactly
                    // `COMPOSER_LINE_HEIGHT` tall, and a minimum ON TOP of that is a box
                    // taller than its content — which on iOS a multiline field fills
                    // from the top, leaving the placeholder high and the gap below it.
                    ...composerFieldPadding(Platform.OS === 'ios' ? COMPOSER_IOS_TOP_INSET : 0)
                  },
                  fieldFocus.fieldProps.style
                ]}
                submitBehavior={submitBehavior}
                testID="composer-input"
                value={value}
              />
            </View>
          </GlassSurface>

          {/*
            The microphone, between the field and the send button.

            LEFT of send and right of the field, which is where every messenger
            that has one puts it: send is the last thing on the row because it
            is the last thing you do, and a control that pushed it out of the
            corner would move the one target this composer's muscle memory is
            built around.

            `onPressIn` / `onPressOut` rather than `onPress`, because the press
            IS the gesture — hold to talk, tap to toggle, and the difference is
            how long the finger stayed down (`press-to-talk.ts`). A `Pressable`
            reports both edges; `onPress` reports neither.

            It is hidden rather than disabled where there is no recognizer. The
            same call `Read aloud` makes in the message menu, and for the same
            reason: there is no later in which a browser grows a speech API.
          */}
          {dictation?.available ? (
            <Pressable
              accessibilityLabel={dictation.listening ? chatStrings.voice.dictateStop : chatStrings.voice.dictate}
              accessibilityRole="button"
              /*
                Voice mode, for assistive technology and for a pointer.

                It is NOT on a long press. A long press is how you hold the mic
                to talk, and a menu that opened under a finger held down to
                dictate would take the gesture away from the feature the button
                is for. The other ways in are the chat options sheet and this
                action, which VoiceOver's rotor and a secondary click both reach.
              */
              {...(dictation.onOpenVoiceMode
                ? {
                    accessibilityActions: [{ name: 'voiceMode', label: chatStrings.voice.modeStart }],
                    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
                      if (event.nativeEvent.actionName === 'voiceMode') {
                        dictation.onOpenVoiceMode?.()
                      }
                    }
                  }
                : {})}
              aria-pressed={dictation.listening}
              hitSlop={TAP_SLOP}
              onPressIn={dictation.onPressIn}
              onPressOut={dictation.onPressOut}
              style={({ pressed }) => ({
                alignItems: 'center',
                // Lit while listening, glass otherwise. A microphone that is on
                // is a thing a reader must be able to see from across the room,
                // so it is the accent's own fill rather than a tint.
                backgroundColor: dictation.listening ? theme.accent().bubble : 'transparent',
                borderRadius: round / 2,
                height: round,
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
                width: round
              })}
              testID="composer-mic"
            >
              <Icon
                color={dictation.listening ? theme.colors.onAccent : theme.colors.textMuted}
                name="mic"
                size={ICON_SIZE.control}
              />
            </Pressable>
          ) : null}

          {/*
            Accent while it sends, a red stop SQUARE while a turn runs.

            The colour is the accent's BUBBLE, not its `fill`. White sits on this
            circle, and `bubble` is the half of the swatch that
            `npm run contrast:check` measures white against — `fill` is the ring
            colour and may be brilliant, which on the studio's lime left a white
            arrow at about 1.3 : 1.

            The stop stays a drawn square rather than an icon: it is a shape, not
            a mark, and it is the one child here that was never a glyph. The
            arrow was, and it sat low in the circle for the same reason the `+`
            did.
          */}
          {stopping ? (
            <Pressable
              accessibilityLabel={chatStrings.composer.stop}
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={press}
              style={({ pressed }) => ({
                alignItems: 'center',
                backgroundColor: theme.colors.danger,
                borderRadius: round / 2,
                height: round,
                justifyContent: 'center',
                opacity: pressed ? 0.85 : 1,
                width: round,
                ...theme.shadows.card
              })}
              testID="composer-stop"
            >
              <View style={{ backgroundColor: theme.colors.onAccent, borderRadius: 2, height: 12, width: 12 }} />
            </Pressable>
          ) : (
            <View>
              <RoundIconButton
                color={theme.accent().bubble}
                disabled={!running && !canSend}
                fill="solid"
                icon="arrowUp"
                // The label names the attachments, because this button is the
                // last thing between a staged file and a sent one, and a screen
                // reader has no other way to hear it is carrying anything.
                label={
                  attachments.length
                    ? chatStrings.composer.sendWithAttachments(attachments.length)
                    : chatStrings.composer.send
                }
                onPress={press}
                size={round}
                testID="composer-send"
              />

              {/* A count on the button as well as in the tray. The tray scrolls
                  out of reach on a short screen with the keyboard up; the
                  button never does, and it is the control about to send them. */}
              {attachments.length ? (
                <View
                  pointerEvents="none"
                  style={{
                    alignItems: 'center',
                    backgroundColor: theme.colors.accentText,
                    borderRadius: 999,
                    height: 16,
                    justifyContent: 'center',
                    minWidth: 16,
                    paddingHorizontal: 3,
                    position: 'absolute',
                    right: -3,
                    top: -3
                  }}
                  testID="composer-send-badge"
                >
                  <Text color="onAccent" style={{ fontSize: 10, fontWeight: '700', lineHeight: 12 }}>
                    {String(attachments.length)}
                  </Text>
                </View>
              ) : null}
            </View>
          )}
        </GlassGroup>

        {/*
          The Mac only, and not merely "wherever a bare Return sends".

          On an iPad with a keyboard case the two chords are true — `Enter` does
          send there, which is what `hardwareKeyboard` is for — but the line has
          nowhere to be: iPadOS keeps its own keyboard bar along the bottom of
          the window, and the hint was drawn straight through it with the
          system's keyboard button sitting on top of the words. A Mac window has
          no such bar, so the line sits under the composer as it was meant to.

          The chords still work on the iPad. They are just not announced there,
          which is the ordinary state of a keyboard shortcut.
        */}
        {RUNS_ON_MAC ? (
          <Text
            color="textFaint"
            style={{ marginTop: theme.space.xs, textAlign: 'center' }}
            testID="composer-key-hint"
            variant="micro"
          >
            {chatStrings.composer.keyHint}
          </Text>
        ) : null}

        {/*
          One line, under the row, about the microphone.

          Not a card and not a sheet: the thing it explains is a button two
          centimetres above it, and a modal about a tap would be louder than the
          tap. `Open Settings` is a link rather than a button for the same
          reason — and it is absent on a platform with nowhere to send the
          reader, which is a browser (see `speech-recognition.web.ts`).
        */}
        {dictation?.notice ? (
          <View
            style={{
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.xs,
              marginTop: theme.space.xs,
              paddingHorizontal: theme.space.xs
            }}
            testID="composer-mic-notice"
          >
            <Text color="textMuted" style={{ flex: 1 }} variant="meta">
              {dictation.notice.message}
            </Text>
            {dictation.notice.onAction && dictation.notice.actionLabel ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={TAP_SLOP}
                onPress={dictation.notice.onAction}
                testID="composer-mic-settings"
              >
                <Text color="accentText" variant="meta">
                  {dictation.notice.actionLabel}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {queuedText ? <QueuedChip testID="composer-queued" text={queuedText} /> : null}

        {/*
          Outside tap.

          A popover is dismissed by a tap that is not on it, and the taps that reach
          this composer are the field, the tray and the three controls — so the
          catcher covers the row the popover stands on, the popover itself being
          above it. The first tap dismisses and does nothing else, which is what a
          popover does everywhere.

          It does NOT reach the transcript above: the menu is the composer's own
          state and a screen-wide catcher would mean lifting it to `ChatScreen`. The
          three dismissals that DO work — this, Escape (registered last, so it beats
          the panel's), and the `+` again — are what the reader has; `design/README.md`
          records the gap.
        */}
        {menuVisible ? (
          <Pressable
            accessibilityLabel={chatStrings.composer.dismissAttach}
            accessibilityRole="button"
            onPress={() => setMenuOpen(false)}
            style={StyleSheet.absoluteFill}
            testID="composer-attach-dismiss"
          />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  )
}
