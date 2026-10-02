/**
 * Picking a language, and the screen changing while you are looking at it.
 *
 * The thing under test is not the picker — it is a store write — but the two
 * halves that make a switch VISIBLE without a restart:
 *
 *  1. `strings.x.y` resolves on access, so a component that renders again
 *     paints the new language with no other change;
 *  2. something has to make it render again. `App` subscribes at the root
 *     (`useFollowsLocale`), which re-renders the tree under it in one pass
 *     rather than remounting it — a remount would throw away the scroll
 *     position and the open sheet of whoever just used the picker.
 *
 * Both halves are asserted, and separately: the first would pass on its own
 * while a reader sat in front of an English screen with a Dutch setting.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { memo, useRef } from 'react'
import { View } from 'react-native'

import { resetActiveLocale, setActiveLocale } from '../src/i18n/active-locale'
import { strings } from '../src/i18n/strings'
import { useFollowsLocale } from '../src/i18n/use-locale'
import { AppearanceSection } from '../src/features/settings/AppearanceSection'
import { resetLanguageStore, useLanguageStore } from '../src/store/language'
import { Text } from '../src/ui/primitives'
import { renderScreen, withProviders } from './support/render'

afterEach(() => {
  act(() => {
    resetLanguageStore()
  })
  resetActiveLocale()
})

describe('the picker in Settings → Appearance', () => {
  it('offers "follow the device" and each language in its own words', () => {
    renderScreen(<AppearanceSection onOpenAdvanced={() => undefined} />)

    expect(screen.getByTestId('settings-language-system')).toBeTruthy()
    expect(screen.getByText('Nederlands')).toBeTruthy()
    expect(screen.getByText('Deutsch')).toBeTruthy()
    expect(screen.getByText('English')).toBeTruthy()
  })

  it('pins the language, and says so in that language', () => {
    renderScreen(<AppearanceSection onOpenAdvanced={() => undefined} />)

    act(() => {
      fireEvent.press(screen.getByTestId('settings-language-nl'))
    })

    expect(useLanguageStore.getState().choice).toBe('nl')
    expect(useLanguageStore.getState().locale).toBe('nl')
    // The group re-rendered because it reads the store, and its own header came
    // back in Dutch. The rest of the screen needs the root subscription below.
    // `InsetGroup` uppercases every header at render (HERM-106), so the
    // rendered text is 'TAAL' even though the string itself is `Taal`.
    expect(screen.getByText('TAAL')).toBeTruthy()
  })

  it('starts on "follow the device"', () => {
    renderScreen(<AppearanceSection onOpenAdvanced={() => undefined} />)

    expect(useLanguageStore.getState().choice).toBe('system')
  })
})

/** A component that reads a string and counts how many times it was mounted. */
function Probe({ mounts }: { mounts: { current: number } }) {
  const first = useRef(true)

  if (first.current) {
    first.current = false
    mounts.current += 1
  }

  return <Text testID="probe">{strings.settings.language}</Text>
}

/** The root's job, in miniature: subscribe, and render the tree under it. */
function Root({ mounts }: { mounts: { current: number } }) {
  useFollowsLocale()

  return (
    <View>
      <Probe mounts={mounts} />
    </View>
  )
}

describe('a switch at the root', () => {
  it('repaints a screen that never touched the language store', () => {
    const mounts = { current: 0 }

    render(withProviders(<Root mounts={mounts} />))

    expect(screen.getByTestId('probe').props.children).toBe('Language')

    act(() => {
      setActiveLocale('nl')
    })

    expect(screen.getByTestId('probe').props.children).toBe('Taal')
  })

  it('re-renders rather than remounting', () => {
    const mounts = { current: 0 }

    render(withProviders(<Root mounts={mounts} />))

    expect(mounts.current).toBe(1)

    act(() => {
      setActiveLocale('de')
    })

    expect(screen.getByTestId('probe').props.children).toBe('Sprache')
    // Still one. A `key={locale}` on the tree would pass the assertion above
    // and fail this one, and would have cost the reader whatever they had open.
    expect(mounts.current).toBe(1)
  })

  it('leaves an untranslated string in English', () => {
    render(withProviders(<Root mounts={{ current: 0 }} />))

    act(() => {
      setActiveLocale('nl')
    })

    // Not a gap in the screen, and not a key: the sentence the app is written
    // in. `tabs.chats` is one the Dutch catalogue deliberately does not answer.
    // See `i18n/coverage.ts` for how a key that SHOULD be translated and is not
    // becomes a to-do instead.
    expect(strings.tabs.chats).toBe('Chats')
  })
})

/**
 * The exception to the root subscription, and the rule it forces.
 *
 * A `React.memo` whose props did not change is not walked, and a language
 * switch changes nobody's props. Two components in this app paint words behind
 * such a boundary — the transcript rows and the chat-list rows — and both would
 * have kept the old language on screen for as long as nothing else moved them,
 * which in an open conversation is a long time.
 *
 * Both call `useFollowsLocale()` themselves now. These two assertions are the
 * rule written down: one shows the failure a memo boundary causes, the other
 * shows the fix, and together they say what anything memoised that reads
 * `strings` has to do.
 */
const Sealed = memo(function Sealed() {
  return <Text testID="sealed">{strings.settings.language}</Text>
})

const SealedAndSubscribed = memo(function SealedAndSubscribed() {
  useFollowsLocale()

  return <Text testID="subscribed">{strings.settings.language}</Text>
})

function MemoRoot() {
  useFollowsLocale()

  return (
    <View>
      <Sealed />
      <SealedAndSubscribed />
    </View>
  )
}

describe('a memo boundary', () => {
  it('does not follow the root, which is why the rows subscribe themselves', () => {
    render(withProviders(<MemoRoot />))

    act(() => {
      setActiveLocale('nl')
    })

    // The root re-rendered — the subscribed twin proves the switch happened —
    // and this one did not, because its props are unchanged and React skipped
    // it. That is the bug an open transcript would have had.
    expect(screen.getByTestId('sealed').props.children).toBe('Language')
    expect(screen.getByTestId('subscribed').props.children).toBe('Taal')
  })
})
