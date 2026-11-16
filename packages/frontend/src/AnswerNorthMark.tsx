export function AnswerNorthMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width="24"
      height="24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <circle cx="32" cy="32" r="26" stroke="currentColor" strokeWidth="3" />
      <path d="M32 12 45 45 32 38 19 45 32 12Z" fill="currentColor" />
    </svg>
  );
}
