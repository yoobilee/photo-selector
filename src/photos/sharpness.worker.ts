import { analyzeImageSharpness, evaluateAnalysisImage, type SharpnessAnalysis } from './analyzeImageSharpness.ts'
import type { GrayImage } from './sharpness.ts'

// 흐림 분석 전용 Web Worker. 디코딩과 계산이 메인 스레드(화면 반응)를 막지 않게 한다.
// 받은 Blob은 같은 기기 메모리 안에서 전달된 원본 참조이며, 외부로 보내거나 수정하지 않는다.
// Worker에서 OffscreenCanvas를 쓸 수 없는 브라우저는 메인 스레드가 만든 작은 분석용 밝기 이미지(pixels)를 보낸다.
export type SharpnessWorkerRequest =
  | { readonly jobId: number; readonly kind: 'file'; readonly file: Blob }
  | { readonly jobId: number; readonly kind: 'pixels'; readonly image: GrayImage | null }

export interface SharpnessWorkerResponse extends SharpnessAnalysis {
  readonly jobId: number
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SharpnessWorkerRequest>) => void) | null
  postMessage(message: SharpnessWorkerResponse): void
}

scope.onmessage = async ({ data: request }) => {
  let analysis: SharpnessAnalysis
  try {
    analysis = request.kind === 'file' ? await analyzeImageSharpness(request.file) : evaluateAnalysisImage(request.image)
  } catch {
    // 오류 상세(파일 내용·메타데이터 포함 가능)는 전달하지 않는다.
    analysis = { result: { status: 'unavailable', reason: 'failed' }, measurement: null }
  }
  scope.postMessage({ jobId: request.jobId, ...analysis })
}
