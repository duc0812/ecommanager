'use client'
import TaxonomyEditor from '@/components/spy/TaxonomyEditor'

export default function NichesPage() {
  return (
    <>
      <a href="/tools/spy-idea" className="mb-md inline-flex items-center gap-1 text-secondary text-label-md hover:underline">
        <span className="material-symbols-outlined text-[18px]">arrow_back</span>Back to Ad Library
      </a>
      <header className="mb-lg">
        <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Tools</p>
        <h2 className="text-display-md font-bold text-primary">Niches</h2>
      </header>
      <TaxonomyEditor title="Niche" endpoint="/api/spy/niches"
        hint="Keywords match product titles and ad title/body (case-insensitive, any keyword)." />
    </>
  )
}
