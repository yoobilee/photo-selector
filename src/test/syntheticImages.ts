import type { GrayImage } from '../photos/sharpness.ts'

// 흐림 판정 테스트용 재현 가능한 합성 이미지. 같은 seed는 해상도와 관계없이 같은 장면(정규화 좌표)을 그린다.
// 단위 테스트(밝기 배열)와 E2E 고정 파일(PNG) 생성이 함께 쓴다.

// 32비트 정수 seed의 결정적 난수(mulberry32)
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

type Shape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; tone: number }
  | { kind: 'circle'; x: number; y: number; r: number; tone: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; thickness: number; tone: number }

function createShapes(seed: number): Shape[] {
  const random = createRandom(seed)
  const tone = () => 20 + random() * 215
  const shapes: Shape[] = []
  for (let index = 0; index < 40; index += 1) {
    shapes.push({ kind: 'rect', x: random(), y: random(), w: 0.02 + random() * 0.22, h: 0.02 + random() * 0.22, tone: tone() })
  }
  for (let index = 0; index < 25; index += 1) {
    shapes.push({ kind: 'circle', x: random(), y: random(), r: 0.01 + random() * 0.1, tone: tone() })
  }
  for (let index = 0; index < 30; index += 1) {
    const x1 = random()
    const y1 = random()
    shapes.push({ kind: 'line', x1, y1, x2: x1 + (random() - 0.5) * 0.4, y2: y1 + (random() - 0.5) * 0.4, thickness: 0.002 + random() * 0.004, tone: tone() })
  }
  // 글자처럼 작은 획이 모인 영역
  const blockX = 0.1 + random() * 0.5
  const blockY = 0.1 + random() * 0.5
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 14; column += 1) {
      if (random() < 0.3) continue
      shapes.push({ kind: 'rect', x: blockX + column * 0.018, y: blockY + row * 0.03, w: 0.006 + random() * 0.008, h: 0.018, tone: 25 })
    }
  }
  return shapes
}

function drawShape(pixels: Float32Array, width: number, height: number, shape: Shape) {
  const scale = Math.max(width, height)
  const fill = (minX: number, minY: number, maxX: number, maxY: number, inside: (px: number, py: number) => boolean, tone: number) => {
    for (let y = Math.max(0, Math.floor(minY)); y < Math.min(height, Math.ceil(maxY)); y += 1) {
      for (let x = Math.max(0, Math.floor(minX)); x < Math.min(width, Math.ceil(maxX)); x += 1) {
        if (inside(x + 0.5, y + 0.5)) pixels[y * width + x] = tone
      }
    }
  }
  if (shape.kind === 'rect') {
    const x = shape.x * width
    const y = shape.y * height
    const w = shape.w * scale
    const h = shape.h * scale
    fill(x, y, x + w, y + h, () => true, shape.tone)
  } else if (shape.kind === 'circle') {
    const cx = shape.x * width
    const cy = shape.y * height
    const r = shape.r * scale
    fill(cx - r, cy - r, cx + r, cy + r, (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r, shape.tone)
  } else {
    const x1 = shape.x1 * width
    const y1 = shape.y1 * height
    const x2 = shape.x2 * width
    const y2 = shape.y2 * height
    const half = (shape.thickness * scale) / 2
    const length = Math.hypot(x2 - x1, y2 - y1) || 1
    fill(Math.min(x1, x2) - half, Math.min(y1, y2) - half, Math.max(x1, x2) + half, Math.max(y1, y2) + half, (px, py) => {
      const t = Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / (length * length)))
      return Math.hypot(px - (x1 + t * (x2 - x1)), py - (y1 + t * (y2 - y1))) <= half
    }, shape.tone)
  }
}

// 세로 그라데이션 배경 위에 사각형·원·선·글자 획을 그린 장면. 가장자리는 계단형(앤티에일리어싱 없음)이다.
export function renderScene(width: number, height: number, seed: number): GrayImage {
  const pixels = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) pixels.fill(60 + (120 * y) / Math.max(1, height - 1), y * width, (y + 1) * width)
  for (const shape of createShapes(seed)) drawShape(pixels, width, height, shape)
  return { width, height, pixels }
}

// 위에서 아래로 밝아지는 매끈한 그라데이션(맑은 하늘처럼 윤곽이 없는 사진)
export function renderGradient(width: number, height: number, from = 70, to = 200): GrayImage {
  const pixels = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) pixels.fill(from + ((to - from) * y) / Math.max(1, height - 1), y * width, (y + 1) * width)
  return { width, height, pixels }
}

export function renderUniform(width: number, height: number, tone = 128): GrayImage {
  return { width, height, pixels: new Float32Array(width * height).fill(tone) }
}

// 분리 가능한 가우시안 흐림. 가장자리는 가장 가까운 화소를 반복한다. sigma가 0 이하면 복사본을 돌려준다.
export function gaussianBlur(image: GrayImage, sigma: number): GrayImage {
  const { width, height } = image
  if (sigma <= 0) return { width, height, pixels: image.pixels.slice() }
  const radius = Math.ceil(sigma * 3)
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, index) => Math.exp(-((index - radius) ** 2) / (2 * sigma * sigma)))
  const total = kernel.reduce((sum, value) => sum + value, 0)
  const weights = kernel.map((value) => value / total)
  const pass = (source: Float32Array, horizontal: boolean) => {
    const target = new Float32Array(source.length)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        for (let offset = -radius; offset <= radius; offset += 1) {
          const sx = horizontal ? Math.min(width - 1, Math.max(0, x + offset)) : x
          const sy = horizontal ? y : Math.min(height - 1, Math.max(0, y + offset))
          sum += source[sy * width + sx]! * weights[offset + radius]!
        }
        target[y * width + x] = sum
      }
    }
    return target
  }
  return { width, height, pixels: pass(pass(image.pixels, true), false) }
}

// 가로 방향으로 length 화소만큼 끌린 흔들림(손떨림·피사체 이동). 가장자리는 가장 가까운 화소를 반복한다.
export function motionBlur(image: GrayImage, length: number): GrayImage {
  const { width, height } = image
  const half = Math.floor(length / 2)
  const pixels = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      for (let offset = -half; offset <= half; offset += 1) sum += image.pixels[y * width + Math.min(width - 1, Math.max(0, x + offset))]!
      pixels[y * width + x] = sum / (half * 2 + 1)
    }
  }
  return { width, height, pixels }
}

// 평균 0, 표준편차 amount의 결정적 가우시안 잡음을 더하고 0~255로 자른다.
export function addNoise(image: GrayImage, amount: number, seed: number): GrayImage {
  const random = createRandom(seed)
  const pixels = image.pixels.map((value) => {
    const noise = Math.sqrt(-2 * Math.log(random() || Number.MIN_VALUE)) * Math.cos(2 * Math.PI * random())
    return Math.min(255, Math.max(0, value + noise * amount))
  })
  return { ...image, pixels }
}

// 평균 밝기를 중심으로 대비를 factor배로 줄인다.
export function scaleContrast(image: GrayImage, factor: number, center = 128): GrayImage {
  return { ...image, pixels: image.pixels.map((value) => center + (value - center) * factor) }
}

// region 안은 sharp, 밖은 blurred의 화소를 쓴다(배경 흐림 속 선명한 피사체). 좌표는 0~1 비율이다.
export function composite(
  blurred: GrayImage,
  sharp: GrayImage,
  region: { x: number; y: number; w: number; h: number },
): GrayImage {
  const pixels = blurred.pixels.slice()
  const { width, height } = blurred
  for (let y = Math.floor(region.y * height); y < Math.min(height, Math.ceil((region.y + region.h) * height)); y += 1) {
    for (let x = Math.floor(region.x * width); x < Math.min(width, Math.ceil((region.x + region.w) * width)); x += 1) {
      pixels[y * width + x] = sharp.pixels[y * width + x]!
    }
  }
  return { width, height, pixels }
}

// 밝기 이미지를 RGBA(불투명 회색)로 바꾼다. 브라우저가 실제로 디코딩하는 E2E 고정 파일을 만들 때 쓴다.
export function toRgba(image: GrayImage): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(image.width * image.height * 4)
  image.pixels.forEach((value, index) => {
    const tone = Math.round(Math.min(255, Math.max(0, value)))
    rgba.set([tone, tone, tone, 255], index * 4)
  })
  return rgba
}
