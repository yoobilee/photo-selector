import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { useIsPageZoomed } from '../hooks/useIsPageZoomed.ts'
import { useMediaQuery } from '../hooks/useMediaQuery.ts'
import type { Photo } from '../photos/photo.ts'
import { iconButtonClassName, secondaryButtonClassName } from './buttonStyles.ts'
import CloseIcon from './CloseIcon.tsx'
import KeepButton, { KeptLabel } from './KeepButton.tsx'
import KeepIcon from './KeepIcon.tsx'
import OriginalImage from './OriginalImage.tsx'
import SharpnessBadge from './SharpnessBadge.tsx'
import { describeSharpness, type PhotoSharpnessState } from './sharpnessText.ts'

// 이 너비 이상이면 두 장을 나란히 보여 준다.
export const SIDE_BY_SIDE_QUERY = '(min-width: 768px)'
// 손가락으로 이만큼(px) 가로로 밀면 이전·다음 사진으로 넘긴다.
const SWIPE_DISTANCE = 48

interface PhotoCompareDialogProps {
  // 비교하는 묶음 이름(예: 묶음 1 · 거의 같은 사진)
  title: string
  // 비교할 사진(갤러리 순서). 목록에서 빠진 사진은 호출자가 뺀다.
  photos: readonly Photo[]
  sharpnessOf: (photo: Photo) => PhotoSharpnessState
  keptIds: ReadonlySet<string>
  onSetKept: (photoId: string, kept: boolean) => void
  // 닫기 버튼, Esc 등으로 비교 화면이 닫힌 뒤 부른다.
  onClose: () => void
}

function ComparePane({
  photo,
  paneIndex,
  sharpness,
  kept,
  onToggleKept,
}: {
  photo: Photo
  // 화면에서 몇 번째 칸인지. 사진을 넘겨 칸이 바뀌어도 같은 칸의 남기기 버튼으로 초점을 옮기는 데 쓴다.
  paneIndex: number
  sharpness: PhotoSharpnessState
  kept: boolean
  onToggleKept: () => void
}) {
  const descriptionId = `compare-${photo.id}-sharpness`
  return (
    <figure className="flex min-h-0 min-w-0 flex-col" data-testid="compare-pane" data-pane-index={paneIndex}>
      <div className={`relative min-h-0 flex-1 overflow-hidden rounded-md bg-neutral-200 ${kept ? 'ring-3 ring-emerald-700' : ''}`}>
        {/* 원본을 읽는 동안 이미 만들어 둔 미리보기를 먼저 보여 준다. */}
        <OriginalImage
          file={photo.source}
          previewUrl={photo.thumbnailUrl}
          alt={photo.source.name}
          className="absolute inset-0 size-full object-contain"
        />
        <SharpnessBadge state={sharpness} />
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1">
            <KeptLabel kept={kept} />
            <span className="min-w-0 truncate text-sm font-semibold text-neutral-950" title={photo.source.name}>
              {photo.source.name}
            </span>
          </p>
          <p
            id={descriptionId}
            className={`text-sm ${sharpness.status === 'blurry' ? 'text-amber-900' : 'text-neutral-700'}`}
          >
            {describeSharpness(sharpness)}
          </p>
        </div>
        <KeepButton
          photoName={photo.source.name}
          kept={kept}
          onToggle={onToggleKept}
          className="shrink-0"
          aria-describedby={descriptionId}
        />
      </figcaption>
    </figure>
  )
}

// 비슷한 사진 묶음을 크게 비교하는 전체 화면. 넓은 화면은 두 장을 나란히, 좁은 화면은 한 장씩 보여 준다.
// 원본은 지금 보이는 사진만 읽고, 넘기거나 닫으면 바로 해제한다. 나머지 사진은 이미 만든 미리보기로 보여 준다.
function PhotoCompareDialog({ title, photos, sharpnessOf, keptIds, onSetKept, onClose }: PhotoCompareDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null)
  // 화면에 닿아 있는 손가락. 두 손가락 이상(확대·축소)이면 넘기기로 보지 않는다.
  const activePointersRef = useRef(new Set<number>())
  const isSideBySide = useMediaQuery(SIDE_BY_SIDE_QUERY)
  // 확대한 동안에는 가로 밀기를 확대한 화면 옮기기로 브라우저에 맡기고 사진 넘기기로 쓰지 않는다.
  const isZoomed = useIsPageZoomed()
  // 맨 앞에 보이는 사진. 비교 중 사진이 빠져도 같은 사진을 계속 보도록 위치 대신 id로 기억한다.
  const [firstPhotoId, setFirstPhotoId] = useState(() => photos[0]?.id ?? '')
  const [hasNavigated, setHasNavigated] = useState(false)
  // 키보드 초점이 마지막으로 있던 비교 칸. 넘기면 그 칸의 사진이 바뀌므로 같은 칸의 새 남기기 버튼으로 초점을 옮긴다.
  const focusedPaneIndexRef = useRef<number | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  const paneCount = Math.min(isSideBySide ? 2 : 1, photos.length)
  const lastStart = Math.max(0, photos.length - paneCount)
  const start = Math.min(Math.max(0, photos.findIndex((photo) => photo.id === firstPhotoId)), lastStart)
  const visiblePhotos = photos.slice(start, start + paneCount)
  const canGoBack = start > 0
  const canGoForward = start < lastStart

  const show = (index: number) => {
    const target = photos[Math.min(Math.max(0, index), lastStart)]
    if (!target) return
    setFirstPhotoId(target.id)
    setHasNavigated(true)
  }
  const goBack = () => {
    if (canGoBack) show(start - 1)
  }
  const goForward = () => {
    if (canGoForward) show(start + 1)
  }

  const position =
    paneCount === 0
      ? '0 / 0'
      : paneCount > 1
        ? `${start + 1}–${start + paneCount} / ${photos.length}`
        : `${start + 1} / ${photos.length}`
  const announcement = `${visiblePhotos.map((photo) => photo.source.name).join(', ')} · ${position}`

  const visibleKey = visiblePhotos.map((photo) => photo.id).join(' ')
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog?.open) return
    const activeElement = document.activeElement
    // 사진을 넘겨 초점이 있던 남기기 버튼이 사라졌을 때만 옮긴다.
    if (activeElement && activeElement !== document.body && dialog.contains(activeElement)) return
    const paneIndex = Math.min(focusedPaneIndexRef.current ?? 0, Math.max(0, visibleKey.split(' ').length - 1))
    const keepButton = dialog.querySelector<HTMLButtonElement>(`[data-pane-index="${paneIndex}"] button[aria-pressed]`)
    ;(keepButton ?? dialog.querySelector<HTMLButtonElement>('button'))?.focus()
  }, [visibleKey])

  const handlePaneFocus = (event: FocusEvent<HTMLDivElement>) => {
    const pane = event.target.closest<HTMLElement>('[data-pane-index]')
    focusedPaneIndexRef.current = pane ? Number(pane.dataset.paneIndex) : null
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goBack()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      goForward()
    }
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return
    activePointersRef.current.add(event.pointerId)
    swipeStartRef.current = activePointersRef.current.size === 1 ? { x: event.clientX, y: event.clientY } : null
  }
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId)
    const swipeStart = swipeStartRef.current
    swipeStartRef.current = null
    return swipeStart
  }
  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const swipeStart = endPointer(event)
    if (!swipeStart) return
    // 사진을 확대한 상태에서 미는 것은 확대한 화면을 옮기는 동작이므로 사진을 넘기지 않는다.
    if (isZoomed) return
    const dx = event.clientX - swipeStart.x
    const dy = event.clientY - swipeStart.y
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy)) return
    if (dx < 0) goForward()
    else goBack()
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="compare-heading"
      onClose={() => {
        // 이전에 닫았다가 다시 연 경우(개발 모드의 이중 실행 등) 늦게 도착한 닫힘 알림은 무시한다.
        if (!dialogRef.current?.open) onClose()
      }}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overscroll-contain bg-white p-0 text-neutral-900 backdrop:bg-neutral-950/70"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 sm:px-4">
          <h2 id="compare-heading" className="min-w-0 flex-1 truncate text-base font-bold text-neutral-950">
            {title} 크게 비교
          </h2>
          <button
            type="button"
            aria-label="비교 닫기"
            title="비교 닫기"
            onClick={() => dialogRef.current?.close()}
            className={`${iconButtonClassName} size-11 text-neutral-700 hover:bg-neutral-200 hover:text-neutral-950`}
          >
            <CloseIcon />
          </button>
        </div>

        <div
          data-testid="compare-panes"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerCancel={endPointer}
          onFocus={handlePaneFocus}
          // 세로 이동과 두 손가락 확대는 브라우저에 맡기고 가로 밀기만 사진 넘기기로 쓴다. 확대한 동안에는 모든 방향 이동을 브라우저에 맡긴다.
          className={`grid min-h-0 flex-1 ${isZoomed ? 'touch-manipulation' : 'touch-pan-y touch-pinch-zoom'} grid-rows-1 gap-3 p-3 sm:p-4 ${paneCount > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
        >
          {visiblePhotos.length === 0 && (
            <p className="self-center text-center text-sm text-neutral-700">비교할 사진이 목록에 없습니다.</p>
          )}
          {visiblePhotos.map((photo, paneIndex) => (
            <ComparePane
              key={photo.id}
              photo={photo}
              paneIndex={paneIndex}
              sharpness={sharpnessOf(photo)}
              kept={keptIds.has(photo.id)}
              onToggleKept={() => onSetKept(photo.id, !keptIds.has(photo.id))}
            />
          ))}
        </div>

        <div className="border-t border-neutral-200 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4">
          <div className="flex items-center justify-between gap-2">
            <button type="button" aria-disabled={!canGoBack} onClick={goBack} className={secondaryButtonClassName}>
              이전 사진
            </button>
            <p className="text-sm font-medium text-neutral-800" data-testid="compare-position">
              {position}
            </p>
            <button type="button" aria-disabled={!canGoForward} onClick={goForward} className={secondaryButtonClassName}>
              다음 사진
            </button>
          </div>
          <span className="sr-only" aria-live="polite">
            {hasNavigated ? announcement : ''}
          </span>
          {/* 묶음의 모든 사진을 미리보기로 보여 준다. 누르면 그 사진이 보이게 넘긴다. */}
          <ul aria-label="비교할 사진" className="mt-1 flex gap-2 overflow-x-auto p-1.5">
            {photos.map((photo, index) => {
              const isVisible = index >= start && index < start + paneCount
              const kept = keptIds.has(photo.id)
              return (
                <li key={photo.id} className="shrink-0">
                  <button
                    type="button"
                    aria-label={`${photo.source.name} 보기${kept ? ', 남김' : ''}`}
                    aria-current={isVisible ? 'true' : undefined}
                    onClick={() => show(index)}
                    className={`relative block size-14 overflow-hidden rounded-md ring-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 ${isVisible ? 'ring-3 ring-neutral-900' : 'opacity-80 hover:opacity-100'}`}
                  >
                    <img src={photo.thumbnailUrl} alt="" className="size-full bg-neutral-200 object-cover" />
                    {kept && (
                      <span className="absolute right-0.5 bottom-0.5 rounded-full bg-white text-emerald-800 [--keep-icon-check:white]">
                        <KeepIcon kept />
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </dialog>
  )
}

export default PhotoCompareDialog
