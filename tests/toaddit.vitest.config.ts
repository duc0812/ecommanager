import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'

// The Windows Node 24/Vitest resolver otherwise resolves the existing bare stream import as a local file.
export default mergeConfig(base, { resolve: { alias: { stream: 'node:stream' } } })
