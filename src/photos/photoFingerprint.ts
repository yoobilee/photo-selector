// 비슷한 사진을 찾기 위한 사진 지문. React·DOM에 의존하지 않는 순수 함수이며 Web Worker에서 흐림 분석과 같은
// 분석용 밝기 이미지(GrayImage)로 계산한다. 원본을 다시 디코딩하지 않고, 원본 화소나 파일 내용은 담지 않는다.
//
// 지문은 두 가지로 이뤄진다.
// - pHash: 32×32로 줄인 밝기의 저주파 DCT 계수가 중앙값보다 큰지(63비트). 밝기·대비·해상도·압축에 둔감해 비교 후보를 빠르게 고른다.
// - 64×64 밝기: 후보를 윤곽(밝기 기울기) 구조로 확인하는 데 쓴다(photoSimilarity.ts). 사진 한 장에 4KB다.
import type { GrayImage } from './sharpness.ts'

// 비교용 밝기 이미지의 한 변. 가로세로 비율과 관계없이 정사각형으로 줄이고, 비율은 aspectRatio로 따로 비교한다.
export const FINGERPRINT_SIZE = 64
// pHash를 계산하는 크기와 쓰는 저주파 계수의 범위(직류 성분 제외 8×8 - 1 = 63개)
export const HASH_SOURCE_SIZE = 32
export const HASH_FREQUENCIES = 8
export const HASH_BITS = HASH_FREQUENCIES * HASH_FREQUENCIES - 1

export interface PhotoFingerprint {
  // 분석용 이미지의 가로 / 세로. EXIF 방향을 반영한 표시 방향 기준이다.
  readonly aspectRatio: number
  // 63비트 pHash. [32~62번 비트(31비트), 0~31번 비트]
  readonly hash: readonly [number, number]
  // FINGERPRINT_SIZE × FINGERPRINT_SIZE 밝기(0~255, 행 우선)
  readonly pixels: Uint8Array
}

// 각 칸이 원본의 어느 화소 범위를 덮는지. 길이 size + 1이며 칸마다 최소 한 화소를 덮는다(length ≥ size).
function binEdges(length: number, size: number): Int32Array {
  const edges = new Int32Array(size + 1)
  for (let index = 0; index <= size; index += 1) edges[index] = Math.round((index * length) / size)
  return edges
}

// 칸에 속한 화소의 평균으로 size × size로 줄인다. 원본이 size보다 작은 변이 있으면 쓸 수 없다.
export function resampleByArea(image: GrayImage, size: number): Float32Array {
  const { width, height, pixels } = image
  if (width < size || height < size) throw new Error('Image is smaller than the resample size')
  const xEdges = binEdges(width, size)
  const yEdges = binEdges(height, size)
  // 먼저 행마다 가로 칸의 합을 구하고, 그다음 세로로 더한다.
  const rowSums = new Float64Array(height * size)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let bin = 0; bin < size; bin += 1) {
      let sum = 0
      for (let x = xEdges[bin]!; x < xEdges[bin + 1]!; x += 1) sum += pixels[row + x]!
      rowSums[y * size + bin] = sum
    }
  }
  const result = new Float32Array(size * size)
  for (let yBin = 0; yBin < size; yBin += 1) {
    const top = yEdges[yBin]!
    const bottom = yEdges[yBin + 1]!
    for (let xBin = 0; xBin < size; xBin += 1) {
      let sum = 0
      for (let y = top; y < bottom; y += 1) sum += rowSums[y * size + xBin]!
      result[yBin * size + xBin] = sum / ((bottom - top) * (xEdges[xBin + 1]! - xEdges[xBin]!))
    }
  }
  return result
}

// 정수 배수 평균으로 정사각형 밝기 배열을 줄인다.
export function shrinkSquare(pixels: ArrayLike<number>, size: number, factor: number): Float32Array {
  const target = size / factor
  const result = new Float32Array(target * target)
  for (let y = 0; y < target; y += 1) {
    for (let x = 0; x < target; x += 1) {
      let sum = 0
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * size + x * factor
        for (let dx = 0; dx < factor; dx += 1) sum += pixels[row + dx]!
      }
      result[y * target + x] = sum / (factor * factor)
    }
  }
  return result
}

// 저주파 DCT-II 계수(정규화 상수 생략). 결과는 v(세로 주파수) 우선 HASH_FREQUENCIES × HASH_FREQUENCIES다.
function lowFrequencyDct(pixels: Float32Array, size: number): Float64Array {
  const cosines = new Float64Array(HASH_FREQUENCIES * size)
  for (let frequency = 0; frequency < HASH_FREQUENCIES; frequency += 1) {
    for (let position = 0; position < size; position += 1) {
      cosines[frequency * size + position] = Math.cos(((2 * position + 1) * frequency * Math.PI) / (2 * size))
    }
  }
  // 행마다 가로 주파수 성분을 구한 뒤 세로로 합친다.
  const rows = new Float64Array(size * HASH_FREQUENCIES)
  for (let y = 0; y < size; y += 1) {
    for (let u = 0; u < HASH_FREQUENCIES; u += 1) {
      let sum = 0
      for (let x = 0; x < size; x += 1) sum += pixels[y * size + x]! * cosines[u * size + x]!
      rows[y * HASH_FREQUENCIES + u] = sum
    }
  }
  const coefficients = new Float64Array(HASH_FREQUENCIES * HASH_FREQUENCIES)
  for (let v = 0; v < HASH_FREQUENCIES; v += 1) {
    for (let u = 0; u < HASH_FREQUENCIES; u += 1) {
      let sum = 0
      for (let y = 0; y < size; y += 1) sum += rows[y * HASH_FREQUENCIES + u]! * cosines[v * size + y]!
      coefficients[v * HASH_FREQUENCIES + u] = sum
    }
  }
  return coefficients
}

// 직류 성분을 뺀 63개 계수가 그 중앙값보다 크면 1이다. 밝기를 더하면 직류만, 대비를 바꾸면 모든 계수가 같은 배율로 바뀌어 비트가 유지된다.
export function perceptualHash(pixels64: Float32Array): readonly [number, number] {
  const coefficients = lowFrequencyDct(shrinkSquare(pixels64, FINGERPRINT_SIZE, FINGERPRINT_SIZE / HASH_SOURCE_SIZE), HASH_SOURCE_SIZE)
  const ac = Array.from(coefficients.subarray(1))
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)]!
  let high = 0
  let low = 0
  ac.forEach((value, bit) => {
    if (value <= median) return
    if (bit < 32) low |= 1 << bit
    else high |= 1 << (bit - 32)
  })
  return [high >>> 0, low >>> 0]
}

function popcount32(value: number): number {
  let bits = value - ((value >>> 1) & 0x55555555)
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333)
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

export function hashDistance(first: readonly [number, number], second: readonly [number, number]): number {
  return popcount32((first[0] ^ second[0]) >>> 0) + popcount32((first[1] ^ second[1]) >>> 0)
}

// Worker가 보낸 값이 지문 형식인지 확인한다.
export function isPhotoFingerprint(value: unknown): value is PhotoFingerprint {
  if (typeof value !== 'object' || value === null) return false
  const { aspectRatio, hash, pixels } = value as Partial<Record<keyof PhotoFingerprint, unknown>>
  return (
    typeof aspectRatio === 'number' &&
    Number.isFinite(aspectRatio) &&
    aspectRatio > 0 &&
    Array.isArray(hash) &&
    hash.length === 2 &&
    hash.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff) &&
    pixels instanceof Uint8Array &&
    pixels.length === FINGERPRINT_SIZE * FINGERPRINT_SIZE
  )
}

// 분석용 밝기 이미지에서 지문을 만든다. 비교용 크기보다 작은 변이 있으면 만들지 않는다(null).
// 이미지를 바꾸지 않으므로 같은 이미지로 하는 흐림 판정에 영향을 주지 않는다.
export function createPhotoFingerprint(image: GrayImage): PhotoFingerprint | null {
  if (image.width < FINGERPRINT_SIZE || image.height < FINGERPRINT_SIZE) return null
  const resampled = resampleByArea(image, FINGERPRINT_SIZE)
  const pixels = new Uint8Array(resampled.length)
  for (let index = 0; index < resampled.length; index += 1) {
    pixels[index] = Math.round(Math.min(255, Math.max(0, resampled[index]!)))
  }
  return { aspectRatio: image.width / image.height, hash: perceptualHash(Float32Array.from(pixels)), pixels }
}
