'use client'
import { Suspense } from 'react'
import SpyFilterSidebar from '@/components/spy/SpyFilterSidebar'

export default function SpyChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-lg">
      <Suspense fallback={<aside className="w-[220px] flex-none" />}>
        <SpyFilterSidebar />
      </Suspense>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
