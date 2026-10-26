// 개발 환경 확인용 최소 화면. 시각적 방향은 디자인 방향 확정 후 별도로 작업한다.
function App() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6 py-12 text-neutral-900">
      <h1 className="text-3xl font-bold">Photo Selector</h1>
      <p className="text-base leading-relaxed text-neutral-700">
        여러 장의 사진에서 실패한 사진과 유사 사진을 구분하고 좋은 사진을 추천하는 서비스입니다.
      </p>
      <p className="text-sm text-neutral-600">
        개발 환경 준비 중입니다. 사진 가져오기와 분석 기능은 아직 제공하지 않습니다.
      </p>
    </main>
  )
}

export default App
