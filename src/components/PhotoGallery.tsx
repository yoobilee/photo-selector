import { useEffect, useRef, useState, type FocusEvent, type Ref } from 'react'
import type { SimilarPhotosState } from '../hooks/useSimilarPhotoGroups.ts'
import type { Photo } from '../photos/photo.ts'
import type { SharpnessResult } from '../photos/sharpness.ts'
import { primaryButtonClassName } from './buttonStyles.ts'
import PhotoCard from './PhotoCard.tsx'
import { summarizeSharpness, type PhotoSharpnessState } from './sharpnessText.ts'
import { similarGroupDescription, similarGroupTitle, summarizeSimilarPhotos } from './similarPhotosText.ts'

const ANALYZING: PhotoSharpnessState = { status: 'analyzing' }

type GalleryView = 'all' | 'groups'

const viewButtonClassName =
  'inline-flex min-h-11 items-center justify-center bg-white px-4 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-blue-700 aria-pressed:bg-neutral-900 aria-pressed:text-white aria-pressed:hover:bg-neutral-900 aria-pressed:focus-visible:outline-white'

interface PhotoGalleryProps {
  photos: readonly Photo[]
  // 사진 id별 흐림 분석 결과. 없는 사진은 분석 중이다.
  sharpness: ReadonlyMap<string, SharpnessResult>
  similar: SimilarPhotosState
  headingRef: Ref<HTMLHeadingElement>
  pickerButtonRef: Ref<HTMLButtonElement>
  isImporting: boolean
  onPickPhotos: () => void
  onRemovePhoto: (photoId: string) => void
}

function PhotoGallery({
  photos,
  sharpness,
  similar,
  headingRef,
  pickerButtonRef,
  isImporting,
  onPickPhotos,
  onRemovePhoto,
}: PhotoGalleryProps) {
  const [view, setView] = useState<GalleryView>('all')
  const removeButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  // 제거한 사진의 버튼이 사라져도 키보드 초점이 이웃 사진에 남도록 다음 대상을 기억한다.
  // 이웃이 없으면(마지막 사진이거나 묶음이 풀리면) App이 갤러리 제목으로 초점을 옮긴다.
  const pendingFocusPhotoIdRef = useRef<string | null>(null)

  // 키보드 초점이 있는 사진. 분석이 진행되며 묶음이 바뀌어 사진 칸이 다른 묶음으로 옮겨지면 초점을 되돌린다.
  const focusedPhotoIdRef = useRef<string | null>(null)
  const groupsViewButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const photoId = pendingFocusPhotoIdRef.current
    if (!photoId) return
    pendingFocusPhotoIdRef.current = null
    removeButtonsRef.current.get(photoId)?.focus()
  }, [photos])

  useEffect(() => {
    const photoId = focusedPhotoIdRef.current
    if (!photoId) return
    const activeElement = document.activeElement
    // 사용자가 초점을 다른 곳으로 옮겼으면 건드리지 않는다. 초점이 있던 칸이 다시 만들어져 잃은 경우만 되돌린다.
    if (activeElement && activeElement !== document.body) return
    // 사진이 어느 묶음에도 남지 않아 화면에서 사라졌으면 보기 전환 버튼으로 옮긴다.
    ;(removeButtonsRef.current.get(photoId) ?? groupsViewButtonRef.current)?.focus()
  }, [similar.groups])

  const handleFocusIn = (event: FocusEvent<HTMLElement>) => {
    focusedPhotoIdRef.current = event.target instanceof HTMLElement ? (event.target.dataset.photoId ?? null) : null
  }
  const handleFocusOut = (event: FocusEvent<HTMLElement>) => {
    // 칸이 화면에서 빠져 초점을 잃은 경우(분리된 요소)는 기억을 남겨 되돌릴 수 있게 한다.
    if (event.target.isConnected && event.relatedTarget === null) focusedPhotoIdRef.current = null
  }

  // siblings는 사진 칸이 놓인 목록(전체 목록 또는 묶음)이다. 묶음에 한 장만 남으면 묶음이 사라지므로 이웃으로 옮기지 않는다.
  const handleRemove = (photo: Photo, siblings: readonly Photo[], keepsSiblings: boolean) => {
    const index = siblings.indexOf(photo)
    const neighbor = keepsSiblings ? (siblings[index + 1] ?? siblings[index - 1]) : undefined
    pendingFocusPhotoIdRef.current = neighbor?.id ?? null
    // 제거 후 초점은 이웃 사진이나 갤러리 제목이 받는다. 묶음 변경에 따른 초점 되돌리기와 겹치지 않게 한다.
    focusedPhotoIdRef.current = null
    onRemovePhoto(photo.id)
  }

  const sharpnessOf = (photo: Photo): PhotoSharpnessState => sharpness.get(photo.id) ?? ANALYZING
  const summary = summarizeSharpness(photos.map(sharpnessOf))
  const similarSummary = summarizeSimilarPhotos(similar)
  const groupNumberOf = new Map(
    similar.groups.flatMap((group, index) => group.photos.map((photo) => [photo.id, index + 1] as const)),
  )
  const groupedCount = groupNumberOf.size

  const renderCard = (photo: Photo, siblings: readonly Photo[], keepsSiblings: boolean, groupNumber: number | null) => (
    <PhotoCard
      key={photo.id}
      photo={photo}
      sharpness={sharpnessOf(photo)}
      groupNumber={groupNumber}
      removeButtonRef={(element) => {
        if (element) removeButtonsRef.current.set(photo.id, element)
        else removeButtonsRef.current.delete(photo.id)
      }}
      onRemove={() => handleRemove(photo, siblings, keepsSiblings)}
    />
  )

  return (
    <section aria-labelledby="gallery-heading" onFocus={handleFocusIn} onBlur={handleFocusOut}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="gallery-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-bold text-neutral-950 focus:outline-none"
        >
          선택한 사진 {photos.length}장
        </h2>
        <button
          ref={pickerButtonRef}
          type="button"
          aria-disabled={isImporting}
          onClick={onPickPhotos}
          className={primaryButtonClassName}
        >
          사진 추가
        </button>
      </div>
      <p className="mt-2 text-sm text-neutral-600">
        목록에서 제거해도 기기에 저장된 원본 파일은 삭제되지 않습니다.
      </p>
      {/* 흐림 판정과 비슷한 사진 묶음은 기기 안에서만 계산한 참고 정보이며 사진을 자동으로 지우거나 바꾸지 않는다. */}
      <p className="mt-1 text-sm font-medium text-neutral-800">
        <span aria-hidden="true">{summary.visible}</span>
        <span className="sr-only" aria-live="polite" data-testid="sharpness-summary">
          {summary.announced}
        </span>
      </p>
      <p className="mt-1 text-sm font-medium text-neutral-800">
        <span aria-hidden="true">{similarSummary}</span>
        <span className="sr-only" aria-live="polite" data-testid="similar-summary">
          {similarSummary}
        </span>
      </p>

      <div role="group" aria-label="사진 보기 방식" className="mt-4 inline-flex overflow-hidden rounded-md border border-neutral-400">
        <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')} className={viewButtonClassName}>
          모든 사진
        </button>
        <button
          ref={groupsViewButtonRef}
          type="button"
          aria-pressed={view === 'groups'}
          onClick={() => setView('groups')}
          className={`${viewButtonClassName} border-l border-neutral-400`}
        >
          비슷한 사진끼리 보기
        </button>
      </div>

      {view === 'all' ? (
        <ul className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-2 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] sm:gap-x-3">
          {photos.map((photo) => renderCard(photo, photos, true, groupNumberOf.get(photo.id) ?? null))}
        </ul>
      ) : (
        <div className="mt-5 space-y-5">
          {similar.groups.length === 0 && (
            <p className="text-sm text-neutral-700">
              {similar.checkingCount > 0
                ? '비슷한 사진을 확인하고 있습니다. 분석이 끝난 사진부터 묶음에 나타납니다.'
                : '비슷한 사진 묶음이 없습니다.'}
            </p>
          )}
          {similar.groups.map((group, index) => {
            const headingId = `similar-group-${index + 1}`
            return (
              // 묶음 순서로 key를 정해, 분석 중 묶음에 사진이 더해져도 묶음과 사진 칸을 다시 만들지 않는다(키보드 초점 유지).
              <section
                key={index}
                aria-labelledby={headingId}
                className="rounded-lg border border-neutral-300 bg-white p-3 sm:p-4"
              >
                <h3 id={headingId} className="text-base font-bold text-neutral-950">
                  묶음 {index + 1} · {similarGroupTitle(group.kind, group.photos.length)}
                </h3>
                <p className="mt-1 text-sm text-neutral-700">{similarGroupDescription[group.kind]}</p>
                {/* 비교하기 쉽도록 좁은 화면에서도 두 장씩 크게 보여 준다. */}
                <ul className="mt-3 grid grid-cols-2 gap-x-2 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] sm:gap-x-3">
                  {group.photos.map((photo) => renderCard(photo, group.photos, group.photos.length > 2, null))}
                </ul>
              </section>
            )
          })}
          {photos.length > groupedCount && (
            <p className="text-sm text-neutral-600">
              묶음에 없는 사진 {photos.length - groupedCount}장은 ‘모든 사진’에서 볼 수 있습니다.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

export default PhotoGallery
