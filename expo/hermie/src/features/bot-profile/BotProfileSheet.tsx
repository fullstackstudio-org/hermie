/**
 * One bot's profile, as a sheet.
 *
 * Reached two ways — the chat header's pill and the row menu's **Edit profile**
 * — because those are the two places a reader is already looking at the bot
 * they mean. Both open THIS component; there is no second, smaller editor.
 *
 * ## What saves when
 *
 * The sheet is deliberately not one big Save. Three of its four editable things
 * write the moment they are touched, because they are local or already
 * debounced, and only the two that cost a round trip wait for a button:
 *
 *  - **Colour** calls `chat-layout`'s `setAccent` on the tap. It is the chat
 *    list's own setting, it rides to the gateway with the rest of the
 *    arrangement on ADR-0016's debounce, and a swatch that needed confirming
 *    would be the only one in the app that did.
 *  - **Description and photo** are `profiles.configure` and
 *    `profiles.set_asset`, which are writes to the profile on the gateway's
 *    disk. Those wait for Save, and Save is what reports a failure.
 *
 * ## The identity block is read-only apart from the name, and that is the point
 *
 * Model, provider, session id and gateway version are facts, not settings —
 * this sheet is not the model picker, which is the chat options sheet's job and
 * is a guarded call with a confirmation of its own.
 *
 * The display NAME is the exception, and it waits for Save like the two above
 * it. It used to write itself into the arrangement on every keystroke, which is
 * how the sheet ended up with a dead button: a reader who came to rename a bot
 * changed the one thing they meant to change and watched Save stay greyed out,
 * with nothing on the screen saying the name had already been kept. So the
 * field holds a DRAFT now and Save commits it — to the gateway's own profile
 * where the plugin offers a route for that, and to `chat-layout`'s `labels`
 * either way. `features/bot-rename/display-name-controller.ts` is the order of
 * those two and the argument for it; this sheet only decides which gateway it
 * is talking to, and says so under the field when the name is not going to
 * travel.
 *
 * Renaming the profile itself is still a separate act behind its own
 * disclosure; that one needs `http`, needs the stores rekeyed, and lives in
 * `features/bot-rename`.
 */
import type { GatewayHttp } from '@hermie/gateway-client'
import { prettyModelName, type ContextUsage } from '@hermie/transcript'
import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'

import type { ChatGateway } from '../../gateway/link'
import { strings } from '../../i18n/strings'
import { contextSummary } from '../../chat-ui/ContextMeter'
import { Avatar } from '../../chat-ui/primitives/Avatar'
import { chatStrings } from '../../chat-ui/strings'
import { useChatLayoutStore } from '../../store/chat-layout'
import { botNames, useHideHandleWhenNamed, useNameOrder } from '../../store/bot-names'
import type { Bot } from '../../store/bots'
import { AccentSwatches } from '../../ui/AccentSwatches'
import { BottomSheet } from '../../ui/BottomSheet'
import { Button, InsetButtonRow, InsetGroup, InsetRow, InsetValueRow, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { AVATAR_SIZE } from '../../ui/tokens'
import {
  asRenameError,
  BotNameFields,
  DisplayNameError,
  renameStrings,
  saveBotName,
  saveDisplayName,
  useDisplayNameHome
} from '../bot-rename'
import { memoryStrings } from '../memory/strings'
import { CapabilitiesSheet } from '../profiles/CapabilitiesSheet'
import { profileStrings } from '../profiles/strings'
import { clearAvatar, changesFor, saveDescription, uploadAvatar } from './bot-profile-controller'
import { pickAvatar } from './avatar'

export interface BotProfileSheetProps {
  visible: boolean
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
  bot: Bot
  /** The picture the roster already loaded, if any. */
  avatarUri?: string
  /** Null while the connection is down; Save is disabled rather than hidden. */
  gateway: ChatGateway | null
  /**
   * The REST half, for the one thing on this sheet that is not a socket call.
   *
   * Absent means the name rows go back to being read-only facts: renaming is
   * `PATCH /api/profiles/{name}` and nothing else on this connection can do it,
   * so an editable field over a gateway with no REST surface would be a field
   * whose Save has nowhere to go.
   */
  http?: GatewayHttp | null
  /** Which gateway this bot is on, so a rename moves the right cache. */
  gatewayId?: string | null
  /** What the gateway reported about itself when it was configured. */
  gatewayVersion?: string
  /**
   * How full this bot's canonical session is, or nothing.
   *
   * Read-only here, like everything else in the About group: the profile sheet
   * describes the bot, and a context window is a fact about the conversation
   * rather than a setting on it. Absent means the gateway did not report a
   * window size and the row is not drawn — see `contextUsageOf`.
   */
  contextUsage?: ContextUsage | null
  /**
   * Open this bot's memory browser. The row is not drawn without it.
   *
   * A callback rather than a page this sheet presents itself: the memory
   * browser is a SCREEN, and a screen opened from inside a `Modal` would be a
   * second modal over the first — which `ChatSheetHost` exists to avoid, and
   * which iOS drops when the first is still dismissing. So the host that opened
   * this sheet is the thing that swaps it for the page.
   */
  onOpenMemory?: () => void
  /**
   * Open this bot's other conversations — branches, and the ones `/new` put
   * away.
   *
   * ONE row, and it is here rather than in the chat because this sheet is the
   * page about the BOT: its handle, its model, its session id. Which
   * conversations that session has had is the same kind of fact. Absent where
   * the host cannot navigate, which drops the row rather than leaving it
   * pointing at nothing.
   */
  onOpenConversations?: () => void
  /** A save landed: the roster should re-read so the new values reach every surface. */
  onSaved?: () => void
  testID?: string
}

export function BotProfileSheet({
  visible,
  onClose,
  onClosed,
  bot,
  avatarUri,
  gateway,
  http,
  gatewayId,
  gatewayVersion,
  contextUsage,
  onOpenMemory,
  onOpenConversations,
  onSaved,
  testID = 'bot-profile'
}: BotProfileSheetProps) {
  const theme = useTheme()
  const text = strings.botProfile
  /*
    The reader's own name for this bot, and the draft the field is editing.

    A draft rather than a live write, for the reason in the docstring. It is
    seeded from the store and reset when the sheet is pointed at another bot;
    like `description`, it deliberately does not follow the store afterwards, so
    an arrangement arriving from another device cannot rewrite a half-typed name
    underneath the reader.
  */
  const label = useChatLayoutStore(state => state.labels[bot.name] ?? '')
  const [name, setName] = useState(label)
  /*
    The same two lines every other surface draws, in this reader's own order, and
    from the STORED name rather than the draft: the title and the avatar's letter
    say what this bot is called, which is not yet what the field says.
  */
  const names = botNames({ ...bot, label }, useNameOrder(), { hideHandle: useHideHandleWhenNamed() })
  const [description, setDescription] = useState(bot.description)
  /**
   * The gateway took the name and part of the local move did not land.
   *
   * Separate from `error` because it is not a failure to retry: the rename
   * happened, and pressing Save again would aim at a profile that is gone.
   */
  const [warning, setWarning] = useState<string | null>(null)
  /** A picked picture, `null` to remove the current one, `undefined` to leave it. */
  const [avatar, setAvatar] = useState<{ base64: string; uri: string } | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A profile rename is in flight, and what it answered. Its own pair: it is a
      different button from Save and must not disable it. */
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  /** A refusal from the display-name route, printed under that field alone. */
  const [nameError, setNameError] = useState<string | null>(null)
  const [showCapabilities, setShowCapabilities] = useState(false)
  /** `gateway`, `app`, or null while no roster has been read on this connection. */
  const home = useDisplayNameHome()

  /*
    Reopening on a different bot — which the wide layout does without unmounting
    the sheet — has to start from that bot's values rather than the last one's.

    Keyed on the NAME alone, and the description is deliberately not a
    dependency. The roster re-reads on a poll, on a reconnect and on every save,
    and each of those rewrites `bot.description` with the gateway's copy; an
    effect that followed it would wipe a half-typed edit the moment a poll
    landed underneath the reader. The name is the only thing here that means
    "this is a different bot now".
  */
  useEffect(() => {
    setDescription(bot.description)
    // Read imperatively: as a dependency, this bot's stored name would reset the
    // draft every time an arrangement arrived, which is the overwrite above.
    setName(useChatLayoutStore.getState().labels[bot.name] ?? '')
    setAvatar(undefined)
    setError(null)
    setWarning(null)
    setNameError(null)
    setRenameError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- following `bot.description` or `bot.displayName` would let a roster poll overwrite what is being typed; see above.
  }, [bot.name])

  const accent = useChatLayoutStore(state => state.accents[bot.name] ?? 'default')
  const setAccent = useChatLayoutStore(state => state.setAccent)

  const onPickPhoto = useCallback(async () => {
    setError(null)

    try {
      const picked = await pickAvatar()

      if (picked) {
        setAvatar(picked)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text.photoFailed)
    }
  }, [text.photoFailed])

  // `undefined` leave it, `null` remove it, a string upload it — the three
  // states the draft distinguishes, flattened out of the picked object.
  const pickedBytes: string | null | undefined = avatar === undefined ? undefined : (avatar?.base64 ?? null)
  const changes = changesFor({ description: bot.description, name: label }, { description, avatar: pickedBytes, name })
  /*
    Which half of this Save needs a connection.

    The description and the picture are writes to the profile on the gateway's
    disk and there is nothing to do about them while the socket is down. The
    display name is the app's own, so a Save that only changes THAT is offered
    on a gateway that is not answering — refusing it would be the second dead
    button on this sheet.
  */
  const needsGateway = changes.description !== null || changes.avatar !== undefined
  const canSave = changes.any && (gateway !== null || !needsGateway)

  const onSave = useCallback(async () => {
    if (!canSave) {
      return
    }

    setBusy(true)
    setError(null)
    setNameError(null)
    setWarning(null)

    try {
      if (gateway) {
        if (changes.description !== null) {
          await saveDescription({ gateway, botName: bot.name }, changes.description)
        }

        // The picture second, so a description that saved is not undone by a
        // photo that did not. Both are independent writes on the gateway anyway.
        if (avatar === null) {
          await clearAvatar({ gateway, botName: bot.name })
        } else if (avatar) {
          await uploadAvatar({ gateway, botName: bot.name }, avatar.base64)
        }
      }

      /*
        The name last, and its refusal is its own.

        Last because the two above it are writes to the profile on the gateway's
        disk and this one is not: a 403 on the name must not stop a description
        that the gateway had already accepted from being reported as saved. Its
        own message because it belongs under the field it is about — `error` at
        the foot of the sheet reads as the description having failed.
      */
      if (changes.name !== null) {
        const saved = await saveDisplayName({
          http: http ?? null,
          profile: bot.name,
          draft: changes.name,
          toGateway: home === 'gateway'
        })

        /*
          The advert said the route was there and it answered 404 — a plugin
          caught between two versions, or a profile the gateway has stopped
          naming. The name IS saved, so this is a warning and not an error, and
          the sheet stays open around it: closing would hide the one sentence
          that says the gateway's own profile still has the old name.
        */
        if (home === 'gateway' && saved.home === 'app' && saved.displayName) {
          setWarning(renameStrings.displayAppOnly)
          onSaved?.()

          return
        }
      }

      onSaved?.()
      onClose()
    } catch (failure) {
      if (failure instanceof DisplayNameError) {
        setNameError(failure.message)
      } else {
        setError(failure instanceof Error ? failure.message : text.saveFailed)
      }
    } finally {
      setBusy(false)
    }
  }, [
    avatar,
    bot.name,
    canSave,
    changes.description,
    changes.name,
    gateway,
    home,
    http,
    onClose,
    onSaved,
    text.saveFailed
  ])

  /**
   * Rename the profile itself — the separate, destructive act.
   *
   * Its own handler rather than a branch of Save, because it is a different
   * button with a different failure: a refusal belongs beside the rename field
   * and must not look like the description having failed to save. Nothing else
   * on this sheet is sent with it, and it is deliberately the ONLY thing sent —
   * the description and the photo address the profile by its current name, and
   * mixing the two would aim one of them at a name that no longer exists.
   */
  const onRenameProfile = useCallback(
    async (draft: string) => {
      if (!http) {
        return
      }

      setRenaming(true)
      setRenameError(null)
      setWarning(null)

      try {
        const saved = await saveBotName({ http, bot, draft, gatewayId: gatewayId ?? null })

        if (saved.warning) {
          // The rename landed; the local half did not, all of it. Reported and
          // the sheet stays open, because closing on it would hide the only
          // sentence that says which part to expect back after a reconnect.
          setWarning(saved.warning)
        }

        onSaved?.()
      } catch (failure) {
        setRenameError(asRenameError(failure, bot.name).message)
      } finally {
        setRenaming(false)
      }
    },
    [bot, gatewayId, http, onSaved]
  )

  const shown = avatar === null ? undefined : (avatar?.uri ?? avatarUri)

  return (
    <BottomSheet
      accessibilityLabel={text.open(names.primary)}
      onRequestClose={onClose}
      {...(onClosed ? { onClosed } : {})}
      testID={testID}
      visible={visible}
    >
      <View style={{ gap: theme.space.md }}>
        <Text variant="sheetTitle">{text.title}</Text>

        <InsetGroup footer={text.photoHint} header={text.photo}>
          <InsetRow style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md }}>
            <Avatar name={names.primary} size={AVATAR_SIZE.list} {...(shown ? { uri: shown } : {})} />
            <View style={{ flex: 1, gap: theme.space.xs }}>
              <Button
                onPress={() => void onPickPhoto()}
                testID={`${testID}-photo`}
                title={shown ? text.photoReplace : text.photoChange}
                variant="secondary"
              />
              {shown ? (
                <Button
                  onPress={() => setAvatar(null)}
                  testID={`${testID}-photo-remove`}
                  title={text.photoRemove}
                  variant="danger"
                />
              ) : null}
            </View>
          </InsetRow>
        </InsetGroup>

        <InsetGroup header={text.description}>
          <InsetRow>
            <TextField
              multiline
              onChangeText={setDescription}
              placeholder={text.descriptionPlaceholder}
              testID={`${testID}-description`}
              value={description}
            />
          </InsetRow>
        </InsetGroup>

        {onOpenMemory ? (
          <InsetGroup header={memoryStrings.rowTitle}>
            <InsetButtonRow
              detail={memoryStrings.rowHint}
              onPress={onOpenMemory}
              testID={`${testID}-memory`}
              title={memoryStrings.rowTitle}
            />
          </InsetGroup>
        ) : null}

        <InsetGroup footer={text.colourHint} header={text.colour}>
          <InsetRow>
            <AccentSwatches
              accent={accent}
              onSelect={name => setAccent(bot.name, name)}
              testIDPrefix={`${testID}-${bot.name}`}
            />
          </InsetRow>
        </InsetGroup>

        {/*
          One row, because the three groups behind it are one question: what can
          this bot do. Its own sheet rather than a section here — three lists of
          switches would bury the two fields this sheet is actually for, and the
          switches write immediately while those fields wait for Save, which is
          a difference worth keeping on two surfaces rather than explaining on
          one.

          There is no row under this for deleting the bot. The gateway has no
          profile-delete method at all; the argument is written out in
          `features/profiles/profiles-controller.ts`.
        */}
        <InsetGroup>
          <InsetButtonRow
            detail={profileStrings.capabilities.rowDetail}
            onPress={() => setShowCapabilities(true)}
            testID={`${testID}-capabilities`}
            title={profileStrings.capabilities.row}
          />
        </InsetGroup>

        {/*
          Directly above About, because it is the one row on this sheet that
          GOES somewhere — everything below is read-only description, and a
          disclosure buried among facts reads as another fact.
        */}
        {onOpenConversations ? (
          <InsetGroup>
            <InsetButtonRow
              onPress={onOpenConversations}
              testID={`${testID}-conversations`}
              title={chatStrings.sessions.conversations}
            />
          </InsetGroup>
        ) : null}

        <InsetGroup header={text.about}>
          {/*
            TWO rows, because they are two facts.

            One row showed the display name under the label "Profile", which
            said neither thing: the handle — the name `@`-addressing, crons, DM
            lines and the gateway's own logs all use — was not on this sheet at
            all, and the label promised the other one. The handle is `mono`
            because it is an identifier and reads as one.
          */}
          <BotNameFields
            botName={bot.name}
            displayName={bot.displayName}
            isDefault={bot.isDefault}
            home={home}
            nameError={nameError}
            onChangeText={setName}
            renameError={renameError}
            renaming={renaming}
            testID={`${testID}-name`}
            value={name}
            {...(http ? { onRenameProfile: (next: string) => void onRenameProfile(next) } : {})}
          />
          <InsetValueRow
            label={text.model}
            mono={false}
            value={bot.model ? prettyModelName(bot.model) : text.unknown}
          />
          <InsetValueRow label={text.provider} value={bot.provider || text.unknown} />
          <InsetValueRow label={text.session} mono value={bot.canonical?.id ?? text.unknown} />
          <InsetValueRow label={text.gatewayVersion} value={gatewayVersion || text.unknown} />
          {/*
            The same words the options sheet's ring says, without the ring: this
            group is a column of label-and-value rows and one drawing in the
            middle of it would read as a control rather than as a fact.
          */}
          {contextUsage ? (
            <InsetValueRow label={chatStrings.context.label} mono={false} value={contextSummary(contextUsage)} />
          ) : null}
        </InsetGroup>

        {error ? (
          <Text color="dangerText" testID={`${testID}-error`} variant="meta">
            {error}
          </Text>
        ) : null}

        {warning ? (
          <Text color="textMuted" testID={`${testID}-warning`} variant="meta">
            {warning}
          </Text>
        ) : null}

        <Button
          busy={busy}
          disabled={!canSave}
          onPress={() => void onSave()}
          testID={`${testID}-save`}
          title={busy ? text.saving : text.save}
        />
      </View>

      <CapabilitiesSheet
        gateway={gateway}
        onClose={() => setShowCapabilities(false)}
        profile={bot.name}
        visible={showCapabilities}
      />
    </BottomSheet>
  )
}
