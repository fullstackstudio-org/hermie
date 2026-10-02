import type { AuthProvider, TokenSet } from '@hermie/gateway-client'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'

import { useGateway } from '../../../gateway/GatewayProvider'
import { strings } from '../../../i18n/strings'
import { Button, CodeChipText, InsetGroup, InsetRow, SecretField, Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { authModeOf, effectiveHeaders, type OnboardingDraft } from '../draft'
import { NativeSignInWebView } from '../NativeSignInWebView'
import { StatusLine } from '../StatusLine'

export interface SignInStepProps {
  draft: OnboardingDraft
  update: (patch: Partial<OnboardingDraft>) => void
}

export function SignInStep({ draft, update }: SignInStepProps) {
  const theme = useTheme()
  const [signingIn, setSigningIn] = useState(false)
  // The system-browser path used to exist only INSIDE the web view, behind a
  // caption under a page that may never load. It is an escape hatch, so it is
  // offered before the thing it is an escape from.
  const [viaBrowser, setViaBrowser] = useState(false)
  const probe = draft.probe
  const authMode = authModeOf(probe)
  const providers = probe?.providers ?? []

  // With exactly one provider there is nothing to choose, so the step should
  // read as a single "Sign in with …" button rather than as a list of one.
  // The app's own auth ring, so a sign-in that cannot be refreshed leaves a
  // record that outlives the wizard.
  const { recordAuth } = useGateway()
  const ring = useMemo(() => ({ record: recordAuth }), [recordAuth])
  const onlyProvider = providers.length === 1 ? providers[0] : undefined
  const selected = draft.provider ?? onlyProvider ?? null

  useEffect(() => {
    if (!draft.provider && onlyProvider) {
      update({ provider: onlyProvider })
    }
  }, [draft.provider, onlyProvider, update])

  const onSuccess = (tokens: TokenSet) => {
    setSigningIn(false)
    update({ tokens, ...(selected ? { provider: selected } : {}) })
  }

  const startSignIn = (inBrowser: boolean) => {
    setViaBrowser(inBrowser)
    setSigningIn(true)
  }

  return (
    <View style={{ gap: theme.space.lg }}>
      {authMode === 'session_token' ? (
        <View style={{ gap: theme.space.sm }}>
          <Text color="textMuted" variant="micro">
            {strings.onboarding.signIn.tokenLabel}
          </Text>
          {/* Outside an inset row, so the field draws its own sunk well. */}
          <SecretField
            accessibilityLabel={strings.onboarding.signIn.tokenLabel}
            autoCapitalize="none"
            autoCorrect={false}
            concealLabel={strings.onboarding.signIn.hideToken}
            onChangeText={sessionToken => update({ sessionToken })}
            placeholder={strings.onboarding.signIn.tokenPlaceholder}
            returnKeyType="done"
            revealLabel={strings.onboarding.signIn.showToken}
            testID="session-token"
            value={draft.sessionToken}
          />
          <CodeChipText color="textFaint" style={{ marginHorizontal: theme.space.xs }} variant="meta">
            {strings.onboarding.signIn.tokenHelp}
          </CodeChipText>
        </View>
      ) : !probe?.supportsNativePkce ? (
        <View style={{ gap: theme.space.xs }}>
          <StatusLine testID="signin-blocked" tone="error">
            {strings.onboarding.signIn.blockedTitle}
          </StatusLine>
          <Text color="textMuted" variant="preview">
            {strings.onboarding.signIn.blockedBody}
          </Text>
        </View>
      ) : providers.length === 0 ? (
        <StatusLine testID="signin-blocked" tone="error">
          {strings.errors.providersUnavailable}
        </StatusLine>
      ) : (
        <View style={{ gap: theme.space.md }}>
          {providers.length > 1 ? (
            <InsetGroup header={strings.onboarding.signIn.chooseProvider}>
              {providers.map(provider => (
                <ProviderRow
                  key={provider.name}
                  onPress={() => update({ provider, tokens: null })}
                  provider={provider}
                  selected={selected?.name === provider.name}
                />
              ))}
            </InsetGroup>
          ) : null}

          {draft.tokens ? (
            <View style={{ gap: theme.space.md }}>
              <StatusLine testID="signin-result" tone="ok">
                {draft.tokens.userId
                  ? strings.onboarding.signIn.signedInAs(draft.tokens.userId)
                  : strings.onboarding.signIn.signedIn}
              </StatusLine>
              <Button
                onPress={() => startSignIn(false)}
                title={strings.onboarding.signIn.signOutAndRetry}
                variant="secondary"
              />
            </View>
          ) : (
            <View style={{ gap: theme.space.sm }}>
              {/*
                One button per provider, styled as the primary action. The
                card's own Continue stays disabled until this has produced a
                token, so only one accented control is ever live at a time.
              */}
              <Button
                disabled={!selected}
                onPress={() => startSignIn(false)}
                title={strings.onboarding.signIn.signInWith(selected?.displayName ?? '')}
              />
              <Pressable
                accessibilityRole="button"
                disabled={!selected}
                hitSlop={8}
                onPress={() => startSignIn(true)}
                style={({ pressed }) => ({
                  alignSelf: 'center',
                  opacity: selected ? (pressed ? 0.6 : 1) : 0.4,
                  padding: theme.space.xs
                })}
                testID="sign-in-via-browser"
              >
                <Text color="accentText" variant="meta">
                  {strings.common.openInBrowser}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {draft.baseUrl && selected ? (
        <NativeSignInWebView
          baseUrl={draft.baseUrl}
          extraHeaders={effectiveHeaders(draft)}
          frontDoor={draft.frontDoor}
          onCancel={() => setSigningIn(false)}
          onSuccess={onSuccess}
          provider={selected.name}
          startInBrowser={viaBrowser}
          timeline={ring}
          visible={signingIn}
        />
      ) : null}
    </View>
  )
}

function ProviderRow({
  provider,
  selected,
  onPress
}: {
  provider: AuthProvider
  selected: boolean
  onPress: () => void
}) {
  const theme = useTheme()

  return (
    <Pressable accessibilityRole="radio" aria-checked={selected} onPress={onPress}>
      <InsetRow style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text variant="body">{provider.displayName}</Text>
        {selected ? (
          <Text color="accentText" style={{ marginLeft: theme.space.md }} variant="body">
            ✓
          </Text>
        ) : null}
      </InsetRow>
    </Pressable>
  )
}
