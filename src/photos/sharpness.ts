// 사진의 흐림 여부를 계산하는 순수 함수. React·DOM에 의존하지 않으므로 Web Worker와 향후 모바일 앱에서 재사용한다.
// 원본은 다루지 않는다. 호출자가 원본에서 따로 만든 작은 분석용 이미지의 밝기 값만 받는다.
//
// 방법(구역별 2차 미분 비율):
// 1. 사진을 SHARPNESS_GRID × SHARPNESS_GRID 구역으로 나눈다.
// 2. 구역마다 가로·세로·두 대각선 방향의 2차 차분 분산을 분석 크기(미세 경계)와 1/SHARPNESS_COARSE_FACTOR 크기(큰 윤곽)에서 구한다.
//    흐림은 미세 경계를 먼저 지우고 큰 윤곽은 남기므로 (미세 / 큰 윤곽) 비율이 작아진다. 비율이라 밝기·대비·해상도에 덜 민감하다.
// 3. 방향마다 가장 선명한 SHARPNESS_TOP_REGIONS개 구역의 비율 평균을 구하고, 가장 낮은 방향의 값을 점수로 쓴다.
//    한 방향으로 끌린 흔들림은 그 방향의 미세 경계만 지우므로 방향별로 봐야 놓치지 않는다.
//    가장 선명한 구역만 보므로 배경 흐림(아웃포커스)이나 하늘처럼 매끈한 영역이 넓어도 피사체가 선명하면 선명하다.
// 4. 잡음은 미세 경계처럼 보여 흐린 사진을 선명하게 보이게 한다. 사진마다 잡음을 추정하고, 잡음이 비율을 임계값 근처까지
//    올릴 수 없을 만큼 큰 윤곽이 뚜렷한 구역만 판정에 쓴다. 쓸 구역이 부족하면 흐림으로 단정하지 않는다(판정 근거 부족).
// 임계값의 근거와 한계는 sharpness.test.ts의 합성 이미지 측정과 README에 기록한다.

// 분석용 이미지의 긴 변. 원본이 이보다 크면 줄이고, 작으면 그대로 쓴다(확대하면 보간으로 흐려져 오탐이 생긴다).
export const SHARPNESS_ANALYSIS_MAX_EDGE = 1024
// 짧은 변이 이보다 작으면 판정할 화소가 부족하다.
export const SHARPNESS_MIN_EDGE = 64
export const SHARPNESS_GRID = 8
export const SHARPNESS_COARSE_FACTOR = 4
// 판정에 쓰는 방향별 가장 선명한 구역 수. 이보다 쓸 수 있는 구역이 적은 방향은 판정에서 뺀다.
export const SHARPNESS_TOP_REGIONS = 3
// 큰 윤곽의 최소 세기. 균일한 배경·매끈한 그라데이션 구역은 판정 근거가 아니다.
export const STRUCTURE_MIN_STRENGTH = 30
// 잡음이 비율에 더할 수 있는 몫을 임계값의 1/NOISE_MARGIN 이하로 제한한다.
export const NOISE_MARGIN = 4
// 점수가 이 값 이상이면 선명하다.
export const SHARP_RATIO_THRESHOLD = 0.025

// 방향별 2차 차분의 화소 간격. 가로, 세로, 대각선(↘), 대각선(↙)
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [1, 1], [1, -1]]
// 같은 크기의 독립 잡음(분산 σ²)에 대해 [1, -2, 1] 차분의 분산은 6σ²이다.
const SECOND_DIFFERENCE_NOISE_GAIN = 6

export interface GrayImage {
  readonly width: number
  readonly height: number
  // 0~255 밝기, 행 우선
  readonly pixels: Float32Array
}

export interface SharpnessMeasurement {
  // 판정할 수 있는 방향 중 가장 낮은 방향의 점수. 판정할 수 있는 방향이 없으면 null
  readonly score: number | null
  // 윤곽은 있지만 잡음에 비해 약해 판정할 수 없는 방향이 있는지. 그 방향만 흐렸을 수 있으므로 선명하다고 단정하지 않는다.
  readonly hasUnjudgedDirection: boolean
  // 분석 크기에서 추정한 화소 잡음의 표준편차(0~255)
  readonly noise: number
}

export type SharpnessVerdict = 'sharp' | 'blurry' | 'low-detail'

// 사진 한 장의 흐림 분석 결과. 분석하지 못한 경우는 흐림으로 보지 않고 이유와 함께 분석 불가로 구분한다.
export type UnavailableReason = 'low-detail' | 'too-small' | 'failed' | 'unsupported'
export type SharpnessResult =
  | { readonly status: 'sharp' }
  | { readonly status: 'blurry' }
  | { readonly status: 'unavailable'; readonly reason: UnavailableReason }

// 원본 크기에서 분석용 이미지 크기를 정한다. 판정하기에 너무 작으면 null이다.
export function getAnalysisSize(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0 && height > 0) || Math.min(width, height) < SHARPNESS_MIN_EDGE) return null
  const scale = Math.min(1, SHARPNESS_ANALYSIS_MAX_EDGE / Math.max(width, height))
  const size = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
  return Math.min(size.width, size.height) < SHARPNESS_MIN_EDGE ? null : size
}

// RGBA 화소를 밝기(Rec. 601)로 바꾼다. 투명 영역은 호출자가 배경색을 채운 뒤 넘긴다.
export function toGrayscale(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  if (rgba.length !== width * height * 4) throw new Error('RGBA length does not match the size')
  const pixels = new Float32Array(width * height)
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4
    pixels[index] = 0.299 * rgba[offset]! + 0.587 * rgba[offset + 1]! + 0.114 * rgba[offset + 2]!
  }
  return { width, height, pixels }
}

// 정수 배수 평균으로 줄인다. 남는 가장자리 화소는 버린다.
export function downsampleByAverage(image: GrayImage, factor: number): GrayImage {
  const width = Math.floor(image.width / factor)
  const height = Math.floor(image.height / factor)
  const pixels = new Float32Array(width * height)
  const area = factor * factor
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * image.width + x * factor
        for (let dx = 0; dx < factor; dx += 1) sum += image.pixels[row + dx]!
      }
      pixels[y * width + x] = sum / area
    }
  }
  return { width, height, pixels }
}

// 가장자리 1화소를 뺀 각 화소의 응답을 구역별 분산으로 모은다(행 우선). 화소가 없는 구역은 NaN이다.
function regionVariance(image: GrayImage, grid: number, response: (index: number) => number): Float64Array {
  const { width, height } = image
  const sums = new Float64Array(grid * grid)
  const squares = new Float64Array(grid * grid)
  const counts = new Float64Array(grid * grid)
  for (let y = 1; y < height - 1; y += 1) {
    const regionRow = Math.floor((y * grid) / height) * grid
    for (let x = 1; x < width - 1; x += 1) {
      const value = response(y * width + x)
      const region = regionRow + Math.floor((x * grid) / width)
      sums[region] = sums[region]! + value
      squares[region] = squares[region]! + value * value
      counts[region] = counts[region]! + 1
    }
  }
  return sums.map((sum, region) => {
    const count = counts[region]!
    if (count === 0) return Number.NaN
    const mean = sum / count
    return Math.max(0, squares[region]! / count - mean * mean)
  })
}

// 방향 (dx, dy)의 2차 차분 I(p - d) + I(p + d) - 2I(p)의 구역별 분산
export function regionSecondDifferenceVariance(image: GrayImage, grid: number, dx: number, dy: number): Float64Array {
  const { width, pixels } = image
  const step = dy * width + dx
  return regionVariance(image, grid, (index) => pixels[index - step]! + pixels[index + step]! - 2 * pixels[index]!)
}

// 화소 잡음의 표준편차를 추정한다(Immerkær 1996의 마스크, 독립 잡음 분산 σ²에 대해 응답 분산 36σ²).
// 이 마스크는 가로·세로 경계와 완만한 밝기 변화에는 반응하지 않는다. 질감·모서리가 있는 구역은 잡음을 크게 추정하므로
// 가장 평평한 쪽(하위 25%) 구역 값을 쓴다. 사진 전체가 미세한 질감이면 크게 추정되어 판정 근거 부족 쪽으로 기운다.
export function estimateNoise(image: GrayImage, grid: number = SHARPNESS_GRID): number {
  const { width, pixels } = image
  const variances = regionVariance(image, grid, (index) => {
    const up = index - width
    const down = index + width
    return (
      pixels[up - 1]! - 2 * pixels[up]! + pixels[up + 1]! -
      2 * (pixels[index - 1]! - 2 * pixels[index]! + pixels[index + 1]!) +
      pixels[down - 1]! - 2 * pixels[down]! + pixels[down + 1]!
    )
  })
  const sorted = Array.from(variances).filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return Math.sqrt(sorted[Math.floor((sorted.length - 1) * 0.25)]! / 36)
}

export function measureSharpness(image: GrayImage): SharpnessMeasurement {
  const coarseImage = downsampleByAverage(image, SHARPNESS_COARSE_FACTOR)
  const noise = estimateNoise(image)
  const minimumStructure = Math.max(
    STRUCTURE_MIN_STRENGTH,
    (NOISE_MARGIN * SECOND_DIFFERENCE_NOISE_GAIN * noise * noise) / SHARP_RATIO_THRESHOLD,
  )
  const directionScores: number[] = []
  let hasUnjudgedDirection = false
  for (const [dx, dy] of DIRECTIONS) {
    const fine = regionSecondDifferenceVariance(image, SHARPNESS_GRID, dx, dy)
    const coarse = regionSecondDifferenceVariance(coarseImage, SHARPNESS_GRID, dx, dy)
    const ratios: number[] = []
    let structuredRegions = 0
    coarse.forEach((structure, region) => {
      const detail = fine[region]!
      if (!Number.isFinite(detail) || !Number.isFinite(structure) || structure < STRUCTURE_MIN_STRENGTH) return
      structuredRegions += 1
      if (structure >= minimumStructure) ratios.push(detail / structure)
    })
    if (ratios.length >= SHARPNESS_TOP_REGIONS) {
      const top = ratios.sort((a, b) => b - a).slice(0, SHARPNESS_TOP_REGIONS)
      directionScores.push(top.reduce((total, value) => total + value, 0) / top.length)
    } else if (structuredRegions >= SHARPNESS_TOP_REGIONS) {
      // 윤곽이 거의 없는 방향(한 방향 줄무늬 등)은 판정 대상이 아니지만, 윤곽이 있는데 잡음 때문에 못 보는 방향은 기록한다.
      hasUnjudgedDirection = true
    }
  }
  return { score: directionScores.length > 0 ? Math.min(...directionScores) : null, hasUnjudgedDirection, noise }
}

// 판정한 방향 중 하나라도 흐리면 흐림 의심이다. 모든 방향을 판정할 수 없으면 선명하다고도 흐리다고도 단정하지 않는다.
export function classifySharpness({ score, hasUnjudgedDirection }: SharpnessMeasurement): SharpnessVerdict {
  if (score === null) return 'low-detail'
  if (score < SHARP_RATIO_THRESHOLD) return 'blurry'
  return hasUnjudgedDirection ? 'low-detail' : 'sharp'
}
