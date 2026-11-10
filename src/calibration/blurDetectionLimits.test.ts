import { describe, expect, it } from 'vitest'
import { classifySharpness, downsampleByAverage, estimateBlurCause, measureSharpness, type GrayImage } from '../photos/sharpness.ts'
import {
  addNoise,
  composite,
  createRandom,
  gaussianBlur,
  motionBlur,
  renderScene,
  renderStripes,
} from '../test/syntheticImages.ts'

// 실제 사진 18장 평가(2026-10-30)에서 본 미탐·분석 불가와 같은 모양의 결과를 합성 이미지로 재현해 현재 판정의 한계를 기록한다.
// 실제 사진이 아니므로 실제 사진의 원인을 증명하지 않는다. 판정 로직·임계값을 바꾸면 이 기록도 함께 다시 확인한다.

function judge(image: GrayImage) {
  const measurement = measureSharpness(image)
  const verdict = classifySharpness(measurement)
  return { verdict, cause: verdict === 'blurry' ? estimateBlurCause(measurement) : null, ...measurement }
}

// 분석 크기 기준으로 화소 일부(위에서 아래로 coverage 비율)에만 섞는다.
function blendBottom(base: GrayImage, other: GrayImage, coverage: number): GrayImage {
  const pixels = base.pixels.slice()
  const start = Math.floor(base.height * (1 - coverage)) * base.width
  pixels.set(other.pixels.subarray(start), start)
  return { ...base, pixels }
}

// 공간 상관이 1화소 수준인 미세 질감(잎·잔디·자갈처럼). 잡음과 달리 사진 내용이다.
function addFineTexture(image: GrayImage, amplitude: number, seed: number): GrayImage {
  const random = createRandom(seed)
  return { ...image, pixels: image.pixels.map((value) => Math.min(255, Math.max(0, value + (random() - 0.5) * 2 * amplitude))) }
}

// 8×8 블록 DCT 계수를 균일 양자화해 JPEG 블록 흔적을 흉내 낸다(밝기만, 실제 JPEG 인코더가 아니다).
function quantizeBlocks(image: GrayImage, step: number): GrayImage {
  const { width, height } = image
  const pixels = image.pixels.slice()
  const scale = (k: number) => (k === 0 ? Math.SQRT1_2 : 1)
  const basis = Array.from({ length: 8 }, (_, x) => Array.from({ length: 8 }, (_, u) => Math.cos(((2 * x + 1) * u * Math.PI) / 16)))
  const coefficients = new Float64Array(64)
  for (let blockY = 0; blockY + 8 <= height; blockY += 8) {
    for (let blockX = 0; blockX + 8 <= width; blockX += 8) {
      const at = (x: number, y: number) => (blockY + y) * width + blockX + x
      for (let v = 0; v < 8; v += 1) {
        for (let u = 0; u < 8; u += 1) {
          let sum = 0
          for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) sum += (image.pixels[at(x, y)]! - 128) * basis[x]![u]! * basis[y]![v]!
          // 고주파 계수일수록 거칠게 양자화한다.
          const quantum = step * (1 + (u + v) / 4)
          coefficients[v * 8 + u] = Math.round((0.25 * scale(u) * scale(v) * sum) / quantum) * quantum
        }
      }
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          let sum = 0
          for (let v = 0; v < 8; v += 1) for (let u = 0; u < 8; u += 1) sum += scale(u) * scale(v) * coefficients[v * 8 + u]! * basis[x]![u]! * basis[y]![v]!
          pixels[at(x, y)] = Math.min(255, Math.max(0, 0.25 * sum + 128))
        }
      }
    }
  }
  return { width, height, pixels }
}

describe('known limits of blur detection (synthetic reproduction, not real photos)', () => {
  // 18장 중 4284×5712 사진(photo-3)이 흐림 정답인데 0.093으로 선명 판정된 것과 같은 방향의 결과
  it('misses blur that is small in original pixels once a large photo is shrunk to the 1024px analysis size', () => {
    // 렌즈 기본 흐림은 분석 크기에서 0.8화소로 같게 두고, 원본 화소 기준 2화소의 초점 흐림을 더한다.
    const focusBlur = 2
    const large = gaussianBlur(renderScene(3072, 2304, 21), 0.8 * 3 + focusBlur)
    expect(judge(downsampleByAverage(large, 3)).verdict).toBe('sharp')

    // 원본이 분석 크기와 같으면 같은 2화소 흐림을 찾는다.
    expect(judge(gaussianBlur(renderScene(1024, 768, 21), 0.8 + focusBlur)).verdict).toBe('blurry')
  })

  // photo-17·18(흐림 정답, 방향 판정 불가로 분석 불가)과 같은 모양의 결과. 방향별 판정만으로는 길게 끌린 방향이 판정에서 빠져
  // 분석 불가(25화소)나 선명(41화소)이 되던 경우를 흔들림 근거가 모두 일치할 때 찾는다. 근거가 하나라도 어긋나면 여전히 놓친다.
  it('finds long one-direction shake only when all shake evidence agrees, and still misses it over a blurred background or with noise', () => {
    const base = gaussianBlur(renderScene(1024, 768, 13), 0.8)
    expect(judge(addNoise(motionBlur(base, 9), 0.3, 5)).verdict).toBe('blurry')
    for (const length of [25, 41]) {
      const long = judge(addNoise(motionBlur(base, length), 0.3, 5))
      // 방향별 점수만 보면 선명하다(끌린 방향은 판정에서 빠졌다).
      expect(long.score).toBeGreaterThan(0.05)
      expect(long.verdict, `${length}px`).toBe('blurry')
      expect(long.cause, `${length}px`).toBe('shake')
    }

    // 배경이 흐린 사진은 모든 방향이 흐린 구역이 많아 흔들림으로 보지 않는다. 피사체가 길게 흔들려도 선명으로 판정한다.
    const subject = gaussianBlur(renderScene(1024, 768, 1), 0.8)
    const portrait = composite(gaussianBlur(renderScene(1024, 768, 1), 4), subject, { x: 0.3, y: 0.2, w: 0.4, h: 0.6 })
    const shakenPortrait = judge(addNoise(motionBlur(portrait, 25), 0.3, 1))
    expect(shakenPortrait.verdict).toBe('sharp')
    expect(shakenPortrait.isotropicBlurRegions).toBeGreaterThan(5)
    // 잡음이 많으면 수직 방향을 선명하다고 확인할 수 없어 분석 불가로 남는다.
    expect(judge(addNoise(motionBlur(base, 25), 1, 13)).verdict).toBe('low-detail')
  })

  // 흔들림 판정과 별개로 원래 있던 한계: 선명한 가로 줄무늬가 강한 배경 흐림 위에 있으면 가로 방향 윤곽이 배경에만 있어 흐림 의심이 된다.
  // 잡음이 없을 때만 재현된다(잡음이 있으면 분석 불가). 원인은 흔들림으로 단정하지 않는다.
  it('flags sharp stripes over a heavily blurred background as blurry without calling it shake', () => {
    const background = gaussianBlur(renderScene(1024, 768, 7), 5)
    const blinds = composite(background, gaussianBlur(renderStripes(1024, 768, 20), 0.8), { x: 0, y: 0.3, w: 1, h: 0.3 })
    const result = judge(blinds)
    expect(result.verdict).toBe('blurry')
    expect(result.cause).toBe('unknown')
    const noisy = judge(addNoise(blinds, 0.3, 3))
    expect(noisy.verdict).toBe('low-detail')
    // 1/2 크기에서는 잡음이 줄어 가로 방향이 배경만으로 흐림이 되지만, 세로 방향이 선명해 원인 근거가 맞지 않으므로 받지 않는다.
    expect(noisy.halfScale?.score).toBeLessThan(0.025)
    expect(Math.max(...noisy.halfScale!.directionScores.filter((score) => score !== null))).toBeGreaterThan(0.05)
    // 점수가 높아도 한 방향을 확인하지 못하면 선명하다고 단정할 수 없다.
    expect(noisy.score).toBeGreaterThan(0.1)
    expect(noisy.hasUnjudgedDirection).toBe(true)
    expect(noisy.directionScores[0]).toBeNull()
    expect(noisy.directionScores.slice(1).every((score) => score !== null)).toBe(true)
  })

  // photo-4(흐림 정답, 점수 1.335, 잡음 추정 0.32)처럼 흐린 사진이 아주 높은 점수를 받는 경우의 한 가지 재현
  it('calls a blurry photo sharp with a very high score when only part of the frame is noisy', () => {
    const blurred = gaussianBlur(renderScene(1024, 768, 31), 3)
    expect(judge(blurred).verdict).toBe('blurry')

    const partlyNoisy = judge(blendBottom(blurred, addNoise(blurred, 5, 4), 0.4))
    expect(partlyNoisy.verdict).toBe('sharp')
    expect(partlyNoisy.score).toBeGreaterThan(1)
    // 잡음은 가장 평평한 25% 구역으로 추정하므로 사진 일부의 잡음은 추정값에 거의 나타나지 않는다.
    expect(partlyNoisy.noise).toBeLessThan(0.1)
  })

  // photo-5·11(선명 정답, 잡음 추정 4.5·7.0, 점수 없음)과 같은 모양의 결과
  it('gives up on a sharp photo whose whole frame is fine texture because the texture is taken as noise', () => {
    const base = gaussianBlur(renderScene(1024, 768, 11), 0.8)
    expect(judge(base).verdict).toBe('sharp')
    const textured = judge(addFineTexture(base, 10, 9))
    expect(textured.verdict).toBe('low-detail')
    expect(textured.score).toBeNull()
    expect(textured.noise).toBeGreaterThan(3)
    expect(textured.directionScores).toEqual([null, null, null, null])
    expect(textured.hasUnjudgedDirection).toBe(true)
    // 1/2 크기에서 다시 봐도 흐림 근거가 없어 분석 불가로 남는다(1/2 크기의 선명은 선명 판정으로 쓰지 않는다).
    expect(textured.halfScale).not.toBeNull()

    const noisy = judge(addNoise(gaussianBlur(renderScene(1024, 768, 11), 0.8), 4, 3))
    expect(noisy).toMatchObject({ verdict: 'low-detail', score: null })
    expect(noisy.directionScores).toEqual([null, null, null, null])
  })

  // photo-15(흐림 정답, 640×427, 0.481 bpp로 가장 강하게 압축, 점수 0.034로 임계값 바로 위)와 같은 방향의 결과
  it('lets JPEG-like block edges lift a blurry photo above the threshold', () => {
    const blurred = gaussianBlur(renderScene(640, 424, 19), 2)
    expect(judge(blurred).verdict).toBe('blurry')
    const blocky = judge(quantizeBlocks(blurred, 8))
    expect(blocky.verdict).toBe('sharp')
  })

  // 반대로 휴대폰식 샤프닝(언샤프 마스크)은 이 합성 조건에서 흐린 사진을 선명으로 바꾸지 않았다.
  it('still finds blur after unsharp-mask sharpening in this synthetic setup', () => {
    const blurred = gaussianBlur(renderScene(1024, 768, 29), 2)
    const halo = gaussianBlur(blurred, 1)
    const sharpened = { ...blurred, pixels: blurred.pixels.map((value, index) => Math.min(255, Math.max(0, value + 2 * (value - halo.pixels[index]!)))) }
    expect(judge(sharpened).verdict).toBe('blurry')
  })
})
