'use client'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import TaxonomyEditor from '@/components/spy/TaxonomyEditor'

export default function ProductTypesPage() {
  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-[280px] flex-1 p-xl">
          <header className="mb-lg">
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools · Spy · Setup</p>
            <h2 className="text-display-md font-bold text-primary">Product types</h2>
          </header>
          <TaxonomyEditor title="Product type" endpoint="/api/spy/product-types"
            hint="Keywords match product titles and ad title/body (case-insensitive, any keyword)." />
          <a href="/tools/spy-idea?area=ads&view=new" className="mt-lg inline-block text-secondary text-label-md hover:underline">← Back to Spy</a>
        </main>
      </div>
    </RoleGate>
  )
}
