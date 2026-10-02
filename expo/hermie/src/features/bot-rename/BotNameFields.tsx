/**
 * The two name rows on the bot profile sheet: one editable, one a fact.
 *
 * ## The editable one is the DISPLAY name, on every profile
 *
 * It used to be whichever name that profile's `PATCH /api/profiles/{name}` would
 * move, which meant the field was a display name on `default` and a RENAME
 * everywhere else. The owner renamed a bot, expecting its label to change, and
 * watched its handle move instead — which is what that route does, and it takes
 * the profile's directory, its wrapper script, its service and the
 * active-profile pointer with it.
 *
 * So the field is the display name now, always. Core still has no way to write
 * one — `profiles.configure` has no such field, `profiles.create` has none, and
 * the REST route above renames instead — so the name is kept beside the reader's
 * folders and colours in `chat-layout`'s `labels` and read back by `botNames`.
 * Clearing it falls back to the name the gateway reports, and then to the handle.
 *
 * Where the gateway-side plugin offers `profiles.display_name` the name goes to
 * the gateway TOO, through the plugin's own route, and `home` is which of those
 * two gateways this is. It changes two things and both are about not lying to
 * the reader: the limit becomes the route's rather than the app's, so a name
 * cannot be composed that the route will refuse, and a gateway that cannot take
 * it says so under the field instead of leaving somebody to find the old name
 * still in the profile list.
 *
 * ## Renaming the profile is still possible, and it is its own act
 *
 * Behind a disclosure of its own, with its own field, its own button and the
 * warning out loud: the handle is what `@`-mentions, crons, DM lines and the
 * gateway's own logs use. Not offered for `default`, which cannot be renamed at
 * all — its home is the installation root — so that row says so instead of
 * opening onto a field whose only answer is a 400.
 */
import { useState } from 'react'
import { View } from 'react-native'

import { BOT_LABEL_MAX } from '../../store/chat-layout'
import { Button, InsetRow, InsetValueRow, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { type DisplayNameHome, PROFILE_DISPLAY_NAME_MAX } from './display-name-controller'
import { PROFILE_NAME_MAX } from './rename-controller'
import { renameStrings } from './strings'

export interface BotNameFieldsProps {
  /** The profile's identifier as the roster last reported it. */
  botName: string
  /** The label the roster reported, which may equal the identifier. */
  displayName: string
  /** `default` keeps its id, so there is no profile rename to offer. */
  isDefault: boolean
  /** The reader's own name for this bot; empty while they have not given one. */
  value: string
  onChangeText: (next: string) => void
  /**
   * Where this name will be saved, or `null` while nobody has looked yet.
   *
   * `gateway` is a plugin advertising `profiles.display_name`; `app` is every
   * other gateway, and is the one that gets a line saying so. `null` draws
   * neither — see `useDisplayNameHome`.
   */
  home?: DisplayNameHome | null
  /** A refusal from the display-name route, under the display-name field. */
  nameError?: string | null
  /**
   * Rename the PROFILE itself.
   *
   * Absent means the disclosure is not drawn: renaming is
   * `PATCH /api/profiles/{name}` and nothing else on this connection can do it,
   * so a button over a gateway with no REST surface would have nowhere to go.
   */
  onRenameProfile?: (next: string) => void
  /** A rename is in flight. */
  renaming?: boolean
  /** Shown under the rename field, in the danger colour. */
  renameError?: string | null
  testID?: string
}

export function BotNameFields({
  botName,
  displayName,
  isDefault,
  value,
  onChangeText,
  home = null,
  nameError,
  onRenameProfile,
  renaming = false,
  renameError,
  testID = 'bot-profile-name'
}: BotNameFieldsProps) {
  const theme = useTheme()
  /* The disclosure, and the draft inside it. Local: it is a form, not a setting. */
  const [renameOpen, setRenameOpen] = useState(false)
  const [draft, setDraft] = useState(botName)
  const canRename = Boolean(onRenameProfile) && !isDefault
  /* What the row shows when the field is empty — the gateway's name, or the handle. */
  const fallback = displayName && displayName !== botName ? displayName : botName

  return (
    <View>
      <InsetRow>
        <TextField
          autoCapitalize="words"
          autoCorrect={false}
          error={nameError ?? null}
          label={renameStrings.displayLabel}
          maxLength={home === 'gateway' ? PROFILE_DISPLAY_NAME_MAX : BOT_LABEL_MAX}
          onChangeText={onChangeText}
          placeholder={fallback}
          testID={testID}
          value={value}
        />
        <Text color="textMuted" variant="meta">
          {renameStrings.displayHint}
        </Text>
        <Text color="textFaint" variant="micro">
          {renameStrings.clearHint}
        </Text>
        {home === 'app' ? (
          <Text color="textFaint" testID={`${testID}-app-only`} variant="micro">
            {renameStrings.displayAppOnly}
          </Text>
        ) : null}
      </InsetRow>

      {/*
        The group draws its own hairlines between CHILDREN, and these rows arrive
        as one child, so the separator between them is drawn here — same inset,
        same colour — rather than the pair reading as one tall row.
      */}
      <View style={{ height: 1, marginLeft: theme.space.lg, backgroundColor: theme.hairline }} />

      {/* The other name, always a fact. `mono` because it is an identifier. */}
      <InsetValueRow detail={renameStrings.profileHint} label={renameStrings.profileLabel} mono value={botName} />

      {isDefault ? (
        <InsetRow>
          <Text color="textMuted" testID={`${testID}-default`} variant="meta">
            {renameStrings.renameDefault}
          </Text>
        </InsetRow>
      ) : null}

      {canRename ? (
        <View>
          <View style={{ height: 1, marginLeft: theme.space.lg, backgroundColor: theme.hairline }} />

          {renameOpen ? (
            <InsetRow>
              <TextField
                autoCapitalize="none"
                autoCorrect={false}
                error={renameError ?? null}
                label={renameStrings.renameField}
                maxLength={PROFILE_NAME_MAX}
                onChangeText={setDraft}
                placeholder={botName}
                testID={`${testID}-rename-field`}
                value={draft}
              />
              <Text color="dangerText" testID={`${testID}-warning`} variant="meta">
                {renameStrings.profileWarning}
              </Text>
              <Button
                busy={renaming}
                disabled={renaming || draft.trim() === '' || draft.trim() === botName}
                onPress={() => onRenameProfile?.(draft)}
                testID={`${testID}-rename-save`}
                title={renaming ? renameStrings.renameBusy : renameStrings.renameAction}
                variant="danger"
              />
              <Button
                onPress={() => {
                  setRenameOpen(false)
                  setDraft(botName)
                }}
                testID={`${testID}-rename-cancel`}
                title={renameStrings.renameCancel}
                variant="secondary"
              />
            </InsetRow>
          ) : (
            <InsetRow>
              <Button
                onPress={() => {
                  setDraft(botName)
                  setRenameOpen(true)
                }}
                testID={`${testID}-rename`}
                title={renameStrings.renameRow}
                variant="secondary"
              />
              <Text color="textMuted" variant="meta">
                {renameStrings.renameHint}
              </Text>
            </InsetRow>
          )}
        </View>
      ) : null}
    </View>
  )
}
