import { posix as posixPath } from 'node:path'
import JSZip from 'jszip'
import { SaxesParser, type SaxesTagNS } from 'saxes'

const ROOT_RELATIONSHIPS_PART = '_rels/.rels'
const PRESENTATION_PART = 'ppt/presentation.xml'
const PRESENTATION_RELATIONSHIPS_PART = 'ppt/_rels/presentation.xml.rels'
const PRESENTATION_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
])
const OFFICE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
])
const PACKAGE_RELATIONSHIP_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/package/2006/relationships',
  'http://purl.oclc.org/ooxml/package/relationships',
])
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
])
const SLIDE_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/slide',
])

type PptxRelationship = Readonly<{
  id: string
  type: string
  target: string
  targetMode: string | null
}>

export async function assertReadablePptxArtifact(
  pptxBytes: Uint8Array,
  expectedSlideCount: number,
) {
  const archive = await JSZip.loadAsync(pptxBytes, { checkCRC32: true, createFolders: false })
  const requiredEntries = [
    '[Content_Types].xml',
    ROOT_RELATIONSHIPS_PART,
    PRESENTATION_PART,
    PRESENTATION_RELATIONSHIPS_PART,
  ]
  if (requiredEntries.some((entry) => !archive.file(entry))) throw new Error('FINAL_PPTX_STRUCTURE_INVALID')
  const xmlParts = await parsePptxXmlParts(archive)
  const rootRelationships = parsePptxRelationships(xmlParts.get(ROOT_RELATIONSHIPS_PART)!, ROOT_RELATIONSHIPS_PART)
  const officeDocumentRelationships = rootRelationships.filter((relationship) =>
    OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.type))
  if (officeDocumentRelationships.length !== 1) throw new Error('FINAL_PPTX_ROOT_RELATIONSHIP_INVALID')
  const officeDocumentRelationship = officeDocumentRelationships[0]!
  if (officeDocumentRelationship.targetMode?.toUpperCase() === 'EXTERNAL'
    || resolvePptxRelationshipTarget(null, officeDocumentRelationship.target) !== PRESENTATION_PART) {
    throw new Error('FINAL_PPTX_ROOT_RELATIONSHIP_INVALID')
  }
  const slideEntries = Object.keys(archive.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  const expectedEntries = Array.from(
    { length: expectedSlideCount },
    (_, index) => `ppt/slides/slide${index + 1}.xml`,
  )
  if (JSON.stringify(slideEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error('FINAL_PPTX_SLIDE_COUNT_INVALID')
  }
  const slideRelationshipIds = parsePresentationSlideRelationshipIds(xmlParts.get(PRESENTATION_PART)!)
  if (slideRelationshipIds.length !== expectedSlideCount) throw new Error('FINAL_PPTX_SLIDE_COUNT_INVALID')
  const relationships = parsePptxRelationships(
    xmlParts.get(PRESENTATION_RELATIONSHIPS_PART)!,
    PRESENTATION_RELATIONSHIPS_PART,
  )
  const relationshipsById = new Map(relationships.map((relationship) => [relationship.id, relationship]))
  if (relationshipsById.size !== relationships.length) throw new Error('FINAL_PPTX_RELATIONSHIP_INVALID')

  const referencedIds = new Set(slideRelationshipIds)
  const slideRelationships = relationships.filter((relationship) => SLIDE_RELATIONSHIP_TYPES.has(relationship.type))
  if (slideRelationships.length !== slideRelationshipIds.length
    || slideRelationships.some((relationship) => !referencedIds.has(relationship.id))) {
    throw new Error('FINAL_PPTX_RELATIONSHIP_INVALID')
  }
  const referencedSlideEntries = slideRelationshipIds.map((relationshipId) => {
    const relationship = relationshipsById.get(relationshipId)
    if (!relationship
      || !SLIDE_RELATIONSHIP_TYPES.has(relationship.type)
      || relationship.targetMode?.toUpperCase() === 'EXTERNAL') {
      throw new Error('FINAL_PPTX_RELATIONSHIP_INVALID')
    }
    const target = resolvePptxRelationshipTarget(PRESENTATION_PART, relationship.target)
    if (!archive.file(target)) throw new Error('FINAL_PPTX_RELATIONSHIP_TARGET_MISSING')
    return target
  })
  if (JSON.stringify(referencedSlideEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error('FINAL_PPTX_SLIDE_SET_INVALID')
  }
}

async function parsePptxXmlParts(archive: JSZip) {
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir && (entry.name.endsWith('.xml') || entry.name.endsWith('.rels')))
  const contents = await Promise.all(entries.map(async (entry) => [entry.name, await entry.async('string')] as const))
  for (const [name, xml] of contents) parseXmlPart(xml, name)
  return new Map(contents)
}

function parseXmlPart(
  xml: string,
  fileName: string,
  handlers: Readonly<{
    openTag?: (tag: SaxesTagNS) => void
    closeTag?: (tag: SaxesTagNS) => void
  }> = {},
) {
  if (xml.length === 0) throw new Error('FINAL_PPTX_XML_INVALID')
  const parser = new SaxesParser<{ xmlns: true; fileName: string }>({ xmlns: true, fileName })
  parser.on('doctype', () => {
    throw new Error('FINAL_PPTX_XML_DOCTYPE_INVALID')
  })
  if (handlers.openTag) parser.on('opentag', handlers.openTag)
  if (handlers.closeTag) parser.on('closetag', handlers.closeTag)
  parser.write(xml).close()
}

function parsePresentationSlideRelationshipIds(xml: string) {
  const relationshipIds: string[] = []
  let depth = 0
  let slideListDepth: number | null = null
  let sawPresentation = false
  let sawSlideList = false
  parseXmlPart(xml, PRESENTATION_PART, {
    openTag(tag) {
      depth += 1
      if (depth === 1) {
        if (tag.local !== 'presentation' || !PRESENTATION_NAMESPACES.has(tag.uri)) {
          throw new Error('FINAL_PPTX_PRESENTATION_INVALID')
        }
        sawPresentation = true
      } else if (depth === 2 && tag.local === 'sldIdLst' && PRESENTATION_NAMESPACES.has(tag.uri)) {
        if (sawSlideList) throw new Error('FINAL_PPTX_PRESENTATION_INVALID')
        sawSlideList = true
        slideListDepth = depth
      } else if (slideListDepth !== null
        && depth === slideListDepth + 1
        && tag.local === 'sldId'
        && PRESENTATION_NAMESPACES.has(tag.uri)) {
        const relationshipId = Object.values(tag.attributes)
          .find((attribute) => attribute.local === 'id'
            && OFFICE_RELATIONSHIP_NAMESPACES.has(attribute.uri))?.value
        if (!relationshipId) throw new Error('FINAL_PPTX_SLIDE_RELATIONSHIP_MISSING')
        relationshipIds.push(relationshipId)
      }
    },
    closeTag() {
      if (depth === slideListDepth) slideListDepth = null
      depth -= 1
    },
  })
  if (!sawPresentation || !sawSlideList || new Set(relationshipIds).size !== relationshipIds.length) {
    throw new Error('FINAL_PPTX_PRESENTATION_INVALID')
  }
  return relationshipIds
}

function parsePptxRelationships(xml: string, fileName: string) {
  const relationships: PptxRelationship[] = []
  let depth = 0
  let sawRelationships = false
  parseXmlPart(xml, fileName, {
    openTag(tag) {
      depth += 1
      if (depth === 1) {
        if (tag.local !== 'Relationships' || !PACKAGE_RELATIONSHIP_NAMESPACES.has(tag.uri)) {
          throw new Error('FINAL_PPTX_RELATIONSHIPS_INVALID')
        }
        sawRelationships = true
        return
      }
      if (depth !== 2 || tag.local !== 'Relationship' || !PACKAGE_RELATIONSHIP_NAMESPACES.has(tag.uri)) return
      const attributes = Object.values(tag.attributes)
      const value = (name: string) => attributes.find((attribute) => attribute.local === name && attribute.uri === '')?.value
      const id = value('Id')
      const type = value('Type')
      const target = value('Target')
      if (!id || !type || !target) throw new Error('FINAL_PPTX_RELATIONSHIP_INVALID')
      relationships.push({ id, type, target, targetMode: value('TargetMode') ?? null })
    },
    closeTag() {
      depth -= 1
    },
  })
  if (!sawRelationships) throw new Error('FINAL_PPTX_RELATIONSHIPS_INVALID')
  return relationships
}

function resolvePptxRelationshipTarget(sourcePart: string | null, rawTarget: string) {
  let target: string
  try {
    target = decodeURI(rawTarget)
  } catch {
    throw new Error('FINAL_PPTX_RELATIONSHIP_TARGET_INVALID')
  }
  if (!target || target.includes('\\') || target.includes('?') || target.includes('#')) {
    throw new Error('FINAL_PPTX_RELATIONSHIP_TARGET_INVALID')
  }
  const resolved = target.startsWith('/')
    ? posixPath.normalize(target.slice(1))
    : posixPath.normalize(sourcePart === null ? target : posixPath.join(posixPath.dirname(sourcePart), target))
  if (!resolved || resolved === '..' || resolved.startsWith('../') || posixPath.isAbsolute(resolved)) {
    throw new Error('FINAL_PPTX_RELATIONSHIP_TARGET_INVALID')
  }
  return resolved
}
