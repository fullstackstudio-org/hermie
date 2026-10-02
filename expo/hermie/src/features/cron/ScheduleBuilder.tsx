/**
 * The schedule picker inside the routine editor.
 *
 * Four modes, one output: a string the gateway's `parse_schedule` accepts. The
 * component holds no schedule of its own — it edits a `ScheduleDraft` and hands
 * the built string up on every change, so the editor can keep Save disabled
 * while the draft does not build.
 *
 * There is no native date picker here on purpose. `@react-native-community/
 * datetimepicker` is a second look and feel to keep in step with the tokens for
 * something that reads fine as `09:00` typed into a field. The Once mode takes
 * text for the same reason.
 */
import { useMemo } from 'react'
import { Pressable, View } from 'react-native'

import { SegmentedRow } from '../../ui/sheets'
import { Text, TextField } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { buildSchedule, type IntervalUnit, type ScheduleDraft, type ScheduleMode } from './schedule'
import { cronStrings } from './strings'

export interface ScheduleBuilderProps {
  draft: ScheduleDraft
  onChange: (draft: ScheduleDraft) => void
  /** Shown once the user tried to save; a half-typed field should not shout. */
  showErrors?: boolean
}

/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
const modes = (): { value: ScheduleMode; label: string }[] => [
  { value: 'interval', label: cronStrings.schedule.modes.interval },
  { value: 'daily', label: cronStrings.schedule.modes.daily },
  { value: 'cron', label: cronStrings.schedule.modes.cron },
  { value: 'once', label: cronStrings.schedule.modes.once }
]

const units = (): { value: IntervalUnit; label: string }[] => [
  { value: 'minutes', label: cronStrings.schedule.units.minutes },
  { value: 'hours', label: cronStrings.schedule.units.hours },
  { value: 'days', label: cronStrings.schedule.units.days }
]

export function ScheduleBuilder({ draft, onChange, showErrors = false }: ScheduleBuilderProps) {
  const theme = useTheme()
  const result = useMemo(() => buildSchedule(draft), [draft])
  const patch = (partial: Partial<ScheduleDraft>) => onChange({ ...draft, ...partial })

  return (
    <View style={{ gap: theme.space.md }} testID="schedule-builder">
      <SegmentedRow
        label={cronStrings.schedule.mode}
        options={modes()}
        value={draft.mode}
        onChange={mode => patch({ mode })}
        testID="schedule-mode"
      />

      {draft.mode === 'interval' ? (
        <View style={{ gap: theme.space.sm }}>
          <TextField
            label={cronStrings.schedule.everyLabel}
            keyboardType="number-pad"
            value={draft.intervalValue}
            onChangeText={intervalValue => patch({ intervalValue })}
            testID="schedule-interval-value"
          />
          <SegmentedRow
            options={units()}
            value={draft.intervalUnit}
            onChange={intervalUnit => patch({ intervalUnit })}
            testID="schedule-interval-unit"
          />
        </View>
      ) : null}

      {draft.mode === 'daily' ? (
        <View style={{ gap: theme.space.sm }}>
          <TextField
            label={cronStrings.schedule.time}
            placeholder={cronStrings.schedule.timePlaceholder}
            autoCapitalize="none"
            value={draft.time}
            onChangeText={time => patch({ time })}
            testID="schedule-time"
          />
          <Text color="textMuted" variant="meta">
            {cronStrings.schedule.days}
          </Text>
          <WeekdayChips weekdays={draft.weekdays} onChange={weekdays => patch({ weekdays })} />
          <Text color="textMuted" variant="meta">
            {cronStrings.schedule.daysHint}
          </Text>
        </View>
      ) : null}

      {draft.mode === 'cron' ? (
        <View style={{ gap: theme.space.sm }}>
          <TextField
            label={cronStrings.schedule.cronExpression}
            placeholder={cronStrings.schedule.cronPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            value={draft.cronExpression}
            onChangeText={cronExpression => patch({ cronExpression })}
            testID="schedule-cron"
          />
          <Text color="textMuted" variant="meta">
            {cronStrings.schedule.cronHint}
          </Text>
        </View>
      ) : null}

      {draft.mode === 'once' ? (
        <View style={{ gap: theme.space.sm }}>
          <TextField
            label={cronStrings.schedule.once}
            placeholder={cronStrings.schedule.oncePlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            value={draft.onceValue}
            onChangeText={onceValue => patch({ onceValue })}
            testID="schedule-once"
          />
          <Text color="textMuted" variant="meta">
            {cronStrings.schedule.onceHint}
          </Text>
        </View>
      ) : null}

      {result.ok ? (
        <Text color="textMuted" variant="meta" testID="schedule-preview">
          {cronStrings.editor.preview(result.schedule)}
        </Text>
      ) : showErrors ? (
        <Text color="dangerText" variant="meta" testID="schedule-error">
          {result.error}
        </Text>
      ) : null}
    </View>
  )
}

function WeekdayChips({ weekdays, onChange }: { weekdays: number[]; onChange: (weekdays: number[]) => void }) {
  const theme = useTheme()

  return (
    <View style={{ flexDirection: 'row', gap: theme.space.xs }}>
      {cronStrings.schedule.weekdayInitials.map((initial, day) => {
        const selected = weekdays.includes(day)

        return (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={cronStrings.schedule.weekdayNames[day]}
            aria-checked={selected}
            key={cronStrings.schedule.weekdayNames[day]}
            onPress={() => onChange(selected ? weekdays.filter(value => value !== day) : [...weekdays, day])}
            style={{
              alignItems: 'center',
              // The bubble, not the fill: the initial on it is `onAccent`.
              backgroundColor: selected ? theme.accent().bubble : theme.elevation.e2,
              borderRadius: theme.radii.pill,
              flex: 1,
              justifyContent: 'center',
              minHeight: 40
            }}
            testID={`schedule-weekday-${day}`}
          >
            <Text color={selected ? 'onAccent' : 'text'} variant="preview">
              {initial}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}
