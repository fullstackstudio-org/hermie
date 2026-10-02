/**
 * The document picker, with the native module stood in for.
 *
 * What is worth pinning is the projection, not the picker: `expo-document-picker`
 * answers with fields that are each optional in a different way — a null name, a
 * missing size, an absent mime type — and every one of them would otherwise reach
 * the upload as `undefined` and become part of a path or a header.
 *
 * `copyToCacheDirectory` is asserted because it is the one option whose absence
 * breaks nothing until it does: iOS hands back a URI inside the provider's own
 * sandbox, which stops resolving once the picker closes, and the upload starts
 * after that.
 */
import { pickFile } from '../src/features/chats/file-attachments'

// `mock`-prefixed so the factory below may close over it: Jest hoists the
// `jest.mock` call above the import, and the factory runs lazily on first
// require, by which time this assignment has happened.
const mockGetDocumentAsync = jest.fn()

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args)
}))

const asset = (overrides: Record<string, unknown> = {}) => ({
  uri: 'file:///var/mobile/Containers/Data/tmp/report.csv',
  name: 'report.csv',
  size: 2048,
  mimeType: 'text/csv',
  ...overrides
})

beforeEach(() => {
  mockGetDocumentAsync.mockReset()
})

it('asks for any type, one file, copied somewhere that outlives the picker', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset()] })

  await pickFile()

  expect(mockGetDocumentAsync).toHaveBeenCalledWith({ type: '*/*', multiple: false, copyToCacheDirectory: true })
})

it('projects the asset onto what the upload needs and nothing else', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset()] })

  expect(await pickFile()).toEqual({
    name: 'report.csv',
    size: 2048,
    mimeType: 'text/csv',
    uri: 'file:///var/mobile/Containers/Data/tmp/report.csv',
    // The part the upload appends as-is. On this platform it is React Native's
    // own `{uri, name, type}` blob, which the native layer streams from disk; in
    // a browser the seam hands over a `File` instead.
    body: {
      uri: 'file:///var/mobile/Containers/Data/tmp/report.csv',
      name: 'report.csv',
      type: 'text/csv'
    }
  })
})

it('answers null when the user backed out', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: true, assets: null })

  expect(await pickFile()).toBeNull()
})

it('answers null for a picker that reported success with nothing in it', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [] })

  expect(await pickFile()).toBeNull()
})

it('falls back to the URI tail when the platform gave no name', async () => {
  mockGetDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [asset({ name: null, uri: 'file:///tmp/Quarterly%20report.pdf' })]
  })

  // Percent-decoded, because the name becomes a filename rather than a URL.
  expect((await pickFile())?.name).toBe('Quarterly report.pdf')
})

it('has a name even for a URI with no usable tail', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset({ name: undefined, uri: 'file:///' })] })

  expect((await pickFile())?.name).toBe('attachment')
})

it('reports an unknown size as 0, so the cap check defers to the gateway', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset({ size: undefined })] })

  // Not a guess: 0 passes the pre-check and the gateway's own 413 decides.
  expect((await pickFile())?.size).toBe(0)
})

it('rejects a non-finite size rather than passing NaN to the cap check', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset({ size: Number.NaN })] })

  expect((await pickFile())?.size).toBe(0)
})

it('falls back to a generic content type, which is what the route defaults to', async () => {
  mockGetDocumentAsync.mockResolvedValue({ canceled: false, assets: [asset({ mimeType: undefined })] })

  expect((await pickFile())?.mimeType).toBe('application/octet-stream')
})

it('lets a picker failure through, because only the screen can word it', async () => {
  mockGetDocumentAsync.mockRejectedValue(new Error('The picker could not be presented'))

  await expect(pickFile()).rejects.toThrow('The picker could not be presented')
})
