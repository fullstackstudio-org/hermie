export const MANIFEST_NAME: string

export interface BuildManifest {
  v: 1
  name: 'hermie-web-client'
  version: string
  sourceRepo: string
  sourceCommit: string
  files: Record<string, { sha256: string; bytes: number }>
  totalBytes: number
}

export function buildManifest(
  dir: string,
  options: {
    commit: string
    packageJson: { name?: string; version: string; repository?: { url?: string } | string }
  }
): BuildManifest

export function serialiseManifest(value: unknown): string
