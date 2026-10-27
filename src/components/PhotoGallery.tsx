import { useEffect, useRef, type Ref } from 'react'
import type { Photo } from '../photos/photo.ts'
import { iconButtonClassName, primaryButtonClassName } from './buttonStyles.ts'
import CloseIcon from './CloseIcon.tsx'

interface PhotoGalleryProps {
  photos: readonly Photo[]
  headingRef: Ref<HTMLHeadingElement>
  pickerButtonRef: Ref<HTMLButtonElement>
  isImporting: boolean
  onPickPhotos: () => void
  onRemovePhoto: (photoId: string) => void
}

function PhotoGallery({
  photos,
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

      <ul className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-2 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] sm:gap-x-3">
        {photos.map((photo, index) => (
          <li key={photo.id} className="min-w-0">
            <img
              src={photo.thumbnailUrl}
              alt={photo.source.name}
              width={photo.width}
              height={photo.height}
              loading="lazy"
              decoding="async"
              className="aspect-square w-full rounded-md bg-neutral-200 object-cover"
            />
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
