// 원본 파일 바이트의 SHA-256을 소문자 16진수로 구한다. 이 브라우저 안에서만 계산하고 원본은 읽기만 한다.
// Web Crypto는 보안 컨텍스트(HTTPS·localhost)에서만 쓸 수 있다. 쓸 수 없거나 읽기에 실패하면 오류를 던진다.
export async function sha256Hex(file: Blob): Promise<string> {
  const subtle = getSubtleCrypto()
  if (!subtle) throw new Error('Web Crypto is unavailable')
  const digest = await subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// 보안 컨텍스트가 아니면 crypto.subtle이 없다(타입 정의와 달리).
export function getSubtleCrypto(): SubtleCrypto | undefined {
  return (globalThis.crypto as Crypto | undefined)?.subtle as SubtleCrypto | undefined
}
