import { describe, expect, it } from 'vitest'

// 사진과 메타데이터가 기기 밖으로 나가거나 로그에 남지 않도록 앱 소스에서 전송·로그 API 사용을 막는다.
// 외부 전송이 필요한 기능을 도입할 때는 이 검사를 함께 검토한다. 실제 브라우저의 요청은 E2E에서 따로 확인한다.
const appSources = import.meta.glob(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}', '!./test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const forbiddenPatterns: ReadonlyArray<[string, RegExp]> = [
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['sendBeacon', /\bsendBeacon\b/],
  ['WebSocket', /\bWebSocket\b/],
  ['EventSource', /\bEventSource\b/],
  ['console', /\bconsole\s*\./],
]

describe('privacy guard', () => {
  it('scans the application sources', () => {
    expect(Object.keys(appSources)).toEqual(
      expect.arrayContaining(['./App.tsx', './photos/importPhotos.ts']),
    )
  })

  it.each(forbiddenPatterns)('does not use %s in application code', (_name, pattern) => {
    const offenders = Object.entries(appSources)
      .filter(([, source]) => pattern.test(source))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })
})
