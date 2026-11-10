import type { SharpnessMeasurement } from '../photos/sharpness.ts'

// 판정 로직을 거치지 않는 테스트(분석기 응답·평가 도구)에서 쓰는 측정값. 지정하지 않은 값은 흔들림 근거가 없는 기본값이다.
export function createMeasurement(overrides: Partial<SharpnessMeasurement> = {}): SharpnessMeasurement {
  return {
    score: null,
    hasUnjudgedDirection: false,
    noise: 0,
    directionScores: [null, null, null, null],
    shake: null,
    isotropicBlurRegions: 0,
    halfScale: null,
    ...overrides,
  }
}
