'use client'
import { useEffect } from 'react'

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center p-xl bg-surface">
      <div className="bg-surface-container-lowest rounded-xl p-xl shadow-card border border-outline-variant/20 max-w-2xl">
        <h2 className="text-headline-sm text-error mb-md">Something went wrong</h2>
        <pre className="text-label-sm text-on-surface-variant whitespace-pre-wrap mb-md">
          {error.message}
        </pre>
        {error.digest && (
          <p className="text-label-sm text-on-surface-variant mb-md">Digest: {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
