/**
 * What the licences screen does when the bundled data does not arrive.
 *
 * A lazily loaded module is a request that can fail — a stale bundle after an
 * update, a platform where the asset did not ship — and the screen has to say so
 * rather than sit on an empty list forever. It lives in its own suite because the
 * loader is mocked wholesale here, which is the only honest way to make the
 * import reject.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { LicencesScreen } from '../src/features/settings/LicencesScreen'
import { renderScreen } from './support/render'

const mockLoad = jest.fn()

jest.mock('../src/features/settings/licences-data', () => ({
  loadLicenceData: (...args: unknown[]) => mockLoad(...args)
}))

beforeEach(() => {
  mockLoad.mockReset()
})

describe('LicencesScreen when the data cannot be loaded', () => {
  it('shows the failure in the reader’s words, not an empty list', async () => {
    mockLoad.mockRejectedValue(new Error('Requiring unknown module'))

    renderScreen(<LicencesScreen />)

    await waitFor(() => expect(screen.getByTestId('licences-error')).toBeTruthy())

    expect(screen.getByText(/could not be loaded: Requiring unknown module/)).toBeTruthy()
    expect(screen.queryByTestId('licences-list')).toBeNull()
  })

  it('retries on demand, and succeeds when the second attempt does', async () => {
    mockLoad.mockRejectedValueOnce(new Error('first attempt failed')).mockResolvedValueOnce({
      generatedBy: 'scripts/generate-third-party-licenses.mjs',
      scope: 'production dependencies of expo/hermie',
      excludesWorkspacePackages: [],
      packages: [{ name: 'marked', version: '18.0.13', licence: 'MIT' }],
      texts: {}
    })

    renderScreen(<LicencesScreen />)

    await waitFor(() => expect(screen.getByTestId('licences-error')).toBeTruthy())

    fireEvent.press(screen.getByText('Try again'))

    await waitFor(() => expect(screen.getByTestId('licences-list')).toBeTruthy())

    expect(mockLoad).toHaveBeenCalledTimes(2)
    expect(screen.getByText('marked')).toBeTruthy()
  })
})
