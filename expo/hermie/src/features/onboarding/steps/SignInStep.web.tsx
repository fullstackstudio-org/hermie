/**
 * Signing in from a browser tab: the gateway's own cookie session.
 *
 * The whole step is a different shape from the native one, which is why it is a
 * platform file rather than a branch inside `SignInStep.tsx`. What differs is
 * not the wording but the mechanics:
 *
 *  - **The address is already known.** Hermie Web serves this page and proxies
 *    the gateway onto the same origin, so the step probes `window.location.origin`
 *    on mount instead of waiting for an address step that does not exist.
 *  - **There may already be a session.** A cookie survives the reload that ends
 *    the OAuth redirect chain, so the first thing the step does after the probe
 *    is ask `GET /api/auth/me`. When that answers, the user is signed in and
 *    never sees a button.
 *  - **The OAuth door is a full-page navigation.** The app is torn down and
 *    rebuilt when it returns; nothing the wizard is holding survives, which is
 *    exactly why the cookie is the state.
 *  - **The password door is not.** `POST /auth/password-login` sets the cookies
 *    on its own response, so a password provider stays inside the SPA.
 */
import { type AuthProvider, CookieSessionCredentials, GatewayHttp, probeGateway } from '@hermie/gateway-client'
import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'

import { describeProbeError, describeSignInError } from '../../../gateway/errors'
import { loadHermieWebConfig, probeFromWebConfig } from '../../../gateway/web-config'
import { strings } from '../../../i18n/strings'
import { Button, InsetGroup, InsetRow, SecretField, Text, TextField } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { passwordLogin, startCookieSignIn } from '../cookie-sign-in'
import { authModeOf, type OnboardingDraft } from '../draft'
import { StatusLine } from '../StatusLine'

export interface SignInStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}

type Phase = 'probing' | 'checking' | 'ready' | 'leaving' | 'failed'

export function SignInStep({ draft, update }: SignInStepProps) {
  const theme = useTheme()
  const baseUrl = draft.baseUrl ?? ''
  /*
   * Always probing on mount, never "ready because the draft already had one".
   *
   * The draft DOES already have one after a sign-out — `draftFromConfig`
   * synthesises it from the stored gateway — and it is a guess about today
   * made out of a preference file. See `discover` for what that guess cost.
   */
  const [phase, setPhase] = useState<Phase>('probing')
  const [error, setError] = useState<string | null>(null)
  const [host, setHost] = useState<string>('')
  const [oidcEnabled, setOidcEnabled] = useState(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void loadHermieWebConfig().then(config => {
      setHost(config?.gatewayHost ?? '')
      // Absent (an older server) reads as on, same as everywhere else this
      // field is read.
      setOidcEnabled(config?.oidc ?? true)
    })
  }, [])

  /*
    The module caches one promise for the whole page, so asking here and in the
    effect above is one request, not two.
  */

  /**
   * Learn what the gateway takes, then ask who we are — in that order and only
   * once.
   *
   * ## Why the gateway is usually not probed at all any more
   *
   * Hermie Web has already read `/api/status` and `/api/auth/providers` to
   * answer `/hermie/config.json`, and it holds the answer for a minute
   * ([ADR-0025](../../../../../docs/adr/0025-hermie-web-is-a-service-layer.md)).
   * Asking again from the page would be the same two requests, through the
   * proxy, for an answer that is already on its way — and it is the request
   * this screen waits on before it can draw anything, so it is the one worth
   * not making. `probeFromWebConfig` answers `null` when the server could not
   * read the gateway or is too old to report it, and then the probe runs
   * exactly as it did before.
   *
   * The identity check is not skipped when the probe says the gateway is
   * ungated: `authModeOf` answers `session_token` there, and this component is
   * only rendered for the cookie case, so the branch simply does not arise. It
   * IS skipped when a session was already found, because a second `/api/auth/me`
   * would tell us the same thing.
   *
   * ## Why the draft's probe is not reused
   *
   * It used to read `draft.probe ?? (await probeGateway(baseUrl))`, and on the
   * path that matters most there IS one — `draftFromConfig` synthesises a probe
   * out of the stored gateway so a sign-out can open the wizard straight on
   * this step. A preference file knows the auth MODE. It does not know whether
   * the provider takes a password, and the synthesised entry says `false`, so
   * after every sign-out this screen offered the redirect and nothing else: the
   * in-app form — the one with the password manager's autofill on it — was
   * unreachable for exactly the visitor who had used it before.
   *
   * The fix is the one the function's own documentation already promised. The
   * probe runs. It is one GET against a gateway this page is already talking
   * to, and it is the only thing here that can answer today's question.
   */
  const discover = useCallback(async () => {
    if (!baseUrl) {
      return
    }

    setError(null)
    setPhase('probing')

    try {
      const probe = probeFromWebConfig(await loadHermieWebConfig()) ?? (await probeGateway(baseUrl))
      update({ probe })
      setPhase('checking')

      if (!probe.authRequired || !probe.authFlows.includes('cookie')) {
        setPhase('ready')

        return
      }

      const http = new GatewayHttp({ baseUrl, credentials: new CookieSessionCredentials({ baseUrl }) })

      try {
        const identity = await http.authMe()
        update({
          cookieIdentity: {
            userId: identity.userId,
            displayName: identity.displayName || identity.email || identity.userId
          },
          ...(probe.providers.length === 1 && probe.providers[0] ? { provider: probe.providers[0] } : {})
        })
      } catch {
        // No session yet — the ordinary first visit. Not an error to report.
      }

      setPhase('ready')
    } catch (probeError) {
      setError(describeProbeError(probeError, baseUrl))
      setPhase('failed')
    }
  }, [baseUrl, update])

  useEffect(() => {
    if (phase === 'probing') {
      void discover()
    }
  }, [discover, phase])

  const probe = draft.probe
  const allProviders = probe?.providers ?? []
  /*
   * `--no-oidc` / `HERMIE_OIDC=0`: every provider that is not a password one
   * is an OIDC/SSO redirect, and this Hermie Web refuses that redirect's own
   * route with a 403 regardless — so it is left out here rather than offered
   * and then failing the moment it is pressed.
   */
  const providers = oidcEnabled ? allProviders : allProviders.filter(provider => provider.supportsPassword)
  // The gateway has a way in; every one of them was OIDC, and this build has
  // turned OIDC off. Worth its own sentence rather than the ordinary
  // "no identity providers" one below, which would blame the gateway for a
  // limit this build chose.
  const ssoOnly = !oidcEnabled && allProviders.length > 0 && providers.length === 0
  const onlyProvider = providers.length === 1 ? providers[0] : undefined
  const selected = draft.provider ?? onlyProvider ?? null

  const submitPassword = async (provider: AuthProvider) => {
    setSubmitting(true)
    setError(null)

    try {
      await passwordLogin({ baseUrl, provider: provider.name, username, password })
      // The password never lives longer than the request that used it.
      setPassword('')

      const http = new GatewayHttp({ baseUrl, credentials: new CookieSessionCredentials({ baseUrl }) })
      const identity = await http.authMe()

      update({
        provider,
        cookieIdentity: {
          userId: identity.userId,
          displayName: identity.displayName || identity.email || identity.userId
        }
      })
    } catch (loginError) {
      setError(describeSignInError(loginError, baseUrl))
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * Return, from either field.
   *
   * It asks the same question the button's `disabled` asks, because a key that
   * submits a form the button refuses to submit is the two disagreeing about
   * what is filled in. A half-typed form swallows the key rather than posting
   * an empty password and painting the error for it.
   */
  const canSubmit = !submitting && username !== '' && password !== ''

  const submitFromKeyboard = () => {
    if (canSubmit && selected?.supportsPassword) {
      void submitPassword(selected)
    }
  }

  return (
    <View style={{ gap: theme.space.lg }}>
      <Text color="textFaint" variant="meta">
        {host ? strings.onboarding.signIn.servedFrom(host) : strings.onboarding.signIn.servedFromUnknown}
      </Text>

      {phase === 'probing' ? <StatusLine tone="checking">{strings.onboarding.signIn.probingGateway}</StatusLine> : null}
      {phase === 'checking' ? (
        <StatusLine tone="checking">{strings.onboarding.signIn.checkingSession}</StatusLine>
      ) : null}
      {phase === 'leaving' ? (
        <StatusLine tone="checking">{strings.onboarding.signIn.leavingForProvider}</StatusLine>
      ) : null}
      {error ? (
        <StatusLine testID="signin-error" tone="error">
          {error}
        </StatusLine>
      ) : null}

      {/*
        `native_pkce` and not "anything that is not cookie".
        
        `authModeOf` answers `session_token` for a gateway that is not gated at
        all, and that took this branch: an ungated gateway was shown "This
        gateway is too old for browser sign-in — it requires a sign-in but does
        not advertise the cookie flow" directly under a lead saying it is not
        gated and authenticates with a session token. Two sentences on one
        screen contradicting each other, one of them accusing a perfectly
        current gateway of being old.
      */}
      {phase === 'ready' && probe && authModeOf(probe) === 'native_pkce' ? (
        <View style={{ gap: theme.space.xs }}>
          <StatusLine testID="signin-blocked" tone="error">
            {strings.onboarding.signIn.cookieBlockedTitle}
          </StatusLine>
          <Text color="textMuted" variant="preview">
            {strings.onboarding.signIn.cookieBlockedBody}
          </Text>
        </View>
      ) : null}

      {/*
        The other dead end, and the one that looked like a bug rather than a
        limit: a gateway that authenticates with a session token. The native
        apps sign in to it happily; this build keeps no bearer token at all —
        `platform/secret-store.web.ts` says why at length — so there is nothing
        for this screen to collect. It used to render nothing, which left a
        Continue that could never be pressed and no reason on the screen.
      */}
      {phase === 'ready' && probe && authModeOf(probe) === 'session_token' ? (
        <View style={{ gap: theme.space.xs }}>
          <StatusLine testID="signin-blocked" tone="error">
            {strings.onboarding.signIn.tokenBlockedTitle}
          </StatusLine>
          <Text color="textMuted" variant="preview">
            {strings.onboarding.signIn.tokenBlockedBody}
          </Text>
        </View>
      ) : null}

      {draft.cookieIdentity ? (
        <StatusLine testID="signin-result" tone="ok">
          {strings.onboarding.signIn.signedInAs(draft.cookieIdentity.displayName)}
        </StatusLine>
      ) : phase === 'ready' && probe && authModeOf(probe) === 'cookie' ? (
        ssoOnly ? (
          <StatusLine testID="signin-sso-off" tone="error">
            {strings.onboarding.signIn.ssoOff}
          </StatusLine>
        ) : providers.length === 0 ? (
          <StatusLine testID="signin-blocked" tone="error">
            {strings.errors.providersUnavailable}
          </StatusLine>
        ) : (
          <View style={{ gap: theme.space.md }}>
            {providers.length > 1 ? (
              <InsetGroup header={strings.onboarding.signIn.chooseProvider}>
                {providers.map(provider => (
                  <InsetRow key={provider.name}>
                    <Button
                      onPress={() => update({ provider })}
                      title={provider.displayName}
                      variant={selected?.name === provider.name ? 'primary' : 'secondary'}
                    />
                  </InsetRow>
                ))}
              </InsetGroup>
            ) : null}

            {selected?.supportsPassword ? (
              <View style={{ gap: theme.space.sm }}>
                <Text color="textMuted" variant="micro">
                  {strings.onboarding.signIn.passwordUser}
                </Text>
                <TextField
                  /*
                   * The visible label SHOUTS, as every section header in the app
                   * does, and a screen reader reading a control called
                   * `USER NAME` either spells it or shouts it back. The quiet
                   * spelling is the accessible name; the loud one stays on
                   * screen.
                   */
                  accessibilityLabel={strings.onboarding.signIn.passwordUserLabel}
                  /*
                   * What lets a password manager fill this, and offer to save it
                   * afterwards. Without the pair a browser falls back to
                   * guessing from the field order, and a manager that guesses
                   * wrong on a sign-in form guesses wrong every time.
                   */
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setUsername}
                  onSubmitEditing={submitFromKeyboard}
                  testID="cookie-username"
                  value={username}
                />
                <Text color="textMuted" variant="micro">
                  {strings.onboarding.signIn.passwordSecret}
                </Text>
                <SecretField
                  accessibilityLabel={strings.onboarding.signIn.passwordSecretLabel}
                  autoComplete="current-password"
                  autoCapitalize="none"
                  autoCorrect={false}
                  concealLabel={strings.onboarding.signIn.hidePassword}
                  onChangeText={setPassword}
                  /*
                   * A sign-in form on a desktop is filled with the keyboard and
                   * submitted with Return, and until this it was filled with the
                   * keyboard and submitted with the mouse: the key did nothing
                   * at all.
                   */
                  onSubmitEditing={submitFromKeyboard}
                  returnKeyType="done"
                  revealLabel={strings.onboarding.signIn.showPassword}
                  testID="cookie-password"
                  value={password}
                />
                <Button
                  busy={submitting}
                  disabled={!canSubmit}
                  onPress={() => void submitPassword(selected)}
                  testID="cookie-password-submit"
                  title={strings.onboarding.signIn.passwordSubmit}
                />
              </View>
            ) : (
              <Button
                disabled={!selected}
                onPress={() => {
                  setPhase('leaving')
                  startCookieSignIn(baseUrl, selected?.name)
                }}
                testID="cookie-sign-in"
                title={strings.onboarding.signIn.signInWith(selected?.displayName ?? '')}
              />
            )}
          </View>
        )
      ) : null}
    </View>
  )
}
