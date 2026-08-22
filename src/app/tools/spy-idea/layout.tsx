'use client'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpyChrome from '@/components/spy/SpyChrome'

export default function SpyLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <SpyChrome>{children}</SpyChrome>
        </main>
      </div>
    </RoleGate>
  )
}
