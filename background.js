const DEFAULT_STATE = { text: "", speed: 120, index: 0, status: "idle", error: "" };

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get("job");
  if (!saved.job) await chrome.storage.local.set({ job: DEFAULT_STATE });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "AUTOTYPE_STATE") return false;
  chrome.storage.local.set({ job: message.state }).then(() => {
    chrome.runtime.sendMessage({ type: "AUTOTYPE_UPDATE", state: message.state }).catch(() => {});
    sendResponse({ ok: true });
  });
  return true;
});
