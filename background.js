const DEFAULT_STATE = { text: "", speed: 120, index: 0, status: "idle", error: "" };
let job = { ...DEFAULT_STATE };
let activeTabId = null;
let attachedTabId = null;
let timer = null;

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get("job");
  if (!saved.job) await chrome.storage.local.set({ job: DEFAULT_STATE });
});

async function publish() {
  await chrome.storage.local.set({ job });
  try { await chrome.runtime.sendMessage({ type: "AUTOTYPE_UPDATE", state: job }); } catch (_) {}
}

async function detachDebugger() {
  const tabId = attachedTabId;
  attachedTabId = null;
  if (tabId === null) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

async function attachDebugger(tabId) {
  if (attachedTabId === tabId) return;
  await detachDebugger();
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabId = tabId;
}

function schedule(delay = Math.max(200, Math.round(60000 / job.speed))) {
  clearTimeout(timer);
  if (job.status !== "running") return;
  timer = setTimeout(step, delay);
}

async function fail(message) {
  clearTimeout(timer);
  job.status = "error";
  job.error = message;
  await publish();
  await detachDebugger();
}

async function step() {
  if (job.status !== "running" || activeTabId === null) return;
  if (job.index >= job.text.length) {
    job.status = "completed";
    job.error = "";
    await publish();
    await detachDebugger();
    return;
  }
  try {
    await chrome.debugger.sendCommand(
      { tabId: activeTabId },
      "Input.insertText",
      { text: job.text[job.index] }
    );
    job.index += 1;
    job.error = "";
    await publish();
    schedule();
  } catch (error) {
    await fail(`Не удалось передать ввод в редактор: ${error.message}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "AUTOTYPE_COMMAND") return false;
  (async () => {
    const command = message.command;
    if (command === "start") {
      clearTimeout(timer);
      activeTabId = message.tabId;
      job = { text: message.text, speed: message.speed, index: 0, status: "running", error: "" };
      await attachDebugger(activeTabId);
      await publish();
      schedule(700);
    } else if (command === "pause") {
      clearTimeout(timer);
      job.status = "paused";
      await publish();
      await detachDebugger();
    } else if (command === "resume") {
      activeTabId = message.tabId;
      job.text = message.text;
      job.speed = message.speed;
      job.index = Math.min(message.index ?? job.index, job.text.length);
      job.status = "running";
      job.error = "";
      await attachDebugger(activeTabId);
      await publish();
      schedule(700);
    } else if (command === "stop") {
      clearTimeout(timer);
      job.status = "stopped";
      job.error = "";
      await publish();
      await detachDebugger();
    } else if (command === "sync") {
      job.speed = message.speed;
      await publish();
      if (job.status === "running") schedule();
    }
    sendResponse({ ok: true, state: job });
  })().catch(async (error) => {
    await fail(error.message.includes("Another debugger")
      ? "Закройте DevTools и другие отладчики, затем повторите запуск."
      : `Не удалось подключиться к вкладке: ${error.message}`);
    sendResponse({ ok: false, error: job.error });
  });
  return true;
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== attachedTabId) return;
  attachedTabId = null;
  if (job.status === "running") fail("Chrome отключил управление вкладкой. Поставьте курсор в документ и нажмите «Продолжить».");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== activeTabId) return;
  clearTimeout(timer);
  activeTabId = null;
  detachDebugger();
});
