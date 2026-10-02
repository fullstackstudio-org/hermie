/**
 * The New-bot form.
 *
 * A bottom sheet rather than a pushed screen, for the reason the cron editor
 * gives: the list stays visible behind it, and the sheet is the one modal idiom
 * that works on all four targets.
 *
 * The handle is validated AS IT IS TYPED, against a transcription of upstream's
 * own validator (`profile-name.ts`). That is not a nicety — `profiles.create`
 * refuses four different ways and each refusal comes back as a Python exception
 * message, so without this the reader learns that `My Bot` is illegal only
 * after a round trip, from a sentence that ends with a shell command.
 *
 * **There is no display-name field**, and the omission is deliberate: no method
 * in the vendored contract writes one. `ProfileRow.display_name` is read-only,
 * `profiles.create` has no such parameter and neither does `profiles.configure`
 * — so a field here could only ever have been a lie. The handle is what the
 * roster shows until the gateway grows a way to set the other.
 *
 * **Model and Clone-from are disclosure rows onto a page, not segmented
 * strips.** They were strips, and a strip divides one fixed width between its
 * options: a gateway offering twenty models gave each label a twentieth of the
 * sheet, so every one of them was cut to two or three characters and the control
 * said nothing at all. The length of both lists is a property of somebody else's
 * machine, which is exactly the case a segmented control cannot serve. A page —
 * the same `PickerPane` the chat's options sheet opens — has one row per option,
 * a tick on the current one, sections per provider and a search field once the
 * list is long. A page rather than a second sheet on top of this one, because two
 * modals deep is where `Modal` stops behaving the same on all four targets.
 */
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'

import type { PickerOption } from '../../chat-ui/types'
import { BottomSheet, SheetEyebrow } from '../../ui/BottomSheet'
import { Button, InsetGroup, InsetRow, Text, TextField } from '../../ui/primitives'
import { DisclosureRow, PickerPane } from '../../ui/sheets'
import { useEscapeKey } from '../../ui/useEscapeKey'
import { useTheme } from '../../ui/theme'
import { checkProfileName } from './profile-name'
import { EMPTY_NEW_BOT_DRAFT, type NewBotDraft } from './profiles-controller'
import { profileStrings } from './strings'

/** One entry in the model picker: what to show, and the pair to send. */
export interface ModelChoice {
  label: string
  model: string
  provider: string
  /**
   * The provider under its own name, which is the picker's section header.
   *
   * Optional because it is the only field the segmented strip this replaced did
   * not need: an inventory that arrives without it falls back to the slug, and a
   * caller that supplies neither gets one ungrouped list.
   */
  providerName?: string
  /** The wire id, under the pretty name. It is what goes in a config file. */
  detail?: string
}

/** Which level of the sheet is showing. A page, not a second modal. */
type Pane = 'root' | 'model' | 'clone'

export interface NewBotSheetProps {
  visible: boolean
  /** Handles already on the roster, so a collision is caught in the field. */
  taken: readonly string[]
  /** Bots that can be cloned from. Empty hides the picker. */
  cloneable?: readonly string[]
  /** From `model.options`. Empty hides the picker and inherits. */
  models?: readonly ModelChoice[]
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onCreate: (draft: NewBotDraft) => void
}

export function NewBotSheet({
  visible,
  taken,
  cloneable = [],
  models = [],
  busy = false,
  error = null,
  onCancel,
  onCreate
}: NewBotSheetProps) {
  const theme = useTheme()
  const [raw, setRaw] = useState('')
  const [draft, setDraft] = useState<NewBotDraft>({ ...EMPTY_NEW_BOT_DRAFT })
  const [touched, setTouched] = useState(false)
  const [pane, setPane] = useState<Pane>('root')

  useEffect(() => {
    // Re-seed on every open: a sheet that reopened holding the last attempt's
    // half-typed handle would look like it had failed to close.
    if (visible) {
      setRaw('')
      setDraft({ ...EMPTY_NEW_BOT_DRAFT })
      setTouched(false)
      setPane('root')
    }
  }, [visible])

  /**
   * Escape goes back exactly ONE level, as it does in the chat's options sheet.
   *
   * The `BottomSheet` below registers its own "close the sheet" handler first,
   * because effects flush child-first and `useEscapeKey` delivers to whoever
   * registered last. A page therefore wins the key while it is open, pops
   * itself, and hands the key back to the sheet.
   */
  useEscapeKey(() => setPane('root'), visible && pane !== 'root')

  const verdict = useMemo(() => checkProfileName(raw, taken), [raw, taken])

  /**
   * The model rows: "Inherit" first and headless, then one section per provider.
   *
   * `value` is the `provider/model` pair the draft actually stores, so the tick
   * needs no lookup table — which is what the strip needed, because a segment's
   * identity there was its LABEL and two providers offering the same model would
   * have collided on it.
   */
  const modelOptions = useMemo<PickerOption[]>(
    () => [
      { value: '', label: profileStrings.new.modelInherit },
      ...models.map(choice => ({
        value: choice.model,
        label: choice.label,
        detail: choice.detail,
        group: choice.providerName ?? choice.provider
      }))
    ],
    [models]
  )

  const cloneOptions = useMemo<PickerOption[]>(
    () => [
      { value: '', label: profileStrings.new.cloneNone },
      ...cloneable.map(name => ({ value: name, label: name }))
    ],
    [cloneable]
  )

  const modelLabel = modelOptions.find(option => option.value === draft.model)?.label ?? profileStrings.new.modelInherit

  const submit = () => {
    setTouched(true)

    if (!verdict.ok || busy) {
      return
    }

    onCreate({ ...draft, handle: verdict.handle })
  }

  return (
    <BottomSheet
      accessibilityLabel={profileStrings.new.title}
      onRequestClose={onCancel}
      testID="new-bot"
      visible={visible}
    >
      {pane === 'model' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            const picked = models.find(choice => choice.model === option.value)

            setDraft(current => ({ ...current, model: picked?.model ?? '', provider: picked?.provider ?? '' }))
            setPane('root')
          }}
          options={modelOptions}
          title={profileStrings.new.model}
          value={draft.model}
        />
      ) : pane === 'clone' ? (
        <PickerPane
          onBack={() => setPane('root')}
          onPick={option => {
            setDraft(current => ({ ...current, cloneFrom: option.value === '' ? null : option.value }))
            setPane('root')
          }}
          options={cloneOptions}
          title={profileStrings.new.cloneFrom}
          value={draft.cloneFrom ?? ''}
        />
      ) : (
        <View style={{ gap: theme.space.xl }}>
          <View style={{ gap: theme.space.xs }}>
            <SheetEyebrow>{profileStrings.new.eyebrow}</SheetEyebrow>
            <Text variant="sheetTitle">{profileStrings.new.title}</Text>
          </View>

          <InsetGroup
            footer={
              <Text color="textMuted" variant="meta">
                {verdict.warning ?? profileStrings.new.handleHint}
              </Text>
            }
          >
            <InsetRow>
              <TextField
                autoCapitalize="none"
                autoCorrect={false}
                error={touched || raw ? verdict.error : null}
                label={profileStrings.new.handle}
                onChangeText={setRaw}
                onSubmitEditing={submit}
                placeholder={profileStrings.new.handlePlaceholder}
                testID="new-bot-handle"
                value={raw}
              />
            </InsetRow>

            <InsetRow>
              <TextField
                label={profileStrings.new.description}
                multiline
                numberOfLines={2}
                onChangeText={description => setDraft(current => ({ ...current, description }))}
                placeholder={profileStrings.new.descriptionPlaceholder}
                style={{ minHeight: 56, textAlignVertical: 'top' }}
                testID="new-bot-description"
                value={draft.description}
              />
            </InsetRow>
          </InsetGroup>

          {models.length ? (
            <InsetGroup
              footer={
                <Text color="textMuted" variant="meta">
                  {profileStrings.new.modelHint}
                </Text>
              }
            >
              <DisclosureRow
                label={profileStrings.new.model}
                onPress={() => setPane('model')}
                testID="new-bot-model"
                value={modelLabel}
              />
            </InsetGroup>
          ) : null}

          {cloneable.length ? (
            <InsetGroup
              footer={
                <Text color="textMuted" variant="meta">
                  {profileStrings.new.cloneHint}
                </Text>
              }
            >
              <DisclosureRow
                label={profileStrings.new.cloneFrom}
                onPress={() => setPane('clone')}
                testID="new-bot-clone"
                value={draft.cloneFrom ?? profileStrings.new.cloneNone}
              />
            </InsetGroup>
          ) : null}

          {error ? (
            <Text color="dangerText" testID="new-bot-error" variant="meta">
              {profileStrings.new.failed(error)}
            </Text>
          ) : null}

          <Button
            busy={busy}
            disabled={!verdict.ok}
            onPress={submit}
            testID="new-bot-create"
            title={profileStrings.new.create}
          />
          <Button onPress={onCancel} title={profileStrings.new.cancel} variant="secondary" />
        </View>
      )}
    </BottomSheet>
  )
}
