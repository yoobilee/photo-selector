import { createAnalysisDownsampler } from './analysisDownsample.ts'
import { createPhotoFingerprint, type PhotoFingerprint } from './photoFingerprint.ts'
import {
  classifySharpness,
  estimateBlurCause,
  getAnalysisSize,
  measureSharpness,
  type GrayImage,
  type SharpnessMeasurement,
  type SharpnessResult,
} from './sharpness.ts'

// 투명 영역을 채울 배경색. 미리보기와 같은 흰색이다.
const ANALYSIS_BACKGROUND = '#ffffff'

// 분석용 화소를 그릴 2D 컨텍스트를 만든다. Worker에서는 OffscreenCanvas, 메인 스레드에서는 canvas 요소를 쓴다.
export type CreateAnalysisContext = (
  width: number,
  height: number,
) => OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null

export const createOffscreenContext: CreateAnalysisContext = (width, height) =>
  new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })

// 판정 결과와 판정에 쓴 측정값. 사용자 화면은 result만 쓰고, 개발용 평가 도구는 측정값도 함께 기록한다.
// 너무 작아 측정하지 않았거나 분석에 실패하면 measurement는 null이다.
export interface SharpnessAnalysis {
  readonly result: SharpnessResult
  readonly measurement: SharpnessMeasurement | null
}

// 원본을 읽는 캔버스 한 장의 최대 폭과 최대 화소 수. 원본 크기 캔버스를 만들지 않고 이 크기씩 나눠 읽는다.
// 화소 수 상한은 띠 한 줄 묶음(RGBA 약 1MB)이다. 띠마다 읽은 화소는 바로 버려지므로 작게 나눠야 수거 전에 쌓이는
// 메모리가 줄어든다(24MP 사진에서 4MB 띠보다 최대 메모리가 낮았다). 폭 상한은 브라우저 캔버스 크기 제한보다 충분히 작다.
export const ANALYSIS_TILE_EDGE = 4096
export const ANALYSIS_STRIP_PIXELS = 262_144

// 원본 Blob을 디코딩해 분석 크기의 밝기 이미지를 만든다. 판정하기에 너무 작으면 null이다.
// 원본은 읽기만 하며, 디코딩한 화소와 캔버스는 끝나면 바로 해제한다. 디코딩 실패는 오류로 전달된다.
//
// 캔버스로 크게 줄이면 브라우저(Chromium·WebKit)마다 보간 방식이 달라 같은 사진의 미세 경계와 잡음 추정이 달라지고
// 판정이 갈린다(docs/sharpness-browser-consistency.md). 그래서 캔버스는 원본을 축소 없이 1:1로 옮기는 데만 쓰고,
// 띠 단위로 읽은 화소를 createAnalysisDownsampler(면적 평균 + 기존 캔버스 경로의 8비트 구조)로 줄인다.
// 원본 크기의 전체 화소 배열은 만들지 않는다.
export async function decodeAnalysisImage(file: Blob, createContext: CreateAnalysisContext): Promise<GrayImage | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const size = getAnalysisSize(bitmap.width, bitmap.height)
    if (!size) return null

    const { width, height } = bitmap
    const tileWidth = Math.min(width, ANALYSIS_TILE_EDGE)
    const stripHeight = Math.max(1, Math.min(height, Math.floor(ANALYSIS_STRIP_PIXELS / width)))
    const context = createContext(tileWidth, stripHeight)
    if (!context) throw new Error('2D canvas context is unavailable')
    try {
      // 1:1 복사이므로 보간이 끼지 않게 끈다.
      context.imageSmoothingEnabled = false
      context.fillStyle = ANALYSIS_BACKGROUND
      const downsampler = createAnalysisDownsampler(width, height, size)
      // 폭이 타일보다 넓으면 타일들을 이 버퍼에 이어 붙여 원본 행을 만든다.
      const rows = tileWidth === width ? null : new Uint8ClampedArray(width * stripHeight * 4)
      for (let top = 0; top < height; top += stripHeight) {
        const count = Math.min(stripHeight, height - top)
        for (let left = 0; left < width; left += tileWidth) {
          const span = Math.min(tileWidth, width - left)
          context.fillRect(0, 0, span, count)
          context.drawImage(bitmap, left, top, span, count, 0, 0, span, count)
          const tile = context.getImageData(0, 0, span, count).data
          if (!rows) {
            downsampler.addRows(tile, top)
            continue
          }
          for (let row = 0; row < count; row += 1) {
            rows.set(tile.subarray(row * span * 4, (row + 1) * span * 4), (row * width + left) * 4)
          }
        }
        if (rows) downsampler.addRows(rows.subarray(0, width * count * 4), top)
      }
      return downsampler.finish()
    } finally {
      context.canvas.width = 0
      context.canvas.height = 0
    }
  } finally {
    bitmap.close()
  }
}

// 분석용 밝기 이미지(너무 작으면 null)를 측정하고 판정한다. 판정은 classifySharpness 하나로만 한다.
export function evaluateAnalysisImage(image: GrayImage | null): SharpnessAnalysis {
  if (!image) return { result: { status: 'unavailable', reason: 'too-small' }, measurement: null }
  const measurement = measureSharpness(image)
  return { result: toSharpnessResult(measurement), measurement }
}

function toSharpnessResult(measurement: SharpnessMeasurement): SharpnessResult {
  switch (classifySharpness(measurement)) {
    case 'sharp':
      return { status: 'sharp' }
    case 'blurry':
      return { status: 'blurry', cause: estimateBlurCause(measurement) }
    case 'low-detail':
      return { status: 'unavailable', reason: 'low-detail' }
  }
}

export function classifyAnalysisImage(image: GrayImage | null): SharpnessResult {
  return evaluateAnalysisImage(image).result
}

// Worker 안에서 디코딩부터 판정까지 한다.
export async function analyzeImageSharpness(file: Blob): Promise<SharpnessAnalysis> {
  return evaluateAnalysisImage(await decodeAnalysisImage(file, createOffscreenContext))
}

// 흐림 판정과 비슷한 사진 지문. 같은 분석용 이미지 한 장으로 둘 다 계산해 원본을 다시 디코딩하지 않는다.
// 너무 작아 분석용 이미지가 없으면 지문도 없다.
export interface PhotoImageAnalysis extends SharpnessAnalysis {
  readonly fingerprint: PhotoFingerprint | null
}

// 흐림 판정을 먼저 하고 같은 이미지로 지문을 만든다. 지문 계산은 이미지를 바꾸지 않으므로 흐림 판정 결과에 영향이 없다.
export function evaluatePhotoImage(image: GrayImage | null): PhotoImageAnalysis {
  const analysis = evaluateAnalysisImage(image)
  return { ...analysis, fingerprint: image ? createPhotoFingerprint(image) : null }
}

export async function analyzePhotoImage(file: Blob): Promise<PhotoImageAnalysis> {
  return evaluatePhotoImage(await decodeAnalysisImage(file, createOffscreenContext))
}
