/**
 * The Qentor Guide's character: an original mark drawn here, in inline SVG
 * (no image file, no external URL, no dependency).
 *
 * "Orbit" is a small graphite sphere — a qubit-ish body — with a soft visor
 * holding two friendly cyan eyes, a thin cyan orbit ring tilted around it
 * (half behind, half in front, like an electron's path), one violet electron,
 * and a short antenna with a violet spark. Cool graphite, cyan and violet
 * accents from the Qentor palette; friendly, not childish. It is built from
 * simple shapes so it stays recognisable down to ~24px (the orbit ring and the
 * two eyes carry the silhouette). It is purely decorative (`aria-hidden`): the
 * button that wraps it provides the accessible name.
 */
import { useId } from 'react'

export function GuideCharacter({ size = 40, className = '' }: { size?: number; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const body = `guide-body-${uid}`
  const glow = `guide-glow-${uid}`

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      data-testid="guide-character"
      className={className}
    >
      <defs>
        <radialGradient id={body} cx="36%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#4b5566" />
          <stop offset="60%" stopColor="#252b35" />
          <stop offset="100%" stopColor="#14171d" />
        </radialGradient>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#b79cff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#b79cff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Soft shadow under the floating body. */}
      <ellipse cx="32" cy="60" rx="13" ry="2.6" fill="#000" opacity="0.28" />

      {/* Orbit ring, back half (behind the body). The ring is an ellipse
          (rx 28, ry 9.5) centred on the body and tilted -20 degrees; the two
          arcs join the ends of its major axis, (5.7, 41.6) and (58.3, 22.4),
          so together they close into one exact ring. */}
      <path
        d="M5.7 41.6 A28 9.5 -20 0 1 58.3 22.4"
        fill="none"
        stroke="#5fd4e6"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.35"
      />

      {/* Antenna. */}
      <line x1="32" y1="14.5" x2="32" y2="8.5" stroke="#5a6475" strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="7" r="4.4" fill={`url(#${glow})`} />
      <circle cx="32" cy="7" r="2.1" fill="#b79cff" />

      {/* Body. */}
      <circle cx="32" cy="34" r="19" fill={`url(#${body})`} stroke="#3d4450" strokeWidth="1.2" />
      <path d="M17 28 A17 17 0 0 1 30 16" fill="none" stroke="#fff" strokeOpacity="0.14" strokeWidth="2" strokeLinecap="round" />

      {/* Visor and eyes. */}
      <rect x="21" y="28.5" width="22" height="13" rx="6.5" fill="#0c0f13" stroke="#2e343d" strokeWidth="1" />
      <circle cx="27.2" cy="34.8" r="2.7" fill="#7fe3f3" />
      <circle cx="36.8" cy="34.8" r="2.7" fill="#7fe3f3" />
      <circle cx="28.1" cy="33.9" r="0.9" fill="#fff" opacity="0.85" />
      <circle cx="37.7" cy="33.9" r="0.9" fill="#fff" opacity="0.85" />
      <path d="M29 39 Q32 41.2 35 39" fill="none" stroke="#7fe3f3" strokeWidth="1.3" strokeLinecap="round" opacity="0.75" />

      {/* Orbit ring, front half (in front of the body), plus the electron. */}
      <path
        d="M5.7 41.6 A28 9.5 -20 0 0 58.3 22.4"
        fill="none"
        stroke="#5fd4e6"
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity="0.9"
      />
      {/* The electron sits ON the front arc (the ring point at 45 degrees). */}
      <circle cx="52.9" cy="31.5" r="4.2" fill={`url(#${glow})`} />
      <circle cx="52.9" cy="31.5" r="2.3" fill="#b79cff" stroke="#0e1014" strokeWidth="0.8" />
    </svg>
  )
}
