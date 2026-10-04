/**
 * A part of a module that is loaded on demand: a chunk of its own, which hands its functions over when it is evaluated
 * (`provide`), however it came to be loaded (a dynamic import from here, or a static one from a chunk that is already
 * on its way).
 *
 * `use` runs a call against the part. When the part is there it runs at once, in the same tick: a method that hands
 * its body to the part behaves exactly as it did when the body was its own (everything up to the first `await`
 * happens before the method returns). When it is not, the part is loaded first; a load that fails rejects that call,
 * and the next one tries again.
 */
export interface OnDemandPart<T> {
  use<R>(run: (part: T) => Promise<R>): Promise<R>
  /** What the part's module calls when it is evaluated. */
  provide(part: T): void
}

/**
 * @param load imports the part's module, whose evaluation calls `provide` (what it resolves to is not read).
 */
export function onDemandPart<T>(load: () => Promise<unknown>): OnDemandPart<T> {
  let part: T | undefined
  let loading: Promise<T> | undefined

  const loaded = (): Promise<T> =>
    (loading ??= load()
      .then(() => {
        if (part === undefined) {
          throw new Error('The module loaded on demand did not provide its part.')
        }

        return part
      })
      .catch((error: unknown) => {
        loading = undefined

        throw error
      }))

  return {
    use: run => (part !== undefined ? run(part) : loaded().then(run)),
    provide: next => {
      part = next
    }
  }
}
