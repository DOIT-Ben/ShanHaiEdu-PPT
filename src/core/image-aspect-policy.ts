export const V4_IMAGE_ASPECT_NORMALIZATION_TOLERANCE = 0.03
export const V4_IMAGE_ASPECT_TARGET = Object.freeze({ width: 1600, height: 900 })

export type VisualDeckV4AspectDecision = Readonly<{
  observedWidth: number
  observedHeight: number
  relativeError: number
  crop: Readonly<{ left: number; top: number; width: number; height: number }> | null
}>

export function hasExactVisualDeckV4AspectRatio(width: number, height: number) {
  return Number.isSafeInteger(width) && width > 0
    && Number.isSafeInteger(height) && height > 0
    && width * 9 === height * 16
}

export function visualDeckV4AspectDecision(width: number, height: number): VisualDeckV4AspectDecision | null {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) return null
  const relativeError = Math.abs((width / height) / (16 / 9) - 1)
  if (relativeError > V4_IMAGE_ASPECT_NORMALIZATION_TOLERANCE) return null
  if (hasExactVisualDeckV4AspectRatio(width, height)) {
    return { observedWidth: width, observedHeight: height, relativeError, crop: null }
  }
  const unit = Math.floor(Math.min(width / 16, height / 9))
  const cropWidth = unit * 16
  const cropHeight = unit * 9
  if (cropWidth <= 0 || cropHeight <= 0) return null
  return {
    observedWidth: width,
    observedHeight: height,
    relativeError,
    crop: {
      left: Math.floor((width - cropWidth) / 2),
      top: Math.floor((height - cropHeight) / 2),
      width: cropWidth,
      height: cropHeight,
    },
  }
}
