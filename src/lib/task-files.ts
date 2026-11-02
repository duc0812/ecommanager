export type FileKind = 'PRINT' | 'MOCKUP'
export type DrivePlace = 'TASK' | 'OLD' | 'STUCK'

export const FILE_KINDS: FileKind[] = ['PRINT', 'MOCKUP']
export const DEFAULT_PART = 'Artwork'
export const PART_MAX = 60
export const OLD_FOLDER_NAME = '_old'
/** Start of the error an approval gets when a template area has no file; the leader is asked and the approval retried. */
export const MISSING_AREAS_PREFIX = 'Chưa có file cho vùng: '

type PartFile = { kind?: string | null; printArea: string; version: number; createdAt?: Date | string | null }

export function fileKindOf(value: unknown): FileKind {
  return value === 'MOCKUP' ? 'MOCKUP' : 'PRINT'
}

export function isFileKind(value: unknown): value is FileKind {
  return value === 'PRINT' || value === 'MOCKUP'
}

export function cleanPartLabel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PART_MAX).trim()
}

/** The part a file belongs to when nobody named one: its file name without the extension. */
export function partLabelFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return cleanPartLabel(dot >= 0 ? base.slice(0, dot) : base) || DEFAULT_PART
}

/** A set made by hand is often named after the line: `LIT4936_2 - front`, `LIT4936_2_1 - cuff`, `LIT5099 - back hem`. */
const LINE_PREFIX = /^lit\d+(?:_\d+)*[\s_]*-[\s_]*/
const PART_ALIASES: Record<string, string> = { hat: 'hood', 'outer hood': 'hood' }

/** What a part is matched by: `back_hem` and `LIT4936_2 - back hem` are the area `BACK HEM`, a designer's `Hat` is the hood. */
export function partKey(label: string): string {
  const key = label.trim().toLowerCase().replace(LINE_PREFIX, '').replace(/[\s_]+/g, ' ')
  return PART_ALIASES[key] ?? key
}

export function sameLabel(a: string, b: string): boolean {
  return partKey(a) === partKey(b)
}

/**
 * A label taken from a file name joins the part it means: a template area first, then a part the task already has,
 * whatever the letter case. `front.png` after `Front.png` is version 2 of "Front", not a second file.
 */
export function resolvePartLabel(label: string, slots: string[], existing: string[]): string {
  return slots.find(s => sameLabel(s, label)) ?? existing.find(e => sameLabel(e, label)) ?? label
}

/**
 * The part an uploaded file lands in. Same name and same type is a new version of that part; same name but another
 * type (`front.psd` next to `front.png`) is a separate part named with its extension, so a source file never
 * pushes the print file out of the folder. `existing` lists the task's files newest first.
 */
export function partForUpload(fileName: string, slots: string[], existing: Array<{ printArea: string; fileName: string }>): string {
  const parts = Array.from(new Set(existing.map(e => e.printArea)))
  const label = resolvePartLabel(partLabelFromFileName(fileName), slots, parts)
  const current = existing.find(e => sameLabel(e.printArea, label))
  const ext = extensionOf(fileName)
  if (!current || !ext || extensionOf(current.fileName) === ext) return label
  return resolvePartLabel(cleanPartLabel(`${partLabelFromFileName(fileName)}.${ext}`), [], parts)
}

export function partTaken(label: string, others: string[]): boolean {
  return others.some(o => sameLabel(o, label))
}

function byLabel(a: string, b: string): number {
  const x = a.toLowerCase(), y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0
}

/** Versions count within one name. Two names of one part (`LIT4936_2 - front`, `FRONT`) are told apart by upload time. */
export function newerFile(a: PartFile, b: PartFile): boolean {
  if (a.printArea === b.printArea) return a.version > b.version
  const at = (f: PartFile) => (f.createdAt ? new Date(f.createdAt).getTime() : 0)
  return at(a) === at(b) ? a.version > b.version : at(a) > at(b)
}

/** The newest version of every part of one kind. Callers pass files that are not removed. */
export function currentFiles<T extends PartFile>(files: T[], kind: FileKind): T[] {
  const newest = new Map<string, T>()
  for (const f of files) {
    if (fileKindOf(f.kind) !== kind) continue
    const key = partKey(f.printArea)
    const have = newest.get(key)
    if (!have || newerFile(f, have)) newest.set(key, f)
  }
  return Array.from(newest.values()).sort((a, b) => byLabel(a.printArea, b.printArea))
}

/** Files uploaded within this time of each other are one set, whatever order they landed in. */
const SAME_SET_MS = 60 * 60 * 1000

/**
 * Print parts left over from before the line used its template: not one of the template's areas, and last uploaded
 * before the first file went into one of them (a 2D set named after its files next to the 3D sheet that replaced it);
 * also an area's file under another name once a newer file fills that area (`LIT5217_1 - front` after `FRONT`).
 * A part added after the template files or with them, or a source file named after an area (`FRONT.psd` beside `FRONT`), stays.
 * Callers pass the line's PRINT files that are not removed.
 */
export function outdatedParts(files: Array<{ printArea: string; createdAt: Date }>, slots: string[]): string[] {
  const inArea = (label: string) => slots.some(s => sameLabel(s, label))
  const isSlot = (label: string) => inArea(label) || inArea(label.replace(/\.[a-z0-9]{1,5}$/i, ''))
  const lastUpload = new Map<string, number>()
  for (const f of files) lastUpload.set(f.printArea, Math.max(lastUpload.get(f.printArea) ?? 0, f.createdAt.getTime()))
  const labels = Array.from(lastUpload.keys())
  const replaced = labels.filter(l => inArea(l) && labels.some(o => o !== l && sameLabel(o, l) && lastUpload.get(o)! > lastUpload.get(l)!))
  const slotTimes = files.filter(f => inArea(f.printArea) && !replaced.includes(f.printArea)).map(f => f.createdAt.getTime())
  if (slotTimes.length === 0) return []
  const firstSlot = Math.min(...slotTimes)
  const leftOver = labels.filter(l => !isSlot(l) && lastUpload.get(l)! < firstSlot - SAME_SET_MS)
  return [...replaced, ...leftOver].sort(byLabel)
}

/** Print files in the order the factory gets them: the template's areas first, then every other part by name. */
export function orderedPrintFiles<T extends PartFile>(files: T[], areas: string[]): T[] {
  const current = currentFiles(files, 'PRINT')
  const inArea = areas.flatMap(area => current.filter(f => sameLabel(f.printArea, area)))
  return [...inArea, ...current.filter(f => !areas.some(area => sameLabel(area, f.printArea)))]
}

export function extraPrintParts(files: PartFile[], areas: string[]): string[] {
  return currentFiles(files, 'PRINT').map(f => f.printArea).filter(p => !areas.some(area => sameLabel(area, p)))
}

export function missingPrintAreas(files: PartFile[], areas: string[]): string[] {
  const have = new Set(currentFiles(files, 'PRINT').map(f => partKey(f.printArea)))
  return areas.filter(a => !have.has(partKey(a)))
}

/** A template task needs a file for every area; a task without a template needs at least one print file. */
export function printFilesReady(files: PartFile[], areas: string[]): boolean {
  return areas.length > 0 ? missingPrintAreas(files, areas).length === 0 : currentFiles(files, 'PRINT').length > 0
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''
}

function driveSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'file'
}

/** The name a current file carries inside its task folder: `<part>.<ext>`, a mockup as `MOCKUP_<part>.<ext>`. */
export function driveFileName(a: { kind?: string | null; printArea: string; fileName: string }): string {
  const base = driveSafe(a.printArea)
  const ext = extensionOf(a.fileName)
  const name = !ext || base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`
  return fileKindOf(a.kind) === 'MOCKUP' ? `MOCKUP_${name}` : name
}

export function driveOldFileName(a: { kind?: string | null; printArea: string; fileName: string; version: number }): string {
  return `v${a.version}_${driveFileName(a)}`
}

type PlacedFile = PartFile & { id: string; storage: string; drivePlace?: string | null; removedAt?: Date | string | null }

export function currentFileIds(files: PlacedFile[]): Set<string> {
  const live = files.filter(f => !f.removedAt)
  return new Set([...currentFiles(live, 'PRINT'), ...currentFiles(live, 'MOCKUP')].map(f => f.id))
}

/**
 * The folder can be handed to the factory once every current print file sits in it and nothing else does:
 * no superseded or removed file may still be next to the current ones. Takes every file of the task, removed ones too.
 */
export function folderHoldsPrintFiles(files: PlacedFile[]): boolean {
  const prints = currentFiles(files.filter(f => !f.removedAt), 'PRINT')
  if (prints.length === 0) return false
  if (!prints.every(f => f.storage === 'DRIVE' && f.drivePlace === 'TASK')) return false
  const current = currentFileIds(files)
  return !files.some(f => f.storage === 'DRIVE' && !current.has(f.id) && f.drivePlace !== 'OLD')
}
