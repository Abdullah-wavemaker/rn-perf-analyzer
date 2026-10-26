// Minimal ambient types so the SDK compiles without react-native installed.
// Consumers resolve the real package and its types.
declare module 'react-native' {
  export const AppState: {
    addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  };
}
