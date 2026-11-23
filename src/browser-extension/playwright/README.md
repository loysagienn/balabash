# Modules of the Playwright extension

The files of this folder are copied from the Playwright repository,
`packages/extension/src` at commit `61775c1ae65409859ebc4e60dec3a4a3a9cc3f92`
(2026-11-23): `channel.ts`, `clientSession.ts`, `ownedTab.ts`,
`tabRegistry.ts`, `tabGroupManager.ts`, `chromeListeners.ts`, `cdpPolicy.ts`,
`types.ts`. Copyright (c) Microsoft Corporation, Apache License 2.0 —
`LICENSE` and `NOTICE` here are the ones of that repository.

They hold the part of the extension that does not care where the client
is: which session owns which tab, the debugger on a tab, the tab group of a
session, the CDP methods a session may not call, and the session link's
framing. What connects a session — in Playwright a page the local relay
opens — is replaced by `../link.ts`.

Two of them are changed, each change stated at the top of its file, as the
license asks: `tabRegistry.ts` (the user's new tab is not claimed for the
session whose tab was active) and `tabGroupManager.ts` (a failed grouping is
reported). The rest are unchanged.
