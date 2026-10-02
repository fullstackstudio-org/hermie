import { useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

import { describeConnectionError } from '../../../gateway/errors'
import { strings } from '../../../i18n/strings'
import { Button, Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { authModeOf, connectionPayloadKey, isTestCurrent, type OnboardingDraft } from '../draft'
import { StatusLine, type StatusTone } from '../StatusLine'
import { runConnectionTest, type ConnectionTestStage } from '../test-connection'

export interface TestConnectionStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}

/** The checklist, in the order `runConnectionTest` actually works through it. */
const STAGES: ConnectionTestStage[] = ['rest', 'socket', 'profiles']

/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
const stageLabel = (): Record<ConnectionTestStage, string> => ({
  rest: strings.onboarding.test.checklist.rest,
  socket: strings.onboarding.test.checklist.socket,
  profiles: strings.onboarding.test.checklist.profiles
})

/**
 * The test runs ITSELF the moment the step appears.
 *
 * It used to be a button, and the button was a question with one answer: the
 * wizard cannot be finished without a passing test, so "Test connection" asked
 * the reader to confirm that they wanted the only thing this step does. What it
 * actually bought was a wait — the reader reads the step, presses, and then
 * waits for a dial that could have started while they were reading.
 *
 * So the button is gone from the success path and kept for the failure one,
 * where it means something different and useful: try that again. The
 * invalidation rule is unchanged and is what makes the automatic run safe —
 * `connectionPayloadKey` identifies everything the test exercised, so changing
 * the address, a header, the provider or the credential produces a new key, and
 * arriving at the step with a key this instance has not run yet starts a run.
 * Arriving with the same key does not, or a failed test would retry itself in a
 * loop nobody asked for.
 */
export function TestConnectionStep({ draft, update }: TestConnectionStepProps) {
  const theme = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // How far the run got. It is reported by the test rather than guessed here,
  // because WHICH half failed is the whole diagnosis: REST refused is a
  // credential, the socket refused is a reverse proxy that drops upgrades.
  const [reached, setReached] = useState<ConnectionTestStage | null>(null)
  const current = isTestCurrent(draft)
  const payloadKey = connectionPayloadKey(draft)
  // Which payload this instance has already dialled for. A ref rather than
  // state: it must not itself cause a render, and the effect below reads it in
  // the same tick it writes it.
  const attempted = useRef<string | null>(null)

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    setReached(null)

    try {
      const outcome = await runConnectionTest(draft, undefined, setReached)

      // The test may have rotated the credential it dialled with; the draft has
      // to carry the live one into the save, not the one it started with.
      update({ test: outcome, ...(outcome.tokens ? { tokens: outcome.tokens } : {}) })
    } catch (testError) {
      update({ test: null })
      setError(describeConnectionError(testError, draft.baseUrl ?? ''))
    } finally {
      setBusy(false)
    }
  }, [draft, update])

  useEffect(() => {
    if (current || busy || attempted.current === payloadKey) {
      return
    }

    attempted.current = payloadKey
    void run()
  }, [busy, current, payloadKey, run])

  const passed = current && draft.test !== null

  return (
    <View style={{ gap: theme.space.lg }}>
      <View style={{ gap: theme.space.sm }}>
        {STAGES.map(stage => (
          <StatusLine
            key={stage}
            testID={`test-stage-${stage}`}
            tone={toneFor(stage, { busy, error, passed, reached })}
          >
            {stageLabel()[stage]}
          </StatusLine>
        ))}
      </View>

      {busy ? (
        <StatusLine testID="test-running" tone="checking">
          {strings.onboarding.test.running}
        </StatusLine>
      ) : null}

      {error ? (
        <View style={{ gap: theme.space.md }}>
          <StatusLine testID="test-error" tone="error">
            {error}
          </StatusLine>
          <Button onPress={() => void run()} testID="test-retry" title={strings.onboarding.test.retry} />
        </View>
      ) : null}

      {passed && draft.test ? (
        <View style={{ gap: theme.space.xs }}>
          <StatusLine testID="test-result" tone="ok">
            {authModeOf(draft.probe) === 'native_pkce' && draft.test.userDisplayName
              ? strings.onboarding.test.connectedAs(draft.test.userDisplayName, draft.test.botCount)
              : strings.onboarding.test.connected(draft.test.botCount)}
          </StatusLine>
          {draft.test.botCount === 0 ? (
            <Text color="textMuted" variant="meta">
              {strings.onboarding.test.noBots}
            </Text>
          ) : null}
        </View>
      ) : null}

      {!busy && !error && !passed ? (
        <Text color="textMuted" testID="test-required" variant="meta">
          {draft.test ? strings.onboarding.test.invalidated : strings.onboarding.test.required}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * Which dot a checklist row gets.
 *
 * A pass marks all three regardless of what the run reported, so a caller that
 * cannot report stages — a test double, or an older code path — still produces
 * an honest checklist rather than three hollow rings beside "Connected".
 */
function toneFor(
  stage: ConnectionTestStage,
  state: { busy: boolean; error: string | null; passed: boolean; reached: ConnectionTestStage | null }
): StatusTone {
  if (state.passed) {
    return 'ok'
  }

  const index = STAGES.indexOf(stage)
  const reachedIndex = state.reached === null ? -1 : STAGES.indexOf(state.reached)

  if (index < reachedIndex) {
    return 'ok'
  }

  if (index > reachedIndex) {
    return 'pending'
  }

  // The stage the run stopped on: still working, or the one that failed.
  return state.busy ? 'checking' : state.error ? 'error' : 'pending'
}
