import { strings } from '../../../i18n/strings'
import { Text } from '../../../ui/primitives'

/**
 * The cover's body.
 *
 * The icon, the title and the lead belong to `OnboardingCard`, so what is left
 * here is the one promise worth making before anybody types an address:
 * nothing is written down until the connection has been proved.
 */
export function WelcomeStep() {
  return (
    <Text color="textFaint" variant="meta">
      {strings.onboarding.welcome.note}
    </Text>
  )
}
