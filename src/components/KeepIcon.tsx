// 남기기 상태 아이콘. 남긴 사진은 체크 표시가 있는 원, 아니면 빈 원이다(색상만으로 구분하지 않는다).
function KeepIcon({ kept, className = 'size-4' }: { kept: boolean; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`${className} shrink-0`} fill="none" stroke="currentColor">
      {kept ? (
        <>
          <circle cx="10" cy="10" r="8" fill="currentColor" stroke="none" />
          <path d="M6.5 10.25l2.25 2.25 4.75-5" stroke="var(--keep-icon-check, white)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle cx="10" cy="10" r="7.25" strokeWidth="1.5" />
      )}
    </svg>
  )
}

export default KeepIcon
