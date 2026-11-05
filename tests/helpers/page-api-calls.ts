import fs from 'fs'
import path from 'path'
import { canAccess, type FeaturePermission } from '@/lib/roles'

const SRC = path.resolve(process.cwd(), 'src')
const EXT = ['.tsx', '.ts', '/index.tsx', '/index.ts']
const MAX_DEPTH = 4

function pageFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'api' ? [] : pageFiles(full)
    return entry.name === 'page.tsx' ? [full] : []
  })
}

function routeOf(file: string): string {
  const rel = path.relative(path.join(SRC, 'app'), path.dirname(file)).split(path.sep).filter(Boolean)
  return `/${rel.join('/')}`
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null
  if (!base || base.startsWith(path.join(SRC, 'lib'))) return null
  return EXT.map(ext => base + ext).find(candidate => fs.existsSync(candidate)) ?? null
}

// Every file a page draws: itself and the components it imports (not src/lib, which holds server code).
function closureOf(file: string, seen = new Set<string>(), depth = 0): Set<string> {
  if (seen.has(file) || depth > MAX_DEPTH) return seen
  seen.add(file)
  for (const m of Array.from(fs.readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g))) {
    const next = resolveImport(file, m[1])
    if (next) closureOf(next, seen, depth + 1)
  }
  return seen
}

// '/api/projects/${id}/snapshots?x=1' -> '/api/projects/:p/snapshots'; a template glued to a name ('pl-summary${qs}') is dropped.
function apiPathsIn(text: string): string[] {
  const flat = text.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ':p')
  return Array.from(flat.matchAll(/['"`](\/api\/[^'"`?\s]*)/g), m => m[1].replace(/(?<!\/):p/g, '').replace(/\/$/, ''))
}

export type PageCalls = { route: string; paths: string[] }

// The /api paths named in the pages that a user with these features can open, and in the components those pages draw.
// `also` adds pages the user is expected to use even when the route table refuses them.
export function apiPathsOfPages(role: 'SELLER', features: FeaturePermission[], also: string[] = []): PageCalls[] {
  return pageFiles(path.join(SRC, 'app'))
    .map(file => ({ file, route: routeOf(file) }))
    .filter(page => also.includes(page.route) || canAccess(role, page.route, features))
    .map(page => ({
      route: page.route,
      paths: Array.from(new Set(Array.from(closureOf(page.file)).flatMap(f => apiPathsIn(fs.readFileSync(f, 'utf8'))))).sort(),
    }))
    .sort((a, b) => a.route.localeCompare(b.route))
}
