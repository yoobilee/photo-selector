import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { primaryButtonClassName, secondaryButtonClassName } from '../components/buttonStyles.ts'
import ImportStatus from '../components/ImportStatus.tsx'
import { usePhotoAnalysis } from '../hooks/usePhotoAnalysis.ts'
import { usePhotoLibrary } from '../hooks/usePhotoLibrary.ts'
import type { SharpnessAnalysis } from '../photos/analyzeImageSharpness.ts'
import { IMAGE_INPUT_ACCEPT } from '../photos/imageFormat.ts'
import type { Photo } from '../photos/photo.ts'
import { getAnalysisPath, type SharpnessAnalyzer } from '../photos/sharpnessWorkerClient.ts'
import { downloadText, evaluationFileName } from './downloadText.ts'
import EvaluationPhotoTable, { type PhotoAnnotation } from './EvaluationPhotoTable.tsx'
import EvaluationSummaryPanel from './EvaluationSummaryPanel.tsx'
import {
  bitsPerPixel,
  buildEvaluationCsv,
  buildEvaluationJson,
  type EvaluationEnvironment,
  type EvaluationPhoto,
} from './evaluationExport.ts'
import { summarizeEvaluation } from './evaluationMetrics.ts'
import { analysisPathText } from './evaluationText.ts'

const FAILED: SharpnessAnalysis = { result: { status: 'unavailable', reason: 'failed' }, measurement: null }
// 사용자 화면(analyze)과 같은 Worker·디코딩·판정 경로로 분석하고 측정값도 함께 받는다.
const selectMeasurement = (analyzer: SharpnessAnalyzer) => analyzer.measure
const EMPTY_ANNOTATION: PhotoAnnotation = { label: null, condition: null, sceneGroup: null }

function toEvaluationPhoto(photo: Photo, analysis: SharpnessAnalysis | undefined, annotation: PhotoAnnotation): EvaluationPhoto {
  const result = analysis?.result
  return {
    // 세션 순번 기반 사진 ID를 평가용 ID로 쓴다. 파일 이름과 관계없다.
    id: photo.id,
    ...annotation,
    verdict: result ? (result.status === 'unavailable' ? 'unavailable' : result.status) : 'pending',
    unavailableReason: result?.status === 'unavailable' ? result.reason : null,
    measurement: analysis?.measurement ?? null,
    format: photo.format,
    width: photo.width,
    height: photo.height,
    bitsPerPixel: bitsPerPixel(photo.source.size, photo.width, photo.height),
  }
}

// 개발용 흐림 판정 평가 도구. 일반 사용자 화면에 연결하지 않으며 개발 서버의 /calibration.html에서만 연다.
// 사진과 평가 데이터는 이 화면의 메모리에만 있고, 사용자가 내보내기를 누를 때만 파일로 저장한다.
function CalibrationApp() {
  const { photos, progress, lastImport, addFiles, removePhoto, dismissImportSummary } = usePhotoLibrary()
  const analyses = usePhotoAnalysis(photos, selectMeasurement, FAILED)
  const [annotations, setAnnotations] = useState<ReadonlyMap<string, PhotoAnnotation>>(() => new Map())
  const [device, setDevice] = useState('')
  const [includeUserAgent, setIncludeUserAgent] = useState(false)
  const [analysisPath] = useState(getAnalysisPath)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importButtonRef = useRef<HTMLButtonElement>(null)
  const previousPhotosRef = useRef(photos)
  const isImporting = progress !== null

  // 마지막 행을 지워 표와 초점을 가진 버튼이 함께 사라지면 불러오기 버튼으로 초점을 옮긴다. 남은 행이 있으면 표가 이웃 행으로 옮긴다.
  useEffect(() => {
    if (previousPhotosRef.current === photos) return
    previousPhotosRef.current = photos
    const activeElement = document.activeElement
    if (photos.length === 0 && (!activeElement || activeElement === document.body)) importButtonRef.current?.focus()
  }, [photos])

  const rows = useMemo(
    () =>
      photos.map((photo) => ({
        photo,
        evaluation: toEvaluationPhoto(photo, analyses.get(photo.id), annotations.get(photo.id) ?? EMPTY_ANNOTATION),
      })),
    [photos, analyses, annotations],
  )
  const evaluations = rows.map((row) => row.evaluation)
  const summary = summarizeEvaluation(evaluations)

  const annotate = (photoId: string, change: Partial<PhotoAnnotation>) => {
    setAnnotations((current) => {
      const next = new Map(current)
      next.set(photoId, { ...(current.get(photoId) ?? EMPTY_ANNOTATION), ...change })
      return next
    })
  }

  // 평가에서 제거한 사진의 정답 기록도 함께 지운다. 다시 가져오면 새 ID로 처음부터 평가한다.
  const remove = (photoId: string) => {
    removePhoto(photoId)
    setAnnotations((current) => {
      const next = new Map(current)
      next.delete(photoId)
      return next
    })
  }

  const environment = (): EvaluationEnvironment => ({
    device: device.trim(),
    analysisPath,
    userAgent: includeUserAgent ? navigator.userAgent : null,
  })

  const exportAs = (extension: 'json' | 'csv') => {
    if (photos.length === 0) return
    const exportedAt = new Date()
    if (extension === 'json') {
      downloadText(evaluationFileName(exportedAt, 'json'), 'application/json', buildEvaluationJson(evaluations, environment(), exportedAt))
    } else {
      downloadText(evaluationFileName(exportedAt, 'csv'), 'text/csv', buildEvaluationCsv(evaluations, environment()))
    }
  }

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    void addFiles(files)
  }

  return (
    <div className="min-h-dvh bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6">
          <h1 className="text-lg font-bold text-neutral-950">흐림 판정 평가 (개발용)</h1>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
        <section aria-labelledby="evaluation-guide-heading" className="text-sm text-neutral-800">
          <h2 id="evaluation-guide-heading" className="sr-only">
            사용 안내
          </h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>실제 사진을 불러와 사진마다 정답(선명·흐림·판단 보류)을 고르면 자동 판정과 비교해 통계를 계산합니다.</li>
            <li>
              사진은 이 기기의 메모리에서만 분석하며 서버로 보내지 않습니다. 화면을 닫거나 새로고침하면 사진과 정답이 사라집니다.
            </li>
            <li>
              내보내기 파일에는 평가용 ID, 정답, 판정, 점수와 크기·형식만 들어갑니다. 파일 이름·경로·위치(EXIF)는 넣지
              않습니다.
            </li>
          </ul>
        </section>

        <section aria-labelledby="evaluation-environment-heading" className="rounded-md border border-neutral-300 bg-white p-4">
          <h2 id="evaluation-environment-heading" className="font-semibold text-neutral-950">
            평가 환경
          </h2>
          <div className="mt-2 flex flex-wrap items-end gap-4 text-sm">
            <label className="flex flex-col gap-1">
              <span>기기·카메라 (선택, 내보내기에 포함)</span>
              <input
                type="text"
                value={device}
                maxLength={80}
                placeholder="예: Pixel 7 기본 카메라"
                onChange={(event) => setDevice(event.currentTarget.value)}
                className="min-h-9 w-64 rounded border border-neutral-400 px-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700"
              />
            </label>
            <label className="flex min-h-9 items-center gap-2">
              <input
                type="checkbox"
                checked={includeUserAgent}
                onChange={(event) => setIncludeUserAgent(event.currentTarget.checked)}
                className="size-4"
              />
              브라우저 User-Agent를 내보내기에 포함
            </label>
            <p>
              분석 경로: <span className="font-medium">{analysisPathText[analysisPath]}</span>
            </p>
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_INPUT_ACCEPT}
            multiple
            hidden
            onChange={handleFileChange}
            data-testid="calibration-file-input"
          />
          <button
            ref={importButtonRef}
            type="button"
            aria-disabled={isImporting}
            onClick={() => {
              if (!isImporting) fileInputRef.current?.click()
            }}
            className={primaryButtonClassName}
          >
            사진 불러오기
          </button>
          <button
            type="button"
            aria-disabled={photos.length === 0}
            onClick={() => exportAs('json')}
            className={secondaryButtonClassName}
          >
            JSON 내보내기
          </button>
          <button
            type="button"
            aria-disabled={photos.length === 0}
            onClick={() => exportAs('csv')}
            className={secondaryButtonClassName}
          >
            CSV 내보내기
          </button>
        </div>

        <ImportStatus progress={progress} lastImport={lastImport} onDismiss={dismissImportSummary} />

        <EvaluationSummaryPanel summary={summary} />

        {photos.length === 0 ? (
          <p className="text-sm text-neutral-700">평가할 사진을 불러오세요.</p>
        ) : (
          <EvaluationPhotoTable rows={rows} onAnnotate={annotate} onRemove={remove} />
        )}
      </main>
    </div>
  )
}

export default CalibrationApp
