import { readFileSync } from 'node:fs'

function candidates(filename: string) {
  return [
    new URL(`../docs/${filename}`, import.meta.url),
    new URL(`../../docs/${filename}`, import.meta.url),
  ]
}

function loadOpenApiDocument(filename: string, title: string) {
  for (const candidate of candidates(filename)) {
    try {
      const source = readFileSync(candidate, 'utf8')
      const document = JSON.parse(source) as {
        openapi?: unknown
        info?: { title?: unknown; version?: unknown }
        paths?: unknown
      }
      if (document.openapi !== '3.1.0'
        || document.info?.title !== title
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

export const OPENAPI_DOCUMENT_JSON = loadOpenApiDocument('openapi-v1.json', 'PPT Agent API')
export const OPENAPI_V2_DOCUMENT_JSON = loadOpenApiDocument('openapi-v2.json', 'PPT Agent Presentation Job API')
