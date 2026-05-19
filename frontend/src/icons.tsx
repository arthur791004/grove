import { Cable, FlaskConical, GitBranch } from 'lucide-react';

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

// Stack of three "containers" suggesting Docker's payload glyph. No whale —
// keeps the silhouette readable at 12px.
export function DockerIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <rect x="2" y="6" width="2.2" height="2.2" rx="0.3" />
      <rect x="4.7" y="6" width="2.2" height="2.2" rx="0.3" />
      <rect x="7.4" y="6" width="2.2" height="2.2" rx="0.3" />
      <rect x="4.7" y="3.3" width="2.2" height="2.2" rx="0.3" />
      <path
        d="M1 9h11c0 2-1.5 3-3.5 3H4.5C2.5 12 1 11 1 9z"
        fill="currentColor"
      />
    </svg>
  );
}

// Two interlocking rounded squares evoke the Python snake/logo without the
// brand colors — currentColor lets it adopt the tab tint.
export function PythonIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor">
      <path
        d="M4 2.5h4a1.5 1.5 0 0 1 1.5 1.5v3h-5A1.5 1.5 0 0 0 3 8.5V11"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 11.5H6a1.5 1.5 0 0 1-1.5-1.5V7h5A1.5 1.5 0 0 0 11 5.5V3"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="5.2" cy="3.7" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="8.8" cy="10.3" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// npm wordmark abstracted to its three-square cadence: one tall, two short,
// arranged in the logo's distinctive proportions.
export function NpmIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor">
      <rect x="1" y="3.5" width="12" height="7" rx="0.6" strokeWidth="1.1" />
      <path
        d="M3.5 10V6.5h1.5V10M5 7h1.5v2.5M7 10V6.5h2v3M9 6.5h1v3M11 6.5v3"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Vim's diamond outline with a vee notch.
export function VimIcon({ size = 12 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor">
      <path
        d="M7 1.5L12.5 7L7 12.5L1.5 7L7 1.5z"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M4.5 5.5L7 9.5L9.5 5.5" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Lucide wrappers — accept the same IconProps signature so commandIcon
// callers don't have to special-case them.
const GitIcon = ({ size = 12 }: IconProps) => <GitBranch size={size} />;
const SshIcon = ({ size = 12 }: IconProps) => <Cable size={size} />;
const PytestIcon = ({ size = 12 }: IconProps) => <FlaskConical size={size} />;

const CMD_PREFIX_RE = /^(?:sudo\s+|env\s+\w+=\S+\s+)+/;
const CMD_SPLIT_RE = /[\s|;&]/;

const COMMAND_ICON_MAP: Record<string, (props: IconProps) => JSX.Element> = {
  claude: ClaudeIcon,
  docker: DockerIcon,
  'docker-compose': DockerIcon,
  podman: DockerIcon,
  python: PythonIcon,
  python3: PythonIcon,
  pip: PythonIcon,
  pip3: PythonIcon,
  poetry: PythonIcon,
  uv: PythonIcon,
  npm: NpmIcon,
  npx: NpmIcon,
  pnpm: NpmIcon,
  yarn: NpmIcon,
  bun: NpmIcon,
  vim: VimIcon,
  nvim: VimIcon,
  vi: VimIcon,
  git: GitIcon,
  gh: GitIcon,
  ssh: SshIcon,
  mosh: SshIcon,
  pytest: PytestIcon,
  jest: PytestIcon,
  vitest: PytestIcon,
};

export function commandIcon(cmd: string): ((props: IconProps) => JSX.Element) | null {
  const head = cmd.trim().replace(CMD_PREFIX_RE, '').split(CMD_SPLIT_RE)[0]?.toLowerCase();
  if (!head) return null;
  const direct = COMMAND_ICON_MAP[head];
  if (direct) return direct;
  // Support `/path/to/claude` style invocations.
  const basename = head.includes('/') ? head.slice(head.lastIndexOf('/') + 1) : head;
  return COMMAND_ICON_MAP[basename] ?? null;
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
