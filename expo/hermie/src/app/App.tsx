import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { ActivityIndicator, View } from 'react-native'

import { DEV_LAUNCH_INTENT, DevGallery } from '../dev'
import { ChatRuntimeProvider } from '../features/chats'
import { AppLock } from '../features/lock'
import { OnboardingNavigator } from '../features/onboarding'
import { GatewayProvider, useGateway } from '../gateway'
import { strings } from '../i18n/strings'
import { useFollowsLocale } from '../i18n/use-locale'
import { useLanguageStore } from '../store/language'
import { SafeArea } from '../platform/safe-area'
import { Screen, Text } from '../ui/primitives'
import { ThemeProvider, useTheme } from '../ui/theme'
import { Shell } from './Shell'

export default function App() {
  /*
    The whole tree follows the language from here.

    Not a context, and not a `key` that remounts: `strings.x.y` resolves on
    access (`i18n/catalogue.ts`), so the only thing a switch needs is a render.
    Subscribing at the root gives every screen under it one — a provider would
    only wake its own consumers, and a remount would throw away the scroll
    position and the open sheet of whoever just used the picker.
  */
  useFollowsLocale()

  const languageLoaded = useLanguageStore(state => state.loaded)

  useEffect(() => {
    // Behind the splash, like the appearance read in `ThemeProvider`: the
    // stored choice is on disk and the first frame cannot wait for it. Until it
    // lands the app is in English, which is the language it is written in.
    if (!languageLoaded) {
      void useLanguageStore.getState().hydrate()
    }
  }, [languageLoaded])

  // One client for the app's lifetime; refetching is driven by gateway events
  // rather than by focus or intervals.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 }
        }
      }),
    []
  )

  return (
    <SafeArea>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider
          {...(DEV_LAUNCH_INTENT?.scheme ? { forceScheme: DEV_LAUNCH_INTENT.scheme } : {})}
          {...(DEV_LAUNCH_INTENT?.preset ? { forcePreset: DEV_LAUNCH_INTENT.preset } : {})}
        >
          {/*
            The lock sits OUTSIDE the gateway provider, not inside it.

            Inside, a locked app would still hold a socket, still take pushes
            into a live store and still have a mounted transcript one z-index
            under the plate. Outside, there is nothing to leak: `AppLock` does
            not render its children while it is up, so the connection is not
            merely hidden, it does not exist. The price is a re-dial on unlock,
            which is paid by the reconnect ladder that already exists.

            Inside `ThemeProvider` because the plate is themed, and the theme
            is not a secret.
          */}
          <AppLock>
            <GatewayProvider>
              <Root />
            </GatewayProvider>
          </AppLock>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeArea>
  )
}

/**
 * Three states, decided by whether a gateway is configured and whether its
 * credentials are still there: the startup read, the wizard, and the app.
 */
function Root() {
  const { gatewayId, phase, resumeAccess, resumeConfig, resumeIntent, reload } = useGateway()
  const devOpen = DEV_LAUNCH_INTENT?.open

  // Before the phase check on purpose: the component kit takes no gateway, so a
  // screenshot of a sheet should not need a configured connection first.
  if (devOpen?.kind === 'gallery') {
    return <DevGallery section={devOpen.section} />
  }

  if (phase === 'loading') {
    return <Booting />
  }

  if (phase === 'onboarding') {
    return (
      <OnboardingNavigator
        // The entry being edited, or null on a first run. A wizard opened over
        // a configured gateway is changing THAT gateway's address rather than
        // describing a second machine; "Add gateway" in Settings is the other
        // one, and it passes null.
        gatewayId={gatewayId}
        onComplete={reload}
        resumeAccess={resumeAccess}
        resumeConfig={resumeConfig}
        // Coming from "Change gateway" the stored gateway is untouched, so the
        // wizard opens on the address step and closing it puts the app back
        // exactly as it was.
        {...(resumeIntent === 'address' ? { initialStep: 'address' as const, onCancel: reload } : {})}
      />
    )
  }

  // The chat runtime sits inside the `connected` branch on purpose: it owns the
  // subscriptions to the live connection, and there is no connection to
  // subscribe to until the gateway is configured.
  return (
    <ChatRuntimeProvider>
      <Shell />
    </ChatRuntimeProvider>
  )
}

function Booting() {
  const theme = useTheme()

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.space.md }}>
        <ActivityIndicator />
        <Text color="textMuted">{strings.app.loading}</Text>
      </View>
    </Screen>
  )
}
