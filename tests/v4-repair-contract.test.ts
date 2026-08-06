import { describe, expect, test } from 'bun:test'
import type { PresentationBlueprint } from '../src/presentation-contracts'
import {
  controlledVisualDeckPageArtifact,
  hasVisualDeckV4AspectRatio,
  latestCompletedAssetStep,
  type BlueprintImageRequirement,
} from '../src/core/blueprint-assets'
import type { StepRecord } from '../src/core/ports'
import { visualDeckV4RevisionInstructions } from '../src/core/revision-instruction-memory'
import {
  compileV4RepairContract,
  compileV4RepairPrompt,
  v4RepairContractHash,
  v4RepairImageKey,
  v4RepairContractSchema,
} from '../src/core/v4-repair-contract'

const proposal = {
  presentationSpec: {
    forbidden: ['不得增加教材外结论'],
  },
  visualContract: {
    continuityRules: ['保持绿色与白色课堂视觉系统', '保持扁平信息图风格'],
    forbidden: ['水印', '品牌标志'],
  },
  slideBriefs: [{
    pageNumber: 2,
    role: 'EXPLANATION',
    title: '五可以分成二和三',
    lockedCopy: ['5', '2 + 3 = 5'],
    facts: ['画面中恰好五个圆片，并分成两个非空组'],
    numbers: ['5', '2', '3'],
    formulas: ['2 + 3 = 5'],
  }],
} as unknown as NonNullable<PresentationBlueprint['visualDeckV4Proposal']>

const sourceArtifact = {
  artifactId: 'artifact-page-2-r0',
  sha256: 'a'.repeat(64),
  mimeType: 'image/png' as const,
  width: 1600,
  height: 900,
}

function contract() {
  return compileV4RepairContract({
    runId: 'run-1',
    pageNumber: 2,
    revisionRound: 1,
    issueIds: ['issue-count', 'issue-layout', 'issue-count'],
    requiredChanges: [
      '只把左侧圆片改成两个，右侧圆片改成三个。',
      '保持标题、公式、背景和其他未指出区域不变。',
    ],
    proposal,
    sourceArtifact,
    editModel: 'gpt-image-2',
  })
}

describe('V4 repair contract', () => {
  test('uses a relative three-percent tolerance for a 16:9 repair source', () => {
    expect(hasVisualDeckV4AspectRatio(1600, 927)).toBe(true)
    expect(hasVisualDeckV4AspectRatio(1600, 929)).toBe(false)
  })

  test('freezes the exact edit scope, teaching constraints, source identity and edit model', () => {
    expect(contract()).toEqual({
      schemaVersion: 'v4-repair-contract-1',
      runId: 'run-1',
      pageNumber: 2,
      revisionRound: 1,
      mode: 'IMAGE_EDIT',
      issueIds: ['issue-count', 'issue-layout'],
      requiredChanges: [
        '只把左侧圆片改成两个，右侧圆片改成三个。',
        '保持标题、公式、背景和其他未指出区域不变。',
      ],
      preserve: {
        allowedCopy: ['五可以分成二和三', '5', '2 + 3 = 5'],
        continuityRules: ['保持绿色与白色课堂视觉系统', '保持扁平信息图风格'],
        unaffectedAreas: '除明确列出的修改外，尽可能保持每一个像素和构图决定不变。',
      },
      exactConstraints: {
        facts: ['画面中恰好五个圆片，并分成两个非空组'],
        numbers: ['5', '2', '3'],
        formulas: ['2 + 3 = 5'],
      },
      forbiddenChanges: ['水印', '品牌标志', '不得增加教材外结论', '不得重新设计或重新生成整页幻灯片。'],
      sourceArtifact,
      editModel: 'gpt-image-2',
    })
  })

  test('has a deterministic full hash and a fixed 24-hex provider key identity', () => {
    const first = contract()
    const second = contract()
    const hash = v4RepairContractHash(first)

    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(v4RepairContractHash(second)).toBe(hash)
    expect(v4RepairImageKey(first, hash)).toBe(`run-1:slide:2:image:r1:v1:edit:${hash.slice(0, 24)}`)
  })

  test('compiles an image-edit instruction without weakening exact constraints', () => {
    const prompt = compileV4RepairPrompt(contract())

    expect(prompt).toContain('在附带的源幻灯片上原位编辑')
    expect(prompt).toContain('只把左侧圆片改成两个')
    expect(prompt).toContain('五可以分成二和三')
    expect(prompt).toContain('恰好五个圆片')
    expect(prompt).toContain('2 + 3 = 5')
    expect(prompt).toContain('不得重新设计或重新生成整页幻灯片')
    expect(prompt).toContain('视觉元素独立性要求')
    expect(prompt).toContain('不得将两个或多个主要元素绑定、粘合、嵌套或合成为不可分割的组合主体')
  })

  test('targets a 16:9 landscape output without demanding pixel-perfect dimensions', () => {
    const prompt = compileV4RepairPrompt(contract())

    expect(prompt).toContain('输出一张完成的满版横向幻灯片，目标比例约为 16:9。')
    expect(prompt).toContain('允许轻微的像素尺寸偏差，但不得有意输出 3:2、4:3 或方形图片。')
    expect(prompt).not.toContain('像素级精确')
  })

  test('keeps the persisted contract strict', () => {
    expect(v4RepairContractSchema.safeParse({ ...contract(), rawProviderResponse: 'forbidden' }).success).toBe(false)
  })

  test('rejects a persisted image-edit contract before its lossless prompt budget can overflow', () => {
    const oversized = {
      ...contract(),
      requiredChanges: ['修订'.repeat(1_000), '修订'.repeat(1_000), '修订'.repeat(50)],
      preserve: {
        allowedCopy: Array.from({ length: 8 }, () => '可见文字'.repeat(125)),
        continuityRules: Array.from({ length: 4 }, () => '连续性规则'.repeat(60)),
        unaffectedAreas: '保持未修改区域。'.repeat(30),
      },
      exactConstraints: { facts: [], numbers: [], formulas: [] },
      forbiddenChanges: Array.from({ length: 5 }, () => '禁项'.repeat(150)),
    }

    expect(v4RepairContractSchema.safeParse(oversized).success).toBe(false)
  })

  test('rejects a fragmented image-edit contract whose rendered separators exceed the prompt budget', () => {
    const fragmented = {
      ...contract(),
      requiredChanges: Array.from({ length: 204 }, () => 'r'.repeat(20)),
      preserve: {
        allowedCopy: Array.from({ length: 10 }, () => 'a'.repeat(50)),
        continuityRules: Array.from({ length: 12 }, () => 'e'.repeat(100)),
        unaffectedAreas: 'u'.repeat(300),
      },
      exactConstraints: {
        facts: Array.from({ length: 20 }, () => 'b'.repeat(100)),
        numbers: Array.from({ length: 20 }, () => 'c'.repeat(20)),
        formulas: Array.from({ length: 20 }, () => 'd'.repeat(50)),
      },
      forbiddenChanges: Array.from({ length: 50 }, () => 'f'.repeat(20)),
    }

    expect(v4RepairContractSchema.safeParse(fragmented).success).toBe(false)
  })

  test('accepts every issue from one valid 100-issue deck review', () => {
    const issueIds = Array.from({ length: 100 }, (_, index) => `issue-${index + 1}`)
    const compiled = compileV4RepairContract({
      runId: 'run-1', pageNumber: 2, revisionRound: 1,
      issueIds, requiredChanges: ['只修正本页已确认的问题。'],
      proposal, sourceArtifact, editModel: 'gpt-image-2',
    })

    expect(compiled.issueIds).toEqual(issueIds)
  })

  test('accepts all 204 cumulative instructions within the four-round upstream limit', () => {
    const requiredChanges = Array.from({ length: 204 }, (_, index) => `仅执行局部修改 ${index + 1}。`)
    const compiled = compileV4RepairContract({
      runId: 'run-1', pageNumber: 2, revisionRound: 2,
      issueIds: ['issue-cumulative'], requiredChanges,
      proposal, sourceArtifact, editModel: 'gpt-image-2',
    })

    expect(compiled.requiredChanges).toEqual(requiredChanges)
    expect(compileV4RepairPrompt(compiled).length).toBeLessThanOrEqual(12_000)
  })
})

describe('V4 edit key compatibility', () => {
  const requirement = {
    idempotencyKey: 'run-1:slide:2:image:r2:v1',
  } as BlueprintImageRequirement
  const step = (idempotencyKey: string, createdAt: string): StepRecord => ({
    id: idempotencyKey,
    runId: 'run-1',
    idempotencyKey,
    inputHash: idempotencyKey,
    tool: 'generate_slide_image',
    status: 'COMPLETED',
    budgetUnits: 1,
    budgetReservationId: 'reservation-1',
    externalOperationId: 'operation-1',
    errorCode: null,
    output: { artifactId: `artifact-${createdAt}` },
    createdAt,
    updatedAt: createdAt,
  })

  test('reads legacy and edit keys and selects the latest completed prior artifact', () => {
    const legacy = step('run-1:slide:2:image:r0:v1', '2026-08-03T00:00:00.000Z')
    const edited = step(`run-1:slide:2:image:r1:v1:edit:${'b'.repeat(24)}`, '2026-08-03T00:01:00.000Z')
    const future = step(`run-1:slide:2:image:r3:v1:edit:${'c'.repeat(24)}`, '2026-08-03T00:02:00.000Z')

    expect(latestCompletedAssetStep([legacy, edited, future], requirement, 2)?.idempotencyKey).toBe(edited.idempotencyKey)
    expect(latestCompletedAssetStep([legacy, edited], requirement, 0)?.idempotencyKey).toBe(legacy.idempotencyKey)
  })

  test('accepts an unchanged prior-round page but rejects an artifact from a future round', () => {
    const completeRequirement = {
      ...requirement,
      slideId: 'run-1:slide:2',
      pageNumber: 2,
    } as BlueprintImageRequirement
    const prior = {
      ...step('run-1:slide:2:image:r1:v1', '2026-08-03T00:01:00.000Z'),
      output: { slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r1:v1', artifactId: 'artifact-prior' },
    }
    const future = {
      ...step('run-1:slide:2:image:r3:v1', '2026-08-03T00:03:00.000Z'),
      output: { slideId: 'run-1:slide:2', versionId: 'run-1:slide:2:r3:v1', artifactId: 'artifact-future' },
    }

    expect(controlledVisualDeckPageArtifact(prior, completeRequirement)).toMatchObject({
      artifactId: 'artifact-prior', revisionRound: 1,
    })
    expect(controlledVisualDeckPageArtifact(future, completeRequirement)).toBeNull()
  })

  test('carries a review derived from an edit key into the next revision round', () => {
    const correction = 'Keep the corrected group count and move only the formula upward.'
    const reviewStep: StepRecord = {
      ...step(`run-1:slide:2:image:r1:v1:edit:${'d'.repeat(24)}:review`, '2026-08-03T00:03:00.000Z'),
      tool: 'review_slide_image',
      budgetUnits: 0,
      budgetReservationId: null,
      externalOperationId: null,
      output: {
        approved: false, textDetected: false, visualScore: 70,
        reasons: ['公式位置需要局部调整。'], retryInstruction: correction,
      },
    }

    expect(visualDeckV4RevisionInstructions({
      runId: 'run-1', pageNumber: 2, revisionRound: 2, steps: [reviewStep],
      currentInstructions: ['Apply the new page review.'],
    })).toEqual([correction, 'Apply the new page review.'])
  })
})
