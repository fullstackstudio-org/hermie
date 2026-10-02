/**
 * Contrast on the COMPOSITED surface, as a check rather than as a paragraph.
 *
 * A glass surface is never the colour of a token: it is a translucent wash over a
 * rung of the elevation ladder, or over the theme's floor, and the ink sits on
 * whatever that composites to. So measuring a token against a token proves
 * nothing.
 *
 * The arithmetic lives in `expo/hermie/src/ui/contrast.ts` and NOT here. That is
 * the point of this round's split: the theme editor refuses a colour while
 * somebody is typing it, this fails a build, and if the two were separate code one
 * of them would be lying. This file is the table and the exit code; the rule is
 * shared.
 *
 *   npm run contrast            # the table
 *   npm run contrast:check      # fails under the thresholds
 *
 * **Every theme, both schemes.** The loop below is over `THEME_PRESETS`, so a
 * fourth preset is checked the moment it exists rather than the moment somebody
 * remembers to add it here. The per-chat accents are checked once, against white,
 * because an accent is not a function of the theme.
 */
import {
  measureFace,
  contrastRatio,
  parseColor,
  surfacesFor,
  AA_TEXT,
  type ContrastRow
} from '../expo/hermie/src/ui/contrast'
import { resolveThemeFace, THEME_PRESET_ORDER } from '../expo/hermie/src/ui/themes'
import { ACCENT_ORDER, ACCENTS, SENDER_INK_ORDER, lightColors, type Scheme } from '../expo/hermie/src/ui/tokens'

function themeRows(): ContrastRow[] {
  const rows: ContrastRow[] = []

  for (const name of THEME_PRESET_ORDER) {
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      rows.push(...measureFace(name, scheme, resolveThemeFace({ kind: 'preset', name }, scheme)))
    }
  }

  return rows
}

/**
 * White on every per-chat outgoing bubble.
 *
 * A chat's colour is the reader's, not the theme's, so every swatch has to clear
 * AA on its own or picking a colour becomes a choice between a look and a legible
 * message.
 */
function accentRows(): ContrastRow[] {
  return ACCENT_ORDER.map(name => ({
    theme: 'accents',
    scheme: 'light' as Scheme,
    surface: `accent ${name}`,
    role: 'onAccent',
    ratio: contrastRatio(lightColors.onAccent, parseColor(ACCENTS[name].bubble).rgb),
    floor: AA_TEXT
  }))
}

/**
 * The sender inks (HERM-83, D5) — `SENDER_INK_ORDER`, which is `ACCENT_ORDER`
 * minus `default`, `red` and `green` (see `tokens.ts`) — on the surfaces a
 * group-chat name actually sits on: the panel, the three opaque elevation
 * rungs a bubble's name label can be drawn over, and the sunk tint. Every
 * preset, both schemes, floor 4.5 — the same floor as any other text.
 *
 * Only the inks a sender can actually be given are measured here. `default`,
 * `red` and `green` are never handed to a person, so a row for them would not
 * be gating anything a sender's name can be drawn in — it would just be
 * `accentRows` a second time.
 */
const SENDER_SURFACES = ['panel', 'elevation e1', 'elevation e2', 'elevation e3', 'sunk tint']

function senderInkRows(): ContrastRow[] {
  const rows: ContrastRow[] = []

  for (const name of THEME_PRESET_ORDER) {
    for (const scheme of ['light', 'dark'] as Scheme[]) {
      const face = resolveThemeFace({ kind: 'preset', name }, scheme)
      const surfaces = surfacesFor(scheme, face.elevation, face.background).filter(surface =>
        SENDER_SURFACES.includes(surface.name)
      )

      for (const accent of SENDER_INK_ORDER) {
        const ink = ACCENTS[accent].text[scheme]

        for (const surface of surfaces) {
          rows.push({
            theme: name,
            scheme,
            surface: `sender ${accent} on ${surface.name}`,
            role: 'senderText',
            ratio: contrastRatio(ink, surface.background),
            floor: AA_TEXT
          })
        }
      }
    }
  }

  return rows
}

function main(): void {
  const check = process.argv.includes('--check')
  const rows = [...themeRows(), ...accentRows(), ...senderInkRows()]
  const failures = rows.filter(row => row.ratio < row.floor)

  if (!check) {
    for (const name of THEME_PRESET_ORDER) {
      for (const scheme of ['light', 'dark'] as Scheme[]) {
        process.stdout.write(`\n## ${name} / ${scheme}\n`)

        for (const row of rows.filter(entry => entry.theme === name && entry.scheme === scheme)) {
          const mark = row.ratio < row.floor ? `   <-- below ${row.floor}` : ''

          process.stdout.write(
            `${`${row.surface}/${row.role}`.padEnd(28)}${String(row.ratio).padStart(7)} : 1${mark}\n`
          )
        }
      }
    }

    process.stdout.write('\n## white on each per-chat bubble\n')

    for (const row of accentRows()) {
      const mark = row.ratio < row.floor ? `   <-- below ${row.floor}` : ''

      process.stdout.write(`${row.surface.padEnd(28)}${String(row.ratio).padStart(7)} : 1${mark}\n`)
    }
  }

  if (!failures.length) {
    process.stdout.write(
      `\n${rows.length} pairs checked across ${THEME_PRESET_ORDER.length} themes, all at or above their floor.\n`
    )

    return
  }

  process.stderr.write(`\n${failures.length} pair(s) below the floor:\n`)

  for (const row of failures) {
    process.stderr.write(
      `  ${row.theme} ${row.scheme} ${row.surface} / ${row.role}: ${row.ratio} : 1 (needs ${row.floor})\n`
    )
  }

  if (check) {
    process.exitCode = 1
  }
}

main()
