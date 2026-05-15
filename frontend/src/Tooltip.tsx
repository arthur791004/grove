import { Tooltip as ChakraTooltip, Portal } from '@chakra-ui/react';
import type { ReactElement, ReactNode } from 'react';

interface Props {
  label: ReactNode;
  children: ReactElement;
  openDelay?: number;
  closeDelay?: number;
}

// Thin wrapper over Chakra v3's Tooltip — keeps the simple
// `<Tooltip label="...">child</Tooltip>` call shape while delegating
// positioning, accessibility, and dismissal to the library.
export function Tooltip({ label, children, openDelay = 200, closeDelay = 0 }: Props) {
  if (label == null || label === '') return children;
  return (
    <ChakraTooltip.Root
      openDelay={openDelay}
      closeDelay={closeDelay}
      positioning={{ placement: 'bottom' }}
    >
      <ChakraTooltip.Trigger asChild>{children}</ChakraTooltip.Trigger>
      <Portal>
        <ChakraTooltip.Positioner>
          <ChakraTooltip.Content
            bg="#1c2128"
            border="1px solid #30363d"
            borderRadius="4px"
            px="2"
            py="1"
            fontSize="11px"
            color="#c9d1d9"
            maxW="320px"
            boxShadow="0 4px 12px rgba(0,0,0,0.4)"
          >
            {label}
          </ChakraTooltip.Content>
        </ChakraTooltip.Positioner>
      </Portal>
    </ChakraTooltip.Root>
  );
}
