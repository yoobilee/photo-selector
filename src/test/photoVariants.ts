import type { GrayImage } from '../photos/sharpness.ts'

// 비슷한 사진 판정 테스트용 변형. 같은 사진을 다른 크기·압축·밝기로 저장하거나, 카메라를 조금 움직여 다시 찍은 경우를 흉내 낸다.
// 실제 카메라·코덱의 결과와 같지 않으며, 합성 테스트 통과가 실제 사진에서의 정확도를 보장하지 않는다.

const clampTone = (value: number) => Math.min(255, Math.max(0, value))

// (x, y)에서 width × height만큼 잘라 낸다. 넓게 그린 장면을 잘라 카메라를 옮겨 찍은 사진을 만든다.
export function cropImage(image: GrayImage, x: number, y: number, width: number, height: number): GrayImage {
  const pixels = new Float32Array(width * height)
  for (let row = 0; row < height; row += 1) {
    pixels.set(image.pixels.subarray((y + row) * image.width + x, (y + row) * image.width + x + width), row * width)
  }
  return { width, height, pixels }
}

// 겹선형 보간으로 크기를 바꾼다(브라우저·편집기의 크기 변경과 다른 방식이라 일부러 쓴다).
export function resizeBilinear(image: GrayImage, width: number, height: number): GrayImage {
  const pixels = new Float32Array(width * height)
  const at = (x: number, y: number) => image.pixels[Math.min(image.height - 1, y) * image.width + Math.min(image.width - 1, x)]!
  for (let row = 0; row < height; row += 1) {
    const sy = Math.max(0, ((row + 0.5) * image.height) / height - 0.5)
    const y0 = Math.floor(sy)
    const fy = sy - y0
    for (let column = 0; column < width; column += 1) {
      const sx = Math.max(0, ((column + 0.5) * image.width) / width - 0.5)
      const x0 = Math.floor(sx)
      const fx = sx - x0
      pixels[row * width + column] =
        (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) + fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1))
    }
  }
  return { width, height, pixels }
}

// 밝기·대비·감마를 바꾼다. 결과는 0~255로 자른다.
export function adjustTone(image: GrayImage, { gain = 1, offset = 0, gamma = 1 } = {}): GrayImage {
  return {
    ...image,
    pixels: image.pixels.map((value) => clampTone(255 * (clampTone(value * gain + offset) / 255) ** gamma)),
  }
}

// JPEG 표준 밝기 양자화표(품질 50)
const LUMA_QUANTIZATION = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112,
  100, 103, 99,
]

// 8×8 블록 DCT 계수를 JPEG 밝기 양자화표로 양자화한 뒤 되돌린다(블록 경계·고주파 손실 흉내). quality는 1~100이다.
export function jpegLike(image: GrayImage, quality: number): GrayImage {
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2
  const table = LUMA_QUANTIZATION.map((value) => Math.max(1, Math.floor((value * scale + 50) / 100)))
  const cos = Array.from({ length: 64 }, (_, index) => {
    const frequency = Math.floor(index / 8)
    const position = index % 8
    return Math.cos(((2 * position + 1) * frequency * Math.PI) / 16)
  })
  const alpha = (frequency: number) => (frequency === 0 ? Math.SQRT1_2 : 1)
  const { width, height } = image
  const pixels = image.pixels.slice()
  const block = new Float64Array(64)
  const coefficients = new Float64Array(64)
  for (let top = 0; top + 8 <= height; top += 8) {
    for (let left = 0; left + 8 <= width; left += 8) {
      for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) block[y * 8 + x] = image.pixels[(top + y) * width + left + x]! - 128
      for (let v = 0; v < 8; v += 1) {
        for (let u = 0; u < 8; u += 1) {
          let sum = 0
          for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) sum += block[y * 8 + x]! * cos[u * 8 + x]! * cos[v * 8 + y]!
          const value = (alpha(u) * alpha(v) * sum) / 4
          const step = table[v * 8 + u]!
          coefficients[v * 8 + u] = Math.round(value / step) * step
        }
      }
      for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
          let sum = 0
          for (let v = 0; v < 8; v += 1) {
            for (let u = 0; u < 8; u += 1) sum += alpha(u) * alpha(v) * coefficients[v * 8 + u]! * cos[u * 8 + x]! * cos[v * 8 + y]!
          }
          pixels[(top + y) * width + left + x] = clampTone(sum / 4 + 128)
        }
      }
    }
  }
  return { width, height, pixels }
}

// 다른 장면의 평균 밝기와 대비를 기준 장면에 맞춘다(색·밝기 분포가 비슷한 다른 사진).
export function matchTone(image: GrayImage, reference: GrayImage): GrayImage {
  const stats = (pixels: Float32Array) => {
    const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length
    const deviation = Math.sqrt(pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pixels.length)
    return { mean, deviation }
  }
  const source = stats(image.pixels)
  const target = stats(reference.pixels)
  const gain = source.deviation > 0 ? target.deviation / source.deviation : 1
  return { ...image, pixels: image.pixels.map((value) => clampTone(target.mean + (value - source.mean) * gain)) }
}
