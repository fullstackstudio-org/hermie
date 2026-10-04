/**
 * The server-request methods that become a `request` item.
 *
 * This list is the contract's (`contract/requests/schema.json`, `methods`), kept
 * here as a constant because the engine must not read files; `request-item.test.ts`
 * holds the two equal, so a method the gateway adds cannot be silently dropped
 * by an engine that has not heard of it.
 *
 * `approval` and `clarify` are not in it: they have items of their own.
 */
export const INTERACTIVE_METHODS = ['input.form', 'input.file', 'review.draft', 'review.diff'] as const

export type InteractiveMethod = (typeof INTERACTIVE_METHODS)[number]

export const isInteractiveMethod = (method: string): method is InteractiveMethod =>
  (INTERACTIVE_METHODS as readonly string[]).includes(method)
