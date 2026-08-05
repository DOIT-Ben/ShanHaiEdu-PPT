import { beforeAll, describe, expect, test } from 'bun:test'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { assertReadablePptxArtifact } from '../src/core/pptx-artifact-validation'

const MEBIBYTE = 1024 * 1024
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50

let validPptxBytes: Uint8Array

type CentralDirectoryEntry = Readonly<{
  offset: number
  name: string
  localHeaderOffset: number
}>

function zipView(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  const view = zipView(bytes)
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE
      && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) return offset
  }
  throw new Error('TEST_ZIP_EOCD_NOT_FOUND')
}

function centralDirectoryEntries(bytes: Uint8Array) {
  const view = zipView(bytes)
  const endOffset = findEndOfCentralDirectory(bytes)
  const entryCount = view.getUint16(endOffset + 10, true)
  let offset = view.getUint32(endOffset + 16, true)
  const entries: CentralDirectoryEntry[] = []
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('TEST_ZIP_CENTRAL_DIRECTORY_INVALID')
    }
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const length = 46 + nameLength + extraLength + commentLength
    entries.push({
      offset,
      name: new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      localHeaderOffset: view.getUint32(offset + 42, true),
    })
    offset += length
  }
  return entries
}

function centralDirectoryEntry(bytes: Uint8Array, name: string) {
  const entry = centralDirectoryEntries(bytes).find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`TEST_ZIP_ENTRY_NOT_FOUND:${name}`)
  return entry
}

function forgeDeclaredUncompressedSize(bytes: Uint8Array, name: string, declaredSize: number) {
  const output = bytes.slice()
  const entry = centralDirectoryEntry(output, name)
  const view = zipView(output)
  view.setUint32(entry.offset + 24, declaredSize, true)
  view.setUint32(entry.localHeaderOffset + 22, declaredSize, true)
  return output
}

function corruptDeclaredCrc(bytes: Uint8Array, name: string) {
  const output = bytes.slice()
  const entry = centralDirectoryEntry(output, name)
  const view = zipView(output)
  const corruptedCrc = (view.getUint32(entry.offset + 16, true) ^ 0xffffffff) >>> 0
  view.setUint32(entry.offset + 16, corruptedCrc, true)
  view.setUint32(entry.localHeaderOffset + 14, corruptedCrc, true)
  return output
}

function mutateZipHeaders(
  bytes: Uint8Array,
  mutator: (view: DataView, endOffset: number, entry: CentralDirectoryEntry) => void,
) {
  const output = bytes.slice()
  mutator(zipView(output), findEndOfCentralDirectory(output), centralDirectoryEntries(output)[0]!)
  return output
}

beforeAll(async () => {
  const pptx = new PptxGenJS()
  pptx.addSlide().addText('Slide 1', { x: 1, y: 1, w: 4, h: 1 })
  pptx.addSlide().addText('Slide 2', { x: 1, y: 1, w: 4, h: 1 })
  const output = await pptx.write({ outputType: 'uint8array', compression: true })
  if (!(output instanceof Uint8Array)) throw new Error('TEST_PPTX_OUTPUT_INVALID')
  validPptxBytes = new Uint8Array(output)
})

async function mutatePptx(mutator: (archive: JSZip) => void | Promise<void>) {
  const archive = await JSZip.loadAsync(validPptxBytes)
  await mutator(archive)
  return archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

describe('PPTX artifact validation', () => {
  test('accepts a generated PresentationML package', async () => {
    await expect(assertReadablePptxArtifact(validPptxBytes, 2)).resolves.toBeUndefined()
  })

  test('rejects a package without a valid OPC content-types root', async () => {
    const bytes = await mutatePptx((archive) => {
      archive.file('[Content_Types].xml', '<fake/>')
    })

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_CONTENT_TYPES_INVALID')
  })

  test('rejects a referenced slide without a PresentationML slide root', async () => {
    const bytes = await mutatePptx((archive) => {
      archive.file('ppt/slides/slide1.xml', '<not-a-slide/>')
    })

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_SLIDE_INVALID')
  })

  test('rejects an archive with an excessive entry count', async () => {
    const bytes = await mutatePptx((archive) => {
      for (let index = 0; index < 2_100; index += 1) {
        archive.file(`extra/entry-${index}.bin`, '')
      }
    })

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
  })

  test('rejects an oversized XML part before parsing it', async () => {
    const bytes = await mutatePptx((archive) => {
      archive.file(
        'customXml/oversized.xml',
        `<root>${'x'.repeat(4 * MEBIBYTE)}</root>`,
        { compression: 'STORE' },
      )
    })

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
  })

  test('rejects excessive aggregate XML expansion before parsing the parts', async () => {
    const bytes = await mutatePptx((archive) => {
      for (let index = 0; index < 5; index += 1) {
        archive.file(
          `customXml/aggregate-${index}.xml`,
          `<root>${String(index).repeat(3_500_000)}</root>`,
          { compression: 'STORE' },
        )
      }
    })

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
  })

  test('rejects an XML part with an unsafe compression ratio', async () => {
    const bytes = await mutatePptx((archive) => {
      archive.file('customXml/compressed.xml', `<root>${'x'.repeat(MEBIBYTE)}</root>`)
    })

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
  })

  test('rejects duplicate normalized raw entries before JSZip folds them', async () => {
    const bytes = await mutatePptx((archive) => {
      archive.file('custom/../[Content_Types].xml', '<fake/>', { createFolders: false })
    })

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_ARCHIVE_DUPLICATE_ENTRY')
  })

  test('enforces XML expansion limits against actual output when the declared size is forged', async () => {
    const entryName = 'customXml/forged-size.xml'
    const bytes = forgeDeclaredUncompressedSize(await mutatePptx((archive) => {
      archive.file(entryName, `<root>${'x'.repeat(5 * MEBIBYTE)}</root>`)
    }), entryName, 1)

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_ARCHIVE_LIMIT_EXCEEDED')
  })

  test('rejects a CRC mismatch with a stable validation error', async () => {
    const bytes = corruptDeclaredCrc(validPptxBytes, '[Content_Types].xml')

    await expect(assertReadablePptxArtifact(bytes, 2))
      .rejects.toThrow('FINAL_PPTX_ARCHIVE_CRC_INVALID')
  })

  for (const [label, mutate] of [
    ['ZIP64', (view: DataView, endOffset: number) => {
      view.setUint16(endOffset + 8, 0xffff, true)
      view.setUint16(endOffset + 10, 0xffff, true)
    }],
    ['multi-disk', (view: DataView, endOffset: number) => {
      view.setUint16(endOffset + 4, 1, true)
    }],
    ['encrypted', (view: DataView, _endOffset: number, entry: CentralDirectoryEntry) => {
      view.setUint16(entry.offset + 8, view.getUint16(entry.offset + 8, true) | 1, true)
      view.setUint16(entry.localHeaderOffset + 6, view.getUint16(entry.localHeaderOffset + 6, true) | 1, true)
    }],
  ] as const) {
    test(`rejects an unsupported ${label} archive before loading JSZip`, async () => {
      const bytes = mutateZipHeaders(validPptxBytes, mutate)

      await expect(assertReadablePptxArtifact(bytes, 2))
        .rejects.toThrow('FINAL_PPTX_ARCHIVE_UNSUPPORTED')
    })
  }
})
