import { sharpnessBadgeText, type PhotoSharpnessState } from './sharpnessText.ts'

const badgeBaseClassName =
  'pointer-events-none absolute top-1 left-1 max-w-[calc(100%-0.5rem)] rounded px-1.5 py-0.5 text-xs font-semibold ring-1'

// 사진 위에 겹치는 시각 표시. 선명한 사진에는 표시하지 않는다. 같은 내용을 describeSharpness가 낭독용으로 제공하므로 숨긴다.
function SharpnessBadge({ state }: { state: PhotoSharpnessState }) {
  const text = sharpnessBadgeText(state)
  if (text === null) return null
  const toneClassName =
    state.status === 'blurry' ? 'bg-amber-100 text-amber-950 ring-amber-400' : 'bg-white/90 text-neutral-700 ring-neutral-300'
  return (
    <span aria-hidden="true" data-testid="sharpness-badge" className={`${badgeBaseClassName} ${toneClassName}`}>
      {text}
    </span>
  )
}

export default SharpnessBadge
