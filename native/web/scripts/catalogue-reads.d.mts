export function pathsReadIn(name: string, text: string): string[] | null

export function pathsReadUnder(dir: string): string[] | null

export function isRead(key: string, paths: readonly string[]): boolean

export function catalogueRead<T>(
  catalogue: Readonly<Record<string, T>>,
  paths: readonly string[] | null
): Record<string, T>
