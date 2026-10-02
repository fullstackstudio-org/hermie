/**
 * A `pie` fence, drawn as a ring with a legend.
 *
 * Shapes only: every label arrived from the layout as a placed box and is drawn by
 * `DiagramCanvas`. What is decided here is the one thing a pie needs that no other
 * diagram in this folder does, which is a set of colours.
 *
 * ## Where the colours come from
 *
 * The app's own accent swatches, in a fixed order. Three reasons, in the order
 * they mattered:
 *
 *  - **They are the only palette in the app that is already verified.** Each
 *    swatch's flat field value is the one `npm run contrast:check` measures white
 *    against, so every one of them is a colour this design system has already
 *    agreed reads as a filled area rather than as a tint. Inventing a chart
 *    palette beside it would be a second set of colours to keep in step with the
 *    themes.
 *  - **They work in both schemes without being chosen per scheme.** They are
 *    saturated mid-tones, which separate from a near-white block surface and from
 *    a near-black one. A palette picked for light mode would have to be picked
 *    again for dark, and a slice whose colour changed with the theme would not
 *    match a screenshot taken in the other one.
 *  - **The order is fixed, so the same source always draws the same chart.** A
 *    hue rotated by slice count would mean a chart that changed colour when a row
 *    was added, which is a thing no reader of a conversation should ever see.
 *
 * The order interleaves hues rather than walking the picker's, so the first few
 * slices — which is all most charts have — are as far apart as the palette allows.
 */

import { memo } from 'react'
import { Circle, G, Path, Rect } from 'react-native-svg'

import { ACCENTS, type AccentName } from '../../ui/tokens'
import type { MarkdownContext } from '../context'
import { DiagramCanvas } from './Canvas'
import type { PieLayout } from './pie-layout'

/**
 * One accent per slice, as far apart in hue as the palette reaches.
 *
 * As long as the pie parser's own slice limit, so a chart that parses always has
 * a colour for every row it drew. The modulo below is the belt to that braces.
 */
const SLICE_ACCENTS: readonly AccentName[] = [
  'default',
  'orange',
  'teal',
  'magenta',
  'green',
  'violet',
  'red',
  'graphite',
  'lime',
  'slate'
]

function sliceColour(index: number): string {
  const name = SLICE_ACCENTS[index % SLICE_ACCENTS.length] as AccentName

  return ACCENTS[name].bubble
}

function PieChartViewInner({ layout, context }: { layout: PieLayout; context: MarkdownContext }) {
  return (
    <DiagramCanvas context={context} layout={layout} testID="markdown-mermaid-pie">
      {layout.arcs.map(arc => {
        const colour = sliceColour(arc.index)

        // One slice holding every unit is a ring: an arc that starts and ends at
        // the same angle draws nothing at all, so the hole is punched with the
        // block's own background rather than described as a sector.
        if (arc.full) {
          return (
            <G key={`arc-${arc.index}`}>
              <Circle cx={layout.centre.x} cy={layout.centre.y} fill={colour} r={layout.outerRadius} />
              <Circle cx={layout.centre.x} cy={layout.centre.y} fill={context.blockBackground} r={layout.innerRadius} />
            </G>
          )
        }

        if (!arc.path) {
          return null
        }

        return (
          <Path d={arc.path} fill={colour} key={`arc-${arc.index}`} stroke={context.blockBackground} strokeWidth={1} />
        )
      })}

      {layout.swatches.map(swatch => (
        <Rect
          fill={sliceColour(swatch.index)}
          height={swatch.height}
          key={`swatch-${swatch.index}`}
          rx={2}
          width={swatch.width}
          x={swatch.x}
          y={swatch.y}
        />
      ))}
    </DiagramCanvas>
  )
}

/** Memoized on the layout and the context, for the reason the flowchart is. */
export const PieChartView = memo(PieChartViewInner)
