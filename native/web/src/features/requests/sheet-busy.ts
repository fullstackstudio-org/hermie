/**
 * How a sheet tells the request layer that it is in the middle of something (an answer on its way, files being
 * uploaded): then a question that arrives waits for it instead of taking the dialog (`sheet-order.ts`). The layer
 * provides it around every sheet; a sheet drawn without a layer (a test of the sheet alone) has none, and says nothing.
 *
 * A module of its own, with nothing but React in it: the layer is in the first load and the sheets are not, and the
 * layer reaches this through a static import. Were it in `interactive-frame.tsx`, that import would pull the frame, the
 * secure sheet, the approval sheet and every sheet string into the first load (`client:check-bundle` guards this).
 */
import { createContext, useContext, useLayoutEffect } from 'react'

export const SheetBusyContext = createContext<((busy: boolean) => void) | null>(null)

/** Say, for as long as it holds, that the sheet must not be cut off. Calls it makes are undone when the sheet goes. */
export function useReportBusy(busy: boolean): void {
  const report = useContext(SheetBusyContext)

  // A layout effect: the layer must know before the next thing that arrives is placed, not after a paint.
  useLayoutEffect(() => {
    if (!report || !busy) {
      return
    }

    report(true)

    return () => report(false)
  }, [report, busy])
}
