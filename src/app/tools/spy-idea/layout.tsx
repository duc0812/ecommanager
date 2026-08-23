'use client'
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpyChrome from '@/components/spy/SpyChrome'

const plexSans = IBM_Plex_Sans({ subsets: ['latin', 'latin-ext', 'vietnamese'], weight: ['400', '500', '600', '700'], display: 'swap' })
const plexMono = IBM_Plex_Mono({ subsets: ['latin', 'latin-ext'], weight: ['400', '500'], display: 'swap', variable: '--font-plex-mono' })

export default function SpyLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate>
      <div className={`${plexSans.className} ${plexMono.variable} flex min-h-screen bg-[#F7F6F4] text-[#1B1A17]`}>
        <Sidebar />
        <div className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex min-w-0 flex-1">
          <SpyChrome>{children}</SpyChrome>
        </div>
      </div>
    </RoleGate>
  )
}
