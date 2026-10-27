import { useEffect, useRef, type ChangeEvent } from 'react'
import EmptyState from './components/EmptyState.tsx'
import ImportStatus from './components/ImportStatus.tsx'
import PhotoGallery from './components/PhotoGallery.tsx'
import { usePhotoLibrary } from './hooks/usePhotoLibrary.ts'
import { IMAGE_INPUT_ACCEPT } from './photos/imageFormat.ts'

// 시각적 방향은 디자인 방향 확정 전까지 중립적인 기본 스타일을 사용한다.
function App() {
  const { photos, progress, lastImport, addFiles, removePhoto, dismissImportSummary } =
    usePhotoLibrary()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pickerButtonRef = useRef<HTMLButtonElement>(null)
  const galleryHeadingRef = useRef<HTMLHeadingElement>(null)
  const previousPhotosRef = useRef(photos)
  const isImporting = progress !== null

  // 빈 화면과 갤러리가 바뀌며 초점을 가진 요소가 사라지면 새 화면의 기준 요소로 초점을 옮긴다.
  useEffect(() => {
    if (previousPhotosRef.current === photos) return
    previousPhotosRef.current = photos

    const activeElement = document.activeElement
    if (activeElement && activeElement !== document.body) return
    if (photos.length > 0) galleryHeadingRef.current?.focus()
    else pickerButtonRef.current?.focus()
  }, [photos])

  const openFilePicker = () => {
    if (!isImporting) fileInputRef.current?.click()
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    // 같은 파일을 다시 선택해도 change가 발생하도록 비운다. 원본 File 객체는 위에서 복사한 배열이 유지한다.
    event.currentTarget.value = ''
    void addFiles(files)
  }

  const handleDismissImportSummary = () => {
    dismissImportSummary()
    pickerButtonRef.current?.focus()
  }

  return (
    <div className="min-h-dvh bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6">
          <h1 className="text-lg font-bold text-neutral-950">Photo Selector</h1>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_INPUT_ACCEPT}
          multiple
          hidden
          onChange={handleFileChange}
          data-testid="photo-file-input"
        />

        <ImportStatus
          progress={progress}
          lastImport={lastImport}
          onDismiss={handleDismissImportSummary}
        />

        {photos.length === 0 ? (
          <EmptyState
            pickerButtonRef={pickerButtonRef}
            isImporting={isImporting}
            onPickPhotos={openFilePicker}
          />
        ) : (
          <PhotoGallery
            photos={photos}
            headingRef={galleryHeadingRef}
            pickerButtonRef={pickerButtonRef}
            isImporting={isImporting}
            onPickPhotos={openFilePicker}
            onRemovePhoto={removePhoto}
          />
        )}
      </main>
    </div>
  )
}

export default App
