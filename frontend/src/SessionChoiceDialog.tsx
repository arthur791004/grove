import { Button, Dialog, Portal, Text } from '@chakra-ui/react';
import { useStore } from './store';
import { launchClaude } from './claudeLaunch';
import { useHideBrowserOverlay } from './useHideBrowserOverlay';

// New-session / Join-existing prompt. Shown when a Claude tab is bootstrapped
// into a workspace that already runs a Claude session — `bootstrapClaude`
// parks the decision in `sessionChoice` and this dialog resolves it. An
// independent new session is the default (dismissing the dialog picks it).
export function SessionChoiceDialog() {
  const choice = useStore((s) => s.sessionChoice);
  const setSessionChoice = useStore((s) => s.setSessionChoice);
  useHideBrowserOverlay(!!choice);

  const startNew = () => {
    if (choice) void launchClaude(choice.tabId, { sessionId: crypto.randomUUID() });
    setSessionChoice(null);
  };
  const joinExisting = () => {
    if (choice) void launchClaude(choice.tabId, { resume: choice.joinSessionId });
    setSessionChoice(null);
  };

  return (
    <Dialog.Root
      open={!!choice}
      onOpenChange={(e) => {
        // Dismissing without a pick falls back to the default: a new,
        // independent session.
        if (!e.open) startNew();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop bg="rgba(0,0,0,0.5)" />
        <Dialog.Positioner>
          <Dialog.Content
            bg="#161b22"
            border="1px solid #30363d"
            borderRadius="8px"
            boxShadow="0 20px 60px rgba(0,0,0,0.6)"
            w="420px"
            maxW="420px"
          >
            <Dialog.Header px="4" pt="4" pb="2">
              <Dialog.Title fontSize="14px" color="#f0f6fc" fontWeight="600">
                Claude already running in {choice?.workspaceName ?? 'this workspace'}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px="4" py="2">
              <Text fontSize="12px" color="#8b949e" lineHeight="1.6">
                This workspace already has a Claude session. Start a new,
                independent session, or join the existing one — joining resumes
                the same conversation transcript.
              </Text>
            </Dialog.Body>
            <Dialog.Footer px="4" pt="3" pb="4" display="flex" gap="2" justifyContent="flex-end">
              <Button
                size="sm"
                variant="outline"
                onClick={joinExisting}
                borderColor="#30363d"
                color="#c9d1d9"
                _hover={{ bg: '#21262d' }}
              >
                Join existing
              </Button>
              <Button
                size="sm"
                onClick={startNew}
                bg="#238636"
                color="#ffffff"
                _hover={{ bg: '#2ea043' }}
              >
                New session
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
