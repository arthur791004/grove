import { Box, Flex } from '@chakra-ui/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  CornerDownLeft,
} from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// On-screen key bar for the mobile web layout. Phone soft keyboards ship no
// arrow / Esc / Tab keys, so a TUI in raw mode — Claude Code's option lists,
// pagers, editors — is otherwise unnavigable on a phone. Each button writes
// the exact byte sequence a hardware key would emit straight to the PTY.
//
// When `agent === 'claude'` an extra row of Claude-specific shortcuts rides
// above the generic keys: Shift+Tab cycles plan / accept-edits / normal mode,
// the slash buttons paste a slash command and press Enter for you.
//
// Rendered only when `isMobile && rawMode`; see TerminalView.

interface KeyDef {
  // The bytes a hardware key sends: arrows are CSI sequences, Esc is the bare
  // escape byte, Tab and Enter are their control characters. Agent-row entries
  // can also carry literal text (e.g. "/clear\r") — the PTY treats it the same
  // as if the user typed it.
  seq: string;
  aria: string;
  glyph: ReactNode;
}

const KEYS: KeyDef[] = [
  { seq: '\x1b', aria: 'Escape', glyph: 'esc' },
  { seq: '\t', aria: 'Tab', glyph: 'tab' },
  { seq: '\x1b[D', aria: 'Arrow left', glyph: <ArrowLeft size={17} strokeWidth={1.8} /> },
  { seq: '\x1b[A', aria: 'Arrow up', glyph: <ArrowUp size={17} strokeWidth={1.8} /> },
  { seq: '\x1b[B', aria: 'Arrow down', glyph: <ArrowDown size={17} strokeWidth={1.8} /> },
  { seq: '\x1b[C', aria: 'Arrow right', glyph: <ArrowRight size={17} strokeWidth={1.8} /> },
  // Page keys: an alt-screen TUI (Claude Code's conversation, a pager) has no
  // xterm scrollback to drag through, so paging is the only way back on a
  // phone. \x1b[5~ / \x1b[6~ are the bytes a hardware PageUp/PageDown sends.
  { seq: '\x1b[5~', aria: 'Page up', glyph: <ChevronsUp size={17} strokeWidth={1.8} /> },
  { seq: '\x1b[6~', aria: 'Page down', glyph: <ChevronsDown size={17} strokeWidth={1.8} /> },
  { seq: '\r', aria: 'Enter', glyph: <CornerDownLeft size={17} strokeWidth={1.8} /> },
];

// Claude Code shortcuts that have no key on a phone soft keyboard:
//  - Shift+Tab cycles plan-mode / accept-edits / normal (\x1b[Z is the byte a
//    real Shift+Tab emits; reverse-tab in xterm parlance).
//  - "/" types a single slash so Claude opens its slash-command menu, which
//    the user can then navigate with the arrows in the row below.
//  - The named slash items paste the whole command + Enter — one tap to clear,
//    compact, or resume.
const CLAUDE_KEYS: KeyDef[] = [
  { seq: '\x1b[Z', aria: 'Shift Tab (plan mode)', glyph: '⇧tab' },
  { seq: '/', aria: 'Slash menu', glyph: '/' },
  { seq: '/clear\r', aria: 'Send /clear', glyph: '/clear' },
  { seq: '/compact\r', aria: 'Send /compact', glyph: '/compact' },
  { seq: '/resume\r', aria: 'Send /resume', glyph: '/resume' },
];

export function MobileKeyBar({
  onKey,
  agent,
}: {
  onKey: (seq: string) => void;
  agent?: 'claude';
}) {
  return (
    <Box flexShrink={0} bg="#0d1117" borderTop="1px solid #21262d">
      {agent === 'claude' && <KeyRow keys={CLAUDE_KEYS} onKey={onKey} accent />}
      <KeyRow keys={KEYS} onKey={onKey} />
    </Box>
  );
}

function KeyRow({
  keys,
  onKey,
  accent,
}: {
  keys: KeyDef[];
  onKey: (seq: string) => void;
  // Slightly tinted background so the agent row reads as a distinct band
  // from the generic keys without needing a divider line.
  accent?: boolean;
}) {
  return (
    <Flex align="stretch" gap="1" px="1" py="1">
      {keys.map((k) => (
        <Box
          key={k.aria}
          as="button"
          aria-label={k.aria}
          // pointerdown + preventDefault sends the key WITHOUT moving focus —
          // a plain tap would blur xterm's hidden textarea and collapse the
          // soft keyboard between every press.
          onPointerDown={(e) => {
            e.preventDefault();
            onKey(k.seq);
          }}
          flex="1"
          minW="0"
          display="flex"
          alignItems="center"
          justifyContent="center"
          h="38px"
          fontSize="12px"
          fontFamily="var(--grove-mono)"
          color={accent ? '#7ee787' : '#c9d1d9'}
          // Borderless keycap, like a phone's soft keyboard — a filled, rounded
          // surface with a faint raised shadow rather than a 1px outline.
          bg={accent ? '#1a2b1f' : '#21262d'}
          borderRadius="6px"
          _active={{ bg: accent ? '#243d2a' : '#30363d' }}
          style={
            {
              border: 'none',
              boxShadow: '0 1px 1px rgba(0,0,0,0.5)',
              cursor: 'pointer',
              padding: 0,
              touchAction: 'manipulation',
              userSelect: 'none',
              WebkitTapHighlightColor: 'transparent',
              whiteSpace: 'nowrap',
            } as CSSProperties
          }
        >
          {k.glyph}
        </Box>
      ))}
    </Flex>
  );
}
