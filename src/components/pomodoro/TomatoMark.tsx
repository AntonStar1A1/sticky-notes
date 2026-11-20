// 番茄钟品牌标记:小番茄(项目没有番茄图标,自己画一个,颜色跟随主题的番茄渐变)
export default function TomatoMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="tomato-mark"
    >
      <path
        d="M12 5.1c-1 1.5-2.9 2.2-4.9 1.9 1.2 1.3 2.9 1.9 4.9 1.9s3.7-.6 4.9-1.9c-2 .3-3.9-.4-4.9-1.9Z"
        fill="#5fae62"
      />
      <path d="M12 2.8v2.6" stroke="#5fae62" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="14.4" r="6.9" fill="var(--pomo-to, #e5484d)" />
      <path
        d="M12 9.2c1.7 0 3.2.6 4.3 1.7"
        stroke="rgba(255,255,255,.55)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
