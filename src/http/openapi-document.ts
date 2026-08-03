import { readFileSync } from 'node:fs'

const candidates = [
  new URL('../docs/openapi-v1.json', import.meta.url),
  new URL('../../docs/openapi-v1.json', import.meta.url),
]

function loadOpenApiDocument() {
  for (const candidate of candidates) {
    try {
      const source = readFileSync(candidate, 'utf8')
      const document = JSON.parse(source) as {
        openapi?: unknown
        info?: { title?: unknown; version?: unknown }
        paths?: unknown
      }
      if (document.openapi !== '3.1.0'
        || document.info?.title !== 'PPT Agent API'
        || typeof document.info.version !== 'string'
        || !document.paths
        || typeof document.paths !== 'object') {
        throw new Error('OPENAPI_DOCUMENT_INVALID')
      }
      return source
    } catch (error) {
      if (error instanceof Error && error.message === 'OPENAPI_DOCUMENT_INVALID') throw error
    }
  }
  throw new Error('OPENAPI_DOCUMENT_UNAVAILABLE')
}

export const OPENAPI_DOCUMENT_JSON = loadOpenApiDocument()
