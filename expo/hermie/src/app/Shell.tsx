import { devInitialView } from '../dev'
import { CompactShell } from './CompactShell'
import { RegularShell } from './RegularShell'
import { useLayoutMode } from './useLayoutMode'

export function Shell() {
  // Read once, here: both shells already own "which bot is selected" and "which
  // section is open", and a second reader of the same launch argument is a
  // second place for the two layouts to disagree. Undefined in a release
  // bundle, where the whole `src/dev` gate is folded out.
  const initial = devInitialView()

  return useLayoutMode() === 'regular' ? <RegularShell initial={initial} /> : <CompactShell initial={initial} />
}
