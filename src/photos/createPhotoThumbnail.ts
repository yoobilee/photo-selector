export interface PhotoThumbnail {
  blob: Blob
  width: number
  height: number
}

const THUMBNAIL_MAX_EDGE = 512
const THUMBNAIL_TYPE = 'image/jpeg'
const THUMBNAIL_QUALITY = 0.85
// 투명 영역이 있는 PNG·WebP를 JPEG 미리보기로 만들 때 채울 배경색
const THUMBNAIL_BACKGROUND = '#ffffff'

// 화면 표시용 미리보기만 만든다. 원본 File은 읽기만 하고, 결과 Blob은 원본과 별개의 데이터다.
// HTMLImageElement 디코딩은 지원 브라우저 전반에서 EXIF 방향을 반영하므로 DOM이 있는 메인 스레드에서 사용한다.
export async function createPhotoThumbnail(file: Blob): Promise<PhotoThumbnail> {
  const sourceUrl = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = sourceUrl
    // 손상된 파일은 decode가 거부되어 호출자가 읽을 수 없는 파일로 처리한다.
    await image.decode()

    const width = image.naturalWidth
    const height = image.naturalHeight
    if (width === 0 || height === 0) {
      throw new Error('Image has no dimensions')
    }

    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas 2D context is unavailable')
    }
    context.fillStyle = THUMBNAIL_BACKGROUND
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, THUMBNAIL_TYPE, THUMBNAIL_QUALITY)
    })
    if (!blob) {
      throw new Error('Thumbnail encoding failed')
    }

    return { blob, width, height }
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}
