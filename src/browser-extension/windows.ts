// Which window a tab of a session is created in. Chrome's default is the
// "current" window — the last one the user focused — and that can be a
// window without a tab strip (a site installed as an app): Chrome then puts
// the tab into some other window and brings it to the front there.

// The window the session already has tabs in; without one — the last
// focused window that has tabs. Undefined leaves the choice to Chrome.
export async function windowForTabs(ownedTabIds: number[]): Promise<number | undefined> {
  for (const tabId of ownedTabIds) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);

    if (tab) {
      return tab.windowId;
    }
  }

  const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined);

  return window?.id;
}
