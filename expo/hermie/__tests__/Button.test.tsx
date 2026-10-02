import { render, screen } from '@testing-library/react-native'

import { Button } from '../src/ui/primitives'
import { ThemeProvider } from '../src/ui/theme'

describe('Button', () => {
  it('renders its title and reports the disabled state', () => {
    render(
      <ThemeProvider>
        <Button title="Test connection" disabled />
      </ThemeProvider>
    )

    const button = screen.getByRole('button')
    expect(screen.getByText('Test connection')).toBeTruthy()
    expect(button.props.accessibilityState).toMatchObject({ disabled: true })
  })
})
