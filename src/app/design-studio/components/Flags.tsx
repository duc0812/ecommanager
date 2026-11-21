'use client'
import Link from 'next/link'
import type { TaskDetail } from './types'
import { productPageUrl } from './model'
import { flagNotes, type StreamId } from './streams'
import { Note } from './ui'

export default function Flags({ detail, stream, inQueue }: { detail: TaskDetail; stream: StreamId | null; inQueue: boolean }) {
  const { task } = detail
  const notes = flagNotes({
    status: task.status, dueAt: task.dueAt, readiness: task.readiness, mapping: task.mapping,
    stream, inQueue, productPageHref: detail.profileRouteKey ? productPageUrl(detail.profileRouteKey) : null,
  })
  return (
    <>
      {notes.map(n => (
        <Note key={n.key} tone={n.tone} icon={n.icon}>
          <b>{n.title}</b> {n.text}
          {n.links.map(l => (
            <span key={l.href}> <Link href={l.href} className="underline">{l.label}</Link></span>
          ))}
        </Note>
      ))}
    </>
  )
}
