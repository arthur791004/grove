declare global {
  type WorktreeStatus = {
    hasUncommitted: boolean;
    hasUnpushed: boolean;
    unpushedCount: number;
    currentBranch: string | null;
  };

  interface Window {
    grove?: {
      pickFolder(): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      stateGet(): Promise<string | null>;
      stateSet(content: string): Promise<void>;
      revealPath(target: string): Promise<void>;
      workspace: {
        fork(req: { workspaceId: string; sourceCwd: string }): Promise<{
          branch: string;
          displayName: string;
          worktreePath: string;
        }>;
        close(req: {
          workspaceId: string;
          force?: boolean;
        }): Promise<{ removed: boolean; branchDeleted: boolean }>;
        status(req: { workspaceId: string }): Promise<WorktreeStatus | null>;
        isGitRepo(req: { cwd: string }): Promise<boolean>;
        listGroveBranches(req: {
          liveWorkspaceIds: string[];
          cwds?: string[];
        }): Promise<Array<{ repoRoot: string; branch: string; worktreePath?: string }>>;
        deleteBranches(req: {
          entries: Array<{ repoRoot: string; branch: string; worktreePath?: string }>;
        }): Promise<{ deleted: number; errors: Array<{ branch: string; message: string }> }>;
      };
      browser: {
        open(url: string): Promise<void>;
        close(): Promise<void>;
        setBounds(
          bounds: { x: number; y: number; width: number; height: number; zoom?: number } | null,
        ): Promise<void>;
        navigate(url: string): Promise<void>;
        reload(): Promise<void>;
        back(): Promise<void>;
        forward(): Promise<void>;
        onNav(cb: (url: string) => void): () => void;
        onNavState(cb: (state: { canGoBack: boolean; canGoForward: boolean }) => void): () => void;
        onFail(cb: (info: { url: string; code: number; message: string }) => void): () => void;
        onLoading(cb: (loading: boolean) => void): () => void;
        clearFail(): void;
      };
    };
  }
}

export {};
