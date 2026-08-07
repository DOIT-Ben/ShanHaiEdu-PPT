import type { CreateRunRequest } from '../contracts'
import { createPublicCapabilities, type PublicCapabilities } from '../run-query-contracts'

export type V4RuntimeMode = 'GATEWAY' | 'MOCK'

export class V4ModelPolicy {
  readonly runtimeMode: V4RuntimeMode
  readonly textModels: readonly string[]
  readonly visionModels: readonly string[]
  readonly imageModels: readonly string[]
  readonly imageEditModels: readonly string[]

  constructor(input: Readonly<{
    runtimeMode: V4RuntimeMode
    textModels: readonly string[]
    visionModels: readonly string[]
    imageModels: readonly string[]
    imageEditModels?: readonly string[]
  }>) {
    this.runtimeMode = input.runtimeMode
    this.textModels = [...input.textModels]
    this.visionModels = [...input.visionModels]
    this.imageModels = [...input.imageModels]
    this.imageEditModels = [...(input.imageEditModels ?? [])]
  }

  assertNewRunAllowed(request: CreateRunRequest) {
    if (request.presentationMode !== 'VISUAL_DECK_V4') return
    if (!this.imageModels.includes(request.imageModel)) {
      throw new Error('V4_IMAGE_MODEL_NOT_ALLOWED')
    }
  }

  publicCapabilities(quickDeckAvailable = false): PublicCapabilities {
    return createPublicCapabilities({
      runtimeMode: this.runtimeMode,
      textModels: this.textModels,
      visionModels: this.visionModels,
      imageModels: this.imageModels,
      imageEditModels: this.imageEditModels,
      quickDeckAvailable,
    })
  }

  static mock() {
    return new V4ModelPolicy({
      runtimeMode: 'MOCK',
      textModels: ['local-mock-text'],
      visionModels: ['local-mock-vision'],
      imageModels: ['local-mock-image'],
    })
  }
}
