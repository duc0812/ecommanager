export const FILTERS_CHANGED = 'spy:filters-changed'

export function notifyFiltersChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(FILTERS_CHANGED))
}
