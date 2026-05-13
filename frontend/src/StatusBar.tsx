import { useEffect, useState } from 'react';
import { Box, HStack, Text } from '@chakra-ui/react';
import { useStore } from './store';

interface Context {
  shortCwd: string;
  branch: string | null;
  diff: { added: number; removed: number; files: number } | null;
  node: string | null;
}

export function StatusBar() {
  const activeTabId = useStore((s) => s.activeTabId);
  const [ctx, setCtx] = useState<Context | null>(null);

  useEffect(() => {
    if (!activeTabId) { setCtx(null); return; }
    let cancelled = false;

    async function refresh() {
      try {
        const cwdRes = await fetch(`http://127.0.0.1:4317/session/${activeTabId}/cwd`);
        const { cwd } = await cwdRes.json();
        const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
        const ctxRes = await fetch(`http://127.0.0.1:4317/context${params}`);
        const data = await ctxRes.json();
        if (!cancelled) setCtx(data);
      } catch {
        if (!cancelled) setCtx(null);
      }
    }

    refresh();
    const id = setInterval(refresh, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeTabId]);

  if (!ctx) {
    return <Box h="32px" bg="#010409" />;
  }

  return (
    <HStack
      px="3"
      py="1"
      bg="#010409"
      gap="2"
      borderTop="1px solid #161b22"
    >
      {ctx.node && <Chip icon="⬢" iconColor="#3fb950" label={ctx.node} />}
      <Chip icon="" iconColor="" prefix="📁" label={ctx.shortCwd} />
      {ctx.branch && <Chip icon="" iconColor="" prefix="⎇" label={ctx.branch} labelColor="#3fb950" />}
      {ctx.diff && ctx.diff.files > 0 && (
        <Chip
          icon=""
          iconColor=""
          prefix="±"
          label={`${ctx.diff.added > 0 ? `+${ctx.diff.added}` : ''}${ctx.diff.removed > 0 ? ` -${ctx.diff.removed}` : ''}${ctx.diff.added === 0 && ctx.diff.removed === 0 ? '0' : ''}`}
        />
      )}
    </HStack>
  );
}

function Chip({
  icon, iconColor, prefix, label, labelColor,
}: {
  icon: string;
  iconColor: string;
  prefix?: string;
  label: React.ReactNode;
  labelColor?: string;
}) {
  return (
    <HStack
      gap="1.5"
      px="2"
      py="1"
      bg="#0d1117"
      border="1px solid #21262d"
      borderRadius="5px"
    >
      {icon && <Text color={iconColor} fontSize="11px" lineHeight="1">{icon}</Text>}
      {prefix && <Text color="#7d8590" fontSize="11px" lineHeight="1">{prefix}</Text>}
      <Text fontSize="11px" color={labelColor ?? '#c9d1d9'} lineHeight="1" fontFamily="Menlo, monospace" fontWeight="500">
        {label}
      </Text>
    </HStack>
  );
}
