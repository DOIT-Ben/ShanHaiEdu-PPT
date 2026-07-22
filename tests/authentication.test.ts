import { describe, expect, test } from 'bun:test'
import { ServiceTokenAuthentication } from '../src/runtime/mock-runtime'

function request(input: Readonly<{
  token: string
  tenantId: string
  role?: 'USER' | 'ADMIN'
}>) {
  const headers = new Headers({
    Authorization: `Bearer ${input.token}`,
    'X-PPT-Agent-Tenant': input.tenantId,
    'X-PPT-Agent-User': 'teacher-1',
  })
  if (input.role) headers.set('X-PPT-Agent-Role', input.role)
  return new Request('http://127.0.0.1:4310/v1/runs', { headers })
}

describe('service token authentication', () => {
  const frameflowUser = 'frameflow-user-token-0001'
  const frameflowAdmin = 'frameflow-admin-token-0001'
  const shanhaiUser = 'shanhai-user-token-000001'
  const authentication = new ServiceTokenAuthentication([
    { tenantId: 'frameflow', userToken: frameflowUser, adminToken: frameflowAdmin },
    { tenantId: 'shanhaiedu', userToken: shanhaiUser },
  ])

  test('binds a user token to its configured tenant', async () => {
    expect(await authentication.authenticate(request({ token: frameflowUser, tenantId: 'frameflow' })))
      .toEqual({ tenantId: 'frameflow', externalUserId: 'teacher-1', role: 'USER' })
    expect(await authentication.authenticate(request({ token: frameflowUser, tenantId: 'shanhaiedu' })))
      .toBeNull()
    expect(await authentication.authenticate(request({ token: shanhaiUser, tenantId: 'shanhaiedu' })))
      .toEqual({ tenantId: 'shanhaiedu', externalUserId: 'teacher-1', role: 'USER' })
  })

  test('rejects role escalation with a user token', async () => {
    expect(await authentication.authenticate(request({
      token: frameflowUser,
      tenantId: 'frameflow',
      role: 'ADMIN',
    }))).toBeNull()
  })

  test('derives administrator role from the administrator token', async () => {
    expect(await authentication.authenticate(request({ token: frameflowAdmin, tenantId: 'frameflow' })))
      .toEqual({ tenantId: 'frameflow', externalUserId: 'teacher-1', role: 'ADMIN' })
  })
})
