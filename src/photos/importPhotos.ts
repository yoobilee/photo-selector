import { createPhotoThumbnail, type PhotoThumbnail } from './createPhotoThumbnail.ts'
import { haveSameBytes } from './haveSameBytes.ts'
import { detectImageFormat } from './imageFormat.ts'
import { releasePhoto, type Photo } from './photo.ts'

export type SkipReason = 'unsupported-format' | 'unreadable' | 'duplicate'

export interface SkippedFile {
  readonly fileName: string
  readonly reason: SkipReason
}

export interface ImportPhotosResult {
  readonly added: Photo[]
  readonly skipped: SkippedFile[]
}

export interface ImportPhotosOptions {
  createThumbnail?: (file: Blob) => Promise<PhotoThumbnail>
  onProgress?: (processed: number, total: number) => void
  // 중단되면 이미 만든 미리보기를 해제하고 빈 결과를 돌려준다.
  signal?: AbortSignal
}

type ReadPhotoOutcome = { kind: 'added'; photo: Photo } | { kind: 'skipped'; reason: SkipReason }

let lastPhotoId = 0

// crypto.randomUUID는 보안 컨텍스트에서만 동작하므로 세션 안에서만 유일한 순번을 사용한다.
function createPhotoId(): string {
  lastPhotoId += 1
  return `photo-${lastPhotoId}`
}

// 중복 기준: 바이트가 완전히 같은 파일. 이름이 달라도 내용이 같으면 중복이고, 이름이 같아도 내용이 다르면 다른 사진이다.
// 비교하는 동안에도 사진이 목록에서 제거될 수 있으므로 일치한 대상이 아직 목록에 있는지 비교 후 다시 확인한다.
async function isDuplicate(file: File, getKnownSources: () => readonly File[]): Promise<boolean> {
  for (const known of getKnownSources()) {
    try {
      if ((await haveSameBytes(file, known)) && getKnownSources().includes(known)) return true
    } catch {
      // 비교 대상을 읽지 못하면 중복으로 단정하지 않는다. 새 파일 자체의 손상 여부는 미리보기 생성에서 확인한다.
    }
  }
  return false
}

async function readPhoto(
  file: File,
  getKnownSources: () => readonly File[],
  createThumbnail: (file: Blob) => Promise<PhotoThumbnail>,
): Promise<ReadPhotoOutcome> {
  try {
    const format = await detectImageFormat(file)
    if (!format) return { kind: 'skipped', reason: 'unsupported-format' }

    if (await isDuplicate(file, getKnownSources)) return { kind: 'skipped', reason: 'duplicate' }

    const thumbnail = await createThumbnail(file)
    return {
      kind: 'added',
      photo: {
        id: createPhotoId(),
        source: file,
        format,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailUrl: URL.createObjectURL(thumbnail.blob),
      },
    }
  } catch {
    // 파일 내용이나 오류 상세(메타데이터 포함)는 기록하지 않고 사유만 남긴다.
    return { kind: 'skipped', reason: 'unreadable' }
  }
}

// 메모리 사용량을 제한하기 위해 파일을 한 장씩 순서대로 처리한다.
// 가져오는 동안에도 사용자가 사진을 제거할 수 있으므로 기존 목록은 getExistingPhotos로 필요할 때마다 다시 읽는다.
export async function importPhotos(
  files: readonly File[],
  getExistingPhotos: () => readonly Photo[],
  { createThumbnail = createPhotoThumbnail, onProgress, signal }: ImportPhotosOptions = {},
): Promise<ImportPhotosResult> {
  const added: Photo[] = []
  const skipped: SkippedFile[] = []
  const getKnownSources = () => [...getExistingPhotos(), ...added].map((photo) => photo.source)

  for (const [index, file] of files.entries()) {
    if (signal?.aborted) break

    const outcome = await readPhoto(file, getKnownSources, createThumbnail)
    if (outcome.kind === 'added') {
      added.push(outcome.photo)
    } else {
      skipped.push({ fileName: file.name, reason: outcome.reason })
    }
    onProgress?.(index + 1, files.length)
  }

  if (signal?.aborted) {
    added.forEach(releasePhoto)
    return { added: [], skipped: [] }
  }

  return { added, skipped }
}
