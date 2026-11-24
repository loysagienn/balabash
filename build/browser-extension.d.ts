// The types of browser-extension.js for the scripts that build an extension
// of their own (scripts/browser-link-check.ts).

export type BuiltExtension = { version: string; dir: string; archive: string };

export function readConsoleDomain(): Promise<string>;
export function buildBrowserExtension(options: { consoleOrigin: string; serverUrl: string; outDir?: string }): Promise<BuiltExtension>;
export function buildInstallationExtension(): Promise<BuiltExtension | null>;
