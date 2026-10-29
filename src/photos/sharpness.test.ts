import { describe, expect, it } from 'vitest'
import {
  addNoise,
  composite,
  gaussianBlur,
  motionBlur,
  renderGradient,
  renderScene,
  renderUniform,
  scaleContrast,
} from '../test/syntheticImages.ts'
import { classifyAnalysisImage } from './analyzeImageSharpness.ts'
import {
  SHARP_RATIO_THRESHOLD,
  classifySharpness,
  downsampleByAverage,
  estimateNoise,
  getAnalysisSize,
  measureSharpness,
  toGrayscale,
  type GrayImage,
} from './sharpness.ts'

// 임계값 근거: 재현 가능한 합성 장면(사각형·원·선·글자 획, seed 고정)을 분석 크기에서 가우시안·흔들림 흐림으로 흐리고
// 잡음·대비·배경 흐림·하늘·해상도를 바꿔 판정을 측정했다. 실제 카메라 사진으로 보정한 값이 아니다(README의 한계 참고).
// 측정한 점수(SHARP_RATIO_THRESHOLD = 0.025 기준, 1024×768, seed 1~8):
//   가우시안 σ=0.8 → 0.094~0.117, σ=1 → 0.056~0.065, σ=1.25 → 0.032~0.041  (모두 선명)
//   σ=1.5 → 0.021~0.026 (8개 중 7개 흐림), σ=1.75 → 0.015~0.019, σ=2 → 0.012~0.015 (모두 흐림)
// 단위 테스트는 시간을 줄이려고 대부분 640×480에서 같은 경향을 확인한다.
const WIDTH = 640
const HEIGHT = 480
const SEEDS = [1, 2, 3, 4]

const verdictOf = (image: GrayImage) => classifySharpness(measureSharpness(image))
const verdicts = (make: (seed: number) => GrayImage) => SEEDS.map((seed) => verdictOf(make(seed)))
const scene = (seed: number, width = WIDTH, height = HEIGHT) => renderScene(width, height, seed)

describe('analysis image preparation', () => {
  it('shrinks large photos to the analysis size and keeps small photos at their own size', () => {
    expect(getAnalysisSize(4032, 3024)).toEqual({ width: 1024, height: 768 })
    expect(getAnalysisSize(3024, 4032)).toEqual({ width: 768, height: 1024 })
    expect(getAnalysisSize(640, 480)).toEqual({ width: 640, height: 480 })
  })

  it('refuses images too small or too thin to judge', () => {
    expect(getAnalysisSize(63, 400)).toBeNull()
    expect(getAnalysisSize(4000, 200)).toBeNull()
    expect(getAnalysisSize(0, 0)).toBeNull()
    expect(classifyAnalysisImage(null)).toEqual({ status: 'unavailable', reason: 'too-small' })
  })

  it('converts RGBA to luminance and averages blocks when shrinking', () => {
    const gray = toGrayscale(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 10, 10, 255]), 2, 2)
    expect(Array.from(gray.pixels).map((value) => Math.round(value * 10) / 10)).toEqual([76.2, 149.7, 29.1, 10])
    expect(() => toGrayscale(new Uint8ClampedArray(12), 2, 2)).toThrow()

    const small = downsampleByAverage({ width: 4, height: 2, pixels: new Float32Array([0, 2, 4, 6, 2, 4, 6, 8]) }, 2)
    expect(small).toEqual({ width: 2, height: 1, pixels: new Float32Array([2, 6]) })
  })

  it('estimates pixel noise without counting straight edges as noise', () => {
    expect(estimateNoise(addNoise(renderUniform(WIDTH, HEIGHT), 2, 1))).toBeCloseTo(2, 0)
    expect(estimateNoise(gaussianBlur(scene(1), 0.8))).toBeLessThan(0.5)
  })
})

describe('sharpness verdict', () => {
  it('treats photos with only slight softness as sharp', () => {
    expect(verdicts((seed) => gaussianBlur(scene(seed), 0.8))).toEqual(['sharp', 'sharp', 'sharp', 'sharp'])
    expect(verdicts((seed) => gaussianBlur(scene(seed), 1))).toEqual(['sharp', 'sharp', 'sharp', 'sharp'])
  })

  it('flags out-of-focus photos', () => {
    for (const sigma of [2, 3, 5]) {
      expect(verdicts((seed) => gaussianBlur(scene(seed), sigma))).toEqual(['blurry', 'blurry', 'blurry', 'blurry'])
    }
  })

  // 흔들림은 한 방향의 미세 경계만 지우므로 방향별로 본다. 1024×768에서 9·15화소 흔들림은 seed 8개 중 7개를 찾고,
  // seed 4는 놓친다(선명으로 판정). 5화소 이하의 약한 흔들림과 25화소 이상의 긴 흔들림은 절반 이상 놓친다.
  it('flags most camera-shake photos at the analysis size', () => {
    const shaken = (seed: number) => motionBlur(gaussianBlur(scene(seed, 1024, 768), 0.6), 9)
    expect([1, 2, 3, 5].map((seed) => verdictOf(shaken(seed)))).toEqual(['blurry', 'blurry', 'blurry', 'blurry'])
    expect(verdictOf(shaken(4))).toBe('sharp')
  })

  it('does not flag sharp photos because of low contrast, background blur or a large plain sky', () => {
    expect(verdicts((seed) => scaleContrast(gaussianBlur(scene(seed), 0.8), 0.2))).toEqual(['sharp', 'sharp', 'sharp', 'sharp'])
    const bokeh = (seed: number) =>
      composite(gaussianBlur(scene(seed), 4), gaussianBlur(scene(seed), 0.8), { x: 0.45, y: 0.4, w: 0.12, h: 0.16 })
    expect(verdicts(bokeh)).toEqual(['sharp', 'sharp', 'sharp', 'sharp'])
    const sky = (seed: number) =>
      composite(renderGradient(WIDTH, HEIGHT), gaussianBlur(scene(seed), 0.8), { x: 0, y: 0.8, w: 1, h: 0.2 })
    expect(verdicts(sky)).toEqual(['sharp', 'sharp', 'sharp', 'sharp'])
  })

  it('still flags blurry photos that are low in contrast or mostly sky', () => {
    expect(verdicts((seed) => scaleContrast(gaussianBlur(scene(seed), 2), 0.2))).toEqual(['blurry', 'blurry', 'blurry', 'blurry'])
    const sky = (seed: number) =>
      composite(renderGradient(WIDTH, HEIGHT), gaussianBlur(scene(seed), 2), { x: 0, y: 0.8, w: 1, h: 0.2 })
    expect(verdicts(sky)).toEqual(['blurry', 'blurry', 'blurry', 'blurry'])
  })

  it('does not judge plain walls, smooth gradients or pure noise as blurry', () => {
    expect(verdictOf(renderUniform(WIDTH, HEIGHT))).toBe('low-detail')
    expect(verdictOf(renderGradient(WIDTH, HEIGHT, 0, 255))).toBe('low-detail')
    expect(verdicts((seed) => addNoise(renderUniform(WIDTH, HEIGHT), 1, seed))).toEqual([
      'low-detail',
      'low-detail',
      'low-detail',
      'low-detail',
    ])
  })

  // 잡음은 미세 경계처럼 보여 흐린 사진을 선명하게 보이게 한다. 잡음이 있어도 흐린 사진을 선명하다고 단정하지 않는다.
  it('never calls a noisy blurry photo sharp', () => {
    expect(verdicts((seed) => addNoise(gaussianBlur(scene(seed), 2), 1, seed))).not.toContain('sharp')
    const noisyShake = (seed: number) => addNoise(motionBlur(gaussianBlur(scene(seed), 0.6), 9), 1, seed)
    expect(verdicts(noisyShake)).not.toContain('sharp')
    expect(verdicts((seed) => addNoise(gaussianBlur(scene(seed), 0.8), 0.5, seed))).toEqual(['sharp', 'sharp', 'sharp', 'sharp'])
  })

  it('gives the same verdict for the same scene at different resolutions', () => {
    for (const [width, height] of [[320, 240], [640, 480], [1024, 768]] as const) {
      expect(verdictOf(gaussianBlur(scene(1, width, height), 0.8)), `${width} sharp`).toBe('sharp')
      expect(verdictOf(gaussianBlur(scene(1, width, height), 2)), `${width} blurry`).toBe('blurry')
    }
  })

  it('reports blur only from judged directions and withholds a sharp verdict when a direction could not be judged', () => {
    expect(classifySharpness({ score: null, hasUnjudgedDirection: false, noise: 0 })).toBe('low-detail')
    expect(classifySharpness({ score: SHARP_RATIO_THRESHOLD / 2, hasUnjudgedDirection: true, noise: 1 })).toBe('blurry')
    expect(classifySharpness({ score: SHARP_RATIO_THRESHOLD * 2, hasUnjudgedDirection: true, noise: 1 })).toBe('low-detail')
    expect(classifySharpness({ score: SHARP_RATIO_THRESHOLD, hasUnjudgedDirection: false, noise: 0 })).toBe('sharp')
  })

  it('maps verdicts to results without treating undecidable photos as blurry', () => {
    expect(classifyAnalysisImage(gaussianBlur(scene(1), 0.8))).toEqual({ status: 'sharp' })
    expect(classifyAnalysisImage(gaussianBlur(scene(1), 3))).toEqual({ status: 'blurry' })
    expect(classifyAnalysisImage(renderUniform(WIDTH, HEIGHT))).toEqual({ status: 'unavailable', reason: 'low-detail' })
  })
})
