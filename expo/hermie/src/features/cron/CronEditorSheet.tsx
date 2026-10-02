/**
 * The routine editor.
 *
 * A bottom sheet rather than a pushed screen, following the design board: the
 * list stays visible behind it, and the sheet is the app's one modal idiom that
 * works on all four targets (`ui/BottomSheet`).
 *
 * The sheet never predicts when the routine will next fire. It builds a
 * schedule string, the gateway parses it, and the `next_run_at` that comes back
 * is what the detail screen shows. Any countdown computed here would be in the
 * phone's timezone, and the scheduler runs in the gateway's.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { View } from 'react-native'

import { BottomSheet, SheetEyebrow } from '../../ui/BottomSheet'
import { Button, Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { CronJobInput } from './cron-controller'
import type { CronDeliveryTarget, CronJob } from './model'
import { buildSchedule, DEFAULT_SCHEDULE_DRAFT, draftFromSchedule, type ScheduleDraft } from './schedule'
import { ScheduleBuilder } from './ScheduleBuilder'
import { cronStrings } from './strings'

export interface CronEditorSheetProps {
  visible: boolean
  /** Null creates a cron; a job edits it. */
  job: CronJob | null
  targets: readonly CronDeliveryTarget[]
  /**
   * Profiles a new cron may be created in, launch profile first. Empty hides
   * the picker, which is the right shape for a single-profile gateway.
   */
  profiles?: readonly string[]
  saving?: boolean
  error?: string | null
  onCancel: () => void
  onSave: (input: CronJobInput) => void
}

interface Draft {
  name: string
  prompt: string
  deliver: string
  /** '' is the launch profile, which is what an absent `profile` param means. */
  profile: string
  schedule: ScheduleDraft
}

const emptyDraft = (): Draft => ({
  name: '',
  prompt: '',
  deliver: 'local',
  profile: '',
  schedule: { ...DEFAULT_SCHEDULE_DRAFT }
})

const draftFor = (job: CronJob | null): Draft =>
  job
    ? {
        name: job.name,
        prompt: job.prompt || job.promptPreview,
        deliver: job.deliver || 'local',
        profile: job.profile ?? '',
        schedule: draftFromSchedule(job.schedule)
      }
    : emptyDraft()

export function CronEditorSheet({
  visible,
  job,
  targets,
  profiles = [],
  saving = false,
  error = null,
  onCancel,
  onSave
}: CronEditorSheetProps) {
  const theme = useTheme()
  const [draft, setDraft] = useState<Draft>(() => draftFor(job))
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    // Re-seed on every open, so editing one routine and then another does not
    // show the first one's prompt for a frame.
    if (visible) {
      setDraft(draftFor(job))
      setTouched(false)
    }
  }, [job, visible])

  const schedule = buildSchedule(draft.schedule)
  const nameError = draft.name.trim() ? null : cronStrings.editor.nameRequired
  const promptError = draft.prompt.trim() ? null : cronStrings.editor.promptRequired
  const valid = !nameError && !promptError && schedule.ok

  const submit = () => {
    setTouched(true)

    if (!valid || !schedule.ok) {
      return
    }

    onSave({
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      deliver: draft.deliver,
      // Only ever sent on create: `PUT {updates}` has no way to move a job
      // between stores, and the route would read it as "look for it over here".
      ...(job ? {} : { profile: draft.profile || null }),
      schedule: schedule.schedule
    })
  }

  return (
    <BottomSheet
      visible={visible}
      onRequestClose={onCancel}
      accessibilityLabel={job ? cronStrings.editor.editTitle : cronStrings.editor.createTitle}
      testID="cron-editor"
    >
      <View style={{ gap: theme.space.xl }}>
        {/*
          Title only. The eyebrow above it read "NEW CRON" over "New cron" — the
          same two words twice, in two sizes, which is a stutter rather than a
          hierarchy. The eyebrow earns its line where it says something the title
          does not (the approval sheet names the bot); here it did not.
        */}
        <Text variant="sheetTitle">{job ? cronStrings.editor.editTitle : cronStrings.editor.createTitle}</Text>

        <Section title={cronStrings.editor.what}>
          <TextField
            label={cronStrings.editor.name}
            placeholder={cronStrings.editor.namePlaceholder}
            value={draft.name}
            onChangeText={name => setDraft(current => ({ ...current, name }))}
            error={touched ? nameError : null}
            testID="cron-editor-name"
          />

          <TextField
            label={cronStrings.editor.prompt}
            placeholder={cronStrings.editor.promptPlaceholder}
            multiline
            numberOfLines={4}
            style={{ minHeight: 96, textAlignVertical: 'top' }}
            value={draft.prompt}
            onChangeText={prompt => setDraft(current => ({ ...current, prompt }))}
            error={touched ? promptError : null}
            testID="cron-editor-prompt"
          />
        </Section>

        <Section hint={cronStrings.editor.nextRunHint} title={cronStrings.editor.schedule}>
          <ScheduleBuilder
            draft={draft.schedule}
            onChange={next => setDraft(current => ({ ...current, schedule: next }))}
            showErrors={touched}
          />
        </Section>

        <Section title={cronStrings.editor.where}>
          <DeliveryPicker
            targets={targets}
            value={draft.deliver}
            onChange={deliver => setDraft(current => ({ ...current, deliver }))}
          />

          <ProfilePicker
            locked={job !== null}
            onChange={profile => setDraft(current => ({ ...current, profile }))}
            profiles={profiles}
            value={draft.profile}
          />
        </Section>

        {error ? (
          <Text color="dangerText" variant="meta" testID="cron-editor-error">
            {cronStrings.editor.saveFailed(error)}
          </Text>
        ) : null}

        <View style={{ gap: theme.space.sm }}>
          <Button
            title={saving ? cronStrings.editor.saving : cronStrings.editor.save}
            busy={saving}
            onPress={submit}
            testID="cron-editor-save"
          />
          <Button title={cronStrings.editor.cancel} variant="secondary" onPress={onCancel} disabled={saving} />
        </View>
      </View>
    </BottomSheet>
  )
}

/**
 * One titled group of fields.
 *
 * The editor is five controls long and, as one flat column, every one of them
 * looked equally important — the schedule builder in particular, which is three
 * controls of its own, ran straight into the delivery pills above it. Three
 * headings are what make it readable without a second screen.
 */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.md }}>
      <SheetEyebrow>{title}</SheetEyebrow>
      {children}
      {hint ? (
        <Text color="textFaint" variant="meta">
          {hint}
        </Text>
      ) : null}
    </View>
  )
}

function DeliveryPicker({
  targets,
  value,
  onChange
}: {
  targets: readonly CronDeliveryTarget[]
  value: string
  onChange: (id: string) => void
}) {
  // `local` is implicit on every gateway; it is listed even before the
  // delivery-targets call has answered, so the picker is never empty.
  const options = targets.length
    ? targets
    : [{ id: 'local', name: cronStrings.editor.deliverLocal, homeTargetSet: true }]

  return (
    <OptionPills
      label={cronStrings.editor.deliver}
      onChange={onChange}
      options={options.map(target => ({ id: target.id, label: target.name }))}
      testID="cron-editor-deliver"
      value={value}
    />
  )
}

/**
 * Which profile's cron store a NEW job is written to.
 *
 * Create-only, and the hint says why rather than the control being missing
 * without explanation: the profile is not a field on the job, it is the scope
 * the gateway ran the create under, so there is nothing an edit could change.
 * A gateway that serves one profile passes no options and gets no picker.
 */
function ProfilePicker({
  profiles,
  value,
  locked,
  onChange
}: {
  profiles: readonly string[]
  value: string
  locked: boolean
  onChange: (profile: string) => void
}) {
  const theme = useTheme()

  if (!profiles.length) {
    return null
  }

  if (locked) {
    return (
      <View style={{ gap: theme.space.xxs }} testID="cron-editor-profile-locked">
        <Text color="textMuted" variant="meta">
          {cronStrings.editor.profile}
        </Text>
        <Text variant="preview">{value || cronStrings.editor.profileDefault}</Text>
        <Text color="textMuted" variant="meta">
          {cronStrings.editor.profileLocked}
        </Text>
      </View>
    )
  }

  return (
    <OptionPills
      hint={cronStrings.editor.profileHint}
      label={cronStrings.editor.profile}
      onChange={onChange}
      options={[
        { id: '', label: cronStrings.editor.profileDefault },
        ...profiles.map(profile => ({ id: profile, label: profile }))
      ]}
      testID="cron-editor-profile"
      value={value}
    />
  )
}

/** The sheet's one row-of-pills control, so both pickers stay one style. */
function OptionPills({
  label,
  hint,
  options,
  value,
  onChange,
  testID
}: {
  label: string
  hint?: string
  options: readonly { id: string; label: string }[]
  value: string
  onChange: (id: string) => void
  testID: string
}) {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.space.sm }} testID={testID}>
      <Text color="textMuted" variant="meta">
        {label}
      </Text>
      {/*
        §3's `.chip`: a 32pt pill on the level-3 tint with a hairline, and the
        pressed one filled with the accent. The hairline is what tells an
        unselected pill apart from the sheet behind it — without it the group
        read as a row of words on a dark sheet.
      */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        {options.map(option => {
          const selected = option.id === value

          return (
            <Text
              accessibilityRole="button"
              aria-selected={selected}
              key={option.id}
              onPress={() => onChange(option.id)}
              color={selected ? 'onAccent' : 'textMuted'}
              style={{
                // The bubble, not the fill: the label on it is `onAccent`.
                backgroundColor: selected ? theme.accent().bubble : theme.elevation.e2,
                borderColor: selected ? 'transparent' : theme.hairlineSoft,
                borderRadius: theme.radii.pill,
                borderWidth: 1,
                fontSize: 14,
                fontWeight: '600',
                lineHeight: 18,
                overflow: 'hidden',
                paddingHorizontal: theme.space.md,
                paddingVertical: 7
              }}
              testID={`${testID}-${option.id}`}
            >
              {option.label}
            </Text>
          )
        })}
      </View>
      {hint ? (
        <Text color="textMuted" variant="meta">
          {hint}
        </Text>
      ) : null}
    </View>
  )
}
