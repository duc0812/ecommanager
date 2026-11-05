'use client'
import { useCallback, useEffect, useState } from 'react'

export type FilterStore = { id: string; shop: string; name: string; orderPrefix: string | null }

const STORAGE_KEY = 'ecom.storeFilter'

function readChoice(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY) } catch { return null }
}

function writeChoice(storeId: string | null) {
  try {
    if (storeId) window.localStorage.setItem(STORAGE_KEY, storeId)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

export function withStoreQuery(url: string, query: string): string {
  if (!query) return url
  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

// A saved choice counts only while it is still one of the user's stores; a user with one store has nothing to pick.
export function choiceFor(saved: string | null, stores: { id: string }[]): string | null {
  return stores.length > 1 && saved && stores.some(store => store.id === saved) ? saved : null
}

// The stores the signed-in user may see (GET /api/stores) and the one it picked, null meaning all of them.
// A user with one store has nothing to pick, so its choice stays null and requests carry no storeId.
// `ready` turns true once the stores are known and the saved choice is checked against them: a page that
// loads data with `query` should wait for it, or it loads once for every store and again for the saved one.
export function useStoreFilter() {
  const [stores, setStores] = useState<FilterStore[]>([])
  const [storeId, setStoreIdState] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/stores', { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : { stores: [] }))
      .then(body => {
        if (cancelled) return
        const list: FilterStore[] = Array.isArray(body?.stores) ? body.stores : []
        setStores(list)
        setStoreIdState(choiceFor(readChoice(), list))
        setReady(true)
      })
      .catch(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true }
  }, [])

  const setStoreId = useCallback((next: string | null) => {
    setStoreIdState(next)
    writeChoice(next)
  }, [])

  return { stores, storeId, setStoreId, query: storeId ? `storeId=${encodeURIComponent(storeId)}` : '', ready }
}

export type StoreFilterState = ReturnType<typeof useStoreFilter>
