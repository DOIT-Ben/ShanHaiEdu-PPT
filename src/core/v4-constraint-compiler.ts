/**
 * The compiler only accepts a deliberately small, arithmetic-closed grammar.
 * Anything outside it remains a generative page instead of inventing a visual
 * constraint from natural language.
 */
export const MAX_CONTROLLED_RASTER_ITEM_COUNT = 20

export type ExactDiagramSpec = Readonly<
  | {
      kind: 'EXACT_COUNT'
      itemLabel: string
      count: number
    }
  | {
      kind: 'PARTITION'
      itemLabel: string
      total: number
      groupCount: number
      itemsPerGroup: number
    }
  | {
      kind: 'COMPARE'
      itemLabel: string
      left: Readonly<{ label: string; count: number }>
      right: Readonly<{ label: string; count: number }>
      direction: 'LEFT_GREATER' | 'RIGHT_GREATER'
      difference: number
    }
>

export type ConstraintCompilerInput = Readonly<{
  title: string
  lockedCopy: readonly string[]
}>

const chineseDigitValues: Readonly<Record<string, number>> = {
  '零': 0,
  '〇': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9,
}

const numberToken = '(\\d{1,3}|[零〇一二两三四五六七八九十]{1,3})'
const countUnitToken = '(?:个|只|张|颗|块|片|支|本|台|条|辆|杯|朵|枚|棵|位)'
const itemToken = '([A-Za-z\\u4E00-\\u9FFF]{1,24}?)'
const labelToken = '([A-Za-z\\u4E00-\\u9FFF]{1,24}?)'
const sentenceEndToken = '(?:[。.!！?？]|$)'
const countMarkerPattern = new RegExp(`${numberToken}\\s*${countUnitToken}`, 'gu')

const partitionPattern = new RegExp(
  `${numberToken}\\s*${countUnitToken}\\s*${itemToken}(?:平均)?分成\\s*${numberToken}\\s*(?:个)?组\\s*[，,]\\s*每组(?:有)?\\s*${numberToken}\\s*${countUnitToken}(?:\\s*[A-Za-z\\u4E00-\\u9FFF]{1,24})?${sentenceEndToken}`,
  'u',
)

const comparisonPattern = new RegExp(
  `${labelToken}(?:有|共有|一共有)${numberToken}\\s*${countUnitToken}\\s*${itemToken}\\s*[，,]\\s*${labelToken}(?:有|共有|一共有)${numberToken}\\s*${countUnitToken}\\s*${itemToken}\\s*[，,]\\s*${labelToken}比${labelToken}(多|少)${numberToken}\\s*${countUnitToken}\\s*${itemToken}${sentenceEndToken}`,
  'u',
)

const exactCountPattern = new RegExp(
  `${numberToken}\\s*${countUnitToken}\\s*${itemToken}(?=[，,。.!！?？]|$)`,
  'gu',
)

function parseNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value)
  if (!/^[零〇一二两三四五六七八九十]+$/.test(value)) return null
  let total = 0
  let current = 0
  for (const character of value) {
    if (character === '十') {
      total += (current || 1) * 10
      current = 0
      continue
    }
    const digit = chineseDigitValues[character]
    if (digit === undefined) return null
    current = digit
  }
  return total + current
}

function isReadableCount(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0 && value <= MAX_CONTROLLED_RASTER_ITEM_COUNT
}

function normalizeLabel(value: string) {
  const normalized = value.replace(/\s+/g, '').trim()
  return normalized.length > 0 && normalized.length <= 24 ? normalized : null
}

function sameSpec(left: ExactDiagramSpec, right: ExactDiagramSpec) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function parsePartition(sentence: string): ExactDiagramSpec | null {
  const match = partitionPattern.exec(sentence)
  if (!match) return null
  const total = parseNumber(match[1]!)
  const itemLabel = normalizeLabel(match[2]!)
  const groupCount = parseNumber(match[3]!)
  const itemsPerGroup = parseNumber(match[4]!)
  if (!isReadableCount(total) || !itemLabel || !isReadableCount(groupCount) || !isReadableCount(itemsPerGroup)) return null
  if (total !== groupCount * itemsPerGroup) return null
  return { kind: 'PARTITION', itemLabel, total, groupCount, itemsPerGroup }
}

function parseComparison(sentence: string): ExactDiagramSpec | null {
  const match = comparisonPattern.exec(sentence)
  if (!match) return null
  const leftLabel = normalizeLabel(match[1]!)
  const leftCount = parseNumber(match[2]!)
  const leftItemLabel = normalizeLabel(match[3]!)
  const rightLabel = normalizeLabel(match[4]!)
  const rightCount = parseNumber(match[5]!)
  const rightItemLabel = normalizeLabel(match[6]!)
  const comparisonLeftLabel = normalizeLabel(match[7]!)
  const comparisonRightLabel = normalizeLabel(match[8]!)
  const relation = match[9]
  const difference = parseNumber(match[10]!)
  const comparisonItemLabel = normalizeLabel(match[11]!)
  if (!leftLabel || !isReadableCount(leftCount) || !leftItemLabel || !rightLabel || !isReadableCount(rightCount)
    || !rightItemLabel || !comparisonLeftLabel || !comparisonRightLabel || !relation
    || !isReadableCount(difference) || !comparisonItemLabel) return null
  if (leftLabel === rightLabel || leftItemLabel !== rightItemLabel || leftItemLabel !== comparisonItemLabel) return null

  const comparisonUsesLeftFirst = comparisonLeftLabel === leftLabel && comparisonRightLabel === rightLabel
  const comparisonUsesRightFirst = comparisonLeftLabel === rightLabel && comparisonRightLabel === leftLabel
  if (!comparisonUsesLeftFirst && !comparisonUsesRightFirst) return null

  const comparisonFirstCount = comparisonUsesLeftFirst ? leftCount : rightCount
  const comparisonSecondCount = comparisonUsesLeftFirst ? rightCount : leftCount
  if (relation === '多' && comparisonFirstCount - comparisonSecondCount !== difference) return null
  if (relation === '少' && comparisonSecondCount - comparisonFirstCount !== difference) return null

  const direction = relation === '多'
    ? comparisonUsesLeftFirst ? 'LEFT_GREATER' as const : 'RIGHT_GREATER' as const
    : comparisonUsesLeftFirst ? 'RIGHT_GREATER' as const : 'LEFT_GREATER' as const
  return {
    kind: 'COMPARE',
    itemLabel: leftItemLabel,
    left: { label: leftLabel, count: leftCount },
    right: { label: rightLabel, count: rightCount },
    direction,
    difference,
  }
}

function parseExactCount(sentence: string): ExactDiagramSpec | null {
  const markers = [...sentence.matchAll(countMarkerPattern)]
  if (markers.length !== 1) return null
  const matches = [...sentence.matchAll(exactCountPattern)]
  if (matches.length !== 1) return null
  const count = parseNumber(matches[0]![1]!)
  const itemLabel = normalizeLabel(matches[0]![2]!)
  if (!isReadableCount(count) || !itemLabel) return null
  return { kind: 'EXACT_COUNT', itemLabel, count }
}

function splitSentences(value: string) {
  return value
    .split(/[。.!！?？；;]/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

function inputSentences(input: ConstraintCompilerInput) {
  return [...input.lockedCopy, input.title]
    .flatMap(splitSentences)
}

/** Converts only complete count facts into a renderer-owned diagram spec. */
export class ConstraintCompiler {
  compile(input: ConstraintCompilerInput): ExactDiagramSpec | null {
    const relationSpecs: ExactDiagramSpec[] = []
    const exactSpecs: ExactDiagramSpec[] = []
    for (const sentence of inputSentences(input)) {
      const partition = parsePartition(sentence)
      if (partition) {
        relationSpecs.push(partition)
        continue
      }
      const comparison = parseComparison(sentence)
      if (comparison) {
        relationSpecs.push(comparison)
        continue
      }
      if (countMarkerPattern.test(sentence)) {
        countMarkerPattern.lastIndex = 0
        const exact = parseExactCount(sentence)
        if (!exact) return null
        exactSpecs.push(exact)
      }
      countMarkerPattern.lastIndex = 0
    }

    if (relationSpecs.length > 0) {
      if (!relationSpecs.every((candidate) => sameSpec(candidate, relationSpecs[0]!))) return null
      return relationSpecs[0]!
    }
    if (exactSpecs.length === 0 || !exactSpecs.every((candidate) => sameSpec(candidate, exactSpecs[0]!))) return null
    return exactSpecs[0]!
  }
}
