import { Box, Flex } from '@chakra-ui/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// On-screen key bar for the mobile web layout. Phone soft keyboards ship no
// arrow / Esc / Tab keys, so a TUI in raw mode — Claude Code's option lists,
// pagers, editors — is otherwise unnavigable on a phone. Each button writes
// the exact byte sequence a hardware key would emit straight to the PTY.
//
// Rendered only when `isMobile && rawMode`; see TerminalView.

interface KeyDef {
  // The bytes a hardware key sends: arrows are CSI sequences, Esc is the bare
  // escape byte, Tab and Enter are their control characters.
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
  { seq: '\r', aria: 'Enter', glyph: <CornerDownLeft size={17} strokeWidth={1.8} /> },
];

export function MobileKeyBar({ onKey }: { onKey: (seq: string) => void }) {
  return (
    <Flex
      flexShrink={0}
      align="stretch"
      gap="1"
      px="1"
      py="1"
      bg="#0d1117"
      borderTop="1px solid #21262d"
    >
      {KEYS.map((k) => (
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
          color="#c9d1d9"
          bg="#161b22"
          borderRadius="8px"
          _active={{ bg: '#30363d' }}
          style={
            {
              border: '1px solid #30363d',
              cursor: 'pointer',
              padding: 0,
              touchAction: 'manipulation',
              userSelect: 'none',
              WebkitTapHighlightColor: 'transparent',
            } as CSSProperties
          }
        >
          {k.glyph}
        </Box>
      ))}
    </Flex>
  );
}
