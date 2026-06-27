// Einstein-inspired intelligent-advisor icon. Original stylized
// silhouette (wild white hair + mustache hint) — NOT a likeness
// of any real person. Calm, professional, internal-IT feel.
export function WatsonAvatar({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Watson assistant">
      <defs>
        <linearGradient id="wbg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1e293b" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="32" fill="url(#wbg)" />
      {/* wild white hair silhouette */}
      <g fill="#e2e8f0">
        <path d="M18 26c-3-1-6 1-6 4 0 2 1 3 3 4-3 1-4 3-3 5 1 1 3 2 5 1-1 2 0 4 2 4 1 0 2-1 3-2v-18z" />
        <path d="M46 26c3-1 6 1 6 4 0 2-1 3-3 4 3 1 4 3 3 5-1 1-3 2-5 1 1 2 0 4-2 4-1 0-2-1-3-2v-18z" />
        <path d="M22 20c2-5 7-8 10-8s8 3 10 8c1 3 1 6 0 8H22c-1-2-1-5 0-8z" />
      </g>
      {/* face */}
      <path d="M24 28c0-5 3-9 8-9s8 4 8 9c0 6-3 12-8 12s-8-6-8-12z" fill="#f1f5f9" />
      {/* eyes */}
      <circle cx="29" cy="31" r="1.6" fill="#0f172a" />
      <circle cx="35" cy="31" r="1.6" fill="#0f172a" />
      {/* mustache hint */}
      <path d="M27 37c2 2 8 2 10 0-2 3-8 3-10 0z" fill="#cbd5e1" />
    </svg>
  );
}
