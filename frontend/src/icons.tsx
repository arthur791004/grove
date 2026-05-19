// Hand-rolled SVG icons used across the renderer.
//
// New icons should come from `lucide-react` first — only add a custom icon
// here when Lucide doesn't have a fitting one (or the bespoke shape matters,
// e.g. the four-square Warp-style Stop glyph).
//
// All icons accept an optional `size` prop and use `currentColor` for stroke
// / fill so callers can style them via Chakra's `color` prop.

interface IconProps {
  size?: number;
}

export function ChevronIcon({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
      <path
        d="M2.5 3.5L5 6L7.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function KebabIcon({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor">
      <circle cx="5" cy="1.5" r="1" />
      <circle cx="5" cy="5" r="1" />
      <circle cx="5" cy="8.5" r="1" />
    </svg>
  );
}

export function BranchIcon({ size = 10 }: IconProps) {
  return (
    <svg width={size * 0.83} height={size} viewBox="0 0 10 12" fill="none">
      <circle cx="2" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <circle cx="2" cy="9.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <circle cx="8" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1" />
      <path
        d="M2 3.7v4.6M2 6c0-1.7 1.4-3.5 6-3.5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function FolderIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M1.5 4a1 1 0 0 1 1-1h4l1.5 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11.5a1 1 0 0 1-1-1V4z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TerminalIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path
        d="M3 4.5L6 7.5L3 10.5M7 11.5h6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// The 2×2 grid of squares mirrors Warp's "stop running command" glyph.
export function StopIcon({ size = 10 }: IconProps) {
  return (
    <svg
      className="grove-sq-icon"
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="currentColor"
    >
      <rect x="1" y="1" width="3.5" height="3.5" rx="0.5" />
      <rect x="5.5" y="1" width="3.5" height="3.5" rx="0.5" />
      <rect x="5.5" y="5.5" width="3.5" height="3.5" rx="0.5" />
      <rect x="1" y="5.5" width="3.5" height="3.5" rx="0.5" />
    </svg>
  );
}

export function PlusIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function NewGroupIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size * (12 / 14)} viewBox="0 0 14 12" fill="none">
      <path
        d="M1 2.5a1 1 0 0 1 1-1h3.5l1.5 1.5h5a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2.5z"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M7 5.5v3M5.5 7h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none">
      <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function FileIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size * (14 / 12)} viewBox="0 0 12 14" fill="none">
      <path
        d="M2 1h5l3 3v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path d="M7 1v3h3" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function ScriptIcon({ size = 13 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path
        d="M3 4l3 3-3 3M7 11h4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Stroke is hard-coded to the Node green so it reads as a brand glyph
// regardless of surrounding text color.
export function NodeIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size * (11 / 12)} height={size} viewBox="0 0 11 12" fill="none">
      <path
        d="M5.5 0.5L10.5 3.25v5.5L5.5 11.5L0.5 8.75v-5.5L5.5 0.5z"
        stroke="#7ee787"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DiffIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor">
      <path
        d="M3 1h5l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <path d="M8 1v3h3" strokeWidth="1" />
      <path d="M5 7.5h4M7 5.5v4" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M5 11h4" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

export function ClaudeIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M6 1.5v9" />
        <path d="M2.1 3.5l7.8 5" />
        <path d="M2.1 8.5l7.8-5" />
      </g>
    </svg>
  );
}

const CMD_PREFIX_RE = /^(?:sudo\s+|env\s+\w+=\S+\s+)+/;
const CMD_SPLIT_RE = /[\s|;&]/;

export function commandIcon(cmd: string): ((props: IconProps) => JSX.Element) | null {
  const head = cmd.trim().replace(CMD_PREFIX_RE, '').split(CMD_SPLIT_RE)[0]?.toLowerCase();
  if (!head) return null;
  if (head === 'claude' || head.endsWith('/claude')) return ClaudeIcon;
  return null;
}

export function PrIcon({ size = 12 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="3.5" cy="3" r="1.3" />
      <circle cx="3.5" cy="11" r="1.3" />
      <circle cx="10.5" cy="11" r="1.3" />
      <path d="M3.5 4.3v5.4" />
      <path d="M10.5 9.7V6a2 2 0 0 0-2-2H7" />
      <path d="M8.5 2.5L7 4l1.5 1.5" />
    </svg>
  );
}
