export function withNodeOption(flag: string, options?: string): string

export function acceptsNodeOption(
  flag: string,
  options?: { execPath?: string; env?: Record<string, string | undefined> }
): boolean
