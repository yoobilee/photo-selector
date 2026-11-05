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
// 5. 길게 끌린 흔들림은 그 방향의 큰 윤곽까지 지워 3의 방향 판정에서 빠진다. 1/16 크기를 함께 보는 여러 독립 근거가 모두
//    일치할 때만 흐림 의심으로 본다(hasConsistentShake).
// 6. 흐림 의심이면 방향별 점수와 구역 근거로 원인(흔들림·초점 불량)을 추정하고, 근거가 부족하면 원인을 단정하지 않는다.
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

// 흔들림 근거(collectShakeEvidence)에 쓰는 아주 거친 크기(1/16)의 구역 수. 분석 크기 1024×768에서 구역 하나가 16×12화소다.
export const SHAKE_COARSE_GRID = 4
// 아주 거친 크기에서 끌린 방향 윤곽이 수직 방향 윤곽의 이 비율 이상이어야 한다(원래 한 방향 윤곽만 있는 장면 제외).
export const SHAKE_MIN_COARSE_BALANCE = 0.25
// 1/4 크기에서 끌린 방향 윤곽의 상대 세기가 아주 거친 크기보다 이 배수 이상 약해야 한다.
export const SHAKE_SCALE_LOSS = 4
// 흔들림으로 보려면 근거 구역이 이 수 이상이고, 서로 다른 행과 열이 각각 SHAKE_MIN_SPREAD개 이상이어야 한다.
export const SHAKE_MIN_REGIONS = 6
export const SHAKE_MIN_SPREAD = 3
// 모든 방향이 흐린 구역 수 × 이 값이 근거 구역 수를 넘으면 흔들림으로 보지 않는다.
export const SHAKE_ISOTROPIC_LIMIT = 2
// 초점 불량 추정(estimateBlurCause)의 기준. 서로 수직인 두 방향 점수의 최대 배율, 모든 방향 점수의 최대 배율,
// 모든 방향이 흐린 최소 구역 수
export const DEFOCUS_PAIR_SPREAD = 1.5
export const DEFOCUS_MAX_SPREAD = 2
export const DEFOCUS_MIN_REGIONS = 3

// 방향별 2차 차분의 화소 간격. 가로, 세로, 대각선(↘), 대각선(↙)
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [0, 1], [1, 1], [1, -1]]
// DIRECTIONS 순서로 각 방향에 수직인 방향의 번호
const PERPENDICULAR: readonly number[] = [1, 0, 3, 2]
const PERPENDICULAR_PAIRS: ReadonlyArray<readonly [number, number]> = [[0, 1], [2, 3]]
// 같은 크기의 독립 잡음(분산 σ²)에 대해 [1, -2, 1] 차분의 분산은 6σ²이다.
const SECOND_DIFFERENCE_NOISE_GAIN = 6

export interface GrayImage {
  readonly width: number
  readonly height: number
  // 0~255 밝기, 행 우선
  readonly pixels: Float32Array
}

// 한 방향의 흔들림 근거(collectShakeEvidence)
export interface ShakeEvidence {
  // 끌린 것으로 보이는 방향(DIRECTIONS 순서: 가로, 세로, 대각선↘, 대각선↙)
  readonly direction: number
  // 근거 구역 수와 근거 구역이 걸친 서로 다른 행·열 수
  readonly regions: number
  readonly rows: number
  readonly columns: number
  // 끌린 방향이 선명한 구역 수
  readonly contradictingRegions: number
}

export interface SharpnessMeasurement {
  // 판정할 수 있는 방향 중 가장 낮은 방향의 점수. 판정할 수 있는 방향이 없으면 null
  readonly score: number | null
  // 윤곽은 있지만 잡음에 비해 약해 판정할 수 없는 방향이 있는지. 그 방향만 흐렸을 수 있으므로 선명하다고 단정하지 않는다.
  readonly hasUnjudgedDirection: boolean
  // 분석 크기에서 추정한 화소 잡음의 표준편차(0~255)
  readonly noise: number
  // DIRECTIONS 순서의 방향별 점수. 판정하지 못한 방향은 null
  readonly directionScores: readonly (number | null)[]
  // 근거 구역이 가장 많은 방향의 흔들림 근거. 어느 방향에도 근거 구역이 없으면 null
  readonly shake: ShakeEvidence | null
  // 서로 수직인 두 방향이 모두 흐린 구역 수(초점 불량·배경 흐림처럼 방향과 관계없는 흐림)
  readonly isotropicBlurRegions: number
}

export type SharpnessVerdict = 'sharp' | 'blurry' | 'low-detail'

// 흐림 의심의 추정 원인. 확정이 아니며 근거가 부족하면 unknown이다.
export type BlurCause = 'shake' | 'defocus' | 'unknown'

// 사진 한 장의 흐림 분석 결과. 분석하지 못한 경우는 흐림으로 보지 않고 이유와 함께 분석 불가로 구분한다.
// timeout은 정해진 시간 안에 분석이 끝나지 않아 중단한 경우다.
export type UnavailableReason = 'low-detail' | 'too-small' | 'failed' | 'unsupported' | 'timeout'
export type SharpnessResult =
  | { readonly status: 'sharp' }
  | { readonly status: 'blurry'; readonly cause: BlurCause }
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

// 구역 하나의 방향별 측정값. ratio는 미세 경계 / 큰 윤곽, structure는 큰 윤곽의 세기다. 화소가 없으면 NaN이다.
interface RegionDirection {
  readonly ratio: number
  readonly structure: number
}

const isBlurryRegion = ({ ratio, structure }: RegionDirection) =>
  structure >= STRUCTURE_MIN_STRENGTH && ratio < SHARP_RATIO_THRESHOLD

// 한 방향의 흔들림 근거를 구역마다 모은다(합성 이미지 측정 근거는 sharpness.test.ts).
// 흔들림은 끌린 방향(direction)의 윤곽만 흐리게 하고, 끌린 길이보다 큰 크기에서는 그 방향의 윤곽도 남긴다.
// - 근거 구역: 같은 구역에서 수직 방향은 선명하고(잡음 기준을 넘는 윤곽), 끌린 방향은 흐리거나 윤곽이 거의 없으며,
//   아주 거친 크기(1/16)에서는 끌린 방향의 윤곽이 수직 방향과 견줄 만큼 있는데 1/4 크기에서는 그보다 훨씬 약하다.
//   줄무늬·수평선처럼 원래 한 방향 윤곽만 있는 장면은 아주 거친 크기에서도 그 방향 윤곽이 없어 근거가 되지 않는다.
// - 반대 구역: 끌린 방향의 윤곽이 잡음 기준을 넘게 뚜렷하고 선명한 구역. 사진 전체가 흔들렸다면 없어야 한다.
function collectShakeEvidence(
  direction: number,
  regions: readonly (readonly RegionDirection[])[],
  veryCoarse: readonly Float64Array[],
  minimumStructure: number,
): ShakeEvidence {
  const perpendicular = PERPENDICULAR[direction]!
  const rows = new Set<number>()
  const columns = new Set<number>()
  const parentScale = SHARPNESS_GRID / SHAKE_COARSE_GRID
  let evidence = 0
  let contradicting = 0
  regions.forEach((byDirection, region) => {
    const shaken = byDirection[direction]!
    const across = byDirection[perpendicular]!
    if (shaken.structure >= minimumStructure && shaken.ratio >= SHARP_RATIO_THRESHOLD) {
      contradicting += 1
      return
    }
    if (!(across.structure >= minimumStructure && across.ratio >= SHARP_RATIO_THRESHOLD)) return
    if (shaken.structure >= STRUCTURE_MIN_STRENGTH && !(shaken.ratio < SHARP_RATIO_THRESHOLD)) return
    const row = Math.floor(region / SHARPNESS_GRID)
    const column = region % SHARPNESS_GRID
    const parent = Math.floor(row / parentScale) * SHAKE_COARSE_GRID + Math.floor(column / parentScale)
    const shakenCoarse = veryCoarse[direction]![parent]!
    // 아주 거친 크기에서 두 방향 모두 윤곽이 거의 없으면(촘촘한 줄무늬가 평균되어 사라진 경우) 비율이 의미 없다.
    if (!(shakenCoarse >= STRUCTURE_MIN_STRENGTH)) return
    const coarseBalance = shakenCoarse / veryCoarse[perpendicular]![parent]!
    const balance = shaken.structure / across.structure
    if (!(coarseBalance >= SHAKE_MIN_COARSE_BALANCE) || !(balance * SHAKE_SCALE_LOSS < coarseBalance)) return
    evidence += 1
    rows.add(row)
    columns.add(column)
  })
  return { direction, regions: evidence, rows: rows.size, columns: columns.size, contradictingRegions: contradicting }
}

export function measureSharpness(image: GrayImage): SharpnessMeasurement {
  const coarseImage = downsampleByAverage(image, SHARPNESS_COARSE_FACTOR)
  const veryCoarseImage = downsampleByAverage(coarseImage, SHARPNESS_COARSE_FACTOR)
  const noise = estimateNoise(image)
  const minimumStructure = Math.max(
    STRUCTURE_MIN_STRENGTH,
    (NOISE_MARGIN * SECOND_DIFFERENCE_NOISE_GAIN * noise * noise) / SHARP_RATIO_THRESHOLD,
  )
  const directionScores: (number | null)[] = []
  // 구역별·방향별 측정값(regions[구역][방향])
  const regions: RegionDirection[][] = Array.from({ length: SHARPNESS_GRID * SHARPNESS_GRID }, () => [])
  let hasUnjudgedDirection = false
  for (const [dx, dy] of DIRECTIONS) {
    const fine = regionSecondDifferenceVariance(image, SHARPNESS_GRID, dx, dy)
    const coarse = regionSecondDifferenceVariance(coarseImage, SHARPNESS_GRID, dx, dy)
    const ratios: number[] = []
    let structuredRegions = 0
    coarse.forEach((structure, region) => {
      const detail = fine[region]!
      regions[region]!.push({ ratio: detail / structure, structure })
      if (!Number.isFinite(detail) || !Number.isFinite(structure) || structure < STRUCTURE_MIN_STRENGTH) return
      structuredRegions += 1
      if (structure >= minimumStructure) ratios.push(detail / structure)
    })
    if (ratios.length >= SHARPNESS_TOP_REGIONS) {
      const top = ratios.sort((a, b) => b - a).slice(0, SHARPNESS_TOP_REGIONS)
      directionScores.push(top.reduce((total, value) => total + value, 0) / top.length)
    } else {
      directionScores.push(null)
      // 윤곽이 거의 없는 방향(한 방향 줄무늬 등)은 판정 대상이 아니지만, 윤곽이 있는데 잡음 때문에 못 보는 방향은 기록한다.
      if (structuredRegions >= SHARPNESS_TOP_REGIONS) hasUnjudgedDirection = true
    }
  }

  const veryCoarse = DIRECTIONS.map(([dx, dy]) => regionSecondDifferenceVariance(veryCoarseImage, SHAKE_COARSE_GRID, dx, dy))
  const shake =
    DIRECTIONS.map((_, direction) => collectShakeEvidence(direction, regions, veryCoarse, minimumStructure))
      .filter((evidence) => evidence.regions > 0)
      .sort((a, b) => b.regions - a.regions)[0] ?? null
  const isotropicBlurRegions = regions.filter((byDirection) =>
    PERPENDICULAR.some(
      (perpendicular, direction) => isBlurryRegion(byDirection[direction]!) && isBlurryRegion(byDirection[perpendicular]!),
    ),
  ).length

  const judged = directionScores.filter((value): value is number => value !== null)
  return {
    score: judged.length > 0 ? Math.min(...judged) : null,
    hasUnjudgedDirection,
    noise,
    directionScores,
    shake,
    isotropicBlurRegions,
  }
}

// 여러 독립 근거가 모두 한 방향의 흔들림을 가리키는지. 하나라도 어긋나면 흔들림으로 보지 않는다.
// 1. 근거 구역이 SHAKE_MIN_REGIONS개 이상이고 SHAKE_MIN_SPREAD개 이상의 행과 열에 퍼져 있다(사진 일부가 아닌 전체의 흔들림).
// 2. 끌린 방향이 선명한 반대 구역이 하나도 없다.
// 3. 모든 방향이 흐린 구역이 근거 구역의 1/SHAKE_ISOTROPIC_LIMIT 이하다(배경 흐림·초점 불량이 원인일 수 있으면 제외).
// 4. 끌린 방향의 수직 방향은 사진 전체 점수로도 선명하다.
export function hasConsistentShake({ shake, isotropicBlurRegions, directionScores }: SharpnessMeasurement): boolean {
  if (!shake) return false
  const across = directionScores[PERPENDICULAR[shake.direction]!] ?? null
  return (
    shake.regions >= SHAKE_MIN_REGIONS &&
    shake.rows >= SHAKE_MIN_SPREAD &&
    shake.columns >= SHAKE_MIN_SPREAD &&
    shake.contradictingRegions === 0 &&
    isotropicBlurRegions * SHAKE_ISOTROPIC_LIMIT <= shake.regions &&
    across !== null &&
    across >= SHARP_RATIO_THRESHOLD
  )
}

// 판정한 방향 중 하나라도 흐리면 흐림 의심이다. 판정한 방향이 모두 선명해도 흔들림 근거가 모두 일치하면 흐림 의심이다
// (길게 끌린 흔들림은 그 방향의 윤곽까지 약해져 방향 판정에서 빠지기 때문). 모든 방향을 판정할 수 없으면 선명하다고도
// 흐리다고도 단정하지 않는다.
export function classifySharpness(measurement: SharpnessMeasurement): SharpnessVerdict {
  const { score, hasUnjudgedDirection } = measurement
  if (score !== null && score < SHARP_RATIO_THRESHOLD) return 'blurry'
  if (hasConsistentShake(measurement)) return 'blurry'
  if (score === null) return 'low-detail'
  return hasUnjudgedDirection ? 'low-detail' : 'sharp'
}

// 흐림 의심 사진의 원인을 추정한다. 방향별 점수는 보조 근거이며 원인을 확정하지 않는다. 근거가 부족하면 unknown이다.
// - shake: hasConsistentShake의 근거가 모두 일치한다.
// - defocus: 초점 불량은 방향과 관계없이 미세 경계를 함께 지우므로 다음이 모두 맞을 때만 추정한다.
//   1. 서로 수직인 두 방향(가로·세로, 두 대각선)은 둘 다 판정했거나 둘 다 판정하지 못했다. 둘 다 판정한 짝이 하나 이상이고,
//      짝 안의 점수 차이가 DEFOCUS_PAIR_SPREAD배 이하다(대각선은 화소 간격이 달라 가로·세로와 점수 수준이 조금 다르다).
//   2. 판정한 모든 방향의 점수가 서로 DEFOCUS_MAX_SPREAD배 안에 있다.
//   3. 모든 방향이 흐린 구역이 DEFOCUS_MIN_REGIONS개 이상이다.
export function estimateBlurCause(measurement: SharpnessMeasurement): BlurCause {
  if (hasConsistentShake(measurement)) return 'shake'
  const scores = measurement.directionScores
  let judgedPairs = 0
  for (const [first, second] of PERPENDICULAR_PAIRS) {
    const a = scores[first] ?? null
    const b = scores[second] ?? null
    if (a === null && b === null) continue
    if (a === null || b === null || Math.max(a, b) > Math.min(a, b) * DEFOCUS_PAIR_SPREAD) return 'unknown'
    judgedPairs += 1
  }
  const judged = scores.filter((value): value is number => value !== null)
  if (
    judgedPairs > 0 &&
    Math.max(...judged) <= Math.min(...judged) * DEFOCUS_MAX_SPREAD &&
    measurement.isotropicBlurRegions >= DEFOCUS_MIN_REGIONS
  ) {
    return 'defocus'
  }
  return 'unknown'
}
