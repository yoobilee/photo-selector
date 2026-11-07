import KeepIcon from './KeepIcon.tsx'

const keepButtonBaseClassName =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700'
// 남긴 사진은 채운 버튼과 체크 아이콘, 아니면 테두리 버튼과 빈 원으로 구분한다.
const keptClassName =
  'border-emerald-800 bg-emerald-800 text-white hover:bg-emerald-900 [--keep-icon-check:var(--color-emerald-800)]'
const idleClassName = 'border-neutral-400 bg-white text-neutral-900 hover:bg-neutral-100'

interface KeepButtonProps {
  photoName: string
  kept: boolean
  onToggle: () => void
  className?: string
  // 갤러리에서 초점을 되돌릴 때 이 버튼을 찾는 데 쓴다.
  photoId?: string
  // 사진의 흐림 판정 등 버튼과 함께 읽을 설명
  'aria-describedby'?: string
}

// 사진을 남길지 사용자가 직접 표시하는 토글 버튼. 이름은 상태와 무관하게 같고 상태는 aria-pressed로 알린다.
function KeepButton({ photoName, kept, onToggle, className = '', photoId, 'aria-describedby': describedBy }: KeepButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={kept}
      aria-label={`${photoName} 남기기`}
      aria-describedby={describedBy}
      data-photo-id={photoId}
      data-photo-control={photoId ? 'keep' : undefined}
      onClick={onToggle}
      className={`${keepButtonBaseClassName} ${kept ? keptClassName : idleClassName} ${className}`}
    >
      <KeepIcon kept={kept} />
      남기기
    </button>
  )
}

// 남긴 사진에 붙이는 글자 표시. 같은 상태를 남기기 버튼의 aria-pressed로 알리므로 낭독에서는 숨긴다.
export function KeptLabel({ kept, className = '' }: { kept: boolean; className?: string }) {
  if (!kept) return null
  return (
    <span
      aria-hidden="true"
      data-testid="kept-label"
      className={`inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-100 px-1 py-0.5 text-xs font-semibold text-emerald-950 ring-1 ring-emerald-700 ${className}`}
    >
      <KeepIcon kept className="size-3 [--keep-icon-check:var(--color-emerald-100)]" />
      남김
    </span>
  )
}

export default KeepButton
