'use client'
import { Suspense, useState } from 'react'
import SpyFilterSidebar from '@/components/spy/SpyFilterSidebar'

export default function SpyChrome({ children }: { children: React.ReactNode }) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  return (
    <div className="flex min-h-screen w-full min-w-0">
      <Suspense fallback={<aside className="hidden w-[268px] flex-none border-r border-[#E6E3DE] bg-white lg:block" />}>
        <SpyFilterSidebar open={filtersOpen} onClose={() => setFiltersOpen(false)} />
      </Suspense>
      <div className="min-w-0 flex-1 px-[18px] py-[18px] lg:px-[36px] lg:py-[28px]">
        <button onClick={() => setFiltersOpen(true)}
          className="mb-[16px] inline-flex items-center gap-2 rounded-[10px] border border-[#E6E3DE] bg-white px-[14px] py-[9px] text-[13px] font-medium text-[#1B1A17] shadow-sm transition-colors hover:bg-[#F2F1EE] lg:hidden">
          <span className="material-symbols-outlined text-[18px]">tune</span>Filters
        </button>
        {children}
      </div>
    </div>
  )
}
