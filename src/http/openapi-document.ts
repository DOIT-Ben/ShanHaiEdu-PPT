import { loadOpenApiDocument } from './openapi-document-loader'
import { PRESENTATION_JOB_V2_OPENAPI_DOCUMENT_JSON } from './presentation-job-v2-openapi-document'

export const OPENAPI_DOCUMENT_JSON = loadOpenApiDocument('openapi-v1.json', 'PPT Agent API')
export const OPENAPI_V2_DOCUMENT_JSON = PRESENTATION_JOB_V2_OPENAPI_DOCUMENT_JSON
