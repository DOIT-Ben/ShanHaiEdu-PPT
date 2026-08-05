import { timingSafeEqual } from 'node:crypto'
import type { HostContext } from '../contracts'
import type { HostAuthenticationPort } from './handler'

export type ServiceCredential = Readonly<{
  tenantId: string
  userToken: string
  adminToken?: string
  v2Token?: string
}>

export type AuthenticatedService = Readonly<{
  tenantId: string
  role: 'USER' | 'ADMIN'
}>

function validIdentifier(value: string) {
  return value.length >= 1 && value.length <= 160 && value === value.trim()
}

function validToken(value: string) {
  return value.length >= 16 && value.length <= 512 && value === value.trim()
}

function matchesToken(provided: string, expected: string) {
  const providedBytes = Buffer.from(provided)
  const expectedBytes = Buffer.from(expected)
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
}

export class ServiceTokenAuthentication implements HostAuthenticationPort {
  private readonly credentials: readonly ServiceCredential[]

  constructor(credentials: readonly ServiceCredential[]) {
    if (credentials.length < 1 || credentials.length > 16) throw new Error('PPT_AGENT_CREDENTIALS_INVALID')
    const tenants = new Set<string>()
    const tokens = new Set<string>()
    for (const credential of credentials) {
      if (!validIdentifier(credential.tenantId) || tenants.has(credential.tenantId)) {
        throw new Error('PPT_AGENT_CREDENTIAL_TENANT_INVALID')
      }
      if (!validToken(credential.userToken) || tokens.has(credential.userToken)) {
        throw new Error('PPT_AGENT_CREDENTIAL_TOKEN_INVALID')
      }
      tenants.add(credential.tenantId)
      tokens.add(credential.userToken)
      if (credential.adminToken) {
        if (!validToken(credential.adminToken) || tokens.has(credential.adminToken)) {
          throw new Error('PPT_AGENT_CREDENTIAL_ADMIN_TOKEN_INVALID')
        }
        tokens.add(credential.adminToken)
      }
      if (credential.v2Token) {
        if (!validToken(credential.v2Token) || tokens.has(credential.v2Token)) {
          throw new Error('PPT_AGENT_CREDENTIAL_V2_TOKEN_INVALID')
        }
        tokens.add(credential.v2Token)
      }
    }
    this.credentials = credentials.map((credential) => ({ ...credential }))
  }

  async authenticate(request: Request): Promise<HostContext | null> {
    const authorization = request.headers.get('Authorization')
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    const tenantId = request.headers.get('X-PPT-Agent-Tenant')
    const externalUserId = request.headers.get('X-PPT-Agent-User')
    const externalProjectId = request.headers.get('X-PPT-Agent-Project')
    const requestedRole = request.headers.get('X-PPT-Agent-Role') ?? 'USER'
    if (!provided || !tenantId || !externalUserId || !validIdentifier(tenantId) || !validIdentifier(externalUserId)) return null
    if (externalProjectId !== null && !validIdentifier(externalProjectId)) return null
    if (requestedRole !== 'USER' && requestedRole !== 'ADMIN') return null

    const credential = this.credentials.find((candidate) => candidate.tenantId === tenantId)
    if (!credential) return null
    const administrator = credential.adminToken ? matchesToken(provided, credential.adminToken) : false
    const user = matchesToken(provided, credential.userToken)
    if (!administrator && !user) return null
    if (requestedRole === 'ADMIN' && !administrator) return null
    return {
      tenantId,
      externalUserId,
      role: administrator ? 'ADMIN' : 'USER',
      ...(externalProjectId ? { externalProjectId } : {}),
    }
  }

  async authenticateService(request: Request): Promise<AuthenticatedService | null> {
    const authorization = request.headers.get('Authorization')
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!provided) return null
    for (const credential of this.credentials) {
      if (credential.v2Token) {
        if (matchesToken(provided, credential.v2Token)) {
          return { tenantId: credential.tenantId, role: 'USER' }
        }
        continue
      }
      const administrator = credential.adminToken ? matchesToken(provided, credential.adminToken) : false
      const user = matchesToken(provided, credential.userToken)
      if (administrator || user) return { tenantId: credential.tenantId, role: administrator ? 'ADMIN' : 'USER' }
    }
    return null
  }
}

export class SharedTokenAuthentication extends ServiceTokenAuthentication {
  constructor(token: string) {
    super([{ tenantId: 'frameflow', userToken: token }])
  }
}
