const $ = (id) => document.getElementById(id);
const ui = {
  text: $("sourceText"), speed: $("speed"), speedValue: $("speedValue"),
  status: $("status"), counter: $("counter"), bar: $("progressBar"), percent: $("percent"),
  message: $("message"), start: $("start"), pause: $("pause"), resume: $("resume"),
  stop: $("stop"), copy: $("copyRemainder")
};
let state = { text: "", speed: 120, index: 0, status: "idle", error: "" };
let saveTimer;
let controlFrameId = null;

const labels = { idle:"Готово", running:"Ввод…", paused:"Пауза", stopped:"Остановлено", completed:"Завершено", error:"Требуется действие" };

function render(next = state) {
  state = { ...state, ...next };
  const total = state.text.length;
  const index = Math.min(state.index, total);
  const pct = total ? Math.round(index / total * 100) : 0;
  ui.speed.value = state.speed;
  ui.speedValue.textContent = `${state.speed} симв/мин`;
  ui.status.textContent = labels[state.status] || state.status;
  ui.counter.textContent = `${index} / ${total}`;
  ui.bar.style.width = `${pct}%`;
  ui.bar.parentElement.setAttribute("aria-valuenow", pct);
  ui.percent.textContent = `${pct}%`;
  const running = state.status === "running";
  ui.start.disabled = running || !state.text.length;
  ui.pause.disabled = !running;
  ui.resume.disabled = !["paused", "stopped", "error"].includes(state.status) || index >= total;
  ui.stop.disabled = !["running", "paused", "error"].includes(state.status);
  ui.text.disabled = running;
  ui.copy.hidden = state.status !== "error" || index >= total;
  ui.message.textContent = state.error || (state.status === "completed" ? "Весь текст перенесён." : "Откройте документ и поставьте курсор в место вставки.");
  ui.message.classList.toggle("error", !!state.error);
}

async function persistLocal(overrides = {}) {
  state = { ...state, ...overrides };
  await chrome.storage.local.set({ job: state });
}

async function activeSupportedTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || "";
  const isGoogleDocs = /^https:\/\/docs\.google\.com\/document\//i.test(url);
  const isWordOnline = /^https:\/\/word\.cloud\.microsoft\//i.test(url) ||
    /^https:\/\/([^/]+\.)?(office\.com|microsoft365\.com|officeapps\.live\.com|sharepoint\.com)\//i.test(url) ||
    /^https:\/\/onedrive\.live\.com\//i.test(url);
  if (!tab?.id || (!isGoogleDocs && !isWordOnline)) {
    throw new Error("Откройте Google Docs или Word Online и повторите попытку.");
  }
  return tab;
}

async function command(command) {
  try {
    const tab = await activeSupportedTab();
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const isGoogleDocs = /^https:\/\/docs\.google\.com\/document\//i.test(tab.url || "");
    if (!isGoogleDocs) {
      const frameScore = (frame) => {
        if (/officeapps\.live\.com|word-edit|wordeditor/i.test(frame.url || "")) return 0;
        if (frame.frameId !== 0) return 1;
        return 2;
      };
      frames.sort((a, b) => frameScore(a) - frameScore(b));
    }
    if (controlFrameId !== null) {
      const preferred = frames.find((frame) => frame.frameId === controlFrameId);
      if (preferred && (isGoogleDocs || preferred.frameId !== 0)) {
        frames.splice(frames.indexOf(preferred), 1);
        frames.unshift(preferred);
      }
    }
    let response = null;
    let lastError = "Редактор документа не найден на странице.";
    for (const frame of frames) {
      try {
        const candidate = await chrome.tabs.sendMessage(tab.id, {
          type: "AUTOTYPE_COMMAND", command, text: ui.text.value,
          speed: Number(ui.speed.value), index: state.index
        }, { frameId: frame.frameId });
        if (candidate?.ok) {
          response = candidate;
          controlFrameId = frame.frameId;
          await chrome.storage.local.set({ controlFrameId });
          break;
        }
        if (candidate?.error) lastError = candidate.error;
      } catch (_) {}
    }
    if (!response?.ok) throw new Error(lastError);
    if (response.state) render(response.state);
  } catch (error) {
    state.error = error.message.includes("Receiving end")
      ? "Обновите вкладку документа после установки расширения и повторите попытку."
      : error.message;
    render();
  }
}

ui.text.addEventListener("input", () => {
  clearTimeout(saveTimer);
  state.text = ui.text.value;
  if (state.index > state.text.length) state.index = 0;
  render();
  saveTimer = setTimeout(() => persistLocal({ text: ui.text.value }), 250);
});
ui.speed.addEventListener("input", () => {
  state.speed = Number(ui.speed.value); render();
  persistLocal({ speed: state.speed });
  if (state.status === "running") command("sync");
});
ui.start.addEventListener("click", async () => {
  if (!ui.text.value) return;
  await persistLocal({ text: ui.text.value, speed: Number(ui.speed.value), index: 0, status: "idle", error: "" });
  command("start");
});
ui.pause.addEventListener("click", () => command("pause"));
ui.resume.addEventListener("click", () => command("resume"));
ui.stop.addEventListener("click", () => command("stop"));
ui.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.text.slice(state.index));
    ui.message.textContent = "Оставшийся текст скопирован. Поставьте курсор в документ и нажмите Ctrl+V.";
    ui.message.classList.remove("error");
  } catch (_) {
    ui.message.textContent = "Не удалось открыть буфер обмена. Выделите оставшийся текст вручную.";
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "AUTOTYPE_UPDATE") render(message.state);
});

(async () => {
  const saved = await chrome.storage.local.get(["job", "controlFrameId"]);
  if (saved.job) state = saved.job;
  if (Number.isInteger(saved.controlFrameId)) controlFrameId = saved.controlFrameId;
  ui.text.value = state.text || "";
  render();
})();
