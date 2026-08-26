/// <reference types="vite/client" />
declare module '*?raw' {
  const content: string;
  export default content;
}

/** Injected by vite.config.ts from package.json. One source, no drift. */
declare const __APP_VERSION__: string;
