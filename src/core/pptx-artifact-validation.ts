import { posix as posixPath } from 'node:path'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'
import JSZip from 'jszip'
import { SaxesParser, type SaxesTagNS } from 'saxes'

const ROOT_RELATIONSHIPS_PART = '_rels/.rels'
const CONTENT_TYPES_PART = '[Content_Types].xml'
const PRESENTATION_PART = 'ppt/presentation.xml'
const PRESENTATION_RELATIONSHIPS_PART = 'ppt/_rels/presentation.xml.rels'
const MAX_PPTX_ENTRY_COUNT = 2_048
const MAX_PPTX_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024
const MAX_PPTX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
const MAX_PPTX_XML_PART_BYTES = 4 * 1024 * 1024
const MAX_PPTX_TOTAL_XML_BYTES = 16 * 1024 * 1024
const MAX_PPTX_COMPRESSION_RATIO = 200
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE = 0x07064b50
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const ZIP64_EXTRA_FIELD_ID = 0x0001
const ZIP_UTF8_FLAG = 0x0800
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008
const ZIP_ENCRYPTION_FLAGS = 0x2041
const PACKAGE_CONTENT_TYPES_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/package/2006/content-types',
  'http://purl.oclc.org/ooxml/package/content-types',
])
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
const PRESENTATION_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'

type PptxRelationship = Readonly<{
  id: string
  type: string
  target: string
  targetMode: string | null
}>

type RawZipEntry = Readonly<{
  name: string
  directory: boolean
  flags: number
  compressionMethod: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  dataOffset: number
}>

type PptxArchiveReadState = {
  totalUncompressedBytes: number
  totalXmlBytes: number
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

export async function assertReadablePptxArtifact(
  pptxBytes: Uint8Array,
  expectedSlideCount: number,
) {
  const rawEntries = parseRawZipEntries(pptxBytes)
  let archive: JSZip
  try {
    archive = await JSZip.loadAsync(pptxBytes, { checkCRC32: false, createFolders: false })
  } catch {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
  const xmlParts = await readAndValidatePptxEntries(pptxBytes, archive, rawEntries)
  const requiredEntries = [
    CONTENT_TYPES_PART,
    ROOT_RELATIONSHIPS_PART,
    PRESENTATION_PART,
    PRESENTATION_RELATIONSHIPS_PART,
  ]
  if (requiredEntries.some((entry) => !archive.file(entry))) throw new Error('FINAL_PPTX_STRUCTURE_INVALID')
  const contentTypes = parsePptxContentTypes(xmlParts.get(CONTENT_TYPES_PART)!)
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
  if (contentTypes.get(PRESENTATION_PART) !== PRESENTATION_CONTENT_TYPE
    || expectedEntries.some((entry) => contentTypes.get(entry) !== SLIDE_CONTENT_TYPE)) {
    throw new Error('FINAL_PPTX_CONTENT_TYPES_INVALID')
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
  for (const entry of referencedSlideEntries) assertPresentationSlide(xmlParts.get(entry)!, entry)
}

async function readAndValidatePptxEntries(
  pptxBytes: Uint8Array,
  archive: JSZip,
  rawEntries: readonly RawZipEntry[],
) {
  if (Object.keys(archive.files).length !== rawEntries.length) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  const contents = new Map<string, string>()
  const state: PptxArchiveReadState = { totalUncompressedBytes: 0, totalXmlBytes: 0 }
  for (const rawEntry of rawEntries) {
    const entry = archive.files[rawEntry.name]
    if (!entry || entry.dir !== rawEntry.directory) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
    if (rawEntry.directory) continue
    const xml = await readAndValidatePptxEntry(pptxBytes, rawEntry, state)
    if (xml === null) continue
    parseXmlPart(xml, rawEntry.name)
    contents.set(rawEntry.name, xml)
  }
  return contents
}

function readAndValidatePptxEntry(
  pptxBytes: Uint8Array,
  rawEntry: RawZipEntry,
  state: PptxArchiveReadState,
) {
  const xmlPart = isPptxXmlPart(rawEntry.name)
  const xmlChunks: Buffer[] = []
  const { stream, destroy } = createZipEntryStream(pptxBytes, rawEntry)
  return consumePptxEntryStream(stream, destroy, rawEntry, state, xmlPart, xmlChunks)
}

async function consumePptxEntryStream(
  stream: Readable,
  destroy: () => void,
  rawEntry: RawZipEntry,
  state: PptxArchiveReadState,
  xmlPart: boolean,
  xmlChunks: Buffer[],
) {
  let entryUncompressedBytes = 0
  let crc32 = 0xffffffff
  try {
    for await (const value of stream) {
      if (!(value instanceof Uint8Array)) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
      entryUncompressedBytes += value.byteLength
      state.totalUncompressedBytes += value.byteLength
      if (entryUncompressedBytes > MAX_PPTX_ENTRY_UNCOMPRESSED_BYTES
        || state.totalUncompressedBytes > MAX_PPTX_TOTAL_UNCOMPRESSED_BYTES
        || (entryUncompressedBytes > 0 && rawEntry.compressedSize === 0)
        || (rawEntry.compressedSize > 0
          && entryUncompressedBytes > rawEntry.compressedSize * MAX_PPTX_COMPRESSION_RATIO)) {
        destroy()
        throw new Error('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
      }
      if (xmlPart) {
        state.totalXmlBytes += value.byteLength
        if (entryUncompressedBytes > MAX_PPTX_XML_PART_BYTES
          || state.totalXmlBytes > MAX_PPTX_TOTAL_XML_BYTES) {
          destroy()
          throw new Error('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
        }
        xmlChunks.push(Buffer.from(value))
      }
      crc32 = updateCrc32(crc32, value)
    }
  } catch (error) {
    destroy()
    throw normalizePptxArchiveReadError(error)
  }
  if (entryUncompressedBytes !== rawEntry.uncompressedSize) {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
  if (((crc32 ^ 0xffffffff) >>> 0) !== rawEntry.crc32) {
    throw new Error('FINAL_PPTX_ARCHIVE_CRC_INVALID')
  }
  if (!xmlPart) return null
  try {
    return new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(xmlChunks, entryUncompressedBytes))
  } catch {
    throw new Error('FINAL_PPTX_XML_INVALID')
  }
}

function createZipEntryStream(pptxBytes: Uint8Array, entry: RawZipEntry) {
  const source = Readable.from(zipCompressedChunks(pptxBytes, entry))
  if (entry.compressionMethod === 0) {
    return { stream: source, destroy: () => source.destroy() }
  }
  const inflater = createInflateRaw()
  source.pipe(inflater)
  return {
    stream: inflater,
    destroy: () => {
      source.destroy()
      inflater.destroy()
    },
  }
}

function* zipCompressedChunks(pptxBytes: Uint8Array, entry: RawZipEntry) {
  const end = entry.dataOffset + entry.compressedSize
  for (let offset = entry.dataOffset; offset < end; offset += 64 * 1024) {
    const length = Math.min(64 * 1024, end - offset)
    yield Buffer.from(pptxBytes.buffer, pptxBytes.byteOffset + offset, length)
  }
}

function updateCrc32(crc32: number, bytes: Uint8Array) {
  for (const byte of bytes) crc32 = CRC32_TABLE[(crc32 ^ byte) & 0xff]! ^ (crc32 >>> 8)
  return crc32 >>> 0
}

function normalizePptxArchiveReadError(error: unknown) {
  if (error instanceof Error && error.message.startsWith('FINAL_PPTX_')) return error
  return new Error('FINAL_PPTX_ARCHIVE_INVALID')
}

function parseRawZipEntries(bytes: Uint8Array) {
  try {
    return parseRawZipEntriesUnchecked(bytes)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('FINAL_PPTX_')) throw error
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
}

function parseRawZipEntriesUnchecked(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const endOffset = findZipEndOfCentralDirectory(view, bytes.byteLength)
  if (endOffset >= 20
    && view.getUint32(endOffset - 20, true) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR_SIGNATURE) {
    throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
  }
  const diskNumber = view.getUint16(endOffset + 4, true)
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true)
  const entriesOnDisk = view.getUint16(endOffset + 8, true)
  const entryCount = view.getUint16(endOffset + 10, true)
  const centralDirectorySize = view.getUint32(endOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true)
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
  }
  if (entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff) {
    throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
  }
  if (entryCount > MAX_PPTX_ENTRY_COUNT) throw new Error('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  if (centralDirectoryOffset > bytes.byteLength
    || centralDirectoryEnd !== endOffset
    || centralDirectoryEnd > bytes.byteLength) {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }

  const entries: RawZipEntry[] = []
  const normalizedNames = new Set<string>()
  let hasNonCanonicalName = false
  let offset = centralDirectoryOffset
  let totalUncompressedBytes = 0
  let totalXmlBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryEnd
      || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
    }
    const flags = view.getUint16(offset + 8, true)
    const compressionMethod = view.getUint16(offset + 10, true)
    const crc32 = view.getUint32(offset + 16, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const diskStart = view.getUint16(offset + 34, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength
    if (entryEnd > centralDirectoryEnd) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
    if (diskStart !== 0) throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
    if (compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localHeaderOffset === 0xffffffff) {
      throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
    }
    if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0) throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
    }
    assertNoZip64ExtraField(view, offset + 46 + nameLength, extraLength)
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const rawName = decodeZipEntryName(nameBytes, flags)
    const name = normalizeZipEntryName(rawName)
    if (normalizedNames.has(name)) throw new Error('FINAL_PPTX_ARCHIVE_DUPLICATE_ENTRY')
    normalizedNames.add(name)
    if (name !== rawName) hasNonCanonicalName = true
    const directory = name.endsWith('/')
    if (directory && (crc32 !== 0 || compressedSize !== 0 || uncompressedSize !== 0)) {
      throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
    }
    totalUncompressedBytes += uncompressedSize
    if (!directory && (uncompressedSize > MAX_PPTX_ENTRY_UNCOMPRESSED_BYTES
      || totalUncompressedBytes > MAX_PPTX_TOTAL_UNCOMPRESSED_BYTES
      || (uncompressedSize > 0 && compressedSize === 0)
      || (compressedSize > 0 && uncompressedSize / compressedSize > MAX_PPTX_COMPRESSION_RATIO))) {
      throw new Error('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
    }
    if (!directory && isPptxXmlPart(name)) {
      totalXmlBytes += uncompressedSize
      if (uncompressedSize > MAX_PPTX_XML_PART_BYTES || totalXmlBytes > MAX_PPTX_TOTAL_XML_BYTES) {
        throw new Error('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
      }
    }
    const dataOffset = validateZipLocalHeader({
      bytes,
      view,
      centralDirectoryOffset,
      nameBytes,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    entries.push({
      name,
      directory,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset,
    })
    offset = entryEnd
  }
  if (offset !== centralDirectoryEnd || hasNonCanonicalName) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  const spans = entries
    .map((entry) => ({ start: entry.localHeaderOffset, end: entry.dataOffset + entry.compressedSize }))
    .sort((left, right) => left.start - right.start)
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index]!.start < spans[index - 1]!.end) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
  return entries
}

function findZipEndOfCentralDirectory(view: DataView, byteLength: number) {
  if (byteLength < 22) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  const minimumOffset = Math.max(0, byteLength - 65_557)
  for (let offset = byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE
      && offset + 22 + view.getUint16(offset + 20, true) === byteLength) return offset
  }
  throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
}

function assertNoZip64ExtraField(view: DataView, offset: number, length: number) {
  const end = offset + length
  while (offset < end) {
    if (offset + 4 > end) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
    const fieldId = view.getUint16(offset, true)
    const fieldLength = view.getUint16(offset + 2, true)
    offset += 4
    if (offset + fieldLength > end) throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
    if (fieldId === ZIP64_EXTRA_FIELD_ID) throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
    offset += fieldLength
  }
}

function decodeZipEntryName(bytes: Uint8Array, flags: number) {
  if ((flags & ZIP_UTF8_FLAG) === 0 && bytes.some((byte) => byte > 0x7f)) {
    throw new Error('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
}

function normalizeZipEntryName(rawName: string) {
  if (!rawName || rawName.includes('\0') || rawName.includes('\\') || rawName.startsWith('/')) {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
  const directory = rawName.endsWith('/')
  const value = directory ? rawName.slice(0, -1) : rawName
  const normalized = posixPath.normalize(value)
  if (!normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || posixPath.isAbsolute(normalized)) {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
  return directory ? `${normalized}/` : normalized
}

function validateZipLocalHeader(input: Readonly<{
  bytes: Uint8Array
  view: DataView
  centralDirectoryOffset: number
  nameBytes: Uint8Array
  flags: number
  compressionMethod: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}>) {
  const { view, localHeaderOffset } = input
  if (localHeaderOffset + 30 > input.centralDirectoryOffset
    || view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
  const localFlags = view.getUint16(localHeaderOffset + 6, true)
  const localCompressionMethod = view.getUint16(localHeaderOffset + 8, true)
  const localNameLength = view.getUint16(localHeaderOffset + 26, true)
  const localExtraLength = view.getUint16(localHeaderOffset + 28, true)
  const localNameOffset = localHeaderOffset + 30
  const localExtraOffset = localNameOffset + localNameLength
  const dataOffset = localExtraOffset + localExtraLength
  if (localFlags !== input.flags
    || localCompressionMethod !== input.compressionMethod
    || localNameLength !== input.nameBytes.byteLength
    || dataOffset + input.compressedSize > input.centralDirectoryOffset
    || !equalBytes(input.bytes.subarray(localNameOffset, localExtraOffset), input.nameBytes)) {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
  assertNoZip64ExtraField(view, localExtraOffset, localExtraLength)
  if ((input.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0
    && (view.getUint32(localHeaderOffset + 14, true) !== input.crc32
      || view.getUint32(localHeaderOffset + 18, true) !== input.compressedSize
      || view.getUint32(localHeaderOffset + 22, true) !== input.uncompressedSize)) {
    throw new Error('FINAL_PPTX_ARCHIVE_INVALID')
  }
  return dataOffset
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function isPptxXmlPart(name: string) {
  return name.endsWith('.xml') || name.endsWith('.rels')
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

function parsePptxContentTypes(xml: string) {
  const overrides = new Map<string, string>()
  let depth = 0
  let sawTypes = false
  parseXmlPart(xml, CONTENT_TYPES_PART, {
    openTag(tag) {
      depth += 1
      if (depth === 1) {
        if (tag.local !== 'Types' || !PACKAGE_CONTENT_TYPES_NAMESPACES.has(tag.uri)) {
          throw new Error('FINAL_PPTX_CONTENT_TYPES_INVALID')
        }
        sawTypes = true
        return
      }
      if (depth !== 2 || tag.local !== 'Override' || !PACKAGE_CONTENT_TYPES_NAMESPACES.has(tag.uri)) return
      const attributes = Object.values(tag.attributes)
      const value = (name: string) => attributes
        .find((attribute) => attribute.local === name && attribute.uri === '')?.value
      const rawPartName = value('PartName')
      const contentType = value('ContentType')
      if (!rawPartName || !contentType) throw new Error('FINAL_PPTX_CONTENT_TYPES_INVALID')
      const partName = normalizePptxPartName(rawPartName)
      if (overrides.has(partName)) throw new Error('FINAL_PPTX_CONTENT_TYPES_INVALID')
      overrides.set(partName, contentType)
    },
    closeTag() {
      depth -= 1
    },
  })
  if (!sawTypes) throw new Error('FINAL_PPTX_CONTENT_TYPES_INVALID')
  return overrides
}

function normalizePptxPartName(rawPartName: string) {
  let decoded: string
  try {
    decoded = decodeURI(rawPartName)
  } catch {
    throw new Error('FINAL_PPTX_CONTENT_TYPES_INVALID')
  }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('?') || decoded.includes('#')) {
    throw new Error('FINAL_PPTX_CONTENT_TYPES_INVALID')
  }
  const normalized = posixPath.normalize(decoded.slice(1))
  if (!normalized || normalized === '..' || normalized.startsWith('../') || `/${normalized}` !== decoded) {
    throw new Error('FINAL_PPTX_CONTENT_TYPES_INVALID')
  }
  return normalized
}

function assertPresentationSlide(xml: string, fileName: string) {
  let depth = 0
  let sawSlide = false
  parseXmlPart(xml, fileName, {
    openTag(tag) {
      depth += 1
      if (depth !== 1) return
      if (tag.local !== 'sld' || !PRESENTATION_NAMESPACES.has(tag.uri)) {
        throw new Error('FINAL_PPTX_SLIDE_INVALID')
      }
      sawSlide = true
    },
    closeTag() {
      depth -= 1
    },
  })
  if (!sawSlide) throw new Error('FINAL_PPTX_SLIDE_INVALID')
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
