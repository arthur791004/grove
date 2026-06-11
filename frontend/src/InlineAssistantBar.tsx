// Inline AI assistant prompt bar — mounts anchored below a CodeMirror
// selection. Stateless about the AI itself; it just handles input, submit,
// dismiss, and renders streaming / result states the parent drives.
//
// Slice 1: input + dismiss + submit. No streaming, no diff yet — the parent
// owns the request lifecycle and passes status/result via props.

import { useEffect, useRef } from 'react';
import { Box, Flex, Text, Textarea, IconButton } from '@chakra-ui/react';
import { ArrowUp, X } from 'lucide-react';

export type AssistantStatus = 'idle' | 'streaming' | 'result' | 'error';

export interface AssistantContext {
  filePath: string;
  language: string;
  selectedText: string;
  surroundingLines: string;
  fullContent: string;
  selectionRange: { fromLine: number; toLine: number };
}

interface Props {
  // Position relative to the editor's top edge — caller computes this from
  // EditorView.coordsAtPos. We render absolutely positioned at `anchorTop`.
  anchorTop: number;
  context: AssistantContext;
  status: AssistantStatus;
  prompt: string;
  onPromptChange: (next: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
  // Status-driven content. The bar doesn't know what these mean, only renders
  // them in the right slot.
  streamingText?: string;
  errorMessage?: string;
  // Result-mode controls — when status === 'result', the parent owns
  // accept/reject and renders them via these handlers.
  onAccept?: () => void;
  onReject?: () => void;
  onTryAgain?: () => void;
}

const LARGE_SELECTION_LINES = 200;

export function InlineAssistantBar({
  anchorTop,
  context,
  status,
  prompt,
  onPromptChange,
  onSubmit,
  onDismiss,
  streamingText,
  errorMessage,
  onAccept,
  onReject,
  onTryAgain,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Autofocus on mount so the user can start typing immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const selectionLines =
    context.selectionRange.toLine - context.selectionRange.fromLine + 1;
  const oversize = selectionLines > LARGE_SELECTION_LINES;

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDismiss();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (status === 'idle' && prompt.trim()) onSubmit();
      return;
    }
  }

  return (
    <Box
      position="absolute"
      top={`${anchorTop}px`}
      left="0"
      right="0"
      mx="3"
      zIndex={10}
      bg="#161b22"
      border="1px solid #30363d"
      borderRadius="6px"
      boxShadow="0 8px 24px rgba(0,0,0,0.4)"
      fontFamily="var(--grove-mono)"
      fontSize="12px"
      color="#c9d1d9"
    >
      {/* Header strip: file + line range, plus dismiss. */}
      <Flex
        align="center"
        justify="space-between"
        px="3"
        h="22px"
        borderBottom="1px solid #21262d"
        color="#7d8590"
      >
        <Text truncate>
          {context.filePath.split('/').pop()} · L{context.selectionRange.fromLine}–
          {context.selectionRange.toLine} · {context.language}
        </Text>
        <IconButton
          aria-label="Dismiss"
          size="2xs"
          variant="ghost"
          color="#7d8590"
          onClick={onDismiss}
        >
          <X size={12} />
        </IconButton>
      </Flex>

      {oversize && (
        <Box px="3" py="1.5" bg="#3b2e0e" color="#d29922" fontSize="11px">
          Large selection ({selectionLines} lines) — only the first{' '}
          {LARGE_SELECTION_LINES} will be sent.
        </Box>
      )}

      {/* Prompt input. */}
      <Flex align="flex-end" px="2" py="2" gap="2">
        <Box
          color="#7d8590"
          fontSize="11px"
          pb="1"
          flexShrink={0}
          minW="20px"
          textAlign="center"
        >
          ⌘↵
        </Box>
        <Textarea
          ref={inputRef}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Tell Claude what to change…"
          rows={1}
          resize="none"
          minH="24px"
          maxH="160px"
          border="none"
          bg="transparent"
          color="#c9d1d9"
          fontSize="12px"
          fontFamily="var(--grove-mono)"
          px="1"
          py="0.5"
          _focus={{ boxShadow: 'none', outline: 'none' }}
          disabled={status === 'streaming'}
        />
        <IconButton
          aria-label="Send"
          size="xs"
          variant="ghost"
          color={prompt.trim() && status === 'idle' ? '#58a6ff' : '#484f58'}
          onClick={() => {
            if (status === 'idle' && prompt.trim()) onSubmit();
          }}
          disabled={status !== 'idle' || !prompt.trim()}
        >
          <ArrowUp size={14} />
        </IconButton>
      </Flex>

      {/* Streaming text preview (pre-diff). */}
      {status === 'streaming' && (
        <Box
          px="3"
          py="2"
          borderTop="1px solid #21262d"
          color="#7d8590"
          fontSize="11px"
          maxH="120px"
          overflowY="auto"
          whiteSpace="pre-wrap"
        >
          {streamingText || 'Waiting for response…'}
        </Box>
      )}

      {/* Error state. */}
      {status === 'error' && errorMessage && (
        <Box
          px="3"
          py="2"
          borderTop="1px solid #21262d"
          color="#f85149"
          fontSize="11px"
        >
          {errorMessage}
        </Box>
      )}

      {/* Result mode — accept / reject / try again controls. */}
      {status === 'result' && (
        <Flex
          align="center"
          justify="flex-end"
          gap="2"
          px="3"
          py="2"
          borderTop="1px solid #21262d"
        >
          <ControlButton onClick={onTryAgain} color="#7d8590">
            Try again ⟳
          </ControlButton>
          <ControlButton onClick={onReject} color="#f85149">
            Reject esc
          </ControlButton>
          <ControlButton onClick={onAccept} color="#3fb950" primary>
            Accept ↵
          </ControlButton>
        </Flex>
      )}
    </Box>
  );
}

function ControlButton({
  children,
  color,
  onClick,
  primary,
}: {
  children: React.ReactNode;
  color: string;
  onClick?: () => void;
  primary?: boolean;
}) {
  return (
    <Box
      as="button"
      onClick={onClick}
      px="2"
      py="1"
      fontSize="11px"
      fontFamily="var(--grove-mono)"
      color={color}
      bg={primary ? 'rgba(63,185,80,0.12)' : 'transparent'}
      border={`1px solid ${primary ? '#3fb950' : '#30363d'}`}
      borderRadius="4px"
      cursor="pointer"
      _hover={{ bg: primary ? 'rgba(63,185,80,0.2)' : '#21262d' }}
    >
      {children}
    </Box>
  );
}
