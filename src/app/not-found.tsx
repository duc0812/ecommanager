import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-xl bg-surface">
      <div className="bg-surface-container-lowest rounded-xl p-xl shadow-card border border-outline-variant/20 text-center">
        <h2 className="text-display-md mb-md">404</h2>
        <p className="text-body-md text-on-surface-variant mb-lg">Page not found.</p>
        <Link href="/" className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md inline-block">
          Back to Overview
        </Link>
      </div>
    </div>
  )
}
