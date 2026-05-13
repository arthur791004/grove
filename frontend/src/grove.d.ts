declare global {
  interface Window {
    grove?: {
      pickFolder(): Promise<string | null>;
    };
  }
}

export {};
