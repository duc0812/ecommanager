'use client'
import { Suspense } from 'react'
import SpyFilterSidebar from '@/components/spy/SpyFilterSidebar'

export default function SpyChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full min-w-0">
      <Suspense fallback={<aside className="hidden w-[268px] flex-none border-r border-[#E6E3DE] bg-white lg:block" />}>
        <SpyFilterSidebar />
      </Suspense>
      <div className="min-w-0 flex-1 px-[36px] py-[28px]">{children}</div>
    </div>
  )
}
