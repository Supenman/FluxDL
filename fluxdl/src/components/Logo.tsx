export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="logo-mark"
    >
      <defs>
        <linearGradient id="flux-logo" x1="10" y1="8" x2="54" y2="58" gradientUnits="userSpaceOnUse">
          <stop stopColor="#A7FFE2" />
          <stop offset="0.55" stopColor="#5EF0C6" />
          <stop offset="1" stopColor="#2BD9A2" />
        </linearGradient>
      </defs>
      <path
        d="M32 10v27m0 0 10-10m-10 10L22 27"
        stroke="url(#flux-logo)"
        strokeWidth="6.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M16 46h32" stroke="url(#flux-logo)" strokeWidth="6.5" strokeLinecap="round" />
    </svg>
  );
}
