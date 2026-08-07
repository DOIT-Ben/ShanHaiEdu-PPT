export interface QuickDeckEvaluatorDirectoryProbe {
  listModels(): Promise<readonly string[]>
}

type QuickDeckEvaluatorDirectoryInput = Readonly<{
  textModel: string
  allowedImageModels: readonly string[]
  textProbe: QuickDeckEvaluatorDirectoryProbe
  imageProbe: QuickDeckEvaluatorDirectoryProbe
}>

async function listedModels(probe: QuickDeckEvaluatorDirectoryProbe, channel: 'TEXT' | 'IMAGE') {
  try {
    return new Set(await probe.listModels())
  } catch {
    throw new Error(`PPT_AGENT_QUICK_DECK_EVALUATION_${channel}_MODEL_DIRECTORY_UNAVAILABLE`)
  }
}

/** Confirms that isolated evaluator credentials can see every configured evaluator model. */
export async function assertQuickDeckEvaluatorModelsAvailable(input: QuickDeckEvaluatorDirectoryInput) {
  const [textModels, imageModels] = await Promise.all([
    listedModels(input.textProbe, 'TEXT'),
    listedModels(input.imageProbe, 'IMAGE'),
  ])
  if (!textModels.has(input.textModel)) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_TEXT_MODEL_UNAVAILABLE')
  }
  if (input.allowedImageModels.some((model) => !imageModels.has(model))) {
    throw new Error('PPT_AGENT_QUICK_DECK_EVALUATION_IMAGE_MODEL_UNAVAILABLE')
  }
}
