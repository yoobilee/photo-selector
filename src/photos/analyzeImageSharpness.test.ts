import { afterEach, describe, expect, it, vi } from 'vitest'
import { gaussianBlur, motionBlur, renderScene, renderUniform } from '../test/syntheticImages.ts'
import {
  ANALYSIS_STRIP_PIXELS,
  ANALYSIS_TILE_EDGE,
  decodeAnalysisImage,
  evaluateAnalysisImage,
  evaluatePhotoImage,
  type CreateAnalysisContext,
} from './analyzeImageSharpness.ts'
import { createAnalysisDownsampler } from './analysisDownsample.ts'
import { createPhotoFingerprint } from './photoFingerprint.ts'
import { getAnalysisSize, toGrayscale, type GrayImage } from './sharpness.ts'

// 큰 Float32Array를 toEqual로 비교하면 원소마다 깊은 비교를 해 수 초가 걸린다. 크기와 모든 화소 값의 정확한 일치를 직접 확인한다.
function expectSameImage(actual: GrayImage | null, expected: GrayImage) {
  expect(actual).not.toBeNull()
  expect([actual!.width, actual!.height, actual!.pixels.length]).toEqual([expected.width, expected.height, expected.pixels.length])
  expect(actual!.pixels.findIndex((value, index) => !Object.is(value, expected.pixels[index]))).toBe(-1)
}

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

interface DrawCall {
  readonly source: readonly [number, number, number, number]
  readonly destination: readonly [number, number, number, number]
}

// 원본 화소를 그대로 돌려주는 가짜 ImageBitmap과 2D 컨텍스트. 축소 없이 그렸는지와 캔버스 크기를 기록한다.
function fakeDecoder(width: number, height: number, source: Uint8ClampedArray) {
  const bitmap = { width, height, close: vi.fn() }
  const draws: DrawCall[] = []
  const canvases: { width: number; height: number }[] = []
  let smoothing: boolean | null = null
  const createContext: CreateAnalysisContext = (canvasWidth, canvasHeight) => {
    const canvas = { width: canvasWidth, height: canvasHeight }
    canvases.push(canvas)
    const pixels = new Uint8ClampedArray(canvasWidth * canvasHeight * 4)
    const context = {
      canvas,
      fillStyle: '',
      imageSmoothingQuality: 'low',
      set imageSmoothingEnabled(value: boolean) {
        smoothing = value
      },
      get imageSmoothingEnabled() {
        return smoothing ?? true
      },
      fillRect(x: number, y: number, w: number, h: number) {
        for (let row = y; row < y + h; row += 1) pixels.fill(255, (row * canvasWidth + x) * 4, (row * canvasWidth + x + w) * 4)
      },
      drawImage(_image: unknown, ...args: number[]) {
        const [sx, sy, sw, sh, dx, dy, dw, dh] = args as [number, number, number, number, number, number, number, number]
        draws.push({ source: [sx, sy, sw, sh], destination: [dx, dy, dw, dh] })
        for (let row = 0; row < Math.min(sh, dh); row += 1) {
          const from = ((sy + row) * width + sx) * 4
          pixels.set(source.subarray(from, from + Math.min(sw, dw) * 4), ((dy + row) * canvasWidth + dx) * 4)
        }
      },
      getImageData(x: number, y: number, w: number, h: number) {
        const data = new Uint8ClampedArray(w * h * 4)
        for (let row = 0; row < h; row += 1) {
          const from = ((y + row) * canvasWidth + x) * 4
          data.set(pixels.subarray(from, from + w * 4), row * w * 4)
        }
        return { data }
      },
    }
    return context as unknown as CanvasRenderingContext2D
  }
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
  return { bitmap, draws, canvases, createContext, smoothing: () => smoothing }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('decodeAnalysisImage', () => {
  it('reads the original 1:1 in bounded tiles and area-averages it in JS', async () => {
    // 타일 폭보다 넓은 원본: 띠마다 여러 타일로 나눠 읽어야 한다.
    const width = ANALYSIS_TILE_EDGE + 300
    const height = 300
    const source = randomRgba(width, height, 7)
    const fake = fakeDecoder(width, height, source)

    const image = await decodeAnalysisImage(new Blob(), fake.createContext)

    const size = getAnalysisSize(width, height)!
    const reference = createAnalysisDownsampler(width, height, size)
    reference.addRows(source, 0)
    expectSameImage(image, reference.finish())
    // 브라우저 보간이 끼지 않도록 모든 그리기는 같은 크기의 1:1 복사이고 보간을 끈다.
    expect(fake.draws.length).toBeGreaterThan(1)
    for (const { source: [, , sw, sh], destination: [, , dw, dh] } of fake.draws) {
      expect([dw, dh]).toEqual([sw, sh])
    }
    expect(fake.smoothing()).toBe(false)
    // 원본 크기 캔버스를 만들지 않는다. 캔버스 폭·화소 수에 상한이 있다.
    for (const canvas of fake.canvases) expect(canvas).toEqual({ width: 0, height: 0 })
    expect(fake.draws.every(({ destination: [, , dw, dh] }) => dw <= ANALYSIS_TILE_EDGE && dw * dh <= ANALYSIS_STRIP_PIXELS)).toBe(true)
    // 원본의 모든 화소를 정확히 한 번 읽는다.
    const covered = fake.draws.reduce((sum, { source: [, , sw, sh] }) => sum + sw * sh, 0)
    expect(covered).toBe(width * height)
    expect(fake.bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('keeps photos within the analysis size unscaled', async () => {
    const source = randomRgba(700, 500, 9)
    const fake = fakeDecoder(700, 500, source)
    expectSameImage(await decodeAnalysisImage(new Blob(), fake.createContext), toGrayscale(source, 700, 500))
  })

  it('returns null for photos too small to analyze without drawing', async () => {
    const fake = fakeDecoder(80, 40, randomRgba(80, 40, 3))
    expect(await decodeAnalysisImage(new Blob(), fake.createContext)).toBeNull()
    expect(fake.draws).toEqual([])
    expect(fake.bitmap.close).toHaveBeenCalledTimes(1)
  })
})

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
