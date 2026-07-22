const SLIDE_WIDTH_PIXELS = 1_600
const SLIDE_HEIGHT_PIXELS = 900
const PIXELS_PER_POINT = SLIDE_WIDTH_PIXELS / (13.333 * 72)
const HORIZONTAL_PADDING_PIXELS = 12
const VERTICAL_PADDING_PIXELS = 6
const LINE_HEIGHT = 1.25

export type PresentationTextLayoutInput = Readonly<{
  text: string
  fontSize: number
  width: number
  height: number
}>

function glyphWidth(character: string, fontSizePixels: number) {
  if (/\s/u.test(character)) return fontSizePixels * 0.34
  if (/[A-Z]/u.test(character)) return fontSizePixels * 0.64
  if (/[a-z0-9]/u.test(character)) return fontSizePixels * 0.55
  if (/[-.,:;!?()[\]{}'"/\\]/u.test(character)) return fontSizePixels * 0.42
  return fontSizePixels
}

function wrappedLines(text: string, maxWidthPixels: number, fontSizePixels: number) {
  const lines: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (paragraph.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    let width = 0
    for (const character of Array.from(paragraph)) {
      const characterWidth = glyphWidth(character, fontSizePixels)
      if (line.length > 0 && width + characterWidth > maxWidthPixels) {
        lines.push(line)
        line = character
        width = characterWidth
      } else {
        line += character
        width += characterWidth
      }
    }
    if (line.length > 0) lines.push(line)
  }
  return lines.length > 0 ? lines : ['']
}

export function layoutPresentationText(input: PresentationTextLayoutInput) {
  const fontSizePixels = input.fontSize * PIXELS_PER_POINT
  const lineHeightPixels = fontSizePixels * LINE_HEIGHT
  const maxWidthPixels = Math.max(1, input.width * SLIDE_WIDTH_PIXELS - HORIZONTAL_PADDING_PIXELS * 2)
  const maxHeightPixels = Math.max(1, input.height * SLIDE_HEIGHT_PIXELS - VERTICAL_PADDING_PIXELS * 2)
  const maxLines = Math.max(1, Math.floor(maxHeightPixels / lineHeightPixels))
  const requiredLines = wrappedLines(input.text, maxWidthPixels, fontSizePixels)
  return {
    fits: requiredLines.length <= maxLines,
    lines: requiredLines.slice(0, maxLines),
    requiredLineCount: requiredLines.length,
    maxLines,
    fontSizePixels,
    lineHeightPixels,
    horizontalPaddingPixels: HORIZONTAL_PADDING_PIXELS,
    verticalPaddingPixels: VERTICAL_PADDING_PIXELS,
    textWithoutNewlines: input.text.replace(/\r\n?/g, '').replace(/\n/g, ''),
  } as const
}
