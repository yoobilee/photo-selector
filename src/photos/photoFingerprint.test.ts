import { describe, expect, it } from 'vitest'
import { gaussianBlur, renderScene } from '../test/syntheticImages.ts'
import { adjustTone } from '../test/photoVariants.ts'
import {
  FINGERPRINT_SIZE,
  createPhotoFingerprint,
  hashDistance,
  isPhotoFingerprint,
  resampleByArea,
} from './photoFingerprint.ts'

const scene = gaussianBlur(renderScene(320, 240, 5), 0.8)

describe('createPhotoFingerprint', () => {
  it('keeps only a 64×64 brightness image, a 63-bit hash and the aspect ratio', () => {
    const fingerprint = createPhotoFingerprint(scene)!

    expect(fingerprint.pixels).toBeInstanceOf(Uint8Array)
    expect(fingerprint.pixels).toHaveLength(FINGERPRINT_SIZE * FINGERPRINT_SIZE)
    expect(fingerprint.aspectRatio).toBeCloseTo(4 / 3)
    expect(fingerprint.hash[0]).toBeLessThan(2 ** 31)
    expect(Object.keys(fingerprint).sort()).toEqual(['aspectRatio', 'hash', 'pixels'])
    expect(isPhotoFingerprint(fingerprint)).toBe(true)
  })

  it('does not change the analysis image that the blur check also reads', () => {
    const before = scene.pixels.slice()

    createPhotoFingerprint(scene)

    expect(scene.pixels).toEqual(before)
  })

  it('does not fingerprint images narrower or shorter than the comparison size', () => {
    expect(createPhotoFingerprint(renderScene(63, 200, 1))).toBeNull()
    expect(createPhotoFingerprint(renderScene(200, 63, 1))).toBeNull()
    expect(createPhotoFingerprint(renderScene(64, 64, 1))).not.toBeNull()
  })

  it('keeps the same hash when only brightness and contrast change', () => {
    const original = createPhotoFingerprint(scene)!
    const adjusted = createPhotoFingerprint(adjustTone(scene, { gain: 0.6, offset: 50 }))!

    expect(hashDistance(original.hash, adjusted.hash)).toBeLessThanOrEqual(1)
  })
})

describe('resampleByArea', () => {
  it('averages every source pixel that falls in each cell', () => {
    // 128×64의 왼쪽 절반은 0, 오른쪽 절반은 200이고 맨 위 행만 100을 더한다.
    const width = 128
    const height = 64
    const pixels = new Float32Array(width * height).map((_, index) => (index % width < 64 ? 0 : 200) + (index < width ? 100 : 0))

    const resampled = resampleByArea({ width, height, pixels }, 32)

    // 한 칸은 4×2화소다. 맨 위 칸은 위 행(100 더함)과 아래 행을 반씩 평균한다.
    expect(resampled[0]).toBe(50)
    expect(resampled[31]).toBe(250)
    expect(resampled[32 * 5]).toBe(0)
    expect(resampled[32 * 5 + 31]).toBe(200)
  })
})

describe('hashDistance', () => {
  it('counts differing bits in both words', () => {
    expect(hashDistance([0, 0], [0, 0])).toBe(0)
    expect(hashDistance([0b101, 0xffffffff], [0, 0])).toBe(34)
    expect(hashDistance([0, 0x80000000], [0x40000000, 0])).toBe(2)
  })
})

describe('isPhotoFingerprint', () => {
  it('rejects values that do not have the fingerprint shape', () => {
    const valid = createPhotoFingerprint(scene)!
    expect(isPhotoFingerprint(null)).toBe(false)
    expect(isPhotoFingerprint({ ...valid, pixels: new Uint8Array(10) })).toBe(false)
    expect(isPhotoFingerprint({ ...valid, pixels: Array.from(valid.pixels) })).toBe(false)
    expect(isPhotoFingerprint({ ...valid, hash: [1] })).toBe(false)
    expect(isPhotoFingerprint({ ...valid, hash: [-1, 0] })).toBe(false)
    expect(isPhotoFingerprint({ ...valid, aspectRatio: Number.NaN })).toBe(false)
    expect(isPhotoFingerprint({ ...valid, aspectRatio: 0 })).toBe(false)
  })
})
