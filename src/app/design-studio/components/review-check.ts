import type { TaskDetail } from './types'
import type { QaResult } from './ai-qa'
import { buildChecklist } from './checklist'
import { mockupFiles, printFiles } from './model'

export type IssueLevel = 'error' | 'warn'
export type ReviewIssue = { key: string; level: IssueLevel; text: string }
export type ReviewVerdict = { status: 'ok' | 'warn' | 'error'; issues: ReviewIssue[]; summary: string }

type Input = Pick<TaskDetail, 'task' | 'line' | 'template' | 'slots' | 'library' | 'profile' | 'me'>

/**
 * What the reviewer has to look at before approving: only what is wrong or doubtful. Passing checks collapse into one
 * summary line. The machine QA covers the files; the checklist adds mapping and customer data; a missing artwork library
 * entry is not listed because a hand-made file is still reviewable.
 */
export function reviewVerdict(detail: Input, qa: QaResult): ReviewVerdict {
  const { line, template, slots } = detail
  const issues: ReviewIssue[] = []

  if (qa.status === 'none') issues.push({ key: 'qa-none', level: 'error', text: 'Chưa có file in nào' })
  for (const it of qa.items) {
    if (it.level === 'pass') continue
    issues.push({ key: `qa-${it.key}`, level: it.level, text: `${it.label}: ${it.detail}` })
  }

  const list = buildChecklist(detail)
  for (const i of list.items) {
    if (i.key !== 'mapping' && i.key !== 'customer') continue
    if (i.state === 'missing') issues.push({ key: `check-${i.key}`, level: 'error', text: `${i.title}: ${i.reason}` })
    else if (i.state === 'blocked') issues.push({ key: `check-${i.key}`, level: 'warn', text: `${i.title}: ${i.reason}` })
  }

  const mockups = mockupFiles(line).length
  if (mockups === 0 && qa.status !== 'none') {
    issues.push({ key: 'mockup', level: 'warn', text: 'Chưa có mockup dựng từ file in — so file in trực tiếp với preview khách' })
  }
  if (!template && line.supplier) {
    issues.push({ key: 'template', level: 'warn', text: 'Sản phẩm chưa có template — tự kiểm khổ file theo yêu cầu xưởng' })
  }

  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))

  const files = printFiles(line, slots)
  const parts = [
    template ? `${template.name} · ${template.widthPx}×${template.heightPx} · ${template.dpi} DPI` : null,
    slots.length ? `${slots.length}/${slots.length} vùng in` : files.length ? `${files.length} file in` : null,
    qa.items.find(i => i.key === 'format')?.level === 'pass' ? 'PNG/JPG' : null,
    mockups ? `${mockups} mockup` : null,
  ].filter((p): p is string => !!p)

  const status = issues.some(i => i.level === 'error') ? 'error' : issues.length ? 'warn' : 'ok'
  return { status, issues, summary: parts.join(' · ') }
}
