import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ArtifactPort } from '../core/ports'

type ArtifactMetadata = Readonly<{
  artifactId: string
  tenantHash: string
  runHash: string
  name: string
  mimeType: string
  sha256: string
  byteLength: number
}>

function digest(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}

export class LocalArtifactPort implements ArtifactPort {
  constructor(private readonly rootDirectory: string) {}

  async put(input: Parameters<ArtifactPort['put']>[0]) {
    const artifactId = `artifact-${digest(`${input.tenantId}\0${input.idempotencyKey}`).slice(0, 40)}`
    const sha256 = digest(input.bytes)
    const directory = path.join(this.rootDirectory, artifactId)
    const metadata: ArtifactMetadata = {
      artifactId,
      tenantHash: digest(input.tenantId),
      runHash: digest(input.runId),
      name: input.name,
      mimeType: input.mimeType,
      sha256,
      byteLength: input.bytes.length,
    }
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 })
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await this.readMetadata(directory)
      if (!existing || JSON.stringify(existing) !== JSON.stringify(metadata)) {
        throw new Error('ARTIFACT_IDEMPOTENCY_CONFLICT')
      }
      return { artifactId, sha256: existing.sha256 }
    }

    const suffix = `${process.pid}-${Date.now()}`
    const contentTemp = path.join(directory, `content-${suffix}.tmp`)
    const metadataTemp = path.join(directory, `metadata-${suffix}.tmp`)
    await writeFile(contentTemp, input.bytes, { mode: 0o600 })
    await writeFile(metadataTemp, JSON.stringify(metadata), { mode: 0o600 })
    await rename(contentTemp, path.join(directory, 'content.bin'))
    await rename(metadataTemp, path.join(directory, 'metadata.json'))
    return { artifactId, sha256 }
  }

  async get(input: Parameters<ArtifactPort['get']>[0]) {
    if (!/^artifact-[a-f0-9]{40}$/.test(input.artifactId)) return null
    const directory = path.join(this.rootDirectory, input.artifactId)
    const metadata = await this.readMetadata(directory)
    if (!metadata || metadata.tenantHash !== digest(input.tenantId)) return null
    try {
      const bytes = new Uint8Array(await readFile(path.join(directory, 'content.bin')))
      if (bytes.length !== metadata.byteLength || digest(bytes) !== metadata.sha256) {
        throw new Error('ARTIFACT_INTEGRITY_FAILED')
      }
      return { mimeType: metadata.mimeType, bytes, sha256: metadata.sha256 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async getByIdempotencyKey(input: Parameters<ArtifactPort['getByIdempotencyKey']>[0]) {
    const artifactId = `artifact-${digest(`${input.tenantId}\0${input.idempotencyKey}`).slice(0, 40)}`
    const artifact = await this.get({ tenantId: input.tenantId, artifactId })
    return artifact ? { artifactId, ...artifact } : null
  }

  verifyIntegrity(input: Parameters<ArtifactPort['verifyIntegrity']>[0]) {
    if (!/^artifact-[a-f0-9]{40}$/.test(input.artifactId)) return false
    const directory = path.join(this.rootDirectory, input.artifactId)
    try {
      const metadata = this.parseMetadata(JSON.parse(
        readFileSync(path.join(directory, 'metadata.json'), 'utf8'),
      ) as Partial<ArtifactMetadata>)
      if (!metadata || metadata.tenantHash !== digest(input.tenantId)
        || metadata.mimeType !== input.mimeType
        || metadata.byteLength !== input.byteLength
        || metadata.sha256 !== input.sha256) return false
      const bytes = new Uint8Array(readFileSync(path.join(directory, 'content.bin')))
      return bytes.length === input.byteLength && digest(bytes) === input.sha256
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async readMetadata(directory: string) {
    try {
      return this.parseMetadata(
        JSON.parse(await readFile(path.join(directory, 'metadata.json'), 'utf8')) as Partial<ArtifactMetadata>,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private parseMetadata(raw: Partial<ArtifactMetadata>) {
    if (
      typeof raw.artifactId !== 'string' || typeof raw.tenantHash !== 'string' || typeof raw.runHash !== 'string'
      || typeof raw.name !== 'string' || typeof raw.mimeType !== 'string' || typeof raw.sha256 !== 'string'
      || typeof raw.byteLength !== 'number'
    ) return null
    return raw as ArtifactMetadata
  }
}
