/**
 * A human turn.
 *
 * The reader's own: right-aligned, the chat's flat accent, white text, a tail
 * on the last of a run, the clock on the body's last line and — on the last
 * sent message only — ticks beside it.
 *
 * Somebody else's, in the group chat, when the gateway said who they are
 * (HERM-83): left-aligned, the reading bubble, normal ink — the same
 * silhouette `AssistantBubble` draws — with their name over the first bubble
 * of their run in their own colour and their avatar beside it, in a gutter
 * reserved for the whole run so every bubble in it keeps one left edge. `own`
 * defaults to `true`, which is every caller before this field existed: a row
 * the host has not proven is somebody else's draws exactly as it always has
 * (D3) — no name, no avatar, the reader's own silhouette.
 *
 * The body is real Markdown, not raw characters. A person who types `**done**`
 * or a path in backticks was writing markup, and the reply beside it renders
 * the same markup: showing the asterisks on one side and bold on the other is
 * the app disagreeing with itself. An outgoing bubble underlines a link in
 * white rather than in the accent, which on its own fill would be invisible;
 * an incoming one reads exactly as `AssistantBubble`'s does.
 */
import { View } from 'react-native'

import { Markdown } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { AVATAR_SIZE } from '../ui/tokens'
import { AttachmentGallery, type GalleryAttachment } from './AttachmentGallery'
import { Avatar } from './primitives/Avatar'
import { Bubble, bubblePaddingX, TAIL_REACH, useBubbleContentWidth } from './primitives/Bubble'
import { Chip } from './primitives/Chip'
import { MetaLine } from './primitives/MetaLine'
import { SenderLabel } from './primitives/SenderLabel'
import { formatClock, needsReadingTreatment } from './format'
import { chatStrings } from './strings'
import type { Presentation, Receipt, UserItem } from './types'

/** Who to draw above an incoming bubble — already resolved and sanitised. */
export interface UserSender {
  /** Real text, ready to show as-is. */
  name: string
  /** The identity the ink and the avatar circle are keyed on. Never the name. */
  authorId: string
  /**
   * Their picture, already fetched and ready to draw (HERM-120).
   *
   * Absent draws the tinted initial `Avatar` always has — no host, not asked
   * for, still loading, a 404, any other error, or a gateway that never grew
   * the endpoint all look the same here, on purpose: this component does not
   * need to tell them apart to draw the right thing.
   */
  pictureUri?: string
}

export interface UserBubbleProps {
  item: UserItem
  presentation?: Presentation
  /** The receipt on the metadata line; only the last own bubble gets one. */
  receipt?: Receipt
  /** Last bubble of a run — the one that carries the tail. */
  tail?: boolean
  /** Continues the run above it. */
  grouped?: boolean
  /** The chat's outgoing fill, from `useChatAccent`. */
  accent?: string
  onLinkPress?: (href: string) => void
  /**
   * Something `Image` can load for this reference, when the host has one.
   *
   * A reference is a path on the GATEWAY's disk, which nothing here can fetch,
   * so the bubble cannot decide on its own whether an attachment is showable —
   * only the screen knows which images it still holds bytes for. Returning
   * `undefined` is the ordinary answer and draws the chip.
   */
  attachmentUri?: (reference: string) => string | undefined
  /** Open one: the full-screen viewer for a picture, the system for a file. */
  onOpenAttachment?: (attachment: GalleryAttachment) => void
  /**
   * Is this the READER'S OWN message?
   *
   * Default `true` — unchanged from before `UserItem.author` existed (D3).
   * Only a caller that has proven this row is somebody else's — the group
   * chat, the reader's own identity known, and an `author` that names somebody
   * else — passes `false`. Everywhere that proof is missing, `true` is the
   * honest answer: it is either actually the reader's, or nobody can say it
   * is not, and painting it any other way would be a guess this component is
   * not allowed to make.
   */
  own?: boolean
  /**
   * Who to draw above the bubble when `own` is `false`.
   *
   * Absent still draws the INCOMING silhouette — the row is known not to be
   * the reader's regardless of whether anybody can be named for it — but with
   * no name and no avatar, which is the honest answer for a foreign row with
   * nothing to attribute it to.
   */
  sender?: UserSender
}

/**
 * `@file:/srv/x/report.pdf` → `report.pdf`. Backticked paths lose the quotes.
 *
 * `UserItem.attachments` stores the reference and nothing else, so the name a
 * chip shows is derived here, at render time. `attachmentRefName` in
 * `@hermie/transcript` derives the same name to PAIR a sent turn with its row, and
 * the two have to agree; the kit imports no runtime code from the engine, so what
 * keeps them in step is an assertion in `__tests__/chat-ui/components.test.tsx`
 * rather than a shared call.
 */
export function attachmentName(reference: string): string {
  const raw = reference.replace(/^@(?:file|image):/u, '').replace(/^[`"']|[`"']$/gu, '')

  return raw.split(/[/\\]/).pop() || raw
}

export function UserBubble({
  item,
  presentation = 'full',
  receipt,
  tail = true,
  grouped = false,
  accent,
  onLinkPress,
  attachmentUri,
  onOpenAttachment,
  own = true,
  sender
}: UserBubbleProps) {
  const theme = useTheme()
  // An outgoing bubble never takes the reading treatment, so its padding — and
  // therefore the room a block in it has — is the plain one. An incoming one
  // takes it exactly as `AssistantBubble` does. Above the early returns,
  // because a hook cannot sit below one.
  const reading = !own && Boolean(item.text) && needsReadingTreatment(item.text)
  const contentWidth = useBubbleContentWidth(own ? false : reading)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  if (presentation === 'chip') {
    return <Chip label={item.text} style={{ alignSelf: 'flex-end' }} />
  }

  const time = formatClock(item.ts)
  const bubble = accent ?? theme.accent().bubble
  const variant = reading ? 'inRead' : 'in'
  const recipe = theme.bubbles[variant]

  const message = (
    <Bubble
      accent={bubble}
      grouped={grouped}
      /*
        The clock on EVERY bubble, on the body's last line. The ticks still only
        appear where the engine has a receipt to report — which is the last sent
        message and nothing else, because a receipt is one fact about the
        conversation rather than one per message. Painting a tick on an older
        bubble would be inventing a delivery the gateway never confirmed. And
        never on a row that is not the reader's own: a colleague's message is
        not something this device has a delivery state for at all.
      */
      meta={
        <MetaLine
          /*
            A steer is a user turn that started no turn of its own: the gateway
            handed it to the agent with its next tool result. Without this word
            the bubble is indistinguishable from an ordinary message the bot
            went on to ignore, because the reply it steers is already streaming
            ABOVE it.
          */
          marker={item.displayKind === 'steer' ? chatStrings.queue.steeredMarker : undefined}
          onAccent={own}
          receipt={own ? receipt : undefined}
          testID={`user-meta-${item.id}`}
          time={time}
        />
      }
      side={own ? 'own' : 'other'}
      tail={tail}
      testID={`user-${item.id}`}
      {...(own ? {} : { variant })}
    >
      {item.text ? (
        <Markdown
          {...(own
            ? {
                // White on the accent. The accent link colour is the bubble's
                // own fill, so it would vanish into it.
                color: 'onAccent' as const,
                mutedColor: 'onAccent' as const,
                // A code chip inside a white-on-accent bubble needs a light
                // wash. The default steps DOWN from the surface it sits on,
                // which on a saturated fill reads as a redaction bar.
                inlineCodeBackground: 'rgba(255,255,255,0.22)',
                inlineCodeBorderColor: 'rgba(255,255,255,0.32)',
                surface: 'rgba(255,255,255,0.16)'
              }
            : {})}
          // A table's cells are transparent, so its edge dissolves into
          // whatever the bubble is filled with.
          fadeTo={own ? bubble : recipe.tail}
          linkColor={own ? theme.colors.onAccent : theme.accent().text}
          maxContentWidth={contentWidth}
          onLinkPress={onLinkPress}
          text={item.text}
        />
      ) : null}

      {/*
        A sent file is a chip, never the raw `@file:` token the gateway needs in
        the prompt. §6.7: the reference is plumbing, and plumbing is not a
        message.
      */}
      {item.attachments?.length ? (
        <View style={{ marginTop: item.text ? theme.space.sm : 0 }}>
          <AttachmentGallery
            attachments={item.attachments.map(reference => {
              const uri = attachmentUri?.(reference)

              return { name: attachmentName(reference), reference, ...(uri ? { uri } : {}) }
            })}
            onAccent={own}
            {...(onOpenAttachment ? { onOpen: onOpenAttachment } : {})}
            testID={`user-file-${item.id}`}
          />
        </View>
      ) : null}
    </Bubble>
  )

  if (own || !sender) {
    return message
  }

  /*
    Somebody else's message in the group chat (HERM-83, D6): their name over
    the first bubble of their run, their avatar beside it — in a gutter
    reserved for the WHOLE run, grouped or not, so every bubble in it keeps
    the same left edge instead of stepping in and out as the avatar comes and
    goes. `Avatar` is `aria-hidden` by design (D7); the name is real text, in
    reading order ahead of the bubble, which is the whole of the attribution a
    screen reader gets from the first bubble of a run.

    A bubble that CONTINUES the run draws no visible name — that is the point
    of a run — but D7 does not let attribution go quiet with it: a reader who
    landed here without seeing the one above (a screen reader jumping between
    messages is exactly that reader) still has to be told once whose bubble
    this is. `SenderNameForScreenReader` is that one announcement: present in
    the same reading-order slot `SenderLabel` would occupy, visually collapsed
    to a `1×1` box rather than drawn — see its own comment for why zero size
    was wrong — so nothing is duplicated on screen: the visible name stays
    suppressed, only its announcement is not.
  */
  return (
    <View style={{ flexDirection: 'row' }} testID={`user-sender-${item.id}`}>
      <View style={{ marginRight: theme.space.sm, width: AVATAR_SIZE.inline }}>
        {grouped ? null : (
          <Avatar
            name={sender.name}
            size={AVATAR_SIZE.inline}
            testID={`user-sender-avatar-${item.id}`}
            tintKey={sender.authorId}
            {...(sender.pictureUri ? { uri: sender.pictureUri } : {})}
          />
        )}
      </View>

      <View style={{ flex: 1 }}>
        {grouped ? (
          <SenderNameForScreenReader name={sender.name} testID={`user-sender-name-a11y-${item.id}`} />
        ) : (
          <SenderLabel
            authorId={sender.authorId}
            name={sender.name}
            style={{ marginBottom: theme.space.xxs, marginLeft: TAIL_REACH + bubblePaddingX(theme.space, reading) }}
            testID={`user-sender-name-${item.id}`}
          />
        )}

        {message}
      </View>
    </View>
  )
}

/**
 * The sender's name, for a screen reader only (HERM-83, D7).
 *
 * A real element with an explicit `accessibilityLabel` — not the bubble made
 * into one opaque accessible unit. Verified against the rendered app
 * (`docs/platform-notes.md` has the read-out): today a bubble is NOT one
 * accessible element — its sender name, its body (including a link, which
 * carries its own `accessibilityRole: 'link'`) and its clock each stand as
 * their own stop. Folding the whole bubble into one label would read fine as
 * prose but takes a link's separate stop away, so this adds an announcement
 * instead of replacing the bubble's.
 *
 * Zero size does not reliably reach a screen reader — a fully transparent or
 * zero-frame view is dropped by VoiceOver on iOS, and by some browser screen
 * readers too. `height`/`width: 1` with `overflow: 'hidden'` is the ordinary
 * "visually hidden" shape instead: a real, fully opaque node a click can
 * never land on and an eye can never see, but one AT can still find.
 *
 * Its text is drawn in `transparent` ink. A 1×1 box still clips a corner of
 * the first glyph, and in normal ink that corner is a visible speck beside the
 * bubble. The element stays opaque and full-size, so a screen reader treats it
 * exactly as before; only the ink is gone.
 */
function SenderNameForScreenReader({ name, testID }: { name: string; testID?: string }) {
  return (
    <Text
      accessibilityLabel={name}
      style={{ color: 'transparent', height: 1, overflow: 'hidden', width: 1 }}
      testID={testID}
    >
      {name}
    </Text>
  )
}
