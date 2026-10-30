// 만든 글자 데이터를 사용자의 기기에 파일로 저장한다. 네트워크로 보내지 않는다.
export function downloadText(fileName: string, mimeType: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  // 다운로드가 시작된 뒤 해제한다. 같은 작업 안에서 바로 해제하면 일부 브라우저가 저장을 취소한다.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function fileTimestamp(exportedAt: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}-${pad(exportedAt.getHours())}${pad(exportedAt.getMinutes())}${pad(exportedAt.getSeconds())}`
}

// 내보낸 시각만 담은 파일 이름. 사진 이름은 넣지 않는다.
export function evaluationFileName(exportedAt: Date, extension: 'json' | 'csv'): string {
  return `blur-evaluation-${fileTimestamp(exportedAt)}.${extension}`
}

// 평가 결과(blur-evaluation)와 헷갈리지 않도록 다른 이름을 쓴다.
export function groundTruthFileName(exportedAt: Date): string {
  return `blur-ground-truth-${fileTimestamp(exportedAt)}.json`
}
