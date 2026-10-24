export type ModelOption = { name: string; values: string[]; default?: string; required: boolean }
export type ModelForm = { promptField: string | null; imageField: string | null; imageIsArray: boolean; options: ModelOption[] }

function resolveRef(ref: string, root: any): any {
  if (!root || !ref.startsWith('#/')) return null
  let cur = root
  for (const seg of ref.slice(2).split('/')) {
    const key = decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~')
    if (cur == null || typeof cur !== 'object' || !(key in cur)) return null
    cur = cur[key]
  }
  return cur
}

export function deref(node: any, root: any, depth = 0): any {
  if (!node || typeof node !== 'object' || depth > 10) return node
  if (typeof node.$ref === 'string') {
    const target = resolveRef(node.$ref, root)
    const { $ref, ...rest } = node
    return { ...deref(target, root, depth + 1), ...rest }
  }
  if (Array.isArray(node.allOf)) {
    const { allOf, ...rest } = node
    const merged = allOf.reduce((acc: any, part: any) => ({ ...acc, ...deref(part, root, depth + 1) }), {})
    return { ...merged, ...rest }
  }
  return node
}

function isStringEnum(prop: any): prop is { enum: string[] } {
  return Array.isArray(prop?.enum) && prop.enum.length > 0 && prop.enum.every((v: unknown) => typeof v === 'string')
}

function isImageName(name: string) {
  const n = name.toLowerCase()
  return n.includes('image') || n.includes('input_url')
}

export function formFromInputSchema(input: any, root?: any): ModelForm {
  const schema = deref(input, root)
  const props: Record<string, any> = schema?.properties ?? {}
  const required: string[] = Array.isArray(schema?.required) ? schema.required : []
  const entries = Object.entries(props).map(([name, p]) => [name, deref(p, root)] as [string, any])

  let promptField: string | null = null
  if (props.prompt) promptField = 'prompt'
  else promptField = entries.find(([name, p]) => required.includes(name) && p?.type === 'string' && !isStringEnum(p))?.[0] ?? null

  let imageField: string | null = null
  let imageIsArray = false
  for (const [name, p] of entries) {
    if (!isImageName(name) || name === promptField) continue
    if (p?.type === 'array' && deref(p.items, root)?.type === 'string') { imageField = name; imageIsArray = true; break }
    if (p?.type === 'string' && !isStringEnum(p)) { imageField = name; imageIsArray = false; break }
  }

  const options: ModelOption[] = entries
    .filter(([name, p]) => name !== promptField && name !== imageField && isStringEnum(p))
    .map(([name, p]) => ({ name, values: p.enum, default: typeof p.default === 'string' ? p.default : undefined, required: required.includes(name) }))

  return { promptField, imageField, imageIsArray, options }
}

export function buildInput(form: ModelForm, p: { prompt: string; imageUrls: string[]; options: Record<string, string> }): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  if (form.promptField) input[form.promptField] = p.prompt
  if (p.imageUrls.length) {
    if (!form.imageField) throw new Error('NO_IMAGE_FIELD')
    input[form.imageField] = form.imageIsArray ? p.imageUrls : p.imageUrls[0]
  }
  for (const opt of form.options) {
    const chosen = p.options[opt.name]
    if (chosen !== undefined && opt.values.includes(chosen)) input[opt.name] = chosen
    else if (opt.required) input[opt.name] = opt.default ?? opt.values[0]
  }
  return input
}
