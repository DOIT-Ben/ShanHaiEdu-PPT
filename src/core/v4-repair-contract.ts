import { z } from 'zod'
import type { PresentationBlueprint } from '../presentation-contracts'
import { hashInput } from './hash'

const identifierSchema = z.string().trim().min(1).max(160)
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum)
const V4_REPAIR_MAX_ISSUES = 100
// Four bounded rounds can contribute 50 plan operations and one page-review
// instruction per round: 4 * 50 + 4 = 204 unique local changes.
const V4_REPAIR_MAX_CHANGES = 204

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
})

export type V4RepairContract = z.infer<typeof v4RepairContractSchema>
export const V4_REPAIR_PROMPT_MAX_LENGTH = 12_000

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
      unaffectedAreas: 'Preserve every pixel and composition decision outside the requested changes as closely as possible.',
    },
    exactConstraints: {
      facts: unique(brief.facts),
      numbers: unique(brief.numbers),
      formulas: unique(brief.formulas),
    },
    forbiddenChanges: unique([
      ...input.proposal.visualContract.forbidden,
      ...input.proposal.presentationSpec.forbidden,
      'Do not redesign or regenerate the entire slide.',
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

function section(label: string, values: readonly string[]) {
  return values.length > 0 ? `${label}: ${values.join(' | ')}.` : ''
}

export function compileV4RepairPrompt(contract: V4RepairContract) {
  const value = v4RepairContractSchema.parse(contract)
  const prompt = [
    'Edit the attached source slide in place. Apply only the explicitly requested changes.',
    section('Required changes', value.requiredChanges),
    value.preserve.unaffectedAreas,
    section('Visible text that must remain exact', value.preserve.allowedCopy),
    section('Teaching facts that must remain visually true', value.exactConstraints.facts),
    section('Numbers that must remain exact', value.exactConstraints.numbers),
    section('Formulas that must remain exact', value.exactConstraints.formulas),
    section('Visual continuity rules', value.preserve.continuityRules),
    section('Forbidden changes', value.forbiddenChanges),
    '视觉元素独立性要求：编辑后仍须让每个主要视觉元素保持完整轮廓、清晰边界和可见间隔，不得绑定、粘合、嵌套或合成为不可分割的组合主体。',
    '即使元素存在语义关系，也只能通过位置、方向、箭头、间距和大小关系表达；除非用户明确要求物理接触，否则不得新增接触、遮挡、交叠、穿插、融合或共用轮廓。',
    'COUNTABLE OBJECT SAFETY: keep exactly one authoritative set of every countable teaching object and preserve the required total cardinality.',
    'Do not invent any additional labels, captions, page numbers, decorative words, watermarks, logos, or content from another slide.',
    'Return one finished full-bleed 16:9 slide image. Do not add explanations, borders, watermarks, or content from another slide.',
  ].filter(Boolean).join(' ')
  if (prompt.length > V4_REPAIR_PROMPT_MAX_LENGTH) throw new Error('V4_REPAIR_PROMPT_BUDGET_EXCEEDED')
  return prompt
}
