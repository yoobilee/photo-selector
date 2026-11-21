import { describe, expect, it } from 'vitest'
import type { GrayImage } from '../photos/sharpness.ts'
import { createRandom, gaussianBlur, renderScene } from './syntheticImages.ts'

// 줄 단위로 빠르게 바꾸기 전의 화소별 가우시안 흐림. 합성 이미지로 기록한 판정 결과가 바뀌지 않도록
// 빠른 구현이 이 기준과 비트 단위로 같은지 확인한다.
function referenceGaussianBlur(image: GrayImage, sigma: number): GrayImage {
  const { width, height } = image
  if (sigma <= 0) return { width, height, pixels: image.pixels.slice() }
  const radius = Math.ceil(sigma * 3)
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-((index - radius) ** 2) / (2 * sigma * sigma)))
  const total = kernel.reduce((sum, value) => sum + value, 0)
  const weights = kernel.map((value) => value / total)
  const pass = (source: Float32Array, horizontal: boolean) => {
    const target = new Float32Array(source.length)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        for (let offset = -radius; offset <= radius; offset += 1) {
          const sx = horizontal ? Math.min(width - 1, Math.max(0, x + offset)) : x
          const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + offset))
          sum += source[sy * width + sx]! * weights[offset + radius]!
        }
        target[y * width + x] = sum
      }
    }
    return target
  }
  return { width, height, pixels: pass(pass(image.pixels, true), false) }
}

function expectSameBits(actual: GrayImage, expected: GrayImage) {
  expect(actual.width).toBe(expected.width)
  expect(actual.height).toBe(expected.height)
  const actualBits = new Uint32Array(actual.pixels.buffer, actual.pixels.byteOffset, actual.pixels.length)
  const expectedBits = new Uint32Array(expected.pixels.buffer, expected.pixels.byteOffset, expected.pixels.length)
  const firstDifference = actualBits.findIndex((bits, index) => bits !== expectedBits[index])
  expect(firstDifference).toBe(-1)
}

describe('gaussianBlur', () => {
  it('matches the per-pixel reference bit for bit, including images narrower than the kernel', () => {
    const random = createRandom(7)
    for (const [width, height] of [[1, 1], [1, 9], [9, 1], [3, 2], [40, 5], [5, 40], [97, 61]] as const) {
      const noise: GrayImage = { width, height, pixels: new Float32Array(width * height).map(() => random() * 400 - 70) }
      for (const sigma of [-1, 0, 0.3, 0.8, 1.6, 2, 2.8, 4.4, 7.3]) {
        expectSameBits(gaussianBlur(noise, sigma), referenceGaussianBlur(noise, sigma))
        expectSameBits(gaussianBlur(renderScene(width, height, 21), sigma), referenceGaussianBlur(renderScene(width, height, 21), sigma))
      }
    }
  })

  it('matches the per-pixel reference bit for bit at the analysis size', () => {
    const scene = renderScene(1024, 768, 21)
    for (const sigma of [0.8, 3]) expectSameBits(gaussianBlur(scene, sigma), referenceGaussianBlur(scene, sigma))
  })

  it('does not change the input image', () => {
    const scene = renderScene(64, 48, 3)
    const before = scene.pixels.slice()
    gaussianBlur(scene, 2)
    expect(scene.pixels).toEqual(before)
  })
})
