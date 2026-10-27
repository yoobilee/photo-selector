import type { SupportedImageFormat } from './imageFormat.ts'

export interface Photo {
  readonly id: string
  // 사용자가 선택한 원본 File. 변경·재인코딩하지 않으며 이후 내보내기는 이 객체의 바이트만 사용한다.
  readonly source: File
  readonly format: SupportedImageFormat
  // EXIF 방향을 반영한 원본 이미지의 표시 크기
  readonly width: number
  readonly height: number
  // 화면 표시용 미리보기의 Object URL. 원본과 분리된 데이터이며 releasePhoto로 해제한다.
  readonly thumbnailUrl: string
}

export function releasePhoto(photo: Photo): void {
  URL.revokeObjectURL(photo.thumbnailUrl)
}
