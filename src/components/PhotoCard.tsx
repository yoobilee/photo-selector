import type { Photo } from '../photos/photo.ts'
import { iconButtonClassName } from './buttonStyles.ts'
import CloseIcon from './CloseIcon.tsx'
import KeepButton, { KeptLabel } from './KeepButton.tsx'
import SharpnessBadge from './SharpnessBadge.tsx'
import { describeSharpness, sharpnessShortReason, type PhotoSharpnessState } from './sharpnessText.ts'

// 판정 사유를 사진 칸 아래에 직접 보여 준다(터치 화면에는 마우스를 올려 보는 설명이 없다).
// 같은 내용의 전체 문장을 사진 설명(describeSharpness)으로 읽으므로 낭독에서는 숨긴다.
function SharpnessReason({ state }: { state: PhotoSharpnessState }) {
  const reason = sharpnessShortReason(state)
  if (reason === null) return null
  return (
    <p
      aria-hidden="true"
      data-testid="sharpness-reason"
      className={`mt-0.5 text-xs leading-snug ${state.status === 'blurry' ? 'text-amber-900' : 'text-neutral-600'}`}
    >
      {reason}
    </p>
  )
}

interface PhotoCardProps {
  photo: Photo
  sharpness: PhotoSharpnessState
  // 모든 사진 보기에서 이 사진이 속한 비슷한 사진 묶음 번호. 없거나 묶음 보기에서는 null
  groupNumber: number | null
  kept: boolean
  onToggleKept: () => void
  onRemove: () => void
}

// 갤러리와 비슷한 사진 묶음이 함께 쓰는 사진 칸. 묶음 표시는 사진 위에 겹쳐 칸 크기를 바꾸지 않는다(분석 중 재배치 방지).
// 남기기 버튼과 남김 표시도 항상 같은 자리를 차지해 선택을 바꿔도 칸 크기가 바뀌지 않는다.
function PhotoCard({ photo, sharpness, groupNumber, kept, onToggleKept, onRemove }: PhotoCardProps) {
  return (
    <li className="min-w-0">
      <div className="relative">
        <img
          src={photo.thumbnailUrl}
          alt={photo.source.name}
          aria-describedby={`${photo.id}-sharpness`}
          width={photo.width}
          height={photo.height}
          loading="lazy"
          decoding="async"
          className={`aspect-square w-full rounded-md bg-neutral-200 object-cover ${kept ? 'ring-3 ring-emerald-700' : ''}`}
        />
        <SharpnessBadge state={sharpness} />
        <KeptLabel kept={kept} className="pointer-events-none absolute right-1 bottom-1" />
        {groupNumber !== null && (
          <span
            data-testid="similar-group-badge"
            className="pointer-events-none absolute bottom-1 left-1 rounded bg-sky-100 px-1.5 py-0.5 text-xs font-semibold text-sky-950 ring-1 ring-sky-400"
          >
            <span aria-hidden="true">묶음 {groupNumber}</span>
            <span className="sr-only">비슷한 사진 묶음 {groupNumber}</span>
          </span>
        )}
      </div>
      <span id={`${photo.id}-sharpness`} className="sr-only">
        {describeSharpness(sharpness)}
      </span>
      <KeepButton
        photoName={photo.source.name}
        kept={kept}
        onToggle={onToggleKept}
        photoId={photo.id}
        className="mt-1.5 w-full"
      />
      <div className="mt-1 flex items-center gap-1">
        <span aria-hidden="true" title={photo.source.name} className="min-w-0 flex-1 truncate text-xs text-neutral-700">
          {photo.source.name}
        </span>
        <button
          type="button"
          data-photo-id={photo.id}
          data-photo-control="remove"
          aria-label={`${photo.source.name} 목록에서 제거`}
          title="목록에서 제거"
          onClick={onRemove}
          className={`${iconButtonClassName} text-neutral-700 hover:bg-neutral-200 hover:text-neutral-950`}
        >
          <CloseIcon />
        </button>
      </div>
      <SharpnessReason state={sharpness} />
    </li>
  )
}

export default PhotoCard
