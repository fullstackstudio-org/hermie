/**
 * A text matcher for a sentence whose words are split across elements, as a
 * sentence with a bot's name in it is (the name sits in its own `<bdi>`,
 * `features/requests/with-name.tsx`): it matches the innermost element whose
 * whole text is `text`. Testing Library's default reads an element's own text
 * nodes only, which is the sentence without the name.
 */
import type { MatcherFunction } from '@testing-library/react'

export const sentence =
  (text: string): MatcherFunction =>
  (_content, element) =>
    element?.textContent === text && ![...element.children].some(child => child.textContent === text)
