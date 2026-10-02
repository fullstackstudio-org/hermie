// Injected by `vite.config.ts` (`define`) at build time; `vitest.config.ts`
// supplies fixed values for the tests.
declare const __HERMIE_VERSION__: string
declare const __HERMIE_COMMIT__: string

/** The client's own semver, from `package.json`. */
export const clientVersion: string = __HERMIE_VERSION__

/** The 40-character commit the bundle was built from. */
export const sourceCommit: string = __HERMIE_COMMIT__

/** The commit as shown to a person: its first seven characters. */
export const shortCommit: string = sourceCommit.slice(0, 7)

/** The build as shown in About and in a bug report: `0.2.0 (abc1234)`. */
export const buildLabel: string = `${clientVersion} (${shortCommit})`
