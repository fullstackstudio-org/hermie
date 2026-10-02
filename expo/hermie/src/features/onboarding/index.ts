// Gateway address, authentication and the mandatory connection test live here.
export {
  authModeOf,
  configFromDraft,
  connectionPayloadKey,
  type ConnectionTestOutcome,
  draftFromConfig,
  emptyDraft,
  hasCredential,
  effectiveHeaders,
  type HeaderRow,
  headerError,
  headerRecord,
  isTestCurrent,
  newHeaderRow,
  NUMBERED_STEPS,
  type OnboardingDraft,
  type OnboardingStep,
  type ResumeAccess
} from './draft'
export { inspectSignInNavigation, type SignInNavigation } from './loopback'
export { NativeSignInWebView, type NativeSignInWebViewProps, SIGN_IN_TIMEOUT_MS } from './NativeSignInWebView'
export { OnboardingCard, type OnboardingCardProps } from './OnboardingCard'
export { OnboardingNavigator, type OnboardingNavigatorProps } from './OnboardingNavigator'
export { StatusDot, StatusLine, type StatusLineProps, type StatusTone } from './StatusLine'
export { DoneStep } from './steps/DoneStep'
export { GatewayAddressStep } from './steps/GatewayAddressStep'
export { NotificationsStep, type NotificationsStepProps } from './steps/NotificationsStep'
export { SignInStep } from './steps/SignInStep'
export { TestConnectionStep } from './steps/TestConnectionStep'
export { WelcomeStep } from './steps/WelcomeStep'
export { CONNECTION_TEST_TIMEOUT_MS, type ConnectionTestStage, runConnectionTest } from './test-connection'
