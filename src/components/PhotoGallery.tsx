import { useEffect, useRef, type Ref } from 'react'
import type { Photo } from '../photos/photo.ts'
import type { SharpnessResult } from '../photos/sharpness.ts'
import { iconButtonClassName, primaryButtonClassName } from './buttonStyles.ts'
import CloseIcon from './CloseIcon.tsx'
import SharpnessBadge from './SharpnessBadge.tsx'
import { describeSharpness, summarizeSharpness, type PhotoSharpnessState } from './sharpnessText.ts'

const ANALYZING: PhotoSharpnessState = { status: 'analyzing' }

interface PhotoGalleryProps {
  photos: readonly Photo[]
  // 사진 id별 흐림 분석 결과. 없는 사진은 분석 중이다.
  sharpness: ReadonlyMap<string, SharpnessResult>
  headingRef: Ref<HTMLHeadingElement>
  pickerButtonRef: Ref<HTMLButtonElement>
  isImporting: boolean
  onPickPhotos: () => void
  onRemovePhoto: (photoId: string) => void
}

function PhotoGallery({
  photos,
  sharpness,
  headingRef,
  pickerButtonRef,
  isImporting,
  onPickPhotos,
  onRemovePhoto,
}: PhotoGalleryProps) {
  const removeButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  // 제거한 사진의 버튼이 사라져도 키보드 초점이 이웃 사진에 남도록 다음 대상을 기억한다.
  const pendingFocusPhotoIdRef = useRef<string | null>(null)

  useEffect(() => {
    const photoId = pendingFocusPhotoIdRef.current
    if (!photoId) return
    pendingFocusPhotoIdRef.current = null
    removeButtonsRef.current.get(photoId)?.focus()
  }, [photos])

  const handleRemove = (index: number) => {
    const photo = photos[index]
    if (!photo) return
    const neighbor = photos[index + 1] ?? photos[index - 1]
    pendingFocusPhotoIdRef.current = neighbor?.id ?? null
    onRemovePhoto(photo.id)
  }

  const sharpnessOf = (photo: Photo): PhotoSharpnessState => sharpness.get(photo.id) ?? ANALYZING
  const summary = summarizeSharpness(photos.map(sharpnessOf))

  return (
    <section aria-labelledby="gallery-heading">
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
      {/* 흐림 판정은 기기 안에서만 계산한 참고 정보이며 사진을 자동으로 지우거나 바꾸지 않는다. */}
      <p className="mt-1 text-sm font-medium text-neutral-800">
        <span aria-hidden="true">{summary.visible}</span>
        <span className="sr-only" aria-live="polite">
          {summary.announced}
        </span>
      </p>

      <ul className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-2 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] sm:gap-x-3">
        {photos.map((photo, index) => (
          <li key={photo.id} className="min-w-0">
            <div className="relative">
              <img
                src={photo.thumbnailUrl}
                alt={photo.source.name}
                aria-describedby={`${photo.id}-sharpness`}
                width={photo.width}
                height={photo.height}
                loading="lazy"
                decoding="async"
                className="aspect-square w-full rounded-md bg-neutral-200 object-cover"
              />
              <SharpnessBadge state={sharpnessOf(photo)} />
            </div>
            <span id={`${photo.id}-sharpness`} className="sr-only">
              {describeSharpness(sharpnessOf(photo))}
            </span>
            <div className="mt-1 flex items-center gap-1">
              <span
                aria-hidden="true"
                title={photo.source.name}
                className="min-w-0 flex-1 truncate text-xs text-neutral-700"
              >
                {photo.source.name}
              </span>
              <button
                ref={(element) => {
                  if (element) removeButtonsRef.current.set(photo.id, element)
                  else removeButtonsRef.current.delete(photo.id)
                }}
                type="button"
                aria-label={`${photo.source.name} 목록에서 제거`}
                title="목록에서 제거"
                onClick={() => handleRemove(index)}
                className={`${iconButtonClassName} text-neutral-700 hover:bg-neutral-200 hover:text-neutral-950`}
              >
                <CloseIcon />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default PhotoGallery
