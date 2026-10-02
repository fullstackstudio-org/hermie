/**
 * Is `android/` still the project `app.config.ts` describes?
 *
 * `android/` is a prebuild output and gitignored, so the FIRST build of a
 * checkout generates it and everything agrees. What nothing noticed is the
 * second: prebuild writes `versionCode`, `versionName` and `applicationId` into
 * `app/build.gradle` once, and the version code is `git rev-list --count HEAD` —
 * a number that moves with every commit on the branch. A tree that prebuilt at
 * 133 and released at 192 uploads a bundle carrying 133, which Play refuses
 * because it has seen it, and the only trace is a line in a Gradle log nobody
 * reads. The same goes for `applicationId` the day it changed from
 * `nl.fullstackstudio.hermie` (docs/release.md records that rename) — a stale
 * `android/` would have kept building the old app.
 *
 * So the three values are compared before every build, and a mismatch regenerates
 * rather than warns: a warning in a release script is a warning somebody will
 * ignore at two in the morning.
 *
 * This file is the arithmetic and none of the doing, so it can be tested without
 * a prebuild, a Gradle or a git history — `__tests__/android-staleness.test.ts`.
 */

/**
 * The three values prebuild writes, and where they are in the file it writes.
 *
 * Read with patterns rather than by parsing Groovy, because the alternative is a
 * Gradle parser in a release script. The file is generated from one template and
 * `plugins/with-android-release-signing.js` is the only thing that edits it
 * afterwards; it touches the signing blocks and nothing in `defaultConfig`.
 */
const IDENTITY = {
  applicationId: /\bapplicationId\s+['"]([^'"]+)['"]/u,
  versionCode: /\bversionCode\s+(\d+)/u,
  versionName: /\bversionName\s+['"]([^'"]+)['"]/u
}

/** What `app/build.gradle` currently says, with `null` for anything not in it. */
function parseGradleIdentity(contents) {
  const identity = {}

  for (const [key, pattern] of Object.entries(IDENTITY)) {
    const match = pattern.exec(contents)

    identity[key] = match ? match[1] : null
  }

  return identity
}

/**
 * Every value that has moved, as a sentence each.
 *
 * A value the generated file does not carry at all counts as drift: it means the
 * file is not the one this check knows how to read, and regenerating it is both
 * the safe answer and the one that makes the next run readable.
 *
 * Comparison is on STRINGS. `versionCode 133` and `133` are the same fact written
 * two ways, and a number parsed out of a regex that failed is `NaN`, which
 * compares equal to nothing including itself — a silence this cannot afford.
 */
function describeDrift(generated, expected) {
  const drift = []

  for (const key of Object.keys(IDENTITY)) {
    const was = generated[key]
    const now = expected[key] === undefined || expected[key] === null ? null : String(expected[key])

    if (now === null) {
      continue
    }

    if (was === null) {
      drift.push(`${key} is not in android/app/build.gradle; app.config.ts says ${now}`)
      continue
    }

    if (was !== now) {
      drift.push(`${key} is ${was} in android/app/build.gradle; app.config.ts says ${now}`)
    }
  }

  return drift
}

module.exports = { describeDrift, IDENTITY, parseGradleIdentity }
