import type { ImportProgress, ImportSummary } from '../hooks/usePhotoLibrary.ts'
import { SUPPORTED_FORMAT_LABEL } from '../photos/imageFormat.ts'
import type { SkipReason, SkippedFile } from '../photos/importPhotos.ts'
import { iconButtonClassName } from './buttonStyles.ts'
import CloseIcon from './CloseIcon.tsx'

interface ImportStatusProps {
  progress: ImportProgress | null
  lastImport: ImportSummary | null
  onDismiss: () => void
}

const MAX_LISTED_FILE_NAMES = 5

const skipReasonGuides: ReadonlyArray<{ reason: SkipReason; title: string; description: string }> = [
  {
    reason: 'unsupported-format',
    title: '지원하지 않는 형식',
    description: `${SUPPORTED_FORMAT_LABEL} 사진만 추가할 수 있습니다.`,
  },
  {
    reason: 'unreadable',
    title: '열 수 없는 파일',
    description: '파일이 손상되었거나 읽을 수 없습니다.',
  },
  {
    reason: 'duplicate',
    title: '이미 추가된 사진',
    description: '내용이 같은 사진이 목록에 있어 다시 추가하지 않았습니다.',
  },
]

function describeImport(progress: ImportProgress | null, lastImport: ImportSummary | null): string {
  if (progress) {
    return `사진을 확인하는 중입니다 (${progress.processed}/${progress.total})`
  }
  if (!lastImport) return ''

  const skippedCount = lastImport.skipped.length
  const addedMessage =
    lastImport.addedCount > 0
      ? `사진 ${lastImport.addedCount}장을 추가했습니다.`
      : '추가한 사진이 없습니다.'
  return skippedCount > 0 ? `${addedMessage} ${skippedCount}개 파일은 추가하지 않았습니다.` : addedMessage
}

function SkippedFileNames({ files }: { files: readonly SkippedFile[] }) {
  const listed = files.slice(0, MAX_LISTED_FILE_NAMES)
  const hiddenCount = files.length - listed.length
  return (
    <ul className="mt-1 list-disc pl-5 text-sm">
      {listed.map((file, index) => (
        <li key={`${index}-${file.fileName}`} className="break-all">
          {file.fileName}
        </li>
      ))}
      {hiddenCount > 0 && <li>외 {hiddenCount}개</li>}
    </ul>
  )
}

function ImportStatus({ progress, lastImport, onDismiss }: ImportStatusProps) {
  const skipped = lastImport?.skipped ?? []

  return (
    <div>
      {/* 상태 문장은 항상 존재하는 같은 영역에서 바뀌어야 화면 낭독기가 안정적으로 읽는다. */}
      <p role="status" className="text-sm font-medium text-neutral-800 not-empty:mb-4">
        {describeImport(progress, lastImport)}
      </p>

      {skipped.length > 0 && (
        <section
          aria-labelledby="skipped-files-heading"
          className="mb-5 rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-950"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id="skipped-files-heading" className="font-semibold">
              추가하지 않은 파일 {skipped.length}개
            </h2>
            <button
              type="button"
              aria-label="알림 닫기"
              title="알림 닫기"
              onClick={onDismiss}
              className={`-mt-1.5 -mr-1.5 ${iconButtonClassName} hover:bg-amber-100`}
            >
              <CloseIcon />
            </button>
          </div>
          <dl className="mt-2 space-y-3">
            {skipReasonGuides.map(({ reason, title, description }) => {
              const files = skipped.filter((file) => file.reason === reason)
              if (files.length === 0) return null
              return (
                <div key={reason}>
                  <dt className="text-sm font-semibold">
                    {title} {files.length}개
                  </dt>
                  <dd className="text-sm">
                    {description}
                    <SkippedFileNames files={files} />
                  </dd>
                </div>
              )
            })}
          </dl>
        </section>
      )}
    </div>
  )
}

export default ImportStatus
