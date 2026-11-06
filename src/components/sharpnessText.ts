import type { BlurCause, SharpnessResult, UnavailableReason } from '../photos/sharpness.ts'

// 결과가 아직 없는 사진은 분석 중이다.
export type PhotoSharpnessState = SharpnessResult | { readonly status: 'analyzing' }

export const unavailableReasonText: Record<UnavailableReason, string> = {
  'low-detail': '윤곽이 적거나 잡음이 많아 판정할 수 없습니다',
  'too-small': '사진이 너무 작아 판정할 수 없습니다',
  failed: '분석 중 오류가 발생했습니다',
  unsupported: '이 브라우저에서는 분석할 수 없습니다',
  timeout: '분석이 너무 오래 걸려 중단했습니다',
}

// 흐림 의심 표시 문구. 원인은 추정이므로 모두 '의심'으로 표현한다. 원인을 구분할 근거가 부족하면 흐림 의심이다.
export const blurCauseLabel: Record<BlurCause, string> = {
  shake: '흔들림 의심',
  defocus: '초점 불량 의심',
  unknown: '흐림 의심',
}

// 판정 근거로 관찰한 모양. 원인을 단정하지 않고 사진에서 보인 특징만 말한다.
export const blurCauseReasonText: Record<BlurCause, string> = {
  shake: '윤곽이 한 방향으로 번져 있습니다',
  defocus: '윤곽이 모든 방향으로 고르게 흐립니다',
  unknown: '윤곽이 흐리지만 원인은 구분하기 어렵습니다',
}

// 좁은 사진 칸 아래에 직접 보여 줄 짧은 사유. 같은 내용의 전체 문장은 describeSharpness가 낭독용으로 제공한다.
const blurCauseShortReason: Record<BlurCause, string> = {
  shake: '한 방향으로 번진 윤곽',
  defocus: '전체가 고르게 흐림',
  unknown: '원인 구분 어려움',
}

const unavailableShortReason: Record<UnavailableReason, string> = {
  'low-detail': '윤곽 부족 또는 잡음',
  'too-small': '사진이 너무 작음',
  failed: '분석 오류',
  unsupported: '브라우저 미지원',
  timeout: '분석 시간 초과',
}

// 사진 위 표시 문구. 선명한 사진에는 표시하지 않는다.
export function sharpnessBadgeText(state: PhotoSharpnessState): string | null {
  switch (state.status) {
    case 'analyzing':
      return '확인 중'
    case 'sharp':
      return null
    case 'blurry':
      return blurCauseLabel[state.cause]
    case 'unavailable':
      return '분석 불가'
  }
}

// 사진 칸 아래에 직접 보여 줄 판정 사유. 분석 중이거나 선명하면 없다.
export function sharpnessShortReason(state: PhotoSharpnessState): string | null {
  switch (state.status) {
    case 'analyzing':
    case 'sharp':
      return null
    case 'blurry':
      return blurCauseShortReason[state.cause]
    case 'unavailable':
      return unavailableShortReason[state.reason]
  }
}

// 화면 낭독기가 사진마다 읽는 흐림 상태
export function describeSharpness(state: PhotoSharpnessState): string {
  switch (state.status) {
    case 'analyzing':
      return '흐림 확인 중'
    case 'sharp':
      return '흐림 의심 없음'
    case 'blurry':
      return `${blurCauseLabel[state.cause]}: ${blurCauseReasonText[state.cause]}`
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

const BLUR_CAUSE_ORDER: readonly BlurCause[] = ['shake', 'defocus', 'unknown']

export function summarizeSharpness(states: readonly PhotoSharpnessState[]): SharpnessSummary {
  const analyzing = states.filter((state) => state.status === 'analyzing').length
  if (analyzing > 0) {
    return { visible: `흐림 확인 중 ${states.length - analyzing}/${states.length}장`, announced: '흐림 확인 중' }
  }
  const parts: string[] = []
  for (const cause of BLUR_CAUSE_ORDER) {
    const count = states.filter((state) => state.status === 'blurry' && state.cause === cause).length
    if (count > 0) parts.push(`${blurCauseLabel[cause]} ${count}장`)
  }
  if (parts.length === 0) parts.push('흐림 의심 사진이 없습니다')
  const unavailable = states.filter((state) => state.status === 'unavailable').length
  if (unavailable > 0) parts.push(`분석 불가 ${unavailable}장`)
  const text = parts.join(' · ')
  return { visible: text, announced: text }
}
