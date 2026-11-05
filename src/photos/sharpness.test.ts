import { describe, expect, it } from 'vitest'
import {
  addNoise,
  angledMotionBlur,
  composite,
  gaussianBlur,
  motionBlur,
  renderBricks,
  renderChecker,
  renderGradient,
  renderHorizon,
  renderScene,
  renderStreaks,
  renderStripes,
  renderUniform,
  scaleContrast,
  transpose,
} from '../test/syntheticImages.ts'
import { createMeasurement } from '../test/measurements.ts'
import { classifyAnalysisImage, evaluateAnalysisImage } from './analyzeImageSharpness.ts'
import {
  SHAKE_MIN_REGIONS,
  SHAKE_MIN_SPREAD,
  SHARP_RATIO_THRESHOLD,
  classifySharpness,
  downsampleByAverage,
  estimateBlurCause,
  estimateNoise,
  getAnalysisSize,
  hasConsistentShake,
  measureSharpness,
  toGrayscale,
  type GrayImage,
  type SharpnessMeasurement,
  type SharpnessVerdict,
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
    expect(classifySharpness(createMeasurement({ score: null }))).toBe('low-detail')
    expect(classifySharpness(createMeasurement({ score: SHARP_RATIO_THRESHOLD / 2, hasUnjudgedDirection: true }))).toBe('blurry')
    expect(classifySharpness(createMeasurement({ score: SHARP_RATIO_THRESHOLD * 2, hasUnjudgedDirection: true }))).toBe('low-detail')
    expect(classifySharpness(createMeasurement({ score: SHARP_RATIO_THRESHOLD }))).toBe('sharp')
  })

  it('maps verdicts to results without treating undecidable photos as blurry', () => {
    expect(classifyAnalysisImage(gaussianBlur(scene(1), 0.8))).toEqual({ status: 'sharp' })
    expect(classifyAnalysisImage(gaussianBlur(scene(1), 3))).toEqual({ status: 'blurry', cause: 'defocus' })
    expect(classifyAnalysisImage(renderUniform(WIDTH, HEIGHT))).toEqual({ status: 'unavailable', reason: 'low-detail' })
  })

  // 개발용 평가 도구는 판정과 함께 측정값을 받는다. 판정은 사용자 화면과 같은 함수에서 나와야 한다.
  it('gives the evaluation tool the same verdict as the gallery plus the measurement it was based on', () => {
    const images = [
      gaussianBlur(scene(1), 0.8),
      gaussianBlur(scene(2), 3),
      motionBlur(gaussianBlur(scene(3), 0.6), 9),
      addNoise(gaussianBlur(scene(4), 2), 1, 4),
      renderUniform(WIDTH, HEIGHT),
    ]
    for (const image of images) {
      const { result, measurement } = evaluateAnalysisImage(image)
      expect(result).toEqual(classifyAnalysisImage(image))
      expect(measurement).toEqual(measureSharpness(image))
    }
    expect(evaluateAnalysisImage(null)).toEqual({ result: { status: 'unavailable', reason: 'too-small' }, measurement: null })
  })
})

// 흔들림·초점 불량 추정과 긴 흔들림 판정. 기준값은 1024×768 합성 장면(seed 1~5, 13)에서 측정해 정했다(실제 사진 보정이 아니다).
// 측정 요약(가우시안 σ0.8 기본 흐림 + 잡음 0.3, 각 6장):
//   선명 24장(기본·저대비·배경 흐림·하늘): 모두 선명, 흔들림 근거 구역 0~3개, 반대 구역 3~50개
//   초점 불량 σ2·σ3: 12장 모두 defocus / σ1.5·σ5: 12장 중 8장 defocus, 4장 unknown
//   가로·세로 흔들림 9화소: 12장 중 10장 shake, 2장 unknown / 15·25화소: 24장 모두 shake / 41화소: 12장 중 10장 shake, 2장 선명
//   비스듬한 흔들림(30·45·120도): 수직 방향도 함께 흐려져 shake로 단정하지 않는다(unknown 또는 분석 불가)
//   방향성이 강한 선명한 장면 102장(줄무늬·바둑판·벽돌·수평선·물결·배경 흐림 위 줄무늬, 잡음 0.3·1): 흐림 의심 0장
// 이전 판정(흔들림 근거 없이 방향별 점수만 보던 판정)과 달라진 경우는 모두 흔들림 장면이 분석 불가·선명에서 흔들림 의심으로 바뀐 것이다.
const CAUSE_WIDTH = 1024
const CAUSE_HEIGHT = 768
const CAUSE_SEEDS = [1, 2, 3]

const lensScene = (seed: number) => gaussianBlur(renderScene(CAUSE_WIDTH, CAUSE_HEIGHT, seed), 0.8)
const horizontalShake = (seed: number, length: number) => addNoise(motionBlur(lensScene(seed), length), 0.3, seed)
const verticalShake = (seed: number, length: number) =>
  addNoise(transpose(motionBlur(transpose(lensScene(seed)), length)), 0.3, seed)

function judgeWithCause(image: GrayImage) {
  const measurement = measureSharpness(image)
  const verdict = classifySharpness(measurement)
  return { verdict, cause: verdict === 'blurry' ? estimateBlurCause(measurement) : null, measurement }
}

// 흔들림 근거를 보지 않던 이전 판정. 새 판정이 이전 판정을 바꾸는 경로가 흔들림 근거 하나뿐인지 확인하는 데 쓴다.
function previousVerdict({ score, hasUnjudgedDirection }: SharpnessMeasurement): SharpnessVerdict {
  if (score === null) return 'low-detail'
  if (score < SHARP_RATIO_THRESHOLD) return 'blurry'
  return hasUnjudgedDirection ? 'low-detail' : 'sharp'
}

// 방향성이 강한 선명한 장면. 수평선·줄무늬·반복 무늬·한 방향으로 긴 결은 흔들림과 비슷한 방향별 차이를 만든다.
function directionalSharpScenes(): [string, GrayImage][] {
  const lens = (image: GrayImage) => gaussianBlur(image, 0.8)
  const blurredBackground = gaussianBlur(renderScene(CAUSE_WIDTH, CAUSE_HEIGHT, 7), 5)
  const scenes: [string, GrayImage][] = []
  for (const period of [4, 8, 12, 24, 40]) {
    scenes.push([`horizontal stripes ${period}px`, lens(renderStripes(CAUSE_WIDTH, CAUSE_HEIGHT, period))])
    scenes.push([`vertical stripes ${period}px`, lens(renderStripes(CAUSE_WIDTH, CAUSE_HEIGHT, period, 90))])
  }
  for (const angle of [3, 30, 45]) scenes.push([`tilted stripes ${angle}°`, lens(renderStripes(CAUSE_WIDTH, CAUSE_HEIGHT, 24, angle))])
  scenes.push(['checker 8px', lens(renderChecker(CAUSE_WIDTH, CAUSE_HEIGHT, 8))])
  scenes.push(['checker 32px', lens(renderChecker(CAUSE_WIDTH, CAUSE_HEIGHT, 32))])
  scenes.push(['bricks', lens(renderBricks(CAUSE_WIDTH, CAUSE_HEIGHT))])
  scenes.push(['horizon', lens(renderHorizon(CAUSE_WIDTH, CAUSE_HEIGHT))])
  for (const length of [15, 31]) {
    const streaks = renderStreaks(CAUSE_WIDTH, CAUSE_HEIGHT, length, 5)
    scenes.push([`streaks ${length}px`, streaks])
    scenes.push([`vertical streaks ${length}px`, transpose(renderStreaks(CAUSE_HEIGHT, CAUSE_WIDTH, length, 5))])
    scenes.push([`scene above streaks ${length}px`, composite(streaks, lensScene(6), { x: 0, y: 0, w: 1, h: 0.45 })])
    scenes.push([`horizon above streaks ${length}px`, composite(streaks, lens(renderHorizon(CAUSE_WIDTH, CAUSE_HEIGHT)), { x: 0, y: 0, w: 1, h: 0.5 })])
  }
  for (const angle of [0, 90]) {
    const stripes = lens(renderStripes(CAUSE_WIDTH, CAUSE_HEIGHT, 20, angle))
    scenes.push([`stripes ${angle}° over blurred background`, composite(blurredBackground, stripes, { x: 0, y: 0.3, w: 1, h: 0.3 })])
    scenes.push([`thin stripes ${angle}° over blurred background`, composite(blurredBackground, stripes, { x: 0.1, y: 0.45, w: 0.8, h: 0.1 })])
  }
  // 카메라 사진처럼 약한 잡음을 넣는다. 잡음이 없는 배경 흐림 위 줄무늬는 원래 있던 한계다(blurDetectionLimits.test.ts).
  return scenes.map(([name, image], index) => [name, addNoise(image, 0.3, index + 1)])
}

// 1024×768 장면을 많이 만들므로 시간이 걸린다.
describe('blur cause and long camera shake', { timeout: 60_000 }, () => {
  it('suggests defocus when every direction is evenly soft', () => {
    for (const sigma of [2, 3]) {
      for (const seed of CAUSE_SEEDS) {
        const { verdict, cause } = judgeWithCause(addNoise(gaussianBlur(lensScene(seed), sigma), 0.3, seed))
        expect([verdict, cause], `σ${sigma} seed ${seed}`).toEqual(['blurry', 'defocus'])
      }
    }
  })

  it('suggests camera shake when one direction is smeared while the perpendicular direction stays sharp', () => {
    for (const seed of CAUSE_SEEDS) {
      for (const [name, image] of [
        ['horizontal 9px', horizontalShake(seed, 9)],
        ['vertical 9px', verticalShake(seed, 9)],
        ['horizontal 15px', horizontalShake(seed, 15)],
        ['vertical 15px', verticalShake(seed, 15)],
      ] as const) {
        const { verdict, cause } = judgeWithCause(image)
        expect([verdict, cause], `${name} seed ${seed}`).toEqual(['blurry', 'shake'])
      }
    }
  })

  // 원인을 구분할 근거가 부족하면 원인을 단정하지 않고 흐림 의심으로만 둔다.
  it('leaves the cause unknown when the evidence does not clearly point to one cause', () => {
    // 비스듬한 흔들림은 4방향 중 어느 방향과도 맞지 않아 수직 방향도 함께 흐려진다.
    for (const seed of CAUSE_SEEDS) {
      expect(judgeWithCause(addNoise(angledMotionBlur(lensScene(seed), 25, 30), 0.3, seed)), `30° seed ${seed}`).toMatchObject({
        verdict: 'blurry',
        cause: 'unknown',
      })
    }
    // 경계에 가까운 약한 초점 흐림은 대각선과 가로·세로 점수 차이가 커 초점 불량으로 단정하지 않는다.
    expect(judgeWithCause(addNoise(gaussianBlur(lensScene(1), 1.5), 0.3, 1))).toMatchObject({ verdict: 'blurry', cause: 'unknown' })
  })

  it('flags long one-direction shake that the per-direction scores alone call undecidable or sharp', () => {
    for (const seed of CAUSE_SEEDS) {
      for (const [name, image] of [
        ['horizontal 25px', horizontalShake(seed, 25)],
        ['vertical 25px', verticalShake(seed, 25)],
      ] as const) {
        const { verdict, cause, measurement } = judgeWithCause(image)
        expect([verdict, cause], `${name} seed ${seed}`).toEqual(['blurry', 'shake'])
        // 방향별 점수만으로는 흐림이 아니었다. 흔들림 근거가 이 판정을 바꾼 유일한 이유다.
        expect(previousVerdict(measurement), `${name} seed ${seed}`).not.toBe('blurry')
        expect(hasConsistentShake(measurement)).toBe(true)
      }
    }
    for (const seed of [1, 2]) {
      expect(judgeWithCause(horizontalShake(seed, 41)), `41px seed ${seed}`).toMatchObject({ verdict: 'blurry', cause: 'shake' })
    }
  })

  it('never turns a sharp photo into a blur suspicion, including strongly directional scenes', () => {
    const sharpScenes: [string, GrayImage][] = CAUSE_SEEDS.flatMap((seed): [string, GrayImage][] => [
      [`scene ${seed}`, addNoise(lensScene(seed), 0.3, seed)],
      [`low contrast ${seed}`, scaleContrast(lensScene(seed), 0.2)],
      [
        `background blur ${seed}`,
        composite(gaussianBlur(renderScene(CAUSE_WIDTH, CAUSE_HEIGHT, seed), 4), lensScene(seed), { x: 0.45, y: 0.4, w: 0.12, h: 0.16 }),
      ],
      [`sky ${seed}`, composite(renderGradient(CAUSE_WIDTH, CAUSE_HEIGHT), lensScene(seed), { x: 0, y: 0.8, w: 1, h: 0.2 })],
    ])
    for (const [name, image] of [...sharpScenes, ...directionalSharpScenes()]) {
      const measurement = measureSharpness(image)
      expect(classifySharpness(measurement), name).not.toBe('blurry')
      expect(hasConsistentShake(measurement), name).toBe(false)
      expect(classifySharpness(measurement), name).toBe(previousVerdict(measurement))
    }
  })

  // 기존 판정을 바꾸는 경로는 흔들림 근거 하나뿐이고, 바뀐다면 언제나 흔들림 의심이다.
  it('changes a previous verdict only to a shake suspicion backed by consistent shake evidence', () => {
    const images = [
      ...[1, 2].flatMap((seed) => [horizontalShake(seed, 5), horizontalShake(seed, 25), verticalShake(seed, 41)]),
      ...[1, 2].map((seed) => addNoise(gaussianBlur(lensScene(seed), 2), 0.3, seed)),
      addNoise(angledMotionBlur(lensScene(1), 25, 45), 0.3, 1),
      ...[1, 2].map((seed) => addNoise(lensScene(seed), 0.3, seed)),
    ]
    let changed = 0
    for (const image of images) {
      const { verdict, cause, measurement } = judgeWithCause(image)
      if (verdict === previousVerdict(measurement)) continue
      changed += 1
      expect(verdict).toBe('blurry')
      expect(cause).toBe('shake')
      expect(hasConsistentShake(measurement)).toBe(true)
    }
    expect(changed).toBeGreaterThan(0)
  })
})

describe('shake evidence rules', () => {
  // 모든 근거가 일치하는 측정값. 하나씩 어긋나게 해 각 근거가 독립적으로 흔들림 판정을 막는지 확인한다.
  const consistent = createMeasurement({
    score: 0.09,
    directionScores: [null, 0.09, 0.08, 0.08],
    shake: { direction: 0, regions: 12, rows: 5, columns: 6, contradictingRegions: 0 },
    isotropicBlurRegions: 2,
  })
  const withShake = (shake: Partial<NonNullable<SharpnessMeasurement['shake']>>) =>
    createMeasurement({ ...consistent, shake: { ...consistent.shake!, ...shake } })

  it('requires every independent piece of shake evidence to agree', () => {
    expect(hasConsistentShake(consistent)).toBe(true)
    expect(classifySharpness(consistent)).toBe('blurry')
    expect(estimateBlurCause(consistent)).toBe('shake')

    expect(hasConsistentShake(createMeasurement({ ...consistent, shake: null }))).toBe(false)
    expect(hasConsistentShake(withShake({ regions: SHAKE_MIN_REGIONS - 1 }))).toBe(false)
    expect(hasConsistentShake(withShake({ rows: SHAKE_MIN_SPREAD - 1 }))).toBe(false)
    expect(hasConsistentShake(withShake({ columns: SHAKE_MIN_SPREAD - 1 }))).toBe(false)
    expect(hasConsistentShake(withShake({ contradictingRegions: 1 }))).toBe(false)
    // 모든 방향이 흐린 구역이 많으면 배경 흐림·초점 불량일 수 있다.
    expect(hasConsistentShake(createMeasurement({ ...consistent, isotropicBlurRegions: 7 }))).toBe(false)
    // 끌린 방향에 수직인 방향이 선명하지 않거나 판정되지 않았다.
    expect(hasConsistentShake(createMeasurement({ ...consistent, directionScores: [null, null, 0.08, 0.08] }))).toBe(false)
    expect(hasConsistentShake(createMeasurement({ ...consistent, directionScores: [null, 0.02, 0.08, 0.08] }))).toBe(false)
    // 근거가 어긋나면 이전 판정(선명)을 그대로 둔다.
    expect(classifySharpness(withShake({ contradictingRegions: 1 }))).toBe('sharp')
  })

  it('suggests defocus only when perpendicular directions agree and many regions are soft in every direction', () => {
    const soft = createMeasurement({ score: 0.015, directionScores: [0.015, 0.016, 0.02, 0.021], isotropicBlurRegions: 40 })
    expect(estimateBlurCause(soft)).toBe('defocus')
    // 아주 흐려 가로·세로를 모두 판정하지 못해도 대각선 짝이 맞으면 초점 불량으로 본다.
    expect(estimateBlurCause(createMeasurement({ ...soft, directionScores: [null, null, 0.011, 0.011] }))).toBe('defocus')
    // 짝 중 한 방향만 판정했다.
    expect(estimateBlurCause(createMeasurement({ ...soft, directionScores: [0.015, null, 0.02, 0.021] }))).toBe('unknown')
    // 짝 안의 점수 차이가 크다.
    expect(estimateBlurCause(createMeasurement({ ...soft, directionScores: [0.015, 0.016, 0.02, 0.031] }))).toBe('unknown')
    // 판정한 방향 전체의 점수 차이가 크다.
    expect(estimateBlurCause(createMeasurement({ ...soft, directionScores: [0.01, 0.01, 0.022, 0.022] }))).toBe('unknown')
    expect(estimateBlurCause(createMeasurement({ ...soft, isotropicBlurRegions: 2 }))).toBe('unknown')
  })
})
