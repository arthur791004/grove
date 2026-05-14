declare global {
  interface Window {
    grove?: {
      pickFolder(): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      stateGet(): Promise<string | null>;
      stateSet(content: string): Promise<void>;
      browser: {
        open(url: string): Promise<void>;
        close(): Promise<void>;
        setBounds(bounds: { x: number; y: number; width: number; height: number; zoom?: number } | null): Promise<void>;
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
