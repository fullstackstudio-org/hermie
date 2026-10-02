/**
 * A label with a command in it.
 *
 * Both of the app's were written the way everybody writes a command — in
 * backticks — and both were drawn as plain text, so both shipped with the
 * punctuation on screen while the transcript two taps away drew a chip.
 */
import { render, screen } from '@testing-library/react-native'

import { CodeChipText, splitOnCode } from '../src/ui/primitives'
import { ThemeProvider } from '../src/ui/theme'

describe('splitting a label on its backticks', () => {
  it('separates the command from the sentence around it', () => {
    expect(splitOnCode('the machine running `hermes serve` — and its bots')).toEqual([
      { text: 'the machine running ', code: false },
      { text: 'hermes serve', code: true },
      { text: ' — and its bots', code: false }
    ])
  })

  it('handles a label that is nothing but a command, and one with none', () => {
    expect(splitOnCode('`hermes serve`')).toEqual([{ text: 'hermes serve', code: true }])
    expect(splitOnCode('no markup here')).toEqual([{ text: 'no markup here', code: false }])
    expect(splitOnCode('')).toEqual([])
  })

  it('leaves an unclosed backtick as the character somebody typed', () => {
    // A label that opens a chip and never closes it is a typo, and swallowing
    // the rest of the sentence into a grey box reports it worse than showing it.
    expect(splitOnCode('run `hermes serve to start')).toEqual([{ text: 'run `hermes serve to start', code: false }])
  })
})

describe('drawing it', () => {
  it('puts the command in a chip and no backtick on screen', () => {
    render(
      <ThemeProvider>
        <CodeChipText testID="lead">Start it with `hermes serve` first.</CodeChipText>
      </ThemeProvider>
    )

    expect(screen.queryByText(/`/)).toBeNull()
    // Non-breaking padding, because React Native will not pad a nested `Text`
    // and an ordinary space at a chip's edge paints a bar to the end of the
    // line. `markdown/Inline.tsx` carries the long version.
    expect(screen.getByText(' hermes serve ')).toBeTruthy()
  })
})
