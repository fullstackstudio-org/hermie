/**
 * The letter that stands in for a source's icon (`sources-model.ts::monogramOf`): drawn by CSS on a colour bucket
 * (`data-hue`, see `sources.css`), with no image and no request. Decoration: it is hidden from assistive technology,
 * and the host is always written out beside it.
 */
import { monogramOf } from './sources-model'

export function Monogram({ url }: { url: string }) {
  const { letter, hue } = monogramOf(url)

  return (
    <span className="hm-mono" data-hue={hue} aria-hidden="true">
      {letter}
    </span>
  )
}
