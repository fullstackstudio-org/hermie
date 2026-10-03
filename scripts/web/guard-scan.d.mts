export interface ScannerSource {
  name: string
  root: string
  repo?: string
  commit?: string
}

export interface ScannerPin {
  name: string
  repo: string
  ref: string
}

export interface ScanFinding {
  severity: string
  category: string
  pattern: string
  file: string
  line: number
}

export interface ScanResult {
  verdict: string
  allowed: boolean | null
  reason: string
  scanner_version: string
  findings: ScanFinding[]
  report: string
  exit: number | null
}

export const RESULT_PREFIX: string
export const PINS_DEFAULT: string
export const RUNNER: string
export const DIST_DEFAULT: string
export const PLUGIN_MANIFEST: string

export class GuardError extends Error {}

export function loadPins(path: string): ScannerPin[]
export function prepareDest(dest: string): void
export function fetchScanner(
  pin: ScannerPin,
  dest: string,
  options?: { attempts?: number; delayMs?: number }
): Promise<ScannerSource>
export function parseScannerRoots(values: string[]): ScannerSource[]
export function checkDist(dist: string): number
export function buildPluginTree(dist: string, parent: string): string
export function scanWith(source: ScannerSource, tree: string, python?: string): ScanResult
export function passes(result: Pick<ScanResult, 'verdict' | 'allowed' | 'exit'>): boolean
export function safeText(text: string): string
export function main(
  argv: string[],
  options?: {
    log?: (line: string) => void
    errorLog?: (line: string) => void
    env?: Record<string, string | undefined>
  }
): Promise<number>
