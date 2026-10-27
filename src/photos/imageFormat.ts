export type SupportedImageFormat = 'jpeg' | 'png' | 'webp'

// 파일 선택기의 1차 필터. 확장자나 브라우저가 알려준 MIME 형식은 신뢰하지 않고 detectImageFormat으로 실제 내용을 확인한다.
export const IMAGE_INPUT_ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'

export const SUPPORTED_FORMAT_LABEL = 'JPEG, PNG, WebP'

const SIGNATURE_LENGTH = 12

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] // "WEBP"

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value)
}

export function detectImageFormatFromBytes(bytes: Uint8Array): SupportedImageFormat | null {
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'jpeg'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png'
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) return 'webp'
  return null
}

// 파일 앞부분의 시그니처만 읽는다. 읽기 실패는 호출자가 처리한다.
export async function detectImageFormat(file: Blob): Promise<SupportedImageFormat | null> {
  const header = await file.slice(0, SIGNATURE_LENGTH).arrayBuffer()
  return detectImageFormatFromBytes(new Uint8Array(header))
}
