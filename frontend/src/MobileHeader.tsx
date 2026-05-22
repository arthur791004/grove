import { Box, Flex, Text } from '@chakra-ui/react';
import { Menu, SlidersHorizontal } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

// The mobile web build runs in a plain browser tab — there is no Electron
// window chrome, so it gets a real in-app header instead of the desktop's
// 36px drag-region titlebar: taller, with 40px touch targets. App.tsx reads
// this height to offset the workspace drawer.
export const MOBILE_HEADER_HEIGHT = 48;

// macOS traffic-light cluster width (with titleBarStyle: 'hiddenInset'). When
// this header runs inside a narrow Electron window it must leave room for
// them; in a browser there's nothing to clear.
const TRAFFIC_LIGHT_WIDTH = 72;

interface PanelButton {
  id: string;
  title: string;
  icon: ReactNode;
}

function HeaderButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Box
      as="button"
      aria-label={label}
      onClick={onClick}
      display="flex"
      alignItems="center"
      justifyContent="center"
      w="40px"
      h="40px"
      flexShrink={0}
      borderRadius="8px"
      color="#c9d1d9"
      bg={active ? '#30363d' : 'transparent'}
      _active={{ bg: '#30363d' }}
      style={
        {
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          // Kill the grey flash iOS paints over tapped elements.
          WebkitTapHighlightColor: 'transparent',
          // Stay clickable when the header is an Electron drag region.
          WebkitAppRegion: 'no-drag',
        } as CSSProperties
      }
    >
      {children}
    </Box>
  );
}

export function MobileHeader({
  workspaceName,
  panels,
  activePanelId,
  onTogglePanel,
  onOpenDrawer,
  settingsOpen,
  onToggleSettings,
  isElectron,
}: {
  workspaceName: string;
  panels: PanelButton[];
  activePanelId: string | null;
  onTogglePanel: (id: string) => void;
  onOpenDrawer: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  isElectron: boolean;
}) {
  return (
    <Flex
      h={`${MOBILE_HEADER_HEIGHT}px`}
      flexShrink={0}
      align="center"
      px="1"
      gap="1"
      bg="#0d1117"
      borderBottom="1px solid #21262d"
      position="relative"
      zIndex={50}
      // In a narrow Electron window the header doubles as the window-drag
      // region; in a browser there's no window to drag.
      style={isElectron ? ({ WebkitAppRegion: 'drag' } as CSSProperties) : undefined}
    >
      {isElectron && <Box w={`${TRAFFIC_LIGHT_WIDTH}px`} h="100%" flexShrink={0} />}
      <HeaderButton label="Workspaces" onClick={onOpenDrawer}>
        <Menu size={20} strokeWidth={1.8} />
      </HeaderButton>
      <Flex flex="1" minW="0" justify="center" px="1">
        <Text fontSize="15px" fontWeight="600" color="#f0f6fc" truncate>
          {workspaceName}
        </Text>
      </Flex>
      {panels.map((p) => (
        <HeaderButton
          key={p.id}
          label={p.title}
          active={activePanelId === p.id}
          onClick={() => onTogglePanel(p.id)}
        >
          {p.icon}
        </HeaderButton>
      ))}
      <HeaderButton label="Settings" active={settingsOpen} onClick={onToggleSettings}>
        <SlidersHorizontal size={18} strokeWidth={1.8} />
      </HeaderButton>
    </Flex>
  );
}
