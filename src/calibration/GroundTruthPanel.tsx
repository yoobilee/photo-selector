import { useRef, type ChangeEvent } from 'react'
import { secondaryButtonClassName } from '../components/buttonStyles.ts'
import type { GroundTruthDataset } from './groundTruthDataset.ts'
import type { GroundTruthMatchSummary } from './groundTruthMatch.ts'

export interface GroundTruthMessage {
  readonly kind: 'success' | 'problem'
  readonly text: string
}

interface GroundTruthPanelProps {
  readonly dataset: GroundTruthDataset | null
  // 정답 데이터를 불러왔을 때만 있다.
  readonly matchSummary: GroundTruthMatchSummary | null
  readonly isHashSupported: boolean
  readonly canExport: boolean
  readonly message: GroundTruthMessage | null
  readonly onLoad: (file: File) => void
  readonly onExport: () => void
  readonly onClose: () => void
}

function Count({ label, value, unit, needsAttention = false }: { label: string; value: number; unit: string; needsAttention?: boolean }) {
  return (
    <div>
      <dt className="text-neutral-700">{label}</dt>
      <dd className={`font-semibold tabular-nums ${needsAttention && value > 0 ? 'text-red-800' : ''}`}>
        {value}
        {unit}
      </dd>
    </div>
  )
}

// 미리 만든 정답 데이터(JSON)를 불러와 사진에 정답을 자동으로 붙이고, 지금 고른 정답을 정답 데이터로 내보낸다.
function GroundTruthPanel({ dataset, matchSummary, isHashSupported, canExport, message, onLoad, onExport, onClose }: GroundTruthPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const loadButtonRef = useRef<HTMLButtonElement>(null)

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) onLoad(file)
  }

  // 닫기 버튼이 사라지므로 초점을 불러오기 버튼으로 옮긴다.
  const close = () => {
    onClose()
    loadButtonRef.current?.focus()
  }

  return (
    <section aria-labelledby="ground-truth-heading" className="rounded-md border border-neutral-300 bg-white p-4">
      <h2 id="ground-truth-heading" className="font-semibold text-neutral-950">
        정답 데이터
      </h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-neutral-800">
        <li>
          원본 파일 바이트의 SHA-256 해시로 사진과 정답을 연결합니다. 파일 이름이나 불러온 순서는 쓰지 않습니다. 해시는 이 브라우저에서만
          계산하며 원본을 바꾸거나 보내지 않습니다.
        </li>
        <li>
          표에서 정답·촬영 조건 등을 하나라도 직접 고친 사진은 정답 데이터로 덮어쓰지 않습니다. 정답 데이터 안에서 서로 다른 정답이 있는
          사진은 적용하지 않습니다.
        </li>
        <li>
          해시는 파일 내용을 가리키는 식별 정보입니다. 같은 사진을 가진 사람은 정답 데이터와 사진을 연결할 수 있으므로 정답 데이터를
          공유할 때 주의하세요.
        </li>
      </ul>

      {!isHashSupported && (
        <p className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-sm text-red-950">
          이 환경에서는 Web Crypto를 쓸 수 없어 해시를 계산하지 못합니다. localhost 또는 HTTPS 주소로 여세요. 그 전에는 정답 데이터를 사진과
          연결하거나 지금 고른 정답을 내보낼 수 없습니다.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={handleFileChange}
          data-testid="ground-truth-file-input"
        />
        <button ref={loadButtonRef} type="button" onClick={() => fileInputRef.current?.click()} className={secondaryButtonClassName}>
          정답 데이터 불러오기
        </button>
        <button
          type="button"
          aria-disabled={!canExport}
          onClick={() => {
            if (canExport) onExport()
          }}
          className={secondaryButtonClassName}
        >
          정답 데이터 내보내기
        </button>
        {dataset && (
          <button type="button" onClick={close} className={secondaryButtonClassName}>
            정답 데이터 닫기
          </button>
        )}
      </div>

      {/* 상태 문장은 항상 존재하는 같은 영역에서 바뀌어야 화면 낭독기가 안정적으로 읽는다. */}
      <p
        role="status"
        className={`text-sm font-medium not-empty:mt-3 ${message?.kind === 'problem' ? 'text-red-800' : 'text-neutral-800'}`}
      >
        {message?.text ?? ''}
      </p>

      {dataset && matchSummary && (
        <div className="mt-3 space-y-2 text-sm">
          <h3 className="font-semibold text-neutral-900">불러온 정답 데이터</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
            <Count label="전체 항목" value={dataset.stats.total} unit="개" />
            <Count label="사용할 수 있는 항목" value={dataset.stats.usable} unit="개" />
            <Count label="손상(형식 오류)" value={dataset.stats.invalid} unit="개" needsAttention />
            <Count label="중복(같은 내용)" value={dataset.stats.duplicate} unit="개" />
            <Count label="충돌(같은 해시, 다른 정답)" value={dataset.stats.conflicting} unit="건" needsAttention />
          </dl>
          {dataset.stats.invalidEntryNumbers.length > 0 && (
            <p className="text-red-800">
              손상 항목 순번: {dataset.stats.invalidEntryNumbers.join(', ')}
              {dataset.stats.invalid > dataset.stats.invalidEntryNumbers.length && ' 외'}
            </p>
          )}
          <h3 className="pt-1 font-semibold text-neutral-900">사진 연결 (사진 {matchSummary.photos}장)</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
            <Count label="정답 적용" value={matchSummary.applied} unit="장" />
            <Count label="직접 고른 정답 유지(데이터와 다름)" value={matchSummary.manualDiffers} unit="장" needsAttention />
            <Count label="정답 데이터에 없는 사진" value={matchSummary.notInDataset} unit="장" />
            <Count label="충돌로 적용 안 함" value={matchSummary.conflicting} unit="장" needsAttention />
            <Count label="해시 계산 중" value={matchSummary.hashPending} unit="장" />
            <Count label="해시 계산 실패" value={matchSummary.hashFailed} unit="장" needsAttention />
            <Count label="불러온 사진에 없는 정답" value={matchSummary.datasetOnly} unit="개" />
          </dl>
        </div>
      )}
    </section>
  )
}

export default GroundTruthPanel
