import type { SimilarPhotosState } from '../hooks/useSimilarPhotoGroups.ts'
import type { SimilarGroupKind } from '../photos/similarPhotoGroups.ts'

// 묶음 제목. 모든 사진 쌍이 거의 같을 때만 '거의 같은 사진'이라고 하고, 하나라도 근거가 약하면 '비슷한 사진'이라고 한다.
// 바이트까지 같은 파일은 가져오기에서 이미 빠지므로 '같은 파일'이라고 하지 않는다.
export const similarGroupLabel: Record<SimilarGroupKind, string> = {
  same: '거의 같은 사진',
  similar: '비슷한 사진',
}

// 묶은 근거. 판정은 추정이므로 단정하지 않는다.
export const similarGroupDescription: Record<SimilarGroupKind, string> = {
  same: '구도와 내용이 거의 같아 보입니다. 크기·화질·밝기·선명도만 다를 수 있습니다.',
  similar: '구도가 비슷해 보입니다. 연속 촬영처럼 조금 다른 순간일 수 있습니다.',
}

export function similarGroupTitle(kind: SimilarGroupKind, count: number): string {
  return `${similarGroupLabel[kind]} ${count}장`
}

// 갤러리 상단 요약. 분석 중에는 끝났을 때만 바뀌는 문구를 쓴다(낭독이 결과마다 반복되지 않게).
export function summarizeSimilarPhotos({ groups, checkingCount, uncomparedCount }: SimilarPhotosState): string {
  if (checkingCount > 0) return '비슷한 사진 확인 중'
  const groupedCount = groups.reduce((sum, group) => sum + group.photos.length, 0)
  const parts = [groups.length > 0 ? `비슷한 사진 묶음 ${groups.length}개(${groupedCount}장)` : '비슷한 사진 묶음이 없습니다']
  if (uncomparedCount > 0) parts.push(`비교하지 못한 사진 ${uncomparedCount}장`)
  return parts.join(' · ')
}
