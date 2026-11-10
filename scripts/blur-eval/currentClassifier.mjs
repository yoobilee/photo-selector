// 현재 제품 판정. evaluateCache.mjs의 기본 판정 모듈이다(Node의 TypeScript 타입 제거 실행으로 src를 그대로 불러온다).
import { classifySharpness, estimateBlurCause, measureSharpness } from '../../src/photos/sharpness.ts'

export function judge(image) {
  const measurement = measureSharpness(image)
  const verdict = classifySharpness(measurement)
  return { verdict, cause: verdict === 'blurry' ? estimateBlurCause(measurement) : null, measurement }
}
