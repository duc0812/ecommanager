'use client'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import SpySectionNav from '@/components/SpySectionNav'
import TaxonomyEditor from '@/components/spy/TaxonomyEditor'

const NAV_ITEMS = [
  { key: 'ads', label: 'Ad Library', icon: 'library_books', href: '/tools/spy-idea?area=ads&view=new' },
  { key: 'products', label: 'Product Spy', icon: 'inventory_2', href: '/tools/spy-idea?area=products&view=new-add' },
  { key: 'sources', label: 'Sources', icon: 'storefront', href: '/tools/spy-idea/sources' },
  { key: 'niches', label: 'Niches', icon: 'sell', href: '/tools/spy-idea/niches' },
  { key: 'types', label: 'Product types', icon: 'category', href: '/tools/spy-idea/product-types' },
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
