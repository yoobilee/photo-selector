const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700'

export const primaryButtonClassName = `inline-flex min-h-11 items-center justify-center rounded-md bg-neutral-900 px-5 text-sm font-semibold text-white hover:bg-neutral-700 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 ${focusRing}`

// 색상은 사용하는 위치의 배경에 맞춰 호출자가 지정한다.
export const iconButtonClassName = `inline-flex size-9 shrink-0 items-center justify-center rounded-md ${focusRing}`
