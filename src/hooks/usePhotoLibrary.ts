import { useCallback, useEffect, useRef, useState } from 'react'
import { importPhotos, type SkippedFile } from '../photos/importPhotos.ts'
import { releasePhoto, type Photo } from '../photos/photo.ts'

export interface ImportProgress {
  readonly processed: number
  readonly total: number
}

export interface ImportSummary {
  readonly addedCount: number
  readonly skipped: readonly SkippedFile[]
}

// 앱 안의 사진 목록과 미리보기 Object URL의 수명을 관리한다. 목록 제거는 앱 상태에서만 일어나며 기기의 원본 파일은 건드리지 않는다.
export function usePhotoLibrary() {
  const [photos, setPhotos] = useState<readonly Photo[]>([])
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [lastImport, setLastImport] = useState<ImportSummary | null>(null)
  // 비동기 가져오기와 언마운트 정리에서 최신 목록을 읽기 위한 사본
  const photosRef = useRef<readonly Photo[]>([])
  const importControllerRef = useRef<AbortController | null>(null)

  const commitPhotos = useCallback((nextPhotos: readonly Photo[]) => {
    photosRef.current = nextPhotos
    setPhotos(nextPhotos)
  }, [])

  useEffect(() => {
    return () => {
      importControllerRef.current?.abort()
      importControllerRef.current = null
      photosRef.current.forEach(releasePhoto)
      photosRef.current = []
    }
  }, [])

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      // 파일 선택을 취소하면 빈 목록이 전달된다. 기존 사진은 그대로 둔다.
      if (files.length === 0 || importControllerRef.current) return

      const controller = new AbortController()
      importControllerRef.current = controller
      setLastImport(null)
      setProgress({ processed: 0, total: files.length })

      try {
        const result = await importPhotos(files, () => photosRef.current, {
          signal: controller.signal,
          onProgress: (processed, total) => {
            if (!controller.signal.aborted) setProgress({ processed, total })
          },
        })
        if (controller.signal.aborted) return

        commitPhotos([...photosRef.current, ...result.added])
        setLastImport({ addedCount: result.added.length, skipped: result.skipped })
      } finally {
        if (importControllerRef.current === controller) {
          importControllerRef.current = null
          setProgress(null)
        }
      }
    },
    [commitPhotos],
  )

  const removePhoto = useCallback(
    (photoId: string) => {
      const target = photosRef.current.find((photo) => photo.id === photoId)
      if (!target) return

      releasePhoto(target)
      commitPhotos(photosRef.current.filter((photo) => photo.id !== photoId))
    },
    [commitPhotos],
  )

  const dismissImportSummary = useCallback(() => {
    setLastImport(null)
  }, [])

  return { photos, progress, lastImport, addFiles, removePhoto, dismissImportSummary }
}
