import { describe, expect, it } from 'vitest'
import { createAnalysisDownsampler } from './analysisDownsample.ts'
import { downsampleByAverage, getAnalysisSize, toGrayscale } from './sharpness.ts'

// 재현 가능한 의사 난수 불투명 RGBA
function randomRgba(width: number, height: number, seed: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4)
  let state = seed
  for (let index = 0; index < rgba.length; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0
    rgba[index] = index % 4 === 3 ? 255 : state >>> 24
  }
  return rgba
}

// 중간 화소마다 원본 화소와 겹친 면적을 채널별로 직접 적분하고, 캔버스처럼 8비트로 반올림한 RGBA
function bruteForceCanvas(rgba: Uint8ClampedArray, width: number, height: number, targetWidth: number, targetHeight: number) {
  const scaleX = width / targetWidth
  const scaleY = height / targetHeight
  const overlap = (start: number, end: number, cell: number) => Math.max(0, Math.min(end, cell + 1) - Math.max(start, cell))
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4)
  for (let ty = 0; ty < targetHeight; ty += 1) {
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const sums = [0, 0, 0]
      for (let y = 0; y < height; y += 1) {
        const wy = overlap(ty * scaleY, (ty + 1) * scaleY, y)
        if (wy === 0) continue
        for (let x = 0; x < width; x += 1) {
          const wx = overlap(tx * scaleX, (tx + 1) * scaleX, x)
          if (wx > 0) for (let c = 0; c < 3; c += 1) sums[c]! += wx * wy * rgba[(y * width + x) * 4 + c]!
        }
      }
      const index = (ty * targetWidth + tx) * 4
      for (let c = 0; c < 3; c += 1) out[index + c] = Math.round(sums[c]! / (scaleX * scaleY))
      out[index + 3] = 255
    }
  }
  return out
}

function downsampleInStrips(rgba: Uint8ClampedArray, width: number, height: number, strip: number, size?: { width: number; height: number }) {
  const downsampler = createAnalysisDownsampler(width, height, size)
  for (let y = 0; y < height; y += strip) {
    const rows = Math.min(strip, height - y)
    downsampler.addRows(rgba.subarray(y * width * 4, (y + rows) * width * 4), y)
  }
  return downsampler.finish()
}

const expectClose = (actual: Float32Array, expected: Float32Array) => {
  expect(actual.length).toBe(expected.length)
  for (let index = 0; index < expected.length; index += 1) expect(actual[index]).toBeCloseTo(expected[index]!, 4)
}

describe('createAnalysisDownsampler', () => {
  it('only converts to grayscale when the photo is within the analysis size', () => {
    const rgba = randomRgba(37, 23, 1)
    expect(downsampleInStrips(rgba, 37, 23, 5, { width: 37, height: 23 })).toEqual(toGrayscale(rgba, 37, 23))
    const photo = randomRgba(300, 200, 2)
    expect(downsampleInStrips(photo, 300, 200, 7)).toEqual(toGrayscale(photo, 300, 200))
  })

  it('area-averages each channel straight to the analysis size and rounds like a canvas when the photo is less than twice as large', () => {
    for (const [width, height, size] of [
      [63, 47, { width: 40, height: 30 }],
      [101, 77, { width: 64, height: 49 }],
    ] as const) {
      const rgba = randomRgba(width, height, width * height)
      const expected = toGrayscale(bruteForceCanvas(rgba, width, height, size.width, size.height), size.width, size.height)
      const actual = downsampleInStrips(rgba, width, height, 9, size)
      expect(actual.width).toBe(size.width)
      expect(actual.height).toBe(size.height)
      expectClose(actual.pixels, expected.pixels)
    }
  })

  it('goes through a rounded twice-size image and a 2x2 average when the photo is at least twice as large', () => {
    for (const [width, height, size] of [
      [70, 50, { width: 20, height: 14 }],
      [97, 61, { width: 31, height: 19 }],
    ] as const) {
      const rgba = randomRgba(width, height, width + height)
      const middle = toGrayscale(bruteForceCanvas(rgba, width, height, size.width * 2, size.height * 2), size.width * 2, size.height * 2)
      const expected = downsampleByAverage(middle, 2)
      const actual = downsampleInStrips(rgba, width, height, 11, size)
      expectClose(actual.pixels, expected.pixels)
    }
  })

  it('uses the product analysis size by default', () => {
    const rgba = randomRgba(1300, 200, 5)
    const result = downsampleInStrips(rgba, 1300, 200, 40)
    expect({ width: result.width, height: result.height }).toEqual(getAnalysisSize(1300, 200))
  })

  it('gives the same result whatever the strip height', () => {
    const rgba = randomRgba(90, 61, 3)
    const size = { width: 32, height: 21 }
    const whole = downsampleInStrips(rgba, 90, 61, 61, size)
    for (const strip of [1, 4, 13, 60]) expect(downsampleInStrips(rgba, 90, 61, strip, size)).toEqual(whole)
  })

  it('keeps a flat colour flat', () => {
    const rgba = new Uint8ClampedArray(31 * 19 * 4)
    for (let index = 0; index < rgba.length; index += 4) rgba.set([200, 100, 50, 255], index)
    const result = downsampleInStrips(rgba, 31, 19, 4, { width: 10, height: 7 })
    for (const value of result.pixels) expect(value).toBeCloseTo(0.299 * 200 + 0.587 * 100 + 0.114 * 50, 4)
  })

  it('rejects upscaling, invalid sizes, gaps, overflow and early finish', () => {
    expect(() => createAnalysisDownsampler(10, 10, { width: 11, height: 10 })).toThrow()
    expect(() => createAnalysisDownsampler(10, 10, { width: 0, height: 10 })).toThrow()
    expect(() => createAnalysisDownsampler(10.5, 10, { width: 5, height: 5 })).toThrow()
    expect(() => createAnalysisDownsampler(40, 40)).toThrow()

    const rgba = randomRgba(10, 10, 4)
    const size = { width: 5, height: 5 }
    const gap = createAnalysisDownsampler(10, 10, size)
    gap.addRows(rgba.subarray(0, 10 * 4 * 2), 0)
    expect(() => gap.addRows(rgba.subarray(0, 10 * 4 * 2), 3)).toThrow()
    expect(() => gap.finish()).toThrow()

    const partialRow = createAnalysisDownsampler(10, 10, size)
    expect(() => partialRow.addRows(rgba.subarray(0, 10 * 4 + 4), 0)).toThrow()

    const overflow = createAnalysisDownsampler(10, 10, size)
    overflow.addRows(rgba, 0)
    expect(() => overflow.addRows(rgba.subarray(0, 40), 10)).toThrow()
  })
})
