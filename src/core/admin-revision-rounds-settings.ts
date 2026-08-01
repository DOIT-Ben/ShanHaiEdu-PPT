import type { HostContext } from '../contracts'
import type { AgentRepository, ClockPort, TenantRevisionRoundsSettings } from './ports'

export class AdminRevisionRoundsSettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'AdminRevisionRoundsSettingsError'
  }
}

export interface AdminRevisionRoundsSettingsPort {
  get(host: HostContext): Promise<TenantRevisionRoundsSettings>
  update(input: Readonly<{
    host: HostContext
    maxRevisionRounds: number
    expectedVersion: number
  }>): Promise<TenantRevisionRoundsSettings>
}

export class AdminRevisionRoundsSettingsService implements AdminRevisionRoundsSettingsPort {
  constructor(private readonly dependencies: Readonly<{ repository: AgentRepository; clock: ClockPort }>) {}

  async get(host: HostContext) {
    this.requireAdmin(host)
    return this.dependencies.repository.getTenantRevisionRoundsSettings(host.tenantId)
  }

  async update(input: Readonly<{
    host: HostContext
    maxRevisionRounds: number
    expectedVersion: number
  }>) {
    this.requireAdmin(input.host)
    const settings = await this.dependencies.repository.updateTenantRevisionRoundsSettings({
      tenantId: input.host.tenantId,
      maxRevisionRounds: input.maxRevisionRounds,
      expectedVersion: input.expectedVersion,
      updatedBy: input.host.externalUserId,
      updatedAt: this.dependencies.clock.now().toISOString(),
    })
    if (!settings) {
      throw new AdminRevisionRoundsSettingsError(409, 'SETTINGS_VERSION_CONFLICT', 'revision-round settings version does not match')
    }
    return settings
  }

  private requireAdmin(host: HostContext) {
    if ((host.role ?? 'USER') !== 'ADMIN') {
      throw new AdminRevisionRoundsSettingsError(403, 'ADMIN_REQUIRED', 'administrator role is required')
    }
  }
}
