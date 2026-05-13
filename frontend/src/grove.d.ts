declare global {
  interface Window {
    grove?: {
      pickFolder(): Promise<string | null>;
      openExternal(url: string): Promise<void>;
      onFrameNav(cb: (url: string) => void): () => void;
      onFrameFail(cb: (info: { url: string; code: number; message: string }) => void): () => void;
      clearFrameFail(): void;
    };
  }
}

export {};
