/** 标题栏置顶图钉图标(手绘 SVG):置顶=实心品牌色,未置顶=描边 */
export default function PinToggleIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {pinned ? (
        <path
          d="M12 17v5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M9 4h6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
      <path
        d="M12 2.5a2.75 2.75 0 0 1 2.75 2.75c0 1.3-.9 2.4-2.1 2.66l-.65 6.84a3.25 3.25 0 1 1-3.5 0l-.65-6.84A2.75 2.75 0 0 1 12 2.5Z"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={pinned ? 0 : 2}
        strokeLinejoin="round"
      />
    </svg>
  )
}
