'use client'
import type { StoreFilterState } from '@/lib/use-store-filter'

// Hidden for a user with one store. `required` is for a page that shows one store at a time (Shopify payouts):
// there is no "all" chip and the first store stands for the pick until the user makes one.
export default function StoreFilter({ filter, required = false }: { filter: Pick<StoreFilterState, 'stores' | 'storeId' | 'setStoreId'>; required?: boolean }) {
  const { stores, storeId, setStoreId } = filter
  if (stores.length < 2) return null
  const active = required ? storeId ?? stores[0].id : storeId
  const chip = (on: boolean) => `px-md py-xs rounded-lg text-label-sm font-semibold transition-all ${
    on ? 'bg-secondary text-on-secondary shadow-sm' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high border border-outline-variant/20'
  }`
  return (
    <div role="group" aria-label="Chọn store" className="flex items-center gap-xs flex-wrap">
      <span className="material-symbols-outlined text-[16px] text-on-surface-variant">storefront</span>
      {!required && (
        <button type="button" aria-pressed={active === null} onClick={() => setStoreId(null)} className={chip(active === null)}>Tất cả store</button>
      )}
      {stores.map(store => (
        <button key={store.id} type="button" aria-pressed={active === store.id} onClick={() => setStoreId(store.id)} className={chip(active === store.id)}>
          {store.name}
        </button>
      ))}
    </div>
  )
}

export function StoreLabel({ name }: { name: string | null | undefined }) {
  if (!name) return null
  return (
    <span className="inline-flex max-w-full items-center gap-[3px] rounded bg-secondary/10 px-xs py-[1px] text-label-sm text-secondary">
      <span className="material-symbols-outlined text-[12px]">storefront</span>
      <span className="truncate">{name}</span>
    </span>
  )
}
