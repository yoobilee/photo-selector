import type { SharpnessResult, UnavailableReason } from '../photos/sharpness.ts'

// 결과가 아직 없는 사진은 분석 중이다.
export type PhotoSharpnessState = SharpnessResult | { readonly status: 'analyzing' }

export const unavailableReasonText: Record<UnavailableReason, string> = {
  'low-detail': '윤곽이 적거나 잡음이 많아 판정할 수 없습니다',
  'too-small': '사진이 너무 작아 판정할 수 없습니다',
  failed: '분석 중 오류가 발생했습니다',
  unsupported: '이 브라우저에서는 분석할 수 없습니다',
}

// 화면 낭독기가 사진마다 읽는 흐림 상태
export function describeSharpness(state: PhotoSharpnessState): string {
  switch (state.status) {
    case 'analyzing':
      return '흐림 확인 중'
    case 'sharp':
      return '흐림 의심 없음'
    case 'blurry':
      return '흐림 의심'
    case 'unavailable':
      return `흐림 분석 불가: ${unavailableReasonText[state.reason]}`
  }
}

export interface SharpnessSummary {
  // 화면에 보이는 문장(진행 수 포함)
  readonly visible: string
  // 화면 낭독기에 알릴 문장. 진행 수가 바뀔 때마다 읽지 않도록 분석 중에는 바뀌지 않는다.
  readonly announced: string
}

export function summarizeSharpness(states: readonly PhotoSharpnessState[]): SharpnessSummary {
  const count = (status: PhotoSharpnessState['status']) => states.filter((state) => state.status === status).length
  const analyzing = count('analyzing')
  if (analyzing > 0) {
    return { visible: `흐림 확인 중 ${states.length - analyzing}/${states.length}장`, announced: '흐림 확인 중' }
  }
  const blurry = count('blurry')
  const unavailable = count('unavailable')
  const parts = [blurry > 0 ? `흐림 의심 ${blurry}장` : '흐림 의심 사진이 없습니다']
  if (unavailable > 0) parts.push(`분석 불가 ${unavailable}장`)
  const text = parts.join(' · ')
  return { visible: text, announced: text }
}
