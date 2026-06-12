// Tabs for the Files panel: each open file is one tab. Click switches the
// active tab; × closes. Mirrors the look of LeafTabBar but specialised for
// file paths (truncated basenames, full-path tooltip, dirty dot).

import { Box, Flex, Text } from '@chakra-ui/react';
import { X } from 'lucide-react';

interface OpenTab {
  path: string;
  dirty: boolean;
}

export function FileTabBar({
  tabs,
  activePath,
  onActivate,
  onClose,
}: {
  tabs: OpenTab[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <Flex
      h="30px"
      flexShrink={0}
      align="stretch"
      bg="#0d1117"
      borderBottom="1px solid #21262d"
      overflowX="auto"
      overflowY="hidden"
      css={{ scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}
    >
      {tabs.map((tab) => (
        <Tab
          key={tab.path}
          path={tab.path}
          dirty={tab.dirty}
          active={tab.path === activePath}
          onActivate={() => onActivate(tab.path)}
          onClose={() => onClose(tab.path)}
        />
      ))}
    </Flex>
  );
}

function Tab({
  path,
  dirty,
  active,
  onActivate,
  onClose,
}: {
  path: string;
  dirty: boolean;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const name = basename(path);
  return (
    <Flex
      role="button"
      onClick={onActivate}
      onAuxClick={(e) => {
        // Middle-click closes the tab.
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      align="center"
      gap="1.5"
      px="2.5"
      h="100%"
      borderRight="1px solid #21262d"
      bg={active ? '#161b22' : 'transparent'}
      color={active ? '#f0f6fc' : '#7d8590'}
      cursor="pointer"
      flexShrink={0}
      maxW="200px"
      title={path}
      position="relative"
      _hover={{ bg: active ? '#161b22' : '#0f1419', color: '#f0f6fc' }}
      style={{
        boxShadow: active ? 'inset 0 -2px 0 #4d9ef6' : undefined,
      }}
    >
      <Text fontSize="12px" fontFamily="var(--grove-mono)" truncate minW="0">
        {name}
      </Text>
      <Box
        as="button"
        aria-label="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        position="relative"
        w="14px"
        h="14px"
        display="inline-flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="3px"
        color="#7d8590"
        flexShrink={0}
        _hover={{ bg: '#30363d', color: '#f0f6fc' }}
      >
        {dirty ? (
          <Box
            w="7px"
            h="7px"
            borderRadius="999px"
            bg="#d29922"
            // Hover swaps the dot for an ×; mimic VS Code.
            css={{
              'button:hover > &': { display: 'none' },
            }}
          />
        ) : null}
        <Box
          css={dirty ? { display: 'none', 'button:hover > &': { display: 'inline-flex' } } : {}}
          alignItems="center"
          justifyContent="center"
          display={dirty ? 'none' : 'inline-flex'}
        >
          <X size={11} strokeWidth={2} />
        </Box>
      </Box>
    </Flex>
  );
}

function basename(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}
