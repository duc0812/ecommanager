// Runs a TypeScript one-off from scripts/merchize with the app's "@/..." imports resolved.
const path = require('path')
const jiti = require('jiti')(__filename, { alias: { '@': path.resolve(__dirname, '../../src') }, interopDefault: true })
const [name, ...args] = process.argv.slice(2)
jiti(path.resolve(__dirname, `${name}.ts`)).main(args).then(() => process.exit(0), e => { console.error(e?.message ?? e); process.exit(1) })
