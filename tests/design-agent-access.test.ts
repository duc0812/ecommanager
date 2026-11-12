import { describe, it, expect } from 'vitest'
// @ts-expect-error Next ships its matcher compiler without types
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp'
import { canCallApi } from '@/lib/api-access'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/roles'
import { config as middlewareConfig } from '@/middleware'

describe('design agent access', () => {
  it('design-agent routes', () => {
    expect(canCallApi(null, [], '/api/design-agent/runner/claim', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['design_tasks'], '/api/design-agent/backfill', 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/design-agent/settings', 'PUT')).toBe('forbidden')
    expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/design-agent/settings/runner-token', 'POST')).toBe('forbidden')
    expect(canCallApi('SUPPORT', ['design_tasks'], '/api/design-agent/settings', 'GET')).toBe('ok')
    expect(canCallApi('SUPPORT', ['design_tasks'], '/api/design-agent/jobs/j1/library', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['cs'], '/api/design-agent/jobs/j1/library', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-agent/jobs/j1/library', 'POST')).toBe('ok')
    expect(canCallApi('SELLER', ['design_tasks'], '/api/design-agent/settings', 'GET')).toBe('forbidden')
    expect(canCallApi(null, [], '/api/design-agent/jobs/j1/library', 'POST')).toBe('unauthenticated')
  })

  it('the runner upload skips middleware, nothing else of the agent does', () => {
    const matcher = pathToRegexp(middlewareConfig.matcher[0])
    expect(matcher.test('/api/design-agent/runner/tasks/LIT6262_1/artwork')).toBe(false)
    expect(matcher.test('/api/design-agent/runner/tasks/LIT6262_1/submit')).toBe(true)
    expect(matcher.test('/api/design-agent/runner/claim')).toBe(true)
  })
})
