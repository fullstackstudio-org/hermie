/**
 * The licences screen, and the one property that is easy to lose by accident:
 * the bundled data must not be in the start-up path.
 *
 * `src/generated/third-party-licences.json` is half a megabyte. If anything the
 * app renders at launch imports it — directly, or through a barrel — every user
 * pays for it on every cold start to serve a screen most of them never open. The
 * first test here is the guard: the mock counts how often the JSON module is
 * required, and it has to still be zero after the screen module is imported.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native'

import { LicencesScreen } from '../src/features/settings/LicencesScreen'
import { renderScreen } from './support/render'

const MIT = 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software.'

let mockJsonRequires = 0

jest.mock('../src/generated/third-party-licences.json', () => {
  mockJsonRequires += 1

  return {
    generatedBy: 'scripts/generate-third-party-licenses.mjs',
    scope: 'production dependencies of expo/hermie',
    excludesWorkspacePackages: ['@hermie/gateway-client', '@hermie/transcript'],
    packages: [
      { name: 'react', version: '19.1.0', licence: 'MIT', repository: 'https://github.com/facebook/react', text: 'a1' },
      { name: 'zustand', version: '5.0.3', licence: 'MIT', text: 'a1' },
      { name: 'text-free', version: '1.0.0', licence: 'ISC' }
    ],
    texts: { a1: MIT }
  }
})

describe('LicencesScreen', () => {
  it('does not require the bundled data until it is rendered', () => {
    // The import at the top of this file is enough to prove it: the screen and
    // its loader are in the module graph and the JSON is not.
    expect(LicencesScreen).toBeDefined()
    expect(mockJsonRequires).toBe(0)
  })

  it('shows a loading state, then the packages the data lists', async () => {
    renderScreen(<LicencesScreen />)

    expect(screen.getByTestId('licences-loading')).toBeTruthy()
    expect(screen.queryByTestId('licences-list')).toBeNull()

    await waitFor(() => expect(screen.getByTestId('licences-list')).toBeTruthy())

    expect(mockJsonRequires).toBe(1)
    expect(screen.getByText('react')).toBeTruthy()
    expect(screen.getByText('19.1.0 · MIT')).toBeTruthy()
    expect(screen.getByText('1.0.0 · ISC')).toBeTruthy()
    expect(screen.queryByTestId('licences-loading')).toBeNull()
  })

  it('reveals a package’s licence text on demand, and only that one', async () => {
    renderScreen(<LicencesScreen />)

    await waitFor(() => expect(screen.getByTestId('licences-list')).toBeTruthy())

    // Nothing is expanded to begin with: 600 texts at once is most of a megabyte.
    expect(screen.queryByText(MIT)).toBeNull()

    fireEvent.press(screen.getByTestId('licence-row-react@19.1.0'))

    expect(screen.getByTestId('licence-text-react@19.1.0')).toBeTruthy()
    expect(screen.getByText(MIT)).toBeTruthy()
    expect(screen.getByText('https://github.com/facebook/react')).toBeTruthy()
    expect(screen.queryByTestId('licence-text-zustand@5.0.3')).toBeNull()

    // A second tap closes it again.
    fireEvent.press(screen.getByTestId('licence-row-react@19.1.0'))
    expect(screen.queryByTestId('licence-text-react@19.1.0')).toBeNull()
  })

  it('says so when a package ships no licence file at all', async () => {
    renderScreen(<LicencesScreen />)

    await waitFor(() => expect(screen.getByTestId('licences-list')).toBeTruthy())

    fireEvent.press(screen.getByTestId('licence-row-text-free@1.0.0'))

    expect(screen.getByText(/ships no licence file/)).toBeTruthy()
  })

  it('offers one way back, the chrome’s, when it was opened from Settings', async () => {
    const onPress = jest.fn()

    renderScreen(<LicencesScreen back={{ label: 'About', onPress }} />)

    await waitFor(() => expect(screen.getByTestId('licences-list')).toBeTruthy())

    expect(screen.getAllByTestId('page-back')).toHaveLength(1)
    fireEvent.press(screen.getByTestId('page-back'))

    expect(onPress).toHaveBeenCalledTimes(1)
  })
})
