import { useEffect, useState } from 'react';
import { CloseButton, Flex, Text } from '@chakra-ui/react';
import { useDaemonHealth } from './daemonHealth';

const AUTO_DISMISS_MS = 5000;

export function ReconnectBanner() {
  const reconnectCount = useDaemonHealth((s) => s.reconnectCount);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (reconnectCount === 0) return; // initial mount is not a restart
    setVisible(true);
    const t = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [reconnectCount]);

  if (!visible) return null;

  return (
    <Flex
      position="fixed"
      top="44px"
      left="50%"
      transform="translateX(-50%)"
      zIndex={1000}
      bg="#3a2a13"
      border="1px solid #614a1f"
      borderRadius="6px"
      px="14px"
      py="8px"
      align="center"
      gap="10px"
      boxShadow="0 4px 18px rgba(0,0,0,0.45)"
    >
      <Text fontSize="13px" color="#f1c47a">
        Grove restarted — processes were interrupted.
      </Text>
      <CloseButton size="xs" color="#f1c47a" onClick={() => setVisible(false)} />
    </Flex>
  );
}
