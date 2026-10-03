export interface BundleLimits {
  maxFileBytes: number
  maxTotalBytes: number
  maxFiles: number
  maxInitialJsBytes: number
  maxInitialJsGzipBytes: number
}

export interface BundleStats {
  files: number
  totalBytes: number
  largestFile: { name: string; bytes: number } | null
  initialJsBytes: number
  initialJsGzipBytes: number
  initialFiles: string[]
}

export const ALLOWED_EXTENSIONS: readonly string[]
export const SOURCE_MAP_EXTENSION: string
export const TEXT_EXTENSIONS: readonly string[]
export const LIMITS: Readonly<BundleLimits>
export const MANIFEST_NAME: string
export const DEVELOPMENT_ONLY_MARKER: string

export function checkBundle(
  dir: string,
  options?: { limits?: Partial<BundleLimits>; commit?: string }
): { problems: string[]; stats: BundleStats }
