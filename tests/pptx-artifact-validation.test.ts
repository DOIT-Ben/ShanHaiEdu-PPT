import { beforeAll, describe, expect, test } from 'bun:test'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { assertReadablePptxArtifact } from '../src/core/pptx-artifact-validation'

const MEBIBYTE = 1024 * 1024

let validPptxBytes: Uint8Array

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
})
