// heif는 HEIC(아이폰 기본 사진 형식)를 포함한 HEIF 컨테이너 사진이다. 브라우저가 직접 디코딩할 수 있을 때만 열린다.
export type SupportedImageFormat = 'jpeg' | 'png' | 'webp' | 'heif'

// 파일 선택기의 1차 필터. 확장자나 브라우저가 알려준 MIME 형식은 신뢰하지 않고 detectImageFormat으로 실제 내용을 확인한다.
// 형식마다 MIME을 정확히 적는다. Mac Safari는 여기 없는 형식의 이미지를 고르면 목록의 첫 형식(JPEG)으로 바꿔서 넘기므로,
// HEIC를 빼면 원본 HEIC 대신 변환된 JPEG를 받게 된다. image/* 같은 넓은 값은 쓰지 않는다.
export const IMAGE_INPUT_ACCEPT =
  'image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif'

export const SUPPORTED_FORMAT_LABEL = 'JPEG, PNG, WebP, HEIC'

// HEIC 디코딩은 브라우저가 직접 지원할 때만 된다(caniuse·WebKit 기준 Safari 17 이상). 실기기 확인 전에는 범위를 넓혀 말하지 않는다.
export const HEIF_SUPPORT_NOTE = 'HEIC는 사진을 직접 열 수 있는 브라우저(iPhone·Mac의 Safari 17 이상)에서만 추가됩니다.'

// HEIF는 ISO 미디어 파일 형식이라 앞부분의 ftyp 상자에서 브랜드를 읽는다. 아이폰 사진의 ftyp은 40바이트 안팎이다.
const SIGNATURE_LENGTH = 64

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] // "WEBP"
const FTYP_SIGNATURE = [0x66, 0x74, 0x79, 0x70] // "ftyp"

// HEVC로 압축한 HEIC 정지 사진·연속 사진 브랜드와 HEIF 공통 브랜드
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'])
// AVIF도 HEIF 공통 브랜드(mif1)를 함께 적는다. AVIF는 이번 지원 범위가 아니므로 HEIF로 보지 않는다.
const AVIF_BRANDS = new Set(['avif', 'avis'])

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value)
}

function readBrand(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4))
}

// ftyp 상자: 크기(4바이트) · "ftyp" · 주 브랜드(4) · 부 버전(4) · 호환 브랜드(4바이트씩)
function isHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || !startsWith(bytes, FTYP_SIGNATURE, 4)) return false
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (boxSize < 16) return false
  const end = Math.min(boxSize, bytes.length)
  const brands = [readBrand(bytes, 8)]
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(readBrand(bytes, offset))
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return false
  return brands.some((brand) => HEIF_BRANDS.has(brand))
}

export function detectImageFormatFromBytes(bytes: Uint8Array): SupportedImageFormat | null {
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'jpeg'
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png'
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) return 'webp'
  if (isHeif(bytes)) return 'heif'
  return null
}

// 파일 앞부분의 시그니처만 읽는다. 읽기 실패는 호출자가 처리한다.
export async function detectImageFormat(file: Blob): Promise<SupportedImageFormat | null> {
  const header = await file.slice(0, SIGNATURE_LENGTH).arrayBuffer()
  return detectImageFormatFromBytes(new Uint8Array(header))
}
