/**
 * The App Intents: where their Swift ends up, and the strings that have to
 * agree across two languages.
 *
 * Every assertion here is about something that fails SILENTLY. That is the
 * character of this whole feature: an App Intent that is not registered does
 * not error, it simply never appears in Shortcuts, and a Siri phrase that is
 * missing one token is never matched and says nothing about it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { INTENT_BUDGET_MS, INTENT_QUEUE_VERSION } from '../src/features/intents/queue'

const plugin = require('../modules/hermie-intents/plugin/with-hermie-intents')
const { assertCompiled, assertPaths, GROUP, intentSources } = plugin

const MODULE_DIR = join(__dirname, '..', 'modules', 'hermie-intents')
const read = (...parts: string[]): string => readFileSync(join(MODULE_DIR, ...parts), 'utf8')

describe('where the Swift goes', () => {
  /**
   * The intents are compiled into the APP, not into the pod. Both halves of
   * that have to hold: the plugin has to add them, and the podspec has to NOT
   * sweep them up as well — the same file in two compilation units is a
   * duplicate-symbol link error.
   */
  it('keeps the pod out of the intents directory', () => {
    const podspec = read('ios', 'HermieIntents.podspec')

    expect(podspec).toContain("s.source_files = '*.{h,m,mm,swift}'")
    expect(podspec).not.toContain("'**/*")
  })

  it('names every Swift file in the intents directory', () => {
    expect(intentSources(join(MODULE_DIR, 'intents'))).toEqual([
      'HermieAppIntents.swift',
      'HermieAppShortcuts.swift',
      'HermieIntentQueue.swift',
      'HermieIntentRoster.swift'
    ])
  })

  /**
   * The symptom of shipping with the sources in a directory nothing compiles
   * is silence: the app builds, it launches, and there are simply no Shortcuts.
   * The plugin fails the prebuild instead.
   */
  it('refuses a project where the app target does not compile them', () => {
    const project = (files: string[]) => ({
      getFirstTarget: () => ({ uuid: 'APP' }),
      pbxSourcesBuildPhaseObj: () => ({ files: files.map(comment => ({ comment })) })
    })

    expect(() => assertCompiled(project(['AppDelegate.swift']), ['HermieAppShortcuts.swift'])).toThrow(
      /does not compile/
    )
    expect(() =>
      assertCompiled(project(['HermieAppShortcuts.swift in Sources']), ['HermieAppShortcuts.swift'])
    ).not.toThrow()
  })

  /**
   * This one is here because it actually happened, and because the assertion
   * above did not catch it.
   *
   * The first version passed `HermieIntents/<name>` to `addSourceFile` while
   * the GROUP already carried `HermieIntents` as its path. Xcode resolves a
   * child relative to its group, so every source was looked for at
   * `ios/HermieIntents/HermieIntents/…` and the app target failed with four
   * "Build input files cannot be found". The files WERE in the sources phase,
   * which is all `assertCompiled` asks, so only a real `xcodebuild` found it.
   */
  it('refuses a file reference that repeats the group’s own path', () => {
    const project = (paths: string[]) => ({
      pbxFileReferenceSection: () =>
        Object.fromEntries(paths.map((value, index) => [`R${index}`, { path: `"${value}"` }]))
    })

    expect(() => assertPaths(project(['HermieIntents/HermieAppIntents.swift']), ['HermieAppIntents.swift'])).toThrow(
      /group that already has one/
    )
    expect(() => assertPaths(project(['HermieAppIntents.swift']), ['HermieAppIntents.swift'])).not.toThrow()
    // Somebody else's file at a nested path is not this plugin's business.
    expect(() => assertPaths(project(['Hermie/AppDelegate.swift']), ['HermieAppIntents.swift'])).not.toThrow()
  })

  it('adds no target of its own', () => {
    // The other two modules each add one. This is the difference that the whole
    // plugin exists to explain, so a change that quietly added a target here
    // should be deliberate.
    expect(read('plugin', 'with-hermie-intents.js')).not.toContain('addTarget(')
    expect(GROUP).toBe('HermieIntents')
  })
})

describe('the strings the two languages share', () => {
  it('names the same App Group and queue directory', () => {
    for (const source of [read('ios', 'HermieIntentsModule.swift'), read('intents', 'HermieIntentQueue.swift')]) {
      expect(source).toContain('"group.dev.hermie.app"')
      expect(source).toContain('"intents"')
    }
  })

  /**
   * A requester that gives up before the answerer leaves a result nobody will
   * ever read; the reverse leaves Shortcuts spinning over an app that has
   * already finished. One number, two languages, no compiler between them.
   */
  it('agrees about the budget', () => {
    expect(read('intents', 'HermieIntentQueue.swift')).toContain(
      `static let budget: TimeInterval = ${INTENT_BUDGET_MS / 1000}`
    )
  })

  it('agrees about the format version', () => {
    expect(read('intents', 'HermieIntentQueue.swift')).toContain(`static let version = ${INTENT_QUEUE_VERSION}`)
  })

  /** `createdAt` is MILLISECONDS here and seconds in the share manifest. */
  it('writes the timestamp in the unit the parser compares against the budget', () => {
    expect(read('intents', 'HermieIntentQueue.swift')).toContain('Date().timeIntervalSince1970 * 1000')
  })

  it('writes only the two kinds the runner knows', () => {
    const queue = read('intents', 'HermieIntentQueue.swift')

    expect(queue).toContain('case ask')
    expect(queue).toContain('case send')
  })
})

describe('the Siri phrases', () => {
  const shortcuts = read('intents', 'HermieAppShortcuts.swift')
  const phrases = [...shortcuts.matchAll(/"([^"]*\\\(\.applicationName\)[^"]*)"/g)].map(match => match[1])

  /**
   * Siri matches a phrase only when it contains the app's name, and
   * `.applicationName` is the token that makes that follow a rename or a
   * localisation. A phrase without it is never matched and nothing reports it.
   */
  it('puts the application name in every phrase', () => {
    const allStrings = [...shortcuts.matchAll(/phrases: \[([\s\S]*?)\]/g)].flatMap(match =>
      [...match[1]!.matchAll(/"([^"]+)"/g)].map(inner => inner[1]!)
    )

    expect(allStrings.length).toBeGreaterThan(0)
    expect(allStrings.filter(phrase => !phrase.includes('\\(.applicationName)'))).toEqual([])
    expect(phrases.length).toBe(allStrings.length)
  })

  /** iOS takes at most ten App Shortcuts and shows far fewer. */
  it('stays well inside what iOS will show', () => {
    expect([...shortcuts.matchAll(/AppShortcut\(/g)]).toHaveLength(4)
  })
})

describe('the one action that never opens the app', () => {
  /**
   * "Bots needing input" reads the snapshot and returns, which is what makes it
   * usable from an automation while the phone is locked. Giving it
   * `openAppWhenRun` would be an easy edit and would silently take that away.
   */
  it('has no openAppWhenRun on the needs-input intent', () => {
    const intents = read('intents', 'HermieAppIntents.swift')
    const start = intents.indexOf('struct HermieNeedsInputIntent')
    // Up to the next declaration, so the comment on whatever follows is not
    // read as part of this one.
    const end = intents.indexOf('\n/**', start)

    expect(start).toBeGreaterThan(-1)
    expect(intents.slice(start, end)).not.toContain('openAppWhenRun')
  })

  it('has it on the three that do need the gateway', () => {
    const intents = read('intents', 'HermieAppIntents.swift')

    expect([...intents.matchAll(/static var openAppWhenRun = true/g)]).toHaveLength(3)
  })
})
