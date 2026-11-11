(() => {
  if (window.__autoTypeForDocsLoaded) return;
  window.__autoTypeForDocsLoaded = true;

  let job = { text: "", speed: 120, index: 0, status: "idle", error: "" };
  let timer = null;
  let target = null;

  const isGoogleDocsInputFrame = () => {
    try {
      return window.frameElement?.classList?.contains("docs-texteventtarget-iframe") ||
        window.frameElement?.getAttribute?.("aria-label")?.toLowerCase().includes("editing");
    } catch (_) {
      return false;
    }
  };

  const isTextControl = (el) => !!el && (
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && /^(text|search|url|email|tel|password)$/i.test(el.type))
  );

  const isEditable = (el) => !!el && (
    isTextControl(el) ||
    el.isContentEditable ||
    el.getAttribute?.("role") === "textbox" ||
    (el === el.ownerDocument?.body && (
      el.ownerDocument.designMode === "on" ||
      isGoogleDocsInputFrame() ||
      el.ownerDocument !== document
    ))
  );

  function findGoogleDocsEditor() {
    const iframe = document.querySelector?.(".docs-texteventtarget-iframe");
    try {
      const editorDocument = iframe?.contentDocument;
      return editorDocument?.querySelector?.('[contenteditable="true"], [role="textbox"], textarea') ||
        editorDocument?.body || null;
    } catch (_) {
      return null;
    }
  }

  function findEditor() {
    const googleDocsEditor = findGoogleDocsEditor();
    if (googleDocsEditor) return googleDocsEditor;

    const active = document.activeElement;
    if (isEditable(active)) return active;
    const selection = document.getSelection();
    const anchor = selection?.anchorNode;
    const candidate = anchor && (anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement);
    const editable = candidate?.closest?.('[contenteditable="true"], textarea, input, [role="textbox"]');
    if (isEditable(editable)) return editable;

    const fallback = document.querySelector(
      'textarea.docs-texteventtarget, textarea[aria-label*="document" i], [contenteditable="true"], [role="textbox"]'
    );
    if (isEditable(fallback)) return fallback;
    if (isGoogleDocsInputFrame() && document.body) return document.body;
    return null;
  }

  async function publish() {
    try { await chrome.runtime.sendMessage({ type: "AUTOTYPE_STATE", state: job }); } catch (_) {}
  }

  function insertIntoTextControl(el, value) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(value, start, end, "end");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return el.value.slice(start, start + value.length) === value;
  }

  function insertIntoGoogleDocs(el, value) {
    const editorDocument = el.ownerDocument;
    const editorWindow = editorDocument?.defaultView;
    if (!editorDocument || !editorWindow) return false;

    try {
      editorWindow.focus();
      el.focus();
      let dataTransfer;
      try {
        dataTransfer = new editorWindow.DataTransfer();
        dataTransfer.setData("text/plain", value);
      } catch (_) {}
      const event = new editorWindow.InputEvent("beforeinput", {
        inputType: "insertReplacementText",
        data: value,
        dataTransfer,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      el.dispatchEvent(event);
      return true;
    } catch (_) {
      try {
        return editorDocument.execCommand("insertText", false, value);
      } catch (_) {
        return false;
      }
    }
  }

  function insertCharacter(char) {
    target.focus({ preventScroll: true });
    if (isTextControl(target)) {
      return insertIntoTextControl(target, char);
    }
    if (location.hostname === "docs.google.com" || target.ownerDocument !== document || isGoogleDocsInputFrame()) {
      return insertIntoGoogleDocs(target, char);
    }
    const targetDocument = target.ownerDocument || document;
    const command = char === "\n" ? "insertParagraph" : "insertText";
    const data = char === "\n" ? null : char;
    try {
      if (targetDocument.execCommand(command, false, data)) return true;
    } catch (_) {}
    try {
      const TargetInputEvent = targetDocument.defaultView?.InputEvent || InputEvent;
      const before = new TargetInputEvent("beforeinput", {
        bubbles: true, cancelable: true,
        inputType: char === "\n" ? "insertParagraph" : "insertText",
        data: char === "\n" ? null : char
      });
      return target.dispatchEvent(before) === false;
    } catch (_) { return false; }
  }

  function schedule() {
    clearTimeout(timer);
    if (job.status !== "running") return;
    timer = setTimeout(step, Math.max(200, Math.round(60000 / job.speed)));
  }

  async function fail(message) {
    clearTimeout(timer);
    job.status = "error";
    job.error = message;
    await publish();
  }

  async function step() {
    if (job.status !== "running") return;
    if (!target?.isConnected || !isEditable(target)) {
      await fail("Фокус редактора потерян. Нажмите в документе и выберите «Продолжить».");
      return;
    }
    if (job.index >= job.text.length) {
      job.status = "completed";
      job.error = "";
      await publish();
      return;
    }
    if (!insertCharacter(job.text[job.index])) {
      await fail("Редактор заблокировал программный ввод. Скопируйте оставшийся текст и вставьте его вручную через Ctrl+V.");
      return;
    }
    job.index += 1;
    job.error = "";
    await publish();
    schedule();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "AUTOTYPE_COMMAND") return false;
    (async () => {
      const command = message.command;
      if (command === "start") {
        target = findEditor();
        if (!target) return sendResponse({ ok: false, error: "Сначала щёлкните в области документа, затем снова нажмите «Старт»." });
        job = { text: message.text, speed: message.speed, index: 0, status: "running", error: "" };
        await publish(); schedule();
      } else if (command === "pause") {
        clearTimeout(timer); job.status = "paused"; await publish();
      } else if (command === "resume") {
        target = findEditor() || target;
        if (!target?.isConnected) return sendResponse({ ok: false, error: "Поставьте курсор в документ перед продолжением." });
        job.text = message.text; job.speed = message.speed; job.index = Math.min(message.index ?? job.index, job.text.length); job.status = "running"; job.error = "";
        await publish(); schedule();
      } else if (command === "stop") {
        clearTimeout(timer); job.status = "stopped"; job.error = ""; await publish();
      } else if (command === "sync") {
        job.speed = message.speed; await publish(); if (job.status === "running") schedule();
      }
      sendResponse({ ok: true, state: job });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
