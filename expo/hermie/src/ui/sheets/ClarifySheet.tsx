/**
 * The clarify sheet: one question, or a stepper over a batch.
 *
 * `clarify` arrives either as a single question or as several at once. A batch
 * is a stepper rather than a long scroll, because the server accepts answers
 * one at a time (`clarify.lock`) and a locked answer may not be edited — the
 * stepper is the shape that makes that visible instead of surprising.
 *
 * Choices and free text coexist on purpose: the model offers options, and the
 * answer the user actually has is often neither of them.
 */
import { useMemo, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'

import { chatStrings } from '../../chat-ui/strings'
import type { ClarifyItem } from '../../chat-ui/types'
import { BottomSheet, SheetEyebrow } from '../BottomSheet'
import { Button, Text, TextField } from '../primitives'
import { useTheme } from '../theme'

export interface ClarifySheetProps {
  visible: boolean
  item: ClarifyItem
  /** Answers the user has committed per question, keyed by `qid`. */
  onLock?: (qid: string, answer: string) => void
  onSubmit: (answers: Record<string, string>) => void
  /**
   * Put the question aside. It stays open on the gateway and in the transcript
   * — this only takes the sheet off the screen — which is why the button says
   * "Later" rather than "Skip".
   */
  onSkip: () => void
  onClose: () => void
  /** Forwarded to the sheet: the slide-out has finished. */
  onClosed?: () => void
}

const MULTI_SEPARATOR = ', '

function toggleValue(current: string, choice: string, multiSelect: boolean): string {
  if (!multiSelect) {
    return current === choice ? '' : choice
  }

  const parts = current ? current.split(MULTI_SEPARATOR).filter(Boolean) : []
  const next = parts.includes(choice) ? parts.filter(part => part !== choice) : [...parts, choice]

  return next.join(MULTI_SEPARATOR)
}

function isSelected(current: string, choice: string, multiSelect: boolean): boolean {
  if (!multiSelect) {
    return current === choice
  }

  return current.split(MULTI_SEPARATOR).includes(choice)
}

export function ClarifySheet({ visible, item, onLock, onSubmit, onSkip, onClose, onClosed }: ClarifySheetProps) {
  const theme = useTheme()
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...item.answers }))

  /**
   * One way out per question.
   *
   * Submit and Later both close the sheet on the tap now, and a closing sheet
   * slides rather than vanishing — so both buttons are still under the finger
   * while it goes. This is the only thing between that and two `clarify.respond`
   * calls for one question.
   */
  const left = useRef(false)

  const leave = (go: () => void) => {
    if (left.current) {
      return
    }

    left.current = true
    go()
  }

  const question = item.questions[Math.min(index, item.questions.length - 1)]
  const batch = item.questions.length > 1
  const locked = useMemo(() => new Set(item.locked), [item.locked])

  if (!question) {
    return null
  }

  // The host keeps a resolved question on screen so its outcome can be read;
  // without this branch the sheet would go on offering Submit for a question
  // the gateway has already closed.
  if (item.state !== 'open') {
    return (
      <BottomSheet
        accessibilityLabel={chatStrings.clarify.title}
        onClosed={onClosed}
        onRequestClose={onClose}
        testID="clarify-sheet"
        visible={visible}
      >
        <SheetEyebrow>{chatStrings.clarify.eyebrow}</SheetEyebrow>
        <Text variant="sheetTitle">{chatStrings.clarify.title}</Text>
        <Text color="textMuted" testID="clarify-resolution">
          {item.state === 'answered'
            ? chatStrings.clarify.outcome(Object.keys(item.answers).length, item.questions.length)
            : item.cancelReason === 'timeout'
              ? chatStrings.approval.timedOut
              : chatStrings.approval.answeredElsewhere}
        </Text>
        <Button onPress={onClose} testID="clarify-close" title={chatStrings.sheet.close} variant="secondary" />
      </BottomSheet>
    )
  }

  const value = answers[question.qid] ?? ''
  const isLocked = locked.has(question.qid)

  const setValue = (next: string) => setAnswers(current => ({ ...current, [question.qid]: next }))

  const lastQuestion = index >= item.questions.length - 1

  return (
    <BottomSheet
      accessibilityLabel={chatStrings.clarify.title}
      onClosed={onClosed}
      onRequestClose={onClose}
      testID="clarify-sheet"
      visible={visible}
    >
      {/*
        The step count rides BESIDE the eyebrow rather than on a line of its own:
        "A QUESTION FOR YOU" and "Question 2 of 3" are the same piece of
        furniture, and stacking them pushed the question itself down a line for
        no information.
      */}
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <View style={{ flex: 1 }}>
          <SheetEyebrow>{chatStrings.clarify.eyebrow}</SheetEyebrow>
        </View>
        {batch ? (
          <Text color="textFaint" testID="clarify-step" variant="micro">
            {chatStrings.clarify.step(index + 1, item.questions.length).toUpperCase()}
          </Text>
        ) : null}
      </View>

      <Text variant="sheetTitle" testID="clarify-question">
        {question.question}
      </Text>

      {/*
        A locked answer is the one state in this sheet a reader can be surprised
        by — the server will not take a second answer — so it says so in words
        with the ok tint behind it, rather than only dimming the controls.
      */}
      {isLocked ? (
        <View
          style={{
            alignSelf: 'flex-start',
            backgroundColor: theme.okSoft,
            borderRadius: theme.radii.pill,
            paddingHorizontal: theme.space.md,
            paddingVertical: 5
          }}
          testID="clarify-locked"
        >
          <Text color="okText" variant="micro">
            {chatStrings.clarify.locked.toUpperCase()}
          </Text>
        </View>
      ) : null}

      {question.multiSelect ? (
        <Text color="textFaint" variant="meta">
          {chatStrings.clarify.multiSelectHint}
        </Text>
      ) : null}

      {question.choices?.length ? (
        <View style={{ gap: theme.space.sm }}>
          {question.choices.map(choice => {
            const selected = isSelected(value, choice, question.multiSelect)

            return (
              <Pressable
                accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={selected}
                aria-disabled={isLocked}
                disabled={isLocked}
                key={choice}
                onPress={() => setValue(toggleValue(value, choice, question.multiSelect))}
                testID={`clarify-choice-${choice}`}
              >
                <View
                  style={{
                    alignItems: 'center',
                    // Unselected is the SUNK well every field in the kit uses, so
                    // a choice reads as something to fill in; selected is the
                    // chat's own accent wash. Both keep a 1pt edge, so picking
                    // one never moves the row by the pixel a 2pt border costs.
                    backgroundColor: selected ? theme.accent().soft : theme.tintSunk,
                    borderColor: selected ? theme.colors.accentText : theme.hairlineSoft,
                    borderRadius: theme.radii.inset,
                    borderWidth: 1,
                    flexDirection: 'row',
                    gap: theme.space.sm,
                    minHeight: 48,
                    opacity: isLocked ? 0.55 : 1,
                    paddingHorizontal: theme.space.lg,
                    paddingVertical: theme.space.sm
                  }}
                >
                  <Text color={selected ? 'accentText' : 'textFaint'} style={{ fontSize: 16 }}>
                    {question.multiSelect ? (selected ? '☑' : '☐') : selected ? '◉' : '○'}
                  </Text>
                  <Text style={{ flex: 1 }}>{choice}</Text>
                </View>
              </Pressable>
            )
          })}
        </View>
      ) : null}

      <TextField
        editable={!isLocked}
        label={chatStrings.clarify.freeText}
        multiline
        onChangeText={setValue}
        placeholder={chatStrings.clarify.freeTextPlaceholder}
        testID="clarify-free-text"
        value={value}
      />

      {/*
        One primary, then the ways sideways. The previous order put "Lock answer"
        above the thing that actually answers the question, so the sheet's first
        button was its most obscure one.
      */}
      <View style={{ gap: theme.space.sm }}>
        {batch && !lastQuestion ? (
          <Button
            onPress={() => setIndex(current => current + 1)}
            testID="clarify-next"
            title={chatStrings.clarify.next}
          />
        ) : (
          <Button
            onPress={() => leave(() => onSubmit(answers))}
            testID="clarify-submit"
            title={chatStrings.clarify.submit}
          />
        )}

        {onLock && !isLocked ? (
          <Button
            disabled={!value.trim()}
            onPress={() => onLock(question.qid, value)}
            testID="clarify-lock"
            title={chatStrings.clarify.lock}
            variant="secondary"
          />
        ) : null}

        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
          {batch && index > 0 ? (
            <Button
              onPress={() => setIndex(current => current - 1)}
              style={{ flex: 1 }}
              testID="clarify-previous"
              title={chatStrings.clarify.previous}
              variant="secondary"
            />
          ) : null}
          <Button
            onPress={() => leave(onSkip)}
            style={{ flex: 1 }}
            testID="clarify-skip"
            title={chatStrings.clarify.later}
            variant="secondary"
          />
        </View>
      </View>
    </BottomSheet>
  )
}
