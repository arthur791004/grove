import { Box, Text } from '@chakra-ui/react';
import { useStore } from './store';
import { TerminalView } from './TerminalView';

export function Workspace() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);

  if (tabs.length === 0) {
    return (
      <Box display="flex" alignItems="center" justifyContent="center" h="100%">
        <Text color="#7d8590" fontSize="sm">
          No tabs. Press ⌘T to create one.
        </Text>
      </Box>
    );
  }

  return (
    <Box position="relative" w="100%" h="100%" bg="#010409">
      {tabs.map((t) => (
        <Box
          key={t.id}
          position="absolute"
          inset="0"
          display={t.id === activeTabId ? 'block' : 'none'}
        >
          <TerminalView tabId={t.id} active={t.id === activeTabId} />
        </Box>
      ))}
    </Box>
  );
}
