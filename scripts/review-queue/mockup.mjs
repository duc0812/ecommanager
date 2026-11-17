import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'

// Every line that enters the local review queue needs a mockup (owner 11/04/2026: every line, every stream; 11/17/2026: a line
// that went through a builder gets its preview rebuilt, never the plain store photo). Intake asks this module for one per line:
//   present  — the push already carries a MOCKUP file
//   prod     — prod already has a live MOCKUP row (snapshot)
//   preview  — the line has the shopper's own preview (Customall / _customall_preview); prod attaches it itself at submit
//   hapo     — builder redrawn by mockups/hapo_render.py (mockups/auto-mockup.json names the designs)
//   library  — the design's mockup library (artwork-builder/<CODE>/mockup/mockup.json) via mockups/lib_mock.py
//   store    — no custom at all: the variant photo of the listing (rule 3)
//   missing  — none of the above: the item fails QA ("Thiếu mockup: …") and never goes to the cloud by itself

export const DEFAULT_ARTWORK_BUILDER = 'D:\\Ecom manager\\artwork-builder'
export const MOCKUP_MISSING = 'Thiếu mockup'
export const MOCKUP_STATES = ['present', 'prod', 'preview', 'hapo', 'library', 'store', 'missing']
const SWITCH_KEY = /yes\s*(or|\/)\s*no|yes\/no|có\s*tên/i
const NO_VALUE = /^(no|none|không|-)?$/i
const CODE_RE = /^([A-Z]{2}\d{8,12})/

export const designCodeOf = sku => (String(sku ?? '').trim().toUpperCase().match(CODE_RE) ?? [])[1] ?? null

/** The personalisation the shopper typed: no `_` keys, no Yes/No switches, no empty or "No" values. */
export function customValues(custom) {
  return (custom ?? [])
    .map(f => ({ name: String(f.name ?? f.key ?? ''), value: String(f.value ?? '').trim() }))
    .filter(f => f.name && !f.name.startsWith('_') && !SWITCH_KEY.test(f.name) && !NO_VALUE.test(f.value))
}

/** 'pers' (the _pers builder), 'cm1' (the _design cm1 builder) or null, from the raw line attributes. */
export function builderOf(attrs) {
  for (const f of attrs ?? []) {
    const key = String(f.key ?? f.name ?? '')
    if (key === '_pers') return 'pers'
    if (key === '_design') return /"v"\s*:\s*"cm1"/.test(String(f.value ?? '')) ? 'cm1' : 'design'
  }
  return null
}

/** The tumbler size (20 | 30 | 40) named in the SKU or the variant title ("OVERSEAS, 40OZ", "US / 40oz"). */
export function sizeOz(...texts) {
  for (const t of texts) {
    const m = String(t ?? '').match(/(20|30|40)\s*oz\b/i)
    if (m) return m[1]
  }
  return null
}

const slug = s => String(s ?? '').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Preview'

export function loadRegistry(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'mockups', 'auto-mockup.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export const hasLibrary = (root, code) => !!code && fs.existsSync(path.join(root, code, 'mockup', 'mockup.json'))

/** Runs python with the mockups folder as cwd; resolves { code, stdout, stderr } (never rejects on a non-zero exit). */
export function runPython(args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn('python', args, { cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }, windowsHide: true })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e?.message ?? String(e) })
      return
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, timeoutMs)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + (e?.message ?? String(e)) }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

async function imageSize(file) {
  try {
    const { default: sharp } = await import('sharp')
    const m = await sharp(file, { limitInputPixels: false }).metadata()
    return { widthPx: m.width ?? null, heightPx: m.height ?? null }
  } catch {
    return { widthPx: null, heightPx: null }
  }
}

const lastJson = text => {
  const lines = String(text ?? '').trim().split(/\r?\n/).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) } catch { /* not the json line */ }
  }
  return null
}

const tail = (s, n = 300) => String(s ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(-n)

/**
 * @param {{
 *   info: { taskKey: string, sku?: string|null, variantTitle?: string|null, custom?: {name: string, value: string}[], builder?: string|null,
 *           customerPreviewUrl?: string|null, prodMockup?: boolean, storeImage?: string|null },
 *   hasMockupFile: boolean, outDir: string, root?: string, run?: typeof runPython, size?: (file: string) => Promise<{widthPx: number|null, heightPx: number|null}>,
 *   log?: (m: string) => void,
 * }} opts
 * @returns {Promise<{ state: string, note: string, reason?: string, file?: { kind: 'MOCKUP', printArea: string, fileName: string, mimeType: string, path: string, widthPx: number|null, heightPx: number|null } }>}
 */
export async function resolveMockup({ info, hasMockupFile, outDir, root = DEFAULT_ARTWORK_BUILDER, run = runPython, size = imageSize, log = () => {} }) {
  const key = info.taskKey
  if (hasMockupFile) return { state: 'present', note: 'kèm trong lần đẩy' }
  if (info.prodMockup) return { state: 'prod', note: 'đã có trên prod' }
  if (info.customerPreviewUrl) return { state: 'preview', note: 'preview của khách (prod tự gắn khi gửi duyệt)' }

  const code = designCodeOf(info.sku)
  const values = customValues(info.custom)
  const names = values.map(v => v.value)
  const mockupsDir = path.join(root, 'mockups')
  const made = async (how, src, name, note) => {
    fs.mkdirSync(outDir, { recursive: true })
    const dst = path.join(outDir, `MOCKUP_${slug(key)}.jpg`)
    if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst)
    const dims = await size(dst)
    const label = name ? `Preview ${name}` : 'Preview no-name'
    return {
      state: how, note,
      file: { kind: 'MOCKUP', printArea: label, fileName: `${key}_${slug(label)}.jpg`, mimeType: 'image/jpeg', path: dst, ...dims },
    }
  }
  const missing = reason => {
    log(`${key}: ${MOCKUP_MISSING} — ${reason}`)
    return { state: 'missing', note: reason, reason }
  }

  const recipe = code ? loadRegistry(root)[code] : null
  if (recipe && typeof recipe === 'object' && recipe.tool === 'hapo') {
    const oz = sizeOz(info.sku, info.variantTitle)
    const name = (values.find(v => v.name === recipe.field) ?? values[0])?.value ?? ''
    if (!oz) return missing(`${code} dựng bằng hapo_render nhưng không đọc được cỡ (20/30/40oz) từ SKU "${info.sku ?? ''}" / "${info.variantTitle ?? ''}"`)
    if (!name) return missing(`${code} dựng bằng hapo_render nhưng dòng không có tên (custom: ${values.length ? values.map(v => `${v.name}=${v.value}`).join('; ') : 'trống'})`)
    fs.mkdirSync(outDir, { recursive: true })
    const out = path.join(outDir, `MOCKUP_${slug(key)}.jpg`)
    const r = await run([path.join(mockupsDir, 'hapo_render.py'), oz, name, out], { cwd: mockupsDir })
    if (r.code !== 0 || !fs.existsSync(out)) return missing(`hapo_render.py lỗi (exit ${r.code}): ${tail(r.stderr || r.stdout)}`)
    return made('hapo', out, name, `dựng lại preview builder (hapo_render ${oz}oz)`)
  }

  if (hasLibrary(root, code)) {
    fs.mkdirSync(outDir, { recursive: true })
    const out = path.join(outDir, `MOCKUP_${slug(key)}.jpg`)
    const args = [path.join(mockupsDir, 'lib_mock.py'), key, String(info.sku ?? ''), ...values.map(v => `${v.name}=${v.value}`), '--variant', String(info.variantTitle ?? ''), '--out', out]
    const r = await run(args, { cwd: mockupsDir })
    const j = lastJson(r.stdout)
    if (r.code === 0 && j?.ok && fs.existsSync(out)) return made('library', out, j.name || '', `thư viện mockup ${code} (${j.base ?? 'base'})`)
    return missing(`thư viện mockup ${code}: ${j?.error ?? tail(r.stderr || r.stdout) ?? `exit ${r.code}`}`)
  }

  if (info.builder) {
    return missing(`dòng qua builder (${info.builder}) nhưng ${code ?? 'design'} chưa có công thức dựng preview — thêm ${code ?? '<CODE>'}/mockup/mockup.json (lib_mock) hoặc mockups/auto-mockup.json`)
  }
  if (names.length) {
    return missing(`có custom (${values.map(v => `${v.name}=${v.value}`).join('; ')}) nhưng không có preview của khách và ${code ?? 'design'} chưa có thư viện mockup`)
  }
  if (info.storeImage && fs.existsSync(info.storeImage)) {
    return made('store', info.storeImage, '', 'không custom: ảnh biến thể trên store — kiểm tra đúng màu/biến thể')
  }
  return missing('không có custom và không tải được ảnh biến thể trên store')
}
