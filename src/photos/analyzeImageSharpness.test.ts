import { describe, expect, it } from 'vitest'
import { gaussianBlur, motionBlur, renderScene, renderUniform } from '../test/syntheticImages.ts'
import { evaluateAnalysisImage, evaluatePhotoImage } from './analyzeImageSharpness.ts'
import { createPhotoFingerprint } from './photoFingerprint.ts'

describe('evaluatePhotoImage', () => {
  it('adds a fingerprint from the same analysis image without changing the blur verdict', () => {
    const images = [
      gaussianBlur(renderScene(320, 240, 11), 0.8),
      gaussianBlur(renderScene(320, 240, 11), 3),
      motionBlur(gaussianBlur(renderScene(320, 240, 13), 0.8), 12),
      renderUniform(320, 240, 150),
    ]
    for (const image of images) {
      const before = image.pixels.slice()
      const sharpnessOnly = evaluateAnalysisImage(image)

      const analysis = evaluatePhotoImage(image)

      expect({ result: analysis.result, measurement: analysis.measurement }).toEqual(sharpnessOnly)
      expect(analysis.fingerprint).toEqual(createPhotoFingerprint(image))
      expect(image.pixels.every((value, index) => value === before[index])).toBe(true)
    }
  })

  it('has no fingerprint when the photo is too small to analyze', () => {
    expect(evaluatePhotoImage(null)).toEqual({ result: { status: 'unavailable', reason: 'too-small' }, measurement: null, fingerprint: null })
  })
})
