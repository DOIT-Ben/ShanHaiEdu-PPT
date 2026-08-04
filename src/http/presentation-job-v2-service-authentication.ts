import { timingSafeEqual } from 'node:crypto'
import type { PresentationJobV2AuthenticationPort } from './presentation-job-v2-handler'

export type PresentationJobV2ServiceCredential = Readonly<{
  tenantId: string
  token: string
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

export class PresentationJobV2ServiceTokenAuthentication implements PresentationJobV2AuthenticationPort {
  private readonly credentials: readonly PresentationJobV2ServiceCredential[]

  constructor(credentials: readonly PresentationJobV2ServiceCredential[]) {
    if (credentials.length < 1 || credentials.length > 16) {
      throw new Error('PRESENTATION_JOB_V2_CREDENTIALS_INVALID')
    }
    const tenants = new Set<string>()
    const tokens = new Set<string>()
    for (const credential of credentials) {
      if (!validIdentifier(credential.tenantId) || tenants.has(credential.tenantId)) {
        throw new Error('PRESENTATION_JOB_V2_CREDENTIAL_TENANT_INVALID')
      }
      if (!validToken(credential.token) || tokens.has(credential.token)) {
        throw new Error('PRESENTATION_JOB_V2_CREDENTIAL_TOKEN_INVALID')
      }
      tenants.add(credential.tenantId)
      tokens.add(credential.token)
    }
    this.credentials = credentials.map((credential) => ({ ...credential }))
  }

  async authenticateService(request: Request) {
    const authorization = request.headers.get('Authorization')
    const provided = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!provided) return null
    const credential = this.credentials.find((candidate) => matchesToken(provided, candidate.token))
    return credential ? { tenantId: credential.tenantId } : null
  }
}
