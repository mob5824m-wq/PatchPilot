import { useId, type ReactNode } from 'react';

/**
 * The PatchPilot seal: a hexagon with a compass needle pointing at the right
 * build. Geometry mirrors `brand/logo.svg` (the canonical file) — a hexagon ring
 * for the package, a needle for picking the exact one, both in the app accent.
 *
 * Kept inline rather than served, so it stays crisp at any size and inherits the
 * page colours instead of needing a second request.
 */
export function LogoMark({ size = 30, title = 'PatchPilot' }: { size?: number; title?: string }): ReactNode {
  const id = useId();
  const background = `bg-${id}`;
  const glow = `glow-${id}`;

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="brand-mark"
      role="img"
      aria-label={title}
      focusable="false"
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={background} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#13212d" />
          <stop offset="1" stopColor="#080d13" />
        </linearGradient>
        <radialGradient id={glow} cx="0.28" cy="0.18" r="0.75">
          <stop offset="0" stopColor="#6ee7a8" stopOpacity="0.22" />
          <stop offset="1" stopColor="#6ee7a8" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill={`url(#${background})`} />
      <rect width="32" height="32" rx="7.5" fill={`url(#${glow})`} />
      <path
        d="M16.00 5.97 23.39 11.25 23.39 22.51 16.00 27.79 8.61 22.51 8.61 11.25Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.95"
        strokeLinejoin="round"
      />
      <path d="M13.01 18.99L17.15 14.85" stroke="currentColor" strokeWidth="1.95" strokeLinecap="round" />
      <circle cx="13.01" cy="18.99" r="1.32" fill="currentColor" />
      <path
        d="M19.43 12.57L18.03 16.52L15.48 13.97Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.85"
        strokeLinejoin="round"
      />
    </svg>
  );
}
