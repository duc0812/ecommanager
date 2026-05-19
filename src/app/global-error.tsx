'use client'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html>
      <body>
        <div style={{ padding: 32, fontFamily: 'system-ui', maxWidth: 800, margin: '0 auto' }}>
          <h2 style={{ color: '#ba1a1a' }}>Application error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f3f4f6', padding: 16, borderRadius: 8 }}>
            {error.message}
          </pre>
          <button
            onClick={reset}
            style={{ marginTop: 16, padding: '8px 16px', background: '#4b41e1', color: '#fff', border: 0, borderRadius: 8, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
