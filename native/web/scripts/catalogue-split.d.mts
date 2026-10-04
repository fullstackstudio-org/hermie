export function pathsReadByFile(dir: string): Map<string, string[] | null>

/** Every module `entry` reaches by static imports, each with the module it was first reached from. */
export function entryGraph(entry: string): Map<string, string | undefined>

export interface ReadSplit {
  entry: string[] | null
  lazy: string[] | null
  byFile: Map<string, string[] | null>
  inEntry: Set<string>
}

export function splitReads(dir: string, entryFile: string): ReadSplit

export function groupOf(key: string): string

export function lazyOnlyKeys(
  catalogue: Readonly<Record<string, unknown>>,
  split: Pick<ReadSplit, 'entry' | 'lazy'>
): string[]
