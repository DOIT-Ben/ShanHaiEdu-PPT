import { z } from 'zod'
import type { PresentationBlueprint } from '../presentation-contracts'
import {
  VISUAL_DECK_V4_CRITICAL_CONTENT_MAX_LENGTH,
  VISUAL_DECK_V4_REPAIR_CONSTRAINT_MAX_LENGTH,
} from '../visual-deck-v4-contracts'
import {
  V4_REVISION_INSTRUCTION_MAX_LENGTH,
  VISUAL_DECK_V4_SAFETY_RULES,
} from './blueprint-assets'
import { hashInput } from './hash'

const identifierSchema = z.string().trim().min(1).max(160)
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum)
const V4_REPAIR_MAX_ISSUES = 100
// Four bounded rounds can contribute 50 plan operations and one page-review
// instruction per round: 4 * 50 + 4 = 204 unique local changes.
const V4_REPAIR_MAX_CHANGES = 204
const V4_REPAIR_NO_FULL_REGENERATION = '不得重新设计或重新生成整页幻灯片。'
export const V4_REPAIR_PROMPT_MAX_LENGTH = 12_000

function controlledDataSection(label: string, values: readonly string[]) {
  return values.length > 0 ? `受控业务数据｜${label}：${values.join(' | ')}` : ''
}

function v4RepairPromptText(value: Readonly<{
  requiredChanges: readonly string[]
  preserve: Readonly<{
    allowedCopy: readonly string[]
    continuityRules: readonly string[]
    unaffectedAreas: string
  }>
  exactConstraints: Readonly<{
    facts: readonly string[]
    numbers: readonly string[]
    formulas: readonly string[]
  }>
  forbiddenChanges: readonly string[]
}>) {
  return [
    '在附带的源幻灯片上原位编辑。仅执行明确列出的修改。',
    `必须执行的修改：${value.requiredChanges.join(' | ')}`,
    value.preserve.unaffectedAreas,
    controlledDataSection('必须原样保留的可见文字', value.preserve.allowedCopy),
    value.exactConstraints.facts.length > 0
      ? `${controlledDataSection('仅供语义与计数准确性核对、不得新增显示的教学事实', value.exactConstraints.facts)} 除非完整且精确的字符串也列在“必须原样保留的可见文字”中，否则不得展示、转录、引用或改写这些事实。`
      : '',
    controlledDataSection('必须原样保留的数字', value.exactConstraints.numbers),
    controlledDataSection('必须原样保留的公式', value.exactConstraints.formulas),
    controlledDataSection('视觉连续性规则', value.preserve.continuityRules),
    controlledDataSection('禁止的修改', value.forbiddenChanges),
    ...VISUAL_DECK_V4_SAFETY_RULES,
    '输出一张完成的满版横向幻灯片，目标比例约为 16:9。允许轻微的像素尺寸偏差，但不得有意输出 3:2、4:3 或方形图片。不得输出解释、边框、水印或其他幻灯片的内容。',
  ].filter(Boolean).join(' ')
}

export const v4RepairContractSchema = z.object({
  schemaVersion: z.literal('v4-repair-contract-1'),
  runId: identifierSchema,
  pageNumber: z.number().int().min(1).max(50),
  revisionRound: z.number().int().min(1).max(4),
  mode: z.literal('IMAGE_EDIT'),
  issueIds: z.array(identifierSchema).min(1).max(V4_REPAIR_MAX_ISSUES),
  requiredChanges: z.array(boundedText(2_000)).min(1).max(V4_REPAIR_MAX_CHANGES),
  preserve: z.object({
    allowedCopy: z.array(boundedText(500)).min(1).max(10),
    continuityRules: z.array(boundedText(300)).min(1).max(12),
    unaffectedAreas: boundedText(300),
  }).strict(),
  exactConstraints: z.object({
    facts: z.array(boundedText(500)).max(20),
    numbers: z.array(boundedText(200)).max(20),
    formulas: z.array(boundedText(300)).max(20),
  }).strict(),
  forbiddenChanges: z.array(boundedText(300)).min(1).max(50),
  sourceArtifact: z.object({
    artifactId: identifierSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    width: z.number().int().positive().max(20_000),
    height: z.number().int().positive().max(20_000),
  }).strict(),
  editModel: boundedText(120),
}).strict().superRefine((value, context) => {
  if (new Set(value.issueIds).size !== value.issueIds.length) {
    context.addIssue({ code: 'custom', path: ['issueIds'], message: 'repair issue ids must be unique' })
  }
  if (value.requiredChanges.join('').length > V4_REVISION_INSTRUCTION_MAX_LENGTH) {
    context.addIssue({
      code: 'custom',
      path: ['requiredChanges'],
      message: 'repair changes exceed the lossless image prompt budget',
    })
  }
  const criticalContentLength = [
    ...value.preserve.allowedCopy,
    ...value.exactConstraints.facts,
    ...value.exactConstraints.numbers,
    ...value.exactConstraints.formulas,
  ].join('').length
  if (criticalContentLength > VISUAL_DECK_V4_CRITICAL_CONTENT_MAX_LENGTH) {
    context.addIssue({
      code: 'custom',
      path: ['exactConstraints'],
      message: 'repair critical content exceeds the lossless image prompt budget',
    })
  }
  const constraintLength = [
    ...value.preserve.continuityRules,
    ...value.forbiddenChanges,
  ].join('').length
  if (constraintLength > VISUAL_DECK_V4_REPAIR_CONSTRAINT_MAX_LENGTH + V4_REPAIR_NO_FULL_REGENERATION.length) {
    context.addIssue({
      code: 'custom',
      path: ['forbiddenChanges'],
      message: 'repair image constraints exceed the lossless image prompt budget',
    })
  }
  if (v4RepairPromptText(value).length > V4_REPAIR_PROMPT_MAX_LENGTH) {
    context.addIssue({
      code: 'custom',
      path: ['requiredChanges'],
      message: 'repair prompt exceeds the lossless image prompt budget',
    })
  }
})

export type V4RepairContract = z.infer<typeof v4RepairContractSchema>

type VisualDeckV4Proposal = NonNullable<PresentationBlueprint['visualDeckV4Proposal']>

function unique(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function compileV4RepairContract(input: Readonly<{
  runId: string
  pageNumber: number
  revisionRound: number
  issueIds: readonly string[]
  requiredChanges: readonly string[]
  proposal: VisualDeckV4Proposal
  sourceArtifact: V4RepairContract['sourceArtifact']
  editModel: string
}>) {
  const brief = input.proposal.slideBriefs.find((candidate) => candidate.pageNumber === input.pageNumber)
  if (!brief) throw new Error('VISUAL_DECK_V4_BRIEF_MISSING')
  return v4RepairContractSchema.parse({
    schemaVersion: 'v4-repair-contract-1',
    runId: input.runId,
    pageNumber: input.pageNumber,
    revisionRound: input.revisionRound,
    mode: 'IMAGE_EDIT',
    issueIds: unique(input.issueIds),
    requiredChanges: unique(input.requiredChanges),
    preserve: {
      allowedCopy: unique([brief.title, ...brief.lockedCopy]),
      continuityRules: unique(input.proposal.visualContract.continuityRules),
      unaffectedAreas: '除明确列出的修改外，尽可能保持每一个像素和构图决定不变。',
    },
    exactConstraints: {
      facts: unique(brief.facts),
      numbers: unique(brief.numbers),
      formulas: unique(brief.formulas),
    },
    forbiddenChanges: unique([
      ...input.proposal.visualContract.forbidden,
      ...input.proposal.presentationSpec.forbidden,
      V4_REPAIR_NO_FULL_REGENERATION,
    ]),
    sourceArtifact: input.sourceArtifact,
    editModel: input.editModel,
  })
}

export function v4RepairContractHash(contract: V4RepairContract) {
  return hashInput(v4RepairContractSchema.parse(contract))
}

export function v4RepairImageKey(contract: V4RepairContract, contractHash = v4RepairContractHash(contract)) {
  const parsed = v4RepairContractSchema.parse(contract)
  if (contractHash !== v4RepairContractHash(parsed)) throw new Error('V4_REPAIR_CONTRACT_HASH_MISMATCH')
  return `${parsed.runId}:slide:${parsed.pageNumber}:image:r${parsed.revisionRound}:v1:edit:${contractHash.slice(0, 24)}`
}

export function compileV4RepairPrompt(contract: V4RepairContract) {
  const value = v4RepairContractSchema.parse(contract)
  const prompt = v4RepairPromptText(value)
  if (prompt.length > V4_REPAIR_PROMPT_MAX_LENGTH) throw new Error('V4_REPAIR_PROMPT_BUDGET_EXCEEDED')
  return prompt
}
