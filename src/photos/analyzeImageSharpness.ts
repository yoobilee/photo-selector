import {
  classifySharpness,
  downsampleByAverage,
  getAnalysisSize,
  measureSharpness,
  toGrayscale,
  type GrayImage,
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

// 원본 Blob을 디코딩해 분석 크기의 밝기 이미지를 만든다. 판정하기에 너무 작으면 null이다.
// 원본은 읽기만 하며, 디코딩한 원본 크기 화소와 캔버스는 끝나면 바로 해제한다. 디코딩 실패는 오류로 전달된다.
export async function decodeAnalysisImage(file: Blob, createContext: CreateAnalysisContext): Promise<GrayImage | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const size = getAnalysisSize(bitmap.width, bitmap.height)
    if (!size) return null

    // 브라우저마다 크게 줄일 때의 보간 방식이 달라 미세 경계가 달라진다. 원본이 충분히 크면 두 배 크기로 그린 뒤
    // 2×2 평균으로 줄여 브라우저 차이를 줄인다.
    const factor = bitmap.width >= size.width * 2 && bitmap.height >= size.height * 2 ? 2 : 1
    const width = size.width * factor
    const height = size.height * factor
    const context = createContext(width, height)
    if (!context) throw new Error('2D canvas context is unavailable')
    try {
      context.fillStyle = ANALYSIS_BACKGROUND
      context.fillRect(0, 0, width, height)
      context.imageSmoothingQuality = 'high'
      context.drawImage(bitmap, 0, 0, width, height)
      const gray = toGrayscale(context.getImageData(0, 0, width, height).data, width, height)
      return factor === 2 ? downsampleByAverage(gray, 2) : gray
    } finally {
      context.canvas.width = 0
      context.canvas.height = 0
    }
  } finally {
    bitmap.close()
  }
}

// 분석용 밝기 이미지(너무 작으면 null)의 판정 결과
export function classifyAnalysisImage(image: GrayImage | null): SharpnessResult {
  if (!image) return { status: 'unavailable', reason: 'too-small' }
  const verdict = classifySharpness(measureSharpness(image))
  return verdict === 'low-detail' ? { status: 'unavailable', reason: 'low-detail' } : { status: verdict }
}

// Worker 안에서 디코딩부터 판정까지 한다.
export async function analyzeImageSharpness(file: Blob): Promise<SharpnessResult> {
  return classifyAnalysisImage(await decodeAnalysisImage(file, createOffscreenContext))
}
