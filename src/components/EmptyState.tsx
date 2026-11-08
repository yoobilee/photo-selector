import type { Ref } from 'react'
import { HEIF_SUPPORT_NOTE, SUPPORTED_FORMAT_LABEL } from '../photos/imageFormat.ts'
import { primaryButtonClassName } from './buttonStyles.ts'

interface EmptyStateProps {
  pickerButtonRef: Ref<HTMLButtonElement>
  isImporting: boolean
  onPickPhotos: () => void
}

function EmptyState({ pickerButtonRef, isImporting, onPickPhotos }: EmptyStateProps) {
  return (
    <section aria-labelledby="empty-state-heading" className="max-w-xl py-8 sm:py-14">
      <h2 id="empty-state-heading" className="text-2xl font-bold text-neutral-950">
        정리할 사진을 선택하세요
      </h2>
      <p className="mt-3 leading-relaxed text-neutral-700">
        여러 장을 한 번에 선택할 수 있습니다. {SUPPORTED_FORMAT_LABEL} 형식을 지원합니다.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-neutral-700">{HEIF_SUPPORT_NOTE}</p>
      <div className="mt-4 space-y-2 text-sm leading-relaxed text-neutral-700">
        <p>
          사진을 여러 장 선택하면 iPhone이 사진을 준비하는 동안 사진 보관함 화면이 잠시 유지될 수
          있습니다.
        </p>
        <p>
          선택을 완료한 뒤에는 화면이 자동으로 닫힐 때까지 기다려 주세요. iCloud에 저장된 사진은
          시간이 더 걸릴 수 있습니다.
        </p>
      </div>
      <button
        ref={pickerButtonRef}
        type="button"
        aria-disabled={isImporting}
        onClick={onPickPhotos}
        className={`mt-6 ${primaryButtonClassName}`}
      >
        사진 선택
      </button>
      <p className="mt-6 text-sm leading-relaxed text-neutral-600">
        사진은 이 기기의 브라우저 안에서만 열리며 서버로 전송되지 않습니다. 원본 파일은 변경되지
        않습니다.
      </p>
    </section>
  )
}

export default EmptyState
