'use client'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpySectionNav from '@/components/SpySectionNav'
import TaxonomyEditor from '@/components/spy/TaxonomyEditor'

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'space_dashboard', href: '/tools/spy-idea/dashboard' },
  { key: 'ads', label: 'Ad Library', icon: 'library_books', href: '/tools/spy-idea?tab=ads' },
  { key: 'products', label: 'Products', icon: 'inventory_2', href: '/tools/spy-idea?tab=products' },
  { key: 'stores', label: 'Stores', icon: 'storefront', href: '/tools/spy-idea?tab=stores' },
  { key: 'ideas', label: 'Ideas', icon: 'lightbulb', href: '/tools/spy-idea?tab=ideas' },
  { key: 'niches', label: 'Niches', icon: 'sell', href: '/tools/spy-idea/niches' },
]

export default function NichesPage() {
  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
            <h2 className="text-display-md font-bold text-primary">Niches</h2>
          </header>
          <SpySectionNav active="niches" items={NAV_ITEMS} />

          <TaxonomyEditor title="Niche" endpoint="/api/spy/niches"
            hint="Keywords match product titles and ad title/body (case-insensitive, any keyword)." />
        </main>
      </div>
    </RoleGate>
  )
}
