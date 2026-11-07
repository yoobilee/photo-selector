// 두 사진 지문을 비교해 거의 같은 사진·비슷한 사진·경계·다른 사진을 판정하는 순수 함수. React·DOM에 의존하지 않는다.
// 서로 다른 사진을 묶는 것(오탐)보다 비슷한 사진을 놓치는 쪽을 택한다. 근거가 부족하면 묶지 않는다.
//
// 판정 순서(앞 단계에서 다르면 다음 단계를 계산하지 않는다)
// 1. 가로세로 비율이 다르면 다른 사진이다.
// 2. 윤곽이 있는 구역이 부족한 사진(맑은 하늘, 벽, 너무 매끈한 사진)은 비교하지 않는다(incomparable).
//    색이나 밝기 분포만 비슷한 사진을 묶지 않기 위해서다.
// 3. pHash 거리가 크면 다른 사진이다(후보 고르기).
// 4. 16×16 크기의 윤곽 상관이 낮으면 다른 사진이다(빠른 거르기).
// 5. 64×64 크기에서 몇 화소 이동(손떨림·구도 차이)을 찾아 맞춘 뒤, 4×4 구역별로 윤곽(밝기 기울기)을 비교한다.
//    기울기는 밝기를 더해도 바뀌지 않고, 구역마다 평균을 빼고 정규화한 상관을 쓰므로 대비와 완만한 밝기 변화(그라데이션)에도 둔감하다.
//    표정·움직임처럼 일부 구역만 다른 연속 촬영을 위해 대부분의 구역이 일치하면 비슷한 사진으로 본다.
import {
  FINGERPRINT_SIZE,
  hashDistance,
  shrinkSquare,
  type PhotoFingerprint,
} from './photoFingerprint.ts'

// 가로세로 비율의 최대 상대 차이. 같은 사진을 다른 크기로 저장할 때의 반올림 차이만 허용한다.
export const ASPECT_TOLERANCE = 0.02
// 이 거리(63비트 중)를 넘으면 비교하지 않는다.
export const HASH_CANDIDATE_MAX = 20
// 거의 같은 사진으로 보려면 pHash 거리가 이 값 이하여야 한다.
export const HASH_SAME_MAX = 6
// 16×16 윤곽 상관(±1화소 이동 중 최대)이 이 값보다 낮으면 다른 사진이다.
export const COARSE_MIN_CORRELATION = 0.3
// 64×64에서 찾는 최대 이동(화소). 64의 약 5%다.
export const SHIFT_RANGE = 3
// 구역 수(가로·세로 각각)
export const CELL_GRID = 4
// 구역의 윤곽 세기(평균을 뺀 기울기의 표준편차, 64×64 밝기 단위)가 이 값 이상이어야 비교 근거로 쓴다.
export const CELL_MIN_DETAIL = 2.5
// 윤곽이 있는 구역이 이 수 이상이어야 비교한다(16개 중).
export const MIN_DETAILED_CELLS = 6
// 구역 상관이 이 값 이상이면 그 구역이 일치한다.
export const CELL_MATCH_CORRELATION = 0.5
// 비슷한 사진: 일치 구역 비율과 전체 상관의 최소값
export const SIMILAR_MIN_MATCHED_FRACTION = 0.75
export const SIMILAR_MIN_CORRELATION = 0.5
// 비슷한 사진 기준에 못 미치지만 이 값 이상이면 경계(uncertain)다. 경계도 묶지 않는다.
export const UNCERTAIN_MIN_MATCHED_FRACTION = 0.5
export const UNCERTAIN_MIN_CORRELATION = 0.35
// 거의 같은 사진: 이동이 없고 전체 상관과 모든 구역 상관이 이 값 이상이며, 비율 차이가 이 값 이하
export const SAME_MIN_CORRELATION = 0.9
export const SAME_MIN_CELL_CORRELATION = 0.8
export const SAME_ASPECT_TOLERANCE = 0.01
// 반복 무늬(줄무늬·바둑판 등): 사진을 자기 자신과 2~SHIFT_RANGE화소 옮겨 비교한 윤곽 상관이 이 값 이상이면 위치 맞춤이 여러 곳에서
// 성립할 수 있어 같은 장면인지 구분할 수 없다. 이런 사진이 낀 쌍은 기준을 넘어도 경계(uncertain)로 두고 묶지 않는다.
// 합성 장면은 0.21~0.40, 줄무늬·바둑판은 0.9 이상이었다.
export const REPETITIVE_SELF_CORRELATION = 0.8

const COARSE_SIZE = 16
const COARSE_SHIFT_RANGE = 1

// same: 크기·압축·밝기만 다른 것으로 보이는 사진, similar: 구도가 비슷한 다른 순간의 사진(연속 촬영 등),
// uncertain: 기준 근처라 판단을 미룬 사진, different: 다른 사진, incomparable: 윤곽이 부족해 비교하지 않은 사진
export type PhotoRelationKind = 'same' | 'similar' | 'uncertain' | 'different' | 'incomparable'

export interface PhotoComparison {
  readonly kind: PhotoRelationKind
  readonly hashDistance: number | null
  // 64×64 윤곽 상관(구조 비교까지 간 경우)
  readonly correlation: number | null
  // 윤곽이 있는 구역 수와 그중 일치한 구역 수
  readonly detailedCells: number
  readonly matchedCells: number
}

// 비교에 반복해서 쓰는 사진별 값. 비교할 때마다 다시 만들지 않도록 한 번만 준비한다.
export interface PreparedFingerprint {
  readonly fingerprint: PhotoFingerprint
  // 자기 구역 중 윤곽이 있는 구역 수가 MIN_DETAILED_CELLS 이상인지
  readonly comparable: boolean
  // 반복 무늬라 위치 맞춤을 믿을 수 없는지(REPETITIVE_SELF_CORRELATION)
  readonly repetitive: boolean
  readonly coarse: GradientField
}

export interface GradientField {
  readonly size: number
  readonly x: Float32Array
  readonly y: Float32Array
}

// 중앙 차분 기울기. 가장자리 한 줄은 0으로 두고 비교에서 뺀다.
function gradients(pixels: ArrayLike<number>, size: number): GradientField {
  const x = new Float32Array(size * size)
  const y = new Float32Array(size * size)
  for (let row = 1; row < size - 1; row += 1) {
    for (let column = 1; column < size - 1; column += 1) {
      const index = row * size + column
      x[index] = (pixels[index + 1]! - pixels[index - 1]!) / 2
      y[index] = (pixels[index + size]! - pixels[index - size]!) / 2
    }
  }
  return { size, x, y }
}

interface WindowStats {
  // 평균을 뺀 기울기 벡터의 정규화 상관. 한쪽이라도 윤곽이 없으면 0
  readonly correlation: number
  // 두 사진 각각의 윤곽 세기(평균을 뺀 기울기 벡터의 표준편차)
  readonly detailA: number
  readonly detailB: number
}

// A의 [left, right) × [top, bottom) 구역과 (dx, dy)만큼 옮긴 B의 같은 크기 구역을 비교한다. step은 표본 간격이다.
function compareWindow(
  a: GradientField,
  b: GradientField,
  dx: number,
  dy: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  step = 1,
): WindowStats {
  const { size } = a
  let count = 0
  let sumAx = 0
  let sumAy = 0
  let sumBx = 0
  let sumBy = 0
  let sumAA = 0
  let sumBB = 0
  let sumAB = 0
  for (let row = top; row < bottom; row += step) {
    for (let column = left; column < right; column += step) {
      const indexA = row * size + column
      const indexB = (row + dy) * size + column + dx
      const ax = a.x[indexA]!
      const ay = a.y[indexA]!
      const bx = b.x[indexB]!
      const by = b.y[indexB]!
      count += 1
      sumAx += ax
      sumAy += ay
      sumBx += bx
      sumBy += by
      sumAA += ax * ax + ay * ay
      sumBB += bx * bx + by * by
      sumAB += ax * bx + ay * by
    }
  }
  if (count === 0) return { correlation: 0, detailA: 0, detailB: 0 }
  const varianceA = Math.max(0, sumAA - (sumAx * sumAx + sumAy * sumAy) / count)
  const varianceB = Math.max(0, sumBB - (sumBx * sumBx + sumBy * sumBy) / count)
  const covariance = sumAB - (sumAx * sumBx + sumAy * sumBy) / count
  const denominator = Math.sqrt(varianceA * varianceB)
  return {
    correlation: denominator > 1e-9 ? covariance / denominator : 0,
    detailA: Math.sqrt(varianceA / count),
    detailB: Math.sqrt(varianceB / count),
  }
}

// B를 (dx, dy)만큼 옮겼을 때 두 사진이 겹치는 내부 영역(A 좌표). 가장자리 한 줄은 기울기가 없어 뺀다.
function overlap(size: number, dx: number, dy: number) {
  return {
    left: Math.max(1, 1 - dx),
    top: Math.max(1, 1 - dy),
    right: Math.min(size - 1, size - 1 - dx),
    bottom: Math.min(size - 1, size - 1 - dy),
  }
}

function edgesOf(start: number, end: number, parts: number): number[] {
  return Array.from({ length: parts + 1 }, (_, index) => start + Math.round(((end - start) * index) / parts))
}

// 이동 범위 안에서 전체 윤곽 상관이 가장 큰 이동을 찾는다. 같은 값이면 더 작은 이동을 고른다(결정적).
function bestShift(a: GradientField, b: GradientField, range: number, step: number) {
  let best = { dx: 0, dy: 0, correlation: -Infinity }
  for (let dy = -range; dy <= range; dy += 1) {
    for (let dx = -range; dx <= range; dx += 1) {
      const area = overlap(a.size, dx, dy)
      const { correlation } = compareWindow(a, b, dx, dy, area.left, area.top, area.right, area.bottom, step)
      const isCloser = Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy)
      if (correlation > best.correlation + 1e-12 || (Math.abs(correlation - best.correlation) <= 1e-12 && isCloser)) {
        best = { dx, dy, correlation }
      }
    }
  }
  return best
}

// 사진 자체의 4×4 구역 중 윤곽이 있는 구역 수
function countDetailedCells(field: GradientField): number {
  const edges = edgesOf(1, field.size - 1, CELL_GRID)
  let detailed = 0
  for (let row = 0; row < CELL_GRID; row += 1) {
    for (let column = 0; column < CELL_GRID; column += 1) {
      const stats = compareWindow(field, field, 0, 0, edges[column]!, edges[row]!, edges[column + 1]!, edges[row + 1]!)
      if (stats.detailA >= CELL_MIN_DETAIL) detailed += 1
    }
  }
  return detailed
}

// 자기 자신을 2화소 이상(최대 SHIFT_RANGE) 옮겨 비교한 윤곽 상관 중 가장 큰 값
export function measureSelfSimilarity(field: GradientField): number {
  let highest = -Infinity
  for (let dy = -SHIFT_RANGE; dy <= SHIFT_RANGE; dy += 1) {
    for (let dx = -SHIFT_RANGE; dx <= SHIFT_RANGE; dx += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 2) continue
      const area = overlap(field.size, dx, dy)
      highest = Math.max(highest, compareWindow(field, field, dx, dy, area.left, area.top, area.right, area.bottom, 2).correlation)
    }
  }
  return highest
}

export function prepareFingerprint(fingerprint: PhotoFingerprint): PreparedFingerprint {
  const fine = gradients(fingerprint.pixels, FINGERPRINT_SIZE)
  const coarsePixels = shrinkSquare(fingerprint.pixels, FINGERPRINT_SIZE, FINGERPRINT_SIZE / COARSE_SIZE)
  const comparable = countDetailedCells(fine) >= MIN_DETAILED_CELLS
  return {
    fingerprint,
    comparable,
    repetitive: comparable && measureSelfSimilarity(fine) >= REPETITIVE_SELF_CORRELATION,
    coarse: gradients(coarsePixels, COARSE_SIZE),
  }
}

// 지문 내용만으로 정한 순서. 가져온 순서·이름과 관계없이 같은 두 사진은 항상 같은 방향으로 비교한다.
export function compareFingerprintOrder(first: PhotoFingerprint, second: PhotoFingerprint): number {
  if (first.hash[0] !== second.hash[0]) return first.hash[0] - second.hash[0]
  if (first.hash[1] !== second.hash[1]) return first.hash[1] - second.hash[1]
  if (first.aspectRatio !== second.aspectRatio) return first.aspectRatio - second.aspectRatio
  for (let index = 0; index < first.pixels.length; index += 1) {
    if (first.pixels[index] !== second.pixels[index]) return first.pixels[index]! - second.pixels[index]!
  }
  return 0
}

const result = (
  kind: PhotoRelationKind,
  details: Partial<Omit<PhotoComparison, 'kind'>> = {},
): PhotoComparison => ({
  kind,
  hashDistance: details.hashDistance ?? null,
  correlation: details.correlation ?? null,
  detailedCells: details.detailedCells ?? 0,
  matchedCells: details.matchedCells ?? 0,
})

// 가로세로 비율의 상대 차이(큰 쪽 / 작은 쪽 - 1). 인수 순서와 관계없다.
function aspectDifference(first: PhotoFingerprint, second: PhotoFingerprint): number {
  return Math.max(first.aspectRatio, second.aspectRatio) / Math.min(first.aspectRatio, second.aspectRatio) - 1
}

// 구조 비교까지 갈 수 있는 후보 쌍인지(비율·윤곽·pHash만 보는 빠른 확인). 비교량을 미리 세는 데 쓴다.
export function isCandidatePair(first: PreparedFingerprint, second: PreparedFingerprint): boolean {
  if (!first.comparable || !second.comparable) return false
  if (aspectDifference(first.fingerprint, second.fingerprint) > ASPECT_TOLERANCE) return false
  return hashDistance(first.fingerprint.hash, second.fingerprint.hash) <= HASH_CANDIDATE_MAX
}

// 구조 비교의 측정값. 판정(comparePhotos)과 테스트·성능 측정이 함께 쓴다.
export interface StructureMeasurement {
  // 16×16 윤곽 상관(±1화소 이동 중 최대)
  readonly coarseCorrelation: number
  // 64×64에서 찾은 이동과 그 이동에서의 전체 윤곽 상관
  readonly shift: { readonly dx: number; readonly dy: number }
  readonly correlation: number
  readonly detailedCells: number
  readonly matchedCells: number
  // 윤곽이 있는 구역 중 가장 낮은 구역 상관. 그런 구역이 없으면 Infinity
  readonly lowestCellCorrelation: number
}

// 16×16 상관이 COARSE_MIN_CORRELATION보다 낮으면 64×64 비교를 하지 않고 coarseCorrelation만 돌려준다(full이 아니면).
export function measureStructure(
  a: PreparedFingerprint,
  b: PreparedFingerprint,
  { full = false }: { full?: boolean } = {},
): StructureMeasurement {
  const coarse = bestShift(a.coarse, b.coarse, COARSE_SHIFT_RANGE, 1)
  if (!full && coarse.correlation < COARSE_MIN_CORRELATION) {
    return {
      coarseCorrelation: coarse.correlation,
      shift: { dx: 0, dy: 0 },
      correlation: 0,
      detailedCells: 0,
      matchedCells: 0,
      lowestCellCorrelation: Infinity,
    }
  }

  const fineA = gradients(a.fingerprint.pixels, FINGERPRINT_SIZE)
  const fineB = gradients(b.fingerprint.pixels, FINGERPRINT_SIZE)
  // 이동은 두 화소 간격 표본으로 찾고, 찾은 이동에서 모든 화소로 다시 잰다.
  const shift = bestShift(fineA, fineB, SHIFT_RANGE, 2)
  const area = overlap(FINGERPRINT_SIZE, shift.dx, shift.dy)
  const correlation = compareWindow(fineA, fineB, shift.dx, shift.dy, area.left, area.top, area.right, area.bottom).correlation

  const columns = edgesOf(area.left, area.right, CELL_GRID)
  const rows = edgesOf(area.top, area.bottom, CELL_GRID)
  let detailedCells = 0
  let matchedCells = 0
  let lowestCellCorrelation = Infinity
  for (let row = 0; row < CELL_GRID; row += 1) {
    for (let column = 0; column < CELL_GRID; column += 1) {
      const cell = compareWindow(fineA, fineB, shift.dx, shift.dy, columns[column]!, rows[row]!, columns[column + 1]!, rows[row + 1]!)
      // 한쪽에만 윤곽이 있는 구역(물체가 사라지거나 나타남)도 불일치 근거로 센다.
      if (Math.max(cell.detailA, cell.detailB) < CELL_MIN_DETAIL) continue
      detailedCells += 1
      if (cell.correlation >= CELL_MATCH_CORRELATION) matchedCells += 1
      lowestCellCorrelation = Math.min(lowestCellCorrelation, cell.correlation)
    }
  }
  return {
    coarseCorrelation: coarse.correlation,
    shift: { dx: shift.dx, dy: shift.dy },
    correlation,
    detailedCells,
    matchedCells,
    lowestCellCorrelation,
  }
}

// 지문 내용 순서로 두 사진의 비교 방향을 정한다. 결과가 인수 순서와 관계없이 같게 한다.
export function orderPair(first: PreparedFingerprint, second: PreparedFingerprint): [PreparedFingerprint, PreparedFingerprint] {
  return compareFingerprintOrder(first.fingerprint, second.fingerprint) <= 0 ? [first, second] : [second, first]
}

// 두 사진을 비교한다. 결과는 인수 순서와 관계없이 같다.
export function comparePhotos(first: PreparedFingerprint, second: PreparedFingerprint): PhotoComparison {
  const [a, b] = orderPair(first, second)

  const aspectGap = aspectDifference(a.fingerprint, b.fingerprint)
  if (aspectGap > ASPECT_TOLERANCE) return result('different')
  if (!a.comparable || !b.comparable) return result('incomparable')

  const distance = hashDistance(a.fingerprint.hash, b.fingerprint.hash)
  if (distance > HASH_CANDIDATE_MAX) return result('different', { hashDistance: distance })

  const structure = measureStructure(a, b)
  if (structure.coarseCorrelation < COARSE_MIN_CORRELATION) return result('different', { hashDistance: distance })

  const { correlation, detailedCells, matchedCells, lowestCellCorrelation, shift } = structure
  const details = { hashDistance: distance, correlation, detailedCells, matchedCells }
  if (detailedCells < MIN_DETAILED_CELLS) return result('incomparable', details)

  const matchedFraction = matchedCells / detailedCells
  const isSimilar = matchedFraction >= SIMILAR_MIN_MATCHED_FRACTION && correlation >= SIMILAR_MIN_CORRELATION
  if (!isSimilar) {
    const isNear = matchedFraction >= UNCERTAIN_MIN_MATCHED_FRACTION && correlation >= UNCERTAIN_MIN_CORRELATION
    return result(isNear ? 'uncertain' : 'different', details)
  }
  if (a.repetitive || b.repetitive) return result('uncertain', details)
  const isSame =
    shift.dx === 0 &&
    shift.dy === 0 &&
    aspectGap <= SAME_ASPECT_TOLERANCE &&
    distance <= HASH_SAME_MAX &&
    correlation >= SAME_MIN_CORRELATION &&
    lowestCellCorrelation >= SAME_MIN_CELL_CORRELATION
  return result(isSame ? 'same' : 'similar', details)
}
