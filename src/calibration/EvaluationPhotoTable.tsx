import { useEffect, useRef } from 'react'
import { iconButtonClassName } from '../components/buttonStyles.ts'
import CloseIcon from '../components/CloseIcon.tsx'
import type { Photo } from '../photos/photo.ts'
import { SHARP_RATIO_THRESHOLD } from '../photos/sharpness.ts'
import { sceneConditions, type EvaluationPhoto, type SceneCondition } from './evaluationExport.ts'
import { classifyOutcome, type GroundTruth } from './evaluationMetrics.ts'
import {
  describeUnavailableReason,
  groundTruthText,
  outcomeText,
  sceneConditionText,
  verdictText,
} from './evaluationText.ts'

export interface PhotoAnnotation {
  readonly label: GroundTruth | null
  readonly condition: SceneCondition | null
  readonly sceneGroup: number | null
}

interface EvaluationPhotoTableProps {
  readonly rows: readonly { readonly photo: Photo; readonly evaluation: EvaluationPhoto }[]
  readonly onAnnotate: (photoId: string, change: Partial<PhotoAnnotation>) => void
  readonly onRemove: (photoId: string) => void
}

const controlClassName =
  'min-h-9 rounded border border-neutral-400 bg-white px-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-700'
const groundTruths: readonly GroundTruth[] = ['sharp', 'blurry', 'unsure']

const formatNumber = (value: number | null | undefined, digits: number) => (value == null ? '—' : value.toFixed(digits))

function EvaluationPhotoTable({ rows, onAnnotate, onRemove }: EvaluationPhotoTableProps) {
  const removeButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  // 제거한 행의 버튼이 사라져도 키보드 초점이 이웃 행에 남도록 다음 대상을 기억한다(갤러리와 같은 방식).
  // 마지막 행을 지우면 표가 사라지므로 CalibrationApp이 불러오기 버튼으로 초점을 옮긴다.
  const pendingFocusPhotoIdRef = useRef<string | null>(null)

  useEffect(() => {
    const photoId = pendingFocusPhotoIdRef.current
    if (!photoId) return
    pendingFocusPhotoIdRef.current = null
    removeButtonsRef.current.get(photoId)?.focus()
  }, [rows])

  const handleRemove = (index: number) => {
    const row = rows[index]
    if (!row) return
    const neighbor = rows[index + 1] ?? rows[index - 1]
    pendingFocusPhotoIdRef.current = neighbor?.photo.id ?? null
    onRemove(row.photo.id)
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">사진별 정답과 자동 판정</caption>
        <thead>
          <tr className="border-b border-neutral-300 text-neutral-700">
            <th scope="col" className="py-2 pr-2 font-medium">사진</th>
            <th scope="col" className="py-2 pr-2 font-medium">정답</th>
            <th scope="col" className="py-2 pr-2 font-medium">촬영 조건</th>
            <th scope="col" className="py-2 pr-2 font-medium">장면 번호</th>
            <th scope="col" className="py-2 pr-2 font-medium">자동 판정</th>
            <th scope="col" className="py-2 pr-2 font-medium">
              점수 <span className="font-normal">(흐림 의심 &lt; {SHARP_RATIO_THRESHOLD})</span>
            </th>
            <th scope="col" className="py-2 pr-2 font-medium">잡음</th>
            <th scope="col" className="py-2 pr-2 font-medium">비교</th>
            <th scope="col" className="py-2 font-medium"><span className="sr-only">제거</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ photo, evaluation }, index) => {
            const outcome = classifyOutcome(evaluation)
            const isError = outcome === 'false-positive' || outcome === 'false-negative'
            return (
              <tr key={photo.id} className="border-b border-neutral-200 align-top">
                <th scope="row" className="py-2 pr-2 font-normal">
                  <div className="flex items-start gap-2">
                    <img
                      src={photo.thumbnailUrl}
                      alt={`${evaluation.id} 미리보기`}
                      width={photo.width}
                      height={photo.height}
                      loading="lazy"
                      decoding="async"
                      className="size-16 shrink-0 rounded bg-neutral-200 object-cover"
                    />
                    <div className="min-w-0">
                      <span className="block font-semibold text-neutral-950">{evaluation.id}</span>
                      <span className="block text-xs text-neutral-700">
                        {photo.width}×{photo.height} · {evaluation.format.toUpperCase()} · {evaluation.bitsPerPixel} bpp
                      </span>
                      {/* 파일 이름은 사진을 찾을 수 있게 이 화면에만 보이며 내보내기에 넣지 않는다. */}
                      <span className="block max-w-48 truncate text-xs text-neutral-600" title={photo.source.name}>
                        {photo.source.name}
                      </span>
                    </div>
                  </div>
                </th>
                <td className="py-2 pr-2">
                  <select
                    aria-label={`${evaluation.id} 정답`}
                    value={evaluation.label ?? ''}
                    onChange={(event) =>
                      onAnnotate(photo.id, { label: (event.currentTarget.value || null) as GroundTruth | null })
                    }
                    className={controlClassName}
                  >
                    <option value="">미지정</option>
                    {groundTruths.map((label) => (
                      <option key={label} value={label}>
                        {groundTruthText[label]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select
                    aria-label={`${evaluation.id} 촬영 조건`}
                    value={evaluation.condition ?? ''}
                    onChange={(event) =>
                      onAnnotate(photo.id, { condition: (event.currentTarget.value || null) as SceneCondition | null })
                    }
                    className={controlClassName}
                  >
                    <option value="">미지정</option>
                    {sceneConditions.map((condition) => (
                      <option key={condition} value={condition}>
                        {sceneConditionText[condition]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    aria-label={`${evaluation.id} 장면 번호`}
                    value={evaluation.sceneGroup ?? ''}
                    onChange={(event) => {
                      const value = Number.parseInt(event.currentTarget.value, 10)
                      onAnnotate(photo.id, { sceneGroup: Number.isSafeInteger(value) && value > 0 ? value : null })
                    }}
                    className={`${controlClassName} w-16`}
                  />
                </td>
                <td className="py-2 pr-2">
                  <span className="font-medium">{verdictText[evaluation.verdict]}</span>
                  {evaluation.unavailableReason && (
                    <span className="block text-xs text-neutral-700">
                      {describeUnavailableReason(evaluation.unavailableReason)}
                    </span>
                  )}
                  {evaluation.measurement?.hasUnjudgedDirection && (
                    <span className="block text-xs text-neutral-700">잡음 때문에 판정하지 못한 방향 있음</span>
                  )}
                </td>
                <td className="py-2 pr-2 tabular-nums">{formatNumber(evaluation.measurement?.score, 4)}</td>
                <td className="py-2 pr-2 tabular-nums">{formatNumber(evaluation.measurement?.noise, 2)}</td>
                <td className={`py-2 pr-2 ${isError ? 'font-semibold text-red-800' : ''}`}>{outcomeText[outcome]}</td>
                <td className="py-2">
                  <button
                    ref={(element) => {
                      if (element) removeButtonsRef.current.set(photo.id, element)
                      else removeButtonsRef.current.delete(photo.id)
                    }}
                    type="button"
                    aria-label={`${evaluation.id} 평가에서 제거`}
                    title="평가에서 제거"
                    onClick={() => handleRemove(index)}
                    className={`${iconButtonClassName} text-neutral-700 hover:bg-neutral-200 hover:text-neutral-950`}
                  >
                    <CloseIcon />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default EvaluationPhotoTable
