/**
 * A `pie` fence, drawn from `layoutPie`: a ring of slices and a legend of
 * swatches, labels and values.
 *
 * The slices take the app's accent swatches in the Expo app's fixed order
 * (`expo/hermie/src/markdown/mermaid/PieChart.tsx`), the same in both schemes, so
 * the same source always draws the same chart: `md-dg-slice-<n>` in
 * `markdown-mermaid.css`, one class per position, as many as the parser allows
 * slices.
 */
import type { PieLayout } from '@hermie/markdown/mermaid/pie-layout'
import { memo } from 'react'

import { DiagramFrame, TextLayer } from './Diagram'

/** How many slice colours there are; a chart with more reuses them in order. */
export const SLICE_COLOURS = 10

const sliceClass = (index: number): string => `md-dg-slice md-dg-slice-${index % SLICE_COLOURS}`

function PieChartView({ layout, label }: { layout: PieLayout; label: string }) {
  return (
    <DiagramFrame kind="pie" label={label} layout={layout}>
      {layout.arcs.map(arc => {
        // One slice that holds every unit is a ring: an arc from an angle to itself draws nothing.
        if (arc.full) {
          return (
            <g key={`arc-${arc.index}`}>
              <circle
                className={sliceClass(arc.index)}
                cx={layout.centre.x}
                cy={layout.centre.y}
                r={layout.outerRadius}
              />
              <circle className="md-dg-hole" cx={layout.centre.x} cy={layout.centre.y} r={layout.innerRadius} />
            </g>
          )
        }

        return arc.path ? (
          <path className={sliceClass(arc.index)} d={arc.path} key={`arc-${arc.index}`} strokeWidth={1} />
        ) : null
      })}

      {layout.swatches.map(swatch => (
        <rect
          className={sliceClass(swatch.index)}
          height={swatch.height}
          key={`swatch-${swatch.index}`}
          rx={2}
          width={swatch.width}
          x={swatch.x}
          y={swatch.y}
        />
      ))}

      <TextLayer texts={layout.texts} />
    </DiagramFrame>
  )
}

export const PieChart = memo(PieChartView)
