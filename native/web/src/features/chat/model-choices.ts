/**
 * The model picker's list: what the gateway offers, cut into one group per
 * provider, the model the chat is on kept in it, and an optional search.
 *
 * Pure, and the one place that decides what is in the picker, so the picker and
 * its tests cannot disagree about it (the Apple apps' `modelPickerOptions` makes
 * the same argument).
 *
 * The chat's own model is always listed, even when the gateway's inventory does
 * not have it (a model set by hand, an inventory that failed to load): a picker
 * whose current value is not one of its options shows the wrong thing, and an
 * empty one is a dead end. It stands above the groups, never inside whichever
 * happens to come first, and the search never removes it for the same reason.
 */
import { prettyModelName } from '@hermie/transcript'

import type { ModelChoice } from '../../core/chat-controller'

export interface ModelEntry {
  /** The wire id, which is what `config.set` takes. */
  id: string
  /** What a reader calls it. */
  label: string
}

export interface ModelGroup {
  /** The provider's name, or `null` for the chat's own model when the inventory did not list it. */
  provider: string | null
  models: ModelEntry[]
}

/** From how many models the picker offers a search; below it, scrolling is quicker. */
export const MODEL_SEARCH_FROM = 8

const entryOf = (id: string): ModelEntry => ({ id, label: prettyModelName(id) })

/** Whether a model answers the search: its name, its wire id or its provider, in any case. */
function matches(model: ModelChoice, query: string): boolean {
  const needle = query.trim().toLowerCase()

  if (!needle) {
    return true
  }

  return [prettyModelName(model.id), model.id, model.provider].some(text => text.toLowerCase().includes(needle))
}

export function modelGroups(models: readonly ModelChoice[], current: string, query = ''): ModelGroup[] {
  const groups: ModelGroup[] = []
  const byProvider = new Map<string, ModelGroup>()

  for (const model of models) {
    if (!matches(model, query) && model.id !== current) {
      continue
    }

    const provider = model.provider
    let group = byProvider.get(provider)

    if (!group) {
      group = { provider: provider || null, models: [] }
      byProvider.set(provider, group)
      groups.push(group)
    }

    group.models.push(entryOf(model.id))
  }

  if (current && !models.some(model => model.id === current)) {
    return [{ provider: null, models: [entryOf(current)] }, ...groups]
  }

  return groups
}

/** The number of models a search leaves besides the one the chat is on. */
export function otherModelCount(groups: readonly ModelGroup[], current: string): number {
  return groups.reduce((total, group) => total + group.models.filter(model => model.id !== current).length, 0)
}
