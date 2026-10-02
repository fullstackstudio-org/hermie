import { useCallback, useState } from 'react'

import { isSecretStoreWriteError, type StoredGatewayConfig } from '../../gateway/config'
import { describeConnectionError } from '../../gateway/errors'
import { saveGatewayAndRegister } from '../../gateway/registry'
import { WEB_GATEWAY_BASE_URL } from '../../gateway/web-config'
import { strings } from '../../i18n/strings'
import {
  authModeOf,
  configFromDraft,
  draftFromConfig,
  emptyDraft,
  hasCredential,
  headerRecord,
  isTestCurrent,
  NUMBERED_STEPS,
  ONBOARDING_ORDER,
  type OnboardingDraft,
  type OnboardingStep,
  type ResumeAccess
} from './draft'
import { OnboardingCard } from './OnboardingCard'
import { DoneStep } from './steps/DoneStep'
import { GatewayAddressStep } from './steps/GatewayAddressStep'
import { NotificationsStep } from './steps/NotificationsStep'
import { SignInStep } from './steps/SignInStep'
import { TestConnectionStep } from './steps/TestConnectionStep'
import { WelcomeStep } from './steps/WelcomeStep'

/**
 * The order, which the browser build shortens: there is no address to ask for
 * when the app is served by a proxy that already fixes the gateway. See
 * `ONBOARDING_ORDER`.
 */
const ORDER: OnboardingStep[] = ONBOARDING_ORDER

/**
 * The draft a wizard STARTS from.
 *
 * In a browser the gateway is the page's own origin, so the address is filled
 * in before the first render rather than typed: every later step reads
 * `draft.baseUrl`, and a wizard that skipped the address step without setting
 * it would have nothing to probe.
 */
function initialDraftFor(resumeConfig: StoredGatewayConfig | null, resumeAccess: ResumeAccess | null): OnboardingDraft {
  const draft = resumeConfig ? draftFromConfig(resumeConfig, resumeAccess ?? undefined) : emptyDraft()

  if (!WEB_GATEWAY_BASE_URL) {
    return draft
  }

  return { ...draft, rawAddress: WEB_GATEWAY_BASE_URL, baseUrl: WEB_GATEWAY_BASE_URL }
}

export interface OnboardingNavigatorProps {
  /** Resuming after a sign-out: the address survives, the credentials do not. */
  resumeConfig?: StoredGatewayConfig | null
  /**
   * The custom headers and the front door that belong to that address.
   *
   * Without them a resumed wizard cannot probe a gateway behind an access
   * proxy at all — `/api/status` is the first thing such a proxy refuses — so
   * it would ask for a service-token secret again in order to recover from an
   * expired access token.
   */
  resumeAccess?: ResumeAccess | null
  /**
   * The entry this wizard writes into, or `null` to mint one.
   *
   * The active gateway when the reader opened setup over a configured one —
   * "Change gateway" is editing that entry's address, not describing a second
   * machine — and `null` on a first run.
   */
  gatewayId?: string | null
  onComplete: () => void | Promise<void>
  /**
   * Offered when the wizard opened over a gateway that is still configured —
   * "Change gateway" — so that looking at the address does not commit to
   * replacing it.
   */
  onCancel?: () => void | Promise<void>
  initialStep?: OnboardingStep
  initialDraft?: OnboardingDraft
  /** Passed through to the address step; tests drive it to zero. */
  probeDebounceMs?: number
}

/**
 * Welcome → Gateway address → Sign in → Test connection → Done.
 *
 * The wizard is one screen with steps rather than a navigator: it owns a single
 * draft that every step reads and writes, the steps are strictly ordered, and
 * nothing about it wants a back stack with its own history.
 *
 * **The chrome lives in `OnboardingCard`, and the heading with it.** Every step
 * used to draw its own title and lead, which is why the two were easy to get
 * out of step with each other — one step used `title`, another an inset group
 * header — and why the wizard read as five loosely related screens instead of
 * one. A step now contributes its body and nothing else; what it is called and
 * what moves it forward are decided here, in one place, where the order already
 * is.
 */
export function OnboardingNavigator({
  resumeConfig = null,
  resumeAccess = null,
  gatewayId = null,
  onComplete,
  onCancel,
  initialStep,
  initialDraft,
  probeDebounceMs
}: OnboardingNavigatorProps) {
  const [draft, setDraft] = useState<OnboardingDraft>(() => initialDraft ?? initialDraftFor(resumeConfig, resumeAccess))
  /*
    The first step of the ORDER, not the literal `welcome`.

    In a browser the order starts at `signin` (ADR-0025) and there is no welcome
    step at all, so naming one would open the wizard on a step that is not in
    its own sequence: `advance` would look it up, find -1, land on index 0 and
    replay the first step, and `goBack` would have nothing to go back to.
  */
  const [step, setStep] = useState<OnboardingStep>(
    () => initialStep ?? (resumeConfig ? 'signin' : (ORDER[0] ?? 'welcome'))
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const update = useCallback((patch: Partial<OnboardingDraft>) => {
    setDraft(current => {
      // Moving to a different gateway invalidates who you are on the old one.
      // The test result invalidates itself through the payload key, but a
      // token minted by another gateway has to be dropped outright.
      const movedGateway =
        patch.baseUrl !== undefined &&
        patch.baseUrl !== null &&
        current.baseUrl !== null &&
        patch.baseUrl !== current.baseUrl

      return movedGateway
        ? { ...current, ...patch, tokens: null, provider: null, sessionToken: '', test: null }
        : { ...current, ...patch }
    })
  }, [])

  const canAdvance = (): boolean => {
    switch (step) {
      case 'welcome':
        return true
      case 'address':
        return draft.probe !== null && draft.baseUrl !== null
      case 'signin': {
        if (!hasCredential(draft)) {
          return false
        }

        const mode = authModeOf(draft.probe)

        // The native flow is the only one with a capability to check: a gateway
        // may be gated and still not offer it, which is a dead end the step
        // says out loud. Cookie and session-token both prove themselves by
        // producing a credential at all.
        return mode !== 'native_pkce' || draft.probe?.supportsNativePkce === true
      }
      case 'test':
        return isTestCurrent(draft)
      case 'notifications':
        // Always. Notifications are worth nothing if they are imposed, and a
        // gateway with no plugin has nothing here for the app to do at all.
        return true
      case 'done':
        return true
    }
  }

  const finish = useCallback(async () => {
    setSaving(true)
    setSaveError(null)

    try {
      const config = configFromDraft(draft)

      /*
        "Change gateway" leaves the previous gateway entirely alone so that the
        trip can be abandoned. This is the moment it stops being abandonable,
        and `saveGatewayAndRegister` is what makes it one act rather than two:
        the configuration lands under the entry's id and the entry is brought
        into step with it, so the list can never name an address the app is not
        dialling. A DIFFERENT address into an existing entry drops that entry's
        credentials on the way — they were minted by a gateway it no longer
        points at.

        The push registration on the OLD gateway is not retired here, and
        cannot be: retiring it is a write over a socket that was closed when
        the wizard opened. It names a device on a gateway this app has left,
        which is worth less than the sign-in that keeping the socket up would
        have cost — see `changeGateway` in `GatewayProvider`.
      */
      await saveGatewayAndRegister({
        gatewayId,
        config,
        // As TYPED, not as sent: the front door is stored as the preset it is,
        // origin-bound, and folded back in on load. Writing the derived pair
        // into the header blob as well would leave two copies of one secret.
        extraHeaders: headerRecord(draft.headers),
        frontDoor: draft.frontDoor,
        tokens: draft.tokens,
        sessionToken: draft.sessionToken.trim() || null
      })
      await onComplete()
    } catch (error) {
      /*
        The keychain refusing is its own sentence, not a variant of "the
        settings could not be saved".

        It is also the only failure here that leaves NOTHING on disk —
        `saveGatewaySetup` rolls its secrets back and writes no configuration —
        so pressing the button again is a clean retry rather than a second
        attempt on top of a half-written gateway. That is what makes it worth
        offering as one.
      */
      setSaveError(
        isSecretStoreWriteError(error)
          ? strings.onboarding.done.credentialsNotStored(error.reason)
          : strings.onboarding.done.saveFailed(describeConnectionError(error, draft.baseUrl ?? ''))
      )
      setSaving(false)
    }
  }, [draft, gatewayId, onComplete])

  const advance = () => {
    if (step === 'done') {
      void finish()

      return
    }

    const next = ORDER[ORDER.indexOf(step) + 1]

    if (next) {
      setStep(next)
    }
  }

  const goBack = () => {
    const previous = ORDER[ORDER.indexOf(step) - 1]

    if (previous) {
      setStep(previous)
    }
  }

  const primaryLabel =
    step === 'welcome'
      ? strings.onboarding.welcome.action
      : step === 'done'
        ? saving
          ? strings.onboarding.done.saving
          : saveError
            ? // The button after a failure is a retry, and a button that still
              // says "Start chatting" under a red line asks the reader to work
              // out for themselves that pressing it again is allowed.
              strings.onboarding.done.retry
            : strings.onboarding.done.finish
        : strings.common.continue

  const authMode = authModeOf(draft.probe)

  const heading: { title: string; lead: string } =
    step === 'welcome'
      ? { title: strings.onboarding.welcome.title, lead: strings.onboarding.welcome.body }
      : step === 'address'
        ? { title: strings.onboarding.address.title, lead: strings.onboarding.address.subtitle }
        : step === 'signin'
          ? {
              title: strings.onboarding.signIn.title,
              lead:
                authMode === 'session_token'
                  ? strings.onboarding.signIn.subtitleToken
                  : authMode === 'cookie'
                    ? strings.onboarding.signIn.subtitleCookie
                    : strings.onboarding.signIn.subtitleNative
            }
          : step === 'test'
            ? { title: strings.onboarding.test.title, lead: strings.onboarding.test.subtitle }
            : step === 'notifications'
              ? draft.test?.plugin
                ? {
                    title: strings.onboarding.notifications.title,
                    lead: strings.onboarding.notifications.subtitle
                  }
                : {
                    title: strings.onboarding.notifications.missingTitle,
                    // The lead is empty because the body carries a command in
                    // backticks, which the card's heading cannot draw as a chip.
                    lead: ''
                  }
              : {
                  title: strings.onboarding.done.title,
                  lead:
                    authMode === 'cookie' ? strings.onboarding.done.subtitleCookie : strings.onboarding.done.subtitle
                }

  return (
    <OnboardingCard
      backDisabled={saving}
      cover={step === 'welcome'}
      lead={heading.lead}
      onBack={step === 'welcome' ? undefined : goBack}
      {...(onCancel ? { onCancel: () => void onCancel() } : {})}
      onPrimary={advance}
      primaryBusy={saving}
      primaryDisabled={!canAdvance()}
      primaryLabel={primaryLabel}
      stepCount={NUMBERED_STEPS.length}
      stepIndex={NUMBERED_STEPS.indexOf(step)}
      title={heading.title}
    >
      {step === 'welcome' ? <WelcomeStep /> : null}
      {step === 'address' ? (
        <GatewayAddressStep
          draft={draft}
          update={update}
          {...(probeDebounceMs === undefined ? {} : { debounceMs: probeDebounceMs })}
        />
      ) : null}
      {step === 'signin' ? <SignInStep draft={draft} update={update} /> : null}
      {step === 'test' ? <TestConnectionStep draft={draft} update={update} /> : null}
      {step === 'notifications' ? <NotificationsStep draft={draft} /> : null}
      {step === 'done' ? <DoneStep draft={draft} error={saveError} /> : null}
    </OnboardingCard>
  )
}
