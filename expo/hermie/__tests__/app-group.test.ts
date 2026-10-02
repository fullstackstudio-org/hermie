/**
 * One App Group, across three signed binaries and two plugins.
 *
 * `ios-widgets-plugin.test.ts` and `ios-share-plugin.test.ts` each hold their
 * own plugin to the group. Neither can see the thing that actually goes wrong:
 * the two plugins write onto the SAME `ios.entitlements`, one after the other,
 * and the app, the widget extension and the share extension are three separate
 * sandboxes that share a container only while all three name the same string.
 *
 * A mismatch reports itself nowhere. Nothing fails to build, nothing fails to
 * launch, nothing logs: the widget draws its empty state for ever and a shared
 * file is written into a container nothing will ever read. Both plugins say so
 * at the point of their own assertion, and this is where the three are compared
 * with each other.
 *
 * `docs/release.md` carries the other half — what the developer portal must
 * hold for the group to exist at all, and which of it `-allowProvisioningUpdates`
 * creates by itself.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const widgets = require('../modules/hermie-widgets/plugin/with-hermie-widgets') as {
  APP_GROUP: string
  applyAppGroup: (entitlements: Record<string, unknown>) => Record<string, unknown>
}

const share = require('../modules/hermie-share/plugin/with-hermie-share') as {
  APP_GROUP: string
  applyAppGroup: (entitlements: Record<string, unknown>) => Record<string, unknown>
}

const GROUPS_KEY = 'com.apple.security.application-groups'

const entitlementsFile = (...parts: string[]) => readFileSync(join(__dirname, '..', 'modules', ...parts), 'utf8')

const widgetEntitlements = entitlementsFile('hermie-widgets', 'widget', 'HermieWidgetsExtension.entitlements')
const shareEntitlements = entitlementsFile('hermie-share', 'share', 'HermieShareExtension.entitlements')

describe('the three binaries that have to agree', () => {
  it('name one group, spelled the same way by both plugins', () => {
    expect(share.APP_GROUP).toBe(widgets.APP_GROUP)
  })

  it('is the group both extensions declare in their own entitlements', () => {
    expect(widgetEntitlements).toContain(`<string>${widgets.APP_GROUP}</string>`)
    expect(shareEntitlements).toContain(`<string>${share.APP_GROUP}</string>`)
  })

  /**
   * The app's half is written by whichever plugin runs first; the second finds
   * it already there. Order is not fixed and must not matter.
   */
  it('lands on the app exactly once, whichever plugin ran first', () => {
    const widgetsFirst = share.applyAppGroup(widgets.applyAppGroup({}))
    const shareFirst = widgets.applyAppGroup(share.applyAppGroup({}))

    expect(widgetsFirst[GROUPS_KEY]).toEqual([widgets.APP_GROUP])
    expect(shareFirst[GROUPS_KEY]).toEqual([widgets.APP_GROUP])
  })

  /**
   * A prebuild without `--clean` runs every mod again over entitlements that
   * already carry the result of the last one.
   */
  it('does not accumulate on a second prebuild', () => {
    const once = share.applyAppGroup(widgets.applyAppGroup({}))
    const twice = share.applyAppGroup(widgets.applyAppGroup(once))

    expect(twice[GROUPS_KEY]).toEqual([widgets.APP_GROUP])
  })

  /** A fork with a group of its own keeps it and gains this one. */
  it('extends a fork’s own groups rather than replacing them', () => {
    const forked = { [GROUPS_KEY]: ['group.example.fork'] }

    expect(share.applyAppGroup(widgets.applyAppGroup(forked))[GROUPS_KEY]).toEqual([
      'group.example.fork',
      widgets.APP_GROUP
    ])
  })

  /**
   * `app.config.ts` deliberately does NOT list the group under
   * `ios.entitlements`: the plugins own it on all three targets, so the two
   * cannot disagree with a third declaration nobody would think to update.
   */
  it('is not also declared by hand in the app config', () => {
    const config = readFileSync(join(__dirname, '..', 'app.config.ts'), 'utf8')

    expect(config).not.toContain(GROUPS_KEY)
  })
})

/**
 * No signing identity anywhere in the repository.
 *
 * A team id is not a secret in the cryptographic sense and is very much one in
 * the sense that matters for a public repository: it is the account a fork
 * would be building against. Both plugins say so; this asserts it across every
 * file a prebuild reads rather than per plugin.
 */
describe('the team', () => {
  it('is named in no checked-in iOS configuration', () => {
    const files = [
      readFileSync(join(__dirname, '..', 'app.config.ts'), 'utf8'),
      readFileSync(join(__dirname, '..', 'eas.json'), 'utf8'),
      widgetEntitlements,
      shareEntitlements
    ]

    for (const contents of files) {
      expect(contents).not.toMatch(/"?(appleTeamId|DEVELOPMENT_TEAM)"?\s*[:=]/)
    }
  })
})
