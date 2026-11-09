// FluxDL 品牌标识：飘带气流 + 下载箭头 + 托盘。
// 单一真源与 public/brand/*.svg 保持一致；用 currentColor 着色，随主题自动切换。
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      className="logo-mark"
    >
      {/* 飘带气流：被竖杆穿过的两段月牙弧 */}
      <path
        d="M15 63 C8 46 19 35 45 34.8 L45 43.2 C27.5 44.5 19.5 52.5 19 60.5 C18 62.3 16.5 63.1 15 63 Z"
        fill="currentColor"
      />
      <path
        d="M55 34.8 C66.5 31 76 24 81 13 C79.5 28.5 70.5 39.5 55 43.2 Z"
        fill="currentColor"
      />
      {/* 下载箭头 */}
      <path
        d="M50 19 L50 57"
        stroke="currentColor"
        strokeWidth="8.2"
        strokeLinecap="round"
      />
      <path
        d="M35.5 45.5 L50 60.5 L64.5 45.5"
        stroke="currentColor"
        strokeWidth="8.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 底部托盘 */}
      <path
        d="M26 65.5 L26 70 Q26 75 31 75 L69 75 Q74 75 74 70 L74 65.5"
        stroke="currentColor"
        strokeWidth="7.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
