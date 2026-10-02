/**
 * One conversation in the list.
 *
 * Everything the row shows about state is derived rather than stored twice:
 * `working` comes from the roster's running poll, `needs input` from the open
 * requests the chat store already holds, unread from the canonical chat's
 * `last_active` against a per-bot watermark. `presenceOf` turns all of it into
 * one of four beads, and it is a pure function so the row and (in Part 2) the
 * chat header cannot disagree about what a bot is doing.
 */
import { memo, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'

import { unreadBadgeLabel } from '@hermie/transcript'

import { Avatar, formatListTime } from '../../chat-ui'
import { strings } from '../../i18n/strings'
import { useFollowsLocale } from '../../i18n/use-locale'
import { ContextMenuHost } from '../../platform/context-menu'
import { secondaryClick } from '../../platform/secondary-click'
import { botNames, useHideHandleWhenNamed, useNameOrder } from '../../store/bot-names'
import type { Bot } from '../../store/bots'
import { useBotLabel } from '../../store/chat-layout'
import { usePendingShareCount } from '../../store/share'
import { GlassSurface } from '../../ui/glass'
import { Icon, ICON_SIZE, type IconName } from '../../ui/Icon'
import { PresenceBead } from '../../ui/PresenceBead'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { AVATAR_SIZE, ROW_HEIGHT, type AccentName } from '../../ui/tokens'
import type { Presence } from './presence'
import { rowMenuItems } from './row-menu-items'
import { useRowPreview } from './row-preview'

export type BotRowProps = {
  bot: Bot
  /**
   * This row's key in the arrangement — `bot:<name>`, or `archived:<name>` in
   * the drawer.
   *
   * Handed down rather than rebuilt here, and that is a fix rather than tidying.
   * The long press used to arm the drag with the bot's NAME while the pan
   * responder was keyed by the row key, so the two never matched and the
   * responder could not claim the gesture: holding a row did nothing at all, and
   * the only way to move one was the edit-mode grip. The list already knows this
   * key — it is what it keyed the cell by — so it is the list that says it.
   */
  rowKey: string
  accent: AccentName
  archived: boolean
  avatarUri?: string | undefined
  compact: boolean
  presence: Presence
  selected: boolean
  unread: boolean
  unreadCount: number
  /**
   * When this chat's silence lapses, `0` for never, `null` when it is not muted.
   *
   * The DEADLINE rather than a boolean, because the menu has to be able to say
   * when the chat comes back. The bell glyph only needs to know that it is not
   * null, which the list has already decided by handing one over.
   */
  mutedUntil: number | null
  /**
   * Held at the top of its container.
   *
   * A glyph rather than a different row treatment: a pinned chat is the same
   * chat and its POSITION is what the reader changed, so the row says so in one
   * mark and is otherwise untouched. Position alone would not be enough — the
   * top of a list is also just the top of a list.
   */
  pinned?: boolean
  /**
   * Every folder the row can move to, `null` first for the loose top level.
   * Must be a stable array — it is part of the memo's key, and a fresh one per
   * render re-renders forty rows because one of them changed.
   */
  menuFolders: readonly { id: string | null; name: string }[]
  /**
   * Every callback takes what it acts on rather than closing over it. That is
   * what lets the list hand down ONE identity per handler, which is the only
   * way the memo above survives a roster refresh.
   */
  onPress: (bot: Bot) => void
  /** A selection from either menu, by the id `rowMenuItems` gave it. */
  onMenuSelect: (botName: string, id: string) => void
  /**
   * The fallback sheet's opener, for a secondary click.
   *
   * A long press no longer calls it: the sheet is opened by the list when a
   * press ENDS without having become a drag, so that one gesture can still mean
   * both things. A right click is not a press and cannot become a drag, so it
   * opens the sheet outright.
   */
  onOpenMenu: (botName: string) => void
  /** One position up or down, for the readers a drag does not serve. */
  onMove?: (botName: string, offset: number) => void
  /** Long press armed the drag; the wrapper's pan responder claims it on the first move. */
  onArm?: (rowKey: string) => void
  /** The press ended. Where a drag never started, this is what opens the menu. */
  onDisarm?: () => void
}

function stampOf(presence: Presence, bot: Bot): string {
  return presence.state === 'offline' && presence.lastSeenAt
    ? formatListTime(presence.lastSeenAt)
    : formatListTime(bot.canonical?.lastActive)
}

export const BotRow = memo(function BotRow({
  accent,
  archived,
  avatarUri,
  bot,
  compact,
  menuFolders,
  mutedUntil,
  pinned = false,
  onArm,
  onDisarm,
  onMenuSelect,
  onMove,
  onOpenMenu,
  onPress,
  presence,
  rowKey,
  selected,
  unread,
  unreadCount
}: BotRowProps) {
  /*
    A memo boundary does not follow the root's re-render.

    `App` subscribes to the locale so a switch repaints the tree under it, and
    that reaches everywhere the tree is actually walked — everywhere except
    behind a `React.memo` whose props did not change. The chat list is exactly
    that: nothing about a bot changes when the reader picks another language,
    so without this the rows would keep their old menu and their old badge
    wording until the roster moved.
  */
  useFollowsLocale()

  const theme = useTheme()
  const [hovered, setHovered] = useState(false)
  const swatch = theme.accent(accent)
  /*
    Both of the bot's names, in the order this reader chose. `secondary` is
    empty for a bot that has only one name, which is every bot on a gateway
    where nobody has set a display name — so the third line is conditional and
    the row keeps the height it had.
  */
  const names = botNames({ ...bot, label: useBotLabel(bot.name) }, useNameOrder(), {
    hideHandle: useHideHandleWhenNamed()
  })

  /**
   * Shares this chat has been given that have not gone out yet.
   *
   * Read from the store here rather than threaded down from the list, the same
   * way the name order is: it is a fact about the bot, not about the row's
   * position, and a prop would have to be passed identically by the chat list,
   * the sidebar and the search results.
   *
   * The commonest way to see one is not a failure. It is sharing something to
   * Hermie while the phone has no route to the gateway — the entry sits in the
   * outbox and this says so, which is the difference between "not yet" and the
   * silence the first version of this feature had.
   */
  const pendingShares = usePendingShareCount(bot.name)

  /**
   * Built here rather than by the list, so the list can keep handing every row the
   * same handler identities. The dependencies are the row's own state, which is
   * exactly what the menu's ticks and its Archive/Unarchive wording read.
   */
  const menu = useMemo(
    () =>
      rowMenuItems({
        accent,
        archived,
        botName: bot.name,
        displayName: names.primary,
        movable: !archived,
        mutedUntil,
        folders: menuFolders,
        unread
      }),
    [accent, archived, names.primary, bot.name, menuFolders, mutedUntil, unread]
  )

  // The last REAL message this bot's chat holds, from the transcript when there
  // is one and from the gateway's own string when there is not. Never the raw
  // `[System: …]` wrapper either way — see `chatRowPreview`.
  const derived = useRowPreview(bot.name, bot.canonical?.preview ?? '')

  // Offline replaces the preview with when the bot was last heard from: a stale
  // last message under a dead connection reads as if it just arrived.
  const offline = presence.state === 'offline' && Boolean(presence.lastSeenAt)
  const preview = offline
    ? strings.presence.offlineSince(formatListTime(presence.lastSeenAt))
    : derived.text || bot.description || strings.bots.noPreview

  // A second muted style, one step quieter and in italics, for a line nobody
  // said. It is the difference between "the chat's last message" and "the last
  // thing that happened to the chat", and without it the switch marker reads as
  // if the bot had announced it.
  const systemLine = !offline && derived.system && Boolean(derived.text)

  const stamp = stampOf(presence, bot)

  const label = [
    // Both names, so a screen reader announces the row by the name the reader
    // sees AND by the one the rest of the app addresses it by.
    [names.primary, names.secondary].filter(Boolean).join(', '),
    strings.presence[presence.state],
    unreadCount > 0 ? strings.bots.unreadLabel(unreadCount) : unread ? strings.bots.unread : '',
    // Said in words here rather than left to the glyphs, which keep themselves
    // out of the accessibility tree like every other decorative icon. One line
    // per mark in the run below, in the same order, so the row reads to a screen
    // reader the way it is drawn.
    mutedUntil === null ? '' : strings.layout.mutedRow,
    pinned ? strings.layout.pinnedRow : '',
    pendingShares > 0 ? strings.bots.sharePending(pendingShares) : ''
  ]
    .filter(Boolean)
    .join(', ')

  /**
   * Every mark the row can show about itself, in one run.
   *
   * The owner's report was about WHERE they were: _"All icons must be to the
   * LEFT of the time, on the row of the big name."_ They were in three places —
   * the bell after the name, the pin and the share in a trailing column beside
   * the unread pill — so a muted, pinned chat drew one mark against its name and
   * another two thirds of a row lower, and neither of them near the time they
   * were supposed to sit beside.
   *
   * A list rather than three conditionals in the markup, because the run has to
   * keep ONE order, ONE gap and ONE ink however many of them are on: the next
   * mark this row learns to draw joins the array and is placed by the same
   * rules. The order is fixed rather than dependent on what is on, so a chat
   * that gains a pin does not shuffle the mark that was already there.
   *
   * An archived chat has no mark of its own: it is drawn inside the archive
   * drawer, under a heading that says so, and a glyph repeating the container
   * the row is already in says nothing the reader cannot see.
   */
  const marks: { key: string; name: IconName; testID: string }[] = [
    ...(mutedUntil === null ? [] : [{ key: 'muted', name: 'bellMuted' as const, testID: `bot-muted-${bot.name}` }]),
    ...(pinned ? [{ key: 'pinned', name: 'pin' as const, testID: `bot-pinned-${bot.name}` }] : []),
    ...(pendingShares > 0 ? [{ key: 'share', name: 'queue' as const, testID: `bot-share-pending-${bot.name}` }] : [])
  ]

  const body = (
    <View
      style={{
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.md,
        minHeight: compact ? ROW_HEIGHT.compact : ROW_HEIGHT.regular,
        paddingHorizontal: theme.space.md,
        paddingVertical: theme.space.sm
      }}
    >
      <View>
        <Avatar
          // The PRIMARY line, so the initial and the tint agree with the name
          // drawn beside them. `initialFor` takes the first character and
          // `tintIndex` hashes the whole string, so feeding it the other name
          // would give `lance-vance` an N in a colour nothing else uses.
          name={names.primary}
          size={AVATAR_SIZE.list}
          // The accent ring is how a per-chat colour shows up in the list. A
          // chat on Default gets no ring at all rather than a blue one, so the
          // ring means "this one was given a colour".
          //
          // §1.3 is the authority: Default is not one of the eight curated
          // colours, and the four things a colour tints start with "the avatar
          // ring in the list and the header". So a ringless Default row is
          // correct and is NOT the cause of a washed-out avatar — that was the
          // tint's separation from the panel, fixed in `Avatar`. Keyed on the
          // accent alone, never on whether the bot has a picture: a ring that
          // came and went with an asset would make the colour mean two things.
          style={
            accent === 'default'
              ? undefined
              : { borderColor: swatch.fill, borderWidth: 2.5, height: AVATAR_SIZE.list, width: AVATAR_SIZE.list }
          }
          {...(avatarUri ? { uri: avatarUri } : {})}
        />
        <View style={{ bottom: -1, position: 'absolute', right: -1 }}>
          <PresenceBead
            ringColor={selected ? theme.elevation.e2s : theme.elevation.e1}
            state={presence.state}
            testID={`bot-presence-${bot.name}`}
          />
        </View>
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ alignItems: 'baseline', flexDirection: 'row', gap: theme.space.sm }}>
          {/*
            The name takes the room, and gives it up first.

            `flex: 1` rather than the `flexShrink` plus a spacer view this line
            used to carry: the spacer was what pushed the stamp to the edge, and
            with a run of marks between the two it would have pushed them
            through it. One growing, shrinking child and two fixed ones says the
            same thing in the layout itself — the name elides, the marks and the
            time never do.
          */}
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontWeight: unread ? '700' : '600' }}
            testID={`bot-name-${bot.name}`}
            variant="name"
          >
            {names.primary}
          </Text>

          {/*
            Every mark this row shows, in one right-aligned run immediately left
            of the time.

            `space.xs` between them — 4pt, tight enough that two marks read as
            one group rather than as two separate claims — at the row-mark size
            and in `textMuted`, which is the ink the bell already used after the
            owner reported the 13pt `textFaint` version as "small and not clear".
            The share glyph gives up its accent to be here: a run drawn in two
            inks is two runs, and "these are the states of this row" is the thing
            the grouping has to say.

            `alignSelf: 'center'` inside a baseline row, because an icon has no
            baseline of its own — Yoga would align its BOTTOM edge with the
            letters' feet and hang the mark a couple of points above the name.
            The name and the stamp keep their shared baseline.
          */}
          {marks.length ? (
            <View
              style={{
                alignItems: 'center',
                alignSelf: 'center',
                flexDirection: 'row',
                flexShrink: 0,
                gap: theme.space.xs
              }}
              testID={`bot-marks-${bot.name}`}
            >
              {marks.map(mark => (
                <Icon
                  color={theme.colors.textMuted}
                  key={mark.key}
                  name={mark.name}
                  size={ICON_SIZE.listMark}
                  testID={mark.testID}
                />
              ))}
            </View>
          ) : null}

          {stamp ? (
            <Text color="textFaint" style={{ flexShrink: 0 }} testID={`bot-time-${bot.name}`} variant="meta">
              {stamp}
            </Text>
          ) : null}
        </View>

        {/*
          The other name, small and quiet, and only when there is one.

          It is not the preview's line: the preview says what was last said and
          this says what the bot is called, and folding one into the other would
          make a bot with no messages yet look as though its name were its last
          message.
        */}
        {names.secondary ? (
          <Text color="textMuted" numberOfLines={1} testID={`bot-secondary-name-${bot.name}`} variant="meta">
            {names.secondary}
          </Text>
        ) : null}

        <Text
          color={systemLine ? 'textFaint' : unread ? 'text' : 'textMuted'}
          numberOfLines={1}
          style={{ marginTop: 2, ...(systemLine ? { fontStyle: 'italic' as const } : {}) }}
          testID={`bot-preview-${bot.name}`}
          variant="preview"
        >
          {preview}
        </Text>
      </View>

      {/*
        The pill, and nothing beside it any more.

        The pin and the pending share used to stand in this column, which is
        vertically centred on a 72pt row — so a mark about the row sat opposite
        the middle of the preview rather than beside the time it describes. They
        are in the name line's run now; what is left here is the one thing that
        counts what ARRIVED rather than describing the row.

        A muted chat still counts on its own row. What mute stops is the buzzing
        and the totals, not the reader's ability to see that four things arrived
        while they were not listening.
      */}
      {unread || unreadCount > 0 ? <UnreadBadge accent={swatch.fill} count={unreadCount} /> : null}
    </View>
  )

  /**
   * Reordering without a drag, for everybody a drag does not serve.
   *
   * VoiceOver's rotor and a keyboard both read `accessibilityActions`, so this
   * is where "one step up" lives now that the arrows are gone — and unlike the
   * buttons it replaces, it is offered on the ROW rather than on a 26pt column,
   * which is the element assistive technology is focused on anyway.
   *
   * Offered on every row that HAS a position, at all times. It used to appear
   * only in edit mode, which meant a screen-reader reader had to find and turn
   * on a mode before the list could be arranged at all — and that mode has gone,
   * so the actions would have gone with it. An archived chat is still excluded:
   * it is drawn in the drawer and has no position to move within, and offering
   * an action that does nothing is worse than offering none.
   */
  const reorderable = !archived && Boolean(onMove)
  const moveActions = reorderable
    ? [
        { name: 'moveUp', label: strings.layout.moveUp },
        { name: 'moveDown', label: strings.layout.moveDown }
      ]
    : []

  const pressable = (
    <Pressable
      {...(reorderable
        ? {
            accessibilityActions: moveActions,
            onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => {
              if (event.nativeEvent.actionName === 'moveUp') {
                onMove?.(bot.name, -1)
              } else if (event.nativeEvent.actionName === 'moveDown') {
                onMove?.(bot.name, 1)
              }
            }
          }
        : {})}
      accessibilityLabel={label}
      accessibilityRole="button"
      aria-selected={selected}
      // 300ms, not the default 500: a lift the reader has to wait half a second for
      // reads as a list that did not notice them.
      delayLongPress={300}
      /*
       * One gesture, two meanings, and the same two on every platform.
       *
       * A hold arms the drag here and nothing else: where UIKit draws the native
       * menu it has already opened one by now (`platform/context-menu`), and
       * where it does not, the list HOLDS its sheet until this press is over and
       * opens it from `onDisarm` — so a hold that turns into a move never leaves
       * a menu over the row it lifted. The two gestures separate by themselves,
       * exactly as they do in the Files app: hold still for the menu, hold and
       * move for the drag.
       *
       * The KEY, not the name. Arming with `bot.name` while the pan responder
       * was keyed by `bot:<name>` is what made the hold inert — see `rowKey`.
       */
      onLongPress={() => onArm?.(rowKey)}
      /*
       * And the desktop gesture for the same menu, where the platform has one.
       * A long press is what a finger does; a right click is what a mouse does,
       * and until this the browser build answered it with nothing at all.
       */
      {...secondaryClick(() => onOpenMenu(bot.name))}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPress={() => onPress(bot)}
      onPressOut={onDisarm}
      // A row is a thing you click, and on a Mac the pointer has to say so.
      //
      // The radius is here as well as on the surface inside, and it paints
      // nothing: the two boxes are identical, and a browser draws a focus ring
      // around the FOCUSABLE element's radius. Without it the keyboard ring is a
      // rectangle around a pill.
      style={{ borderRadius: theme.radii.card, cursor: 'pointer', marginHorizontal: theme.space.sm }}
      testID={`bot-row-${bot.name}`}
    >
      {selected ? (
        // The selected row is a lighter glass pill tinted with the chat's own
        // colour — level 3, so a tint and no blur of its own.
        <GlassSurface tint={swatch.soft} variant="rowSelected">
          {body}
        </GlassSurface>
      ) : (
        <View
          style={{
            backgroundColor: hovered ? theme.glass.row.solid : 'transparent',
            borderRadius: theme.radii.card
          }}
        >
          {body}
        </View>
      )}
    </Pressable>
  )

  // The host draws nothing and lays its child out as a `View` would, so on a build
  // without the native menu this is the same tree with one wrapper fewer.
  return (
    <ContextMenuHost
      // The same radius the row's own selected surface is drawn with, so the
      // platform's pointer highlight is a rounded pill rather than the square
      // block UIKit defaults to. Our own hover background below already used it;
      // the one that did not was the system's, drawn over the top.
      cornerRadius={theme.radii.card}
      items={menu}
      menuTitle={names.primary}
      onSelect={id => onMenuSelect(bot.name, id)}
      testID={`bot-row-menu-${bot.name}`}
    >
      {pressable}
    </ContextMenuHost>
  )
})

/**
 * A number when the app can count, a dot when it cannot.
 *
 * The gateway reports `last_active` for a canonical chat and nothing more, so a
 * chat this app has never read can only be shown as "it moved". A chat it HAS
 * read is counted from the transcript itself and capped, because a badge wider
 * than the row's stamp stops being a badge.
 */
function UnreadBadge({ accent, count }: { accent: string; count: number }) {
  const label = unreadBadgeLabel(count)

  if (!label) {
    return (
      <View
        accessibilityElementsHidden
        // `aria-hidden` is the web's spelling of the two props around it; react-native-web
        // honours neither of those. See `ui/Icon.tsx`.
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        style={{ backgroundColor: accent, borderRadius: 5, height: 10, width: 10 }}
        testID="bot-unread"
      />
    )
  }

  return (
    <View
      accessibilityElementsHidden
      // `aria-hidden` is the web's spelling of the two props around it; react-native-web
      // honours neither of those. See `ui/Icon.tsx`.
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={{
        alignItems: 'center',
        backgroundColor: accent,
        borderRadius: 11,
        justifyContent: 'center',
        minWidth: 22,
        paddingHorizontal: 6,
        paddingVertical: 2
      }}
      testID="bot-unread"
    >
      <Text color="onAccent" style={{ fontSize: 12, fontWeight: '700' }}>
        {label}
      </Text>
    </View>
  )
}
