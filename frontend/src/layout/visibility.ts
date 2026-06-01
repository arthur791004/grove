// Workspace visibility context. LayoutContent renders every visited
// workspace under display:none/block to keep terminals mounted across
// switches; descendants (TerminalView, BrowserPanel) need a signal to
// refit / refresh when their workspace flips back to visible, because
// ResizeObserver only fires after layout settles and may lag a frame.
//
// Provider: LayoutHost (per workspace). Consumer: any leaf-level
// component that needs to react to the visible→hidden→visible cycle.

import { createContext, useContext } from 'react';

const Ctx = createContext<boolean>(true);

export const WorkspaceVisibilityProvider = Ctx.Provider;

export function useWorkspaceVisible(): boolean {
  return useContext(Ctx);
}
