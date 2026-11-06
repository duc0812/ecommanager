import fs from 'fs/promises'
import path from 'path'
import { storageRoot } from '@/lib/design-storage'

export type ScaleKind = 'targets' | 'jobs' | 'views'
export type ScaleBase = 'blank' | 'candidate' | 'src' | 'out' | `part-${number}`

const KINDS = ['targets', 'jobs', 'views']
const ID = /^[a-z0-9_]+$/i
const FILE_NAME = /^(blank|candidate|src|out|part-\d+)\.(png|jpe?g|webp)$/
const EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export function scaleRoot(): string {
  return path.join(storageRoot(), 'scale')
}

export function resolveScaleFile(kind: string, id: string, name: string): string | null {
  if (!KINDS.includes(kind) || !ID.test(id) || !FILE_NAME.test(name)) return null
  const root = path.resolve(scaleRoot())
  const abs = path.resolve(root, kind, id, name)
  if (!abs.startsWith(root + path.sep)) return null
  return abs
}

async function removeBase(dir: string, base: ScaleBase) {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(names.filter(n => n.startsWith(`${base}.`)).map(n => fs.rm(path.join(dir, n), { force: true })))
}

export async function writeScaleFile(kind: ScaleKind, id: string, base: ScaleBase, bytes: Buffer, ext: string): Promise<string> {
  const name = `${base}.${ext}`
  const abs = resolveScaleFile(kind, id, name)
  if (!abs) throw new Error('invalid scale file path')
  const dir = path.dirname(abs)
  await fs.mkdir(dir, { recursive: true })
  await removeBase(dir, base)
  await fs.writeFile(abs, bytes)
  return name
}

export async function readScaleFile(kind: ScaleKind, id: string, name: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const abs = resolveScaleFile(kind, id, name)
  if (!abs) return null
  try { return { bytes: await fs.readFile(abs), mime: EXT_MIME[name.split('.').pop()!.toLowerCase()] } } catch { return null }
}

export async function removeScaleFile(kind: ScaleKind, id: string, base: ScaleBase): Promise<void> {
  if (!ID.test(id)) return
  await removeBase(path.join(scaleRoot(), kind, id), base)
}

export async function deleteScaleFolder(kind: ScaleKind, id: string): Promise<void> {
  if (!ID.test(id)) return
  await fs.rm(path.join(scaleRoot(), kind, id), { recursive: true, force: true })
}

export function toDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}
