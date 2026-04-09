// sidepanel.js — UI controller and event handler.
// All intelligence lives in background.js. This file only renders state.

// ---- State ----
let geminiKey = "";
let groqKey = "";
let openRouterKey = "";
let isListening = false;
let isRecording = false;
let recordingSteps = [];
let playbackContext = null;
let nextStartTime = 0;
let currentAgentText = "";

// ---- DOM refs ----
const micBtn = document.getElementById("mic-btn");
const abortBtn = document.getElementById("abort-btn");
const fieldQuestionPanel = document.getElementById("field-question-panel");
const fieldQuestionText = document.getElementById("field-question-text");
const fieldAnswerInput = document.getElementById("field-answer-input");
const fieldAnswerSend = document.getElementById("field-answer-send");
const statusBadge = document.getElementById("status-badge");
const robotWrap   = document.getElementById("robot-wrap");
const taskCard = document.getElementById("task-card");
const taskText = document.getElementById("task-text");
const skillBadge = document.getElementById("skill-badge");
const stepCounter = document.getElementById("step-counter");
const tabBadges = document.getElementById("tab-badges");
const bgTasksWrap = document.getElementById("bg-tasks-wrap");
const bgTasksList = document.getElementById("bg-tasks-list");
const transcript = document.getElementById("transcript");
const actionLog = document.getElementById("action-log");
const settingsBtn = document.getElementById("settings-btn");
const settingsDrawer = document.getElementById("settings-drawer");
const recordBtn = document.getElementById("record-btn");
const recordingBanner = document.getElementById("recording-banner");
const geminiKeyInput = document.getElementById("gemini-key");
const groqKeyInput = document.getElementById("groq-key");
const openRouterKeyInput = document.getElementById("openrouter-key");
const permissionMode = document.getElementById("permission-mode");
const skillsList = document.getElementById("skills-list");
const skillUrlInput = document.getElementById("skill-url");
const installSkillBtn = document.getElementById("install-skill-btn");
const installStatus = document.getElementById("install-status");
const workflowsList = document.getElementById("workflows-list");

// ---- Init ----
chrome.storage.local.get(["gemini_key", "groq_key", "openrouter_key", "permission_mode"], (res) => {
  geminiKey = res.gemini_key || "";
  groqKey = res.groq_key || "";
  openRouterKey = res.openrouter_key || "";

  if (geminiKeyInput) geminiKeyInput.value = geminiKey;
  if (groqKeyInput) groqKeyInput.value = groqKey;
  if (openRouterKeyInput) openRouterKeyInput.value = openRouterKey;
  if (permissionMode && res.permission_mode) permissionMode.value = res.permission_mode;

  if (groqKey) chrome.runtime.sendMessage({ type: "SET_GROQ_KEY", apiKey: groqKey });
  if (openRouterKey) chrome.runtime.sendMessage({ type: "SET_OPENROUTER_KEY", apiKey: openRouterKey });

  if (!geminiKey || !groqKey || !openRouterKey) {
    settingsDrawer.classList.remove("hidden");
  }

  loadSkillsList();
  loadWorkflowsList();
  loadBgTasks();
});

// ---- Settings ----
const settingsCloseBtn = document.getElementById("settings-close-btn");
settingsBtn.onclick = () => {
  settingsDrawer.classList.toggle("hidden");
  if (!settingsDrawer.classList.contains("hidden")) loadProfileList();
};
if (settingsCloseBtn) settingsCloseBtn.onclick = () => settingsDrawer.classList.add("hidden");

// ---- Profile memory list ----
const profileList = document.getElementById("profile-list");
const profileEmptyHint = document.getElementById("profile-empty-hint");

function loadProfileList() {
  chrome.storage.local.get("user_profile", (res) => {
    const profile = res.user_profile || {};
    const entries = Object.entries(profile);
    profileList.innerHTML = "";
    if (entries.length === 0) {
      profileEmptyHint.classList.remove("hidden");
      return;
    }
    profileEmptyHint.classList.add("hidden");
    for (const [key, value] of entries) {
      const label = key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const item = document.createElement("div");
      item.className = "profile-item";
      item.innerHTML = `
        <span class="profile-item-key">${label}</span>
        <span class="profile-item-value" title="${String(value)}">${String(value)}</span>
        <button class="profile-item-del" title="Delete">✕</button>
      `;
      item.querySelector(".profile-item-del").onclick = () => {
        chrome.storage.local.get("user_profile", (r) => {
          const p = r.user_profile || {};
          delete p[key];
          chrome.storage.local.set({ user_profile: p }, () => loadProfileList());
        });
      };
      profileList.appendChild(item);
    }
  });
}

geminiKeyInput?.addEventListener("change", (e) => {
  geminiKey = e.target.value.trim();
  chrome.storage.local.set({ gemini_key: geminiKey });
  if (geminiKey) chrome.runtime.sendMessage({ type: "CONNECT_WEBSOCKET", apiKey: geminiKey });
});

groqKeyInput?.addEventListener("change", (e) => {
  groqKey = e.target.value.trim();
  chrome.storage.local.set({ groq_key: groqKey });
  if (groqKey) chrome.runtime.sendMessage({ type: "SET_GROQ_KEY", apiKey: groqKey });
});

openRouterKeyInput?.addEventListener("change", (e) => {
  openRouterKey = e.target.value.trim();
  chrome.storage.local.set({ openrouter_key: openRouterKey });
  if (openRouterKey) chrome.runtime.sendMessage({ type: "SET_OPENROUTER_KEY", apiKey: openRouterKey });
});

permissionMode?.addEventListener("change", (e) => {
  chrome.storage.local.set({ permission_mode: e.target.value });
});

installSkillBtn?.addEventListener("click", async () => {
  const url = skillUrlInput?.value.trim();
  if (!url) return;
  installStatus.textContent = "Installing...";
  const res = await msgBg({ type: "INSTALL_SKILL", url });
  if (res?.success) {
    installStatus.textContent = `Installed: ${res.name}`;
    skillUrlInput.value = "";
    loadSkillsList();
  } else {
    installStatus.textContent = `Error: ${res?.error || "unknown"}`;
  }
});

// ---- Mic button ----
micBtn.onclick = async () => {
  if (!playbackContext) {
    playbackContext = new AudioContext({ sampleRate: 24000 });
  }
  if (playbackContext.state === "suspended") await playbackContext.resume();

  if (isListening) {
    // Stop mic capture — but keep the WebSocket open so Gemini can still speak
    // (narrate task results, etc.). The WebSocket is a fresh session on next mic-on.
    isListening = false;
    micBtn.classList.remove("mic-on", "mic-listening");
    micBtn.classList.add("mic-off");
    setStatus("idle");
    await msgBg({ type: "STOP_MIC" });
    // Do NOT disconnect WebSocket here — Gemini needs it to narrate task updates.
  } else {
    // Start — always create a FRESH Gemini session (clears history → fast responses).
    if (!geminiKey || !groqKey) {
      settingsDrawer.classList.remove("hidden");
      appendTranscript("agent", "Please set both your Gemini and Groq API keys first.");
      return;
    }
    isListening = true; // set immediately so second click always goes to Stop branch
    micBtn.classList.remove("mic-off");
    micBtn.classList.add("mic-on");
    setStatus("listening");
    // Disconnect any existing session first, then create a fresh one.
    await msgBg({ type: "DISCONNECT_WEBSOCKET" });
    await msgBg({ type: "CONNECT_WEBSOCKET", apiKey: geminiKey });
    await msgBg({ type: "START_MIC" });
  }
};

// ---- Abort button ----
abortBtn.onclick = () => {
  msgBg({ type: "ABORT_TASK" });
  abortBtn.classList.add("hidden");
  taskCard.classList.add("hidden");
  hideFieldQuestion();
  setStatus("idle");
};

// ---- Field answer input ----
function showFieldQuestion(question, fieldKey, isSubjective) {
  fieldQuestionText.textContent = question;
  fieldAnswerInput.value = "";
  fieldAnswerInput.dataset.fieldKey = fieldKey || "";
  fieldQuestionPanel.classList.remove("hidden");
  fieldAnswerInput.focus();
  appendLog("❓", `Asking: ${question.slice(0, 80)}`, "thinking");
}

function hideFieldQuestion() {
  fieldQuestionPanel.classList.add("hidden");
  fieldAnswerInput.value = "";
}

function submitFieldAnswer() {
  const text = fieldAnswerInput.value.trim();
  if (!text) return;
  hideFieldQuestion();
  appendLog("💬", `You answered: ${text.slice(0, 60)}`, "");
  msgBg({ type: "FIELD_ANSWER_TEXT", text });
}

fieldAnswerSend.onclick = submitFieldAnswer;
fieldAnswerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitFieldAnswer();
});

// ---- Record button ----
recordBtn.onclick = () => {
  if (!isRecording) {
    isRecording = true;
    recordingSteps = [];
    recordBtn.classList.add("active");
    recordingBanner.classList.remove("hidden");
    appendLog("🔴", "Recording started", "recording");
  } else {
    stopRecording();
  }
};

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  recordBtn.classList.remove("active");
  recordingBanner.classList.add("hidden");
  if (recordingSteps.length > 0) {
    const name = `Workflow ${new Date().toLocaleDateString()}`;
    msgBg({ type: "SAVE_WORKFLOW", name, steps: recordingSteps });
    appendTranscript("agent", `Saved workflow "${name}" with ${recordingSteps.length} steps.`);
    loadWorkflowsList();
  }
}

// ---- Background message handler ----
chrome.runtime.onMessage.addListener((message) => {
  // Raw Gemini Live messages (audio + text)
  if (message.type === "SERVER_MESSAGE") {
    try { handleGeminiServerMessage(JSON.parse(message.data)); } catch { }
    return;
  }

  if (message.type === "WEBSOCKET_CONNECTED") {
    if (isListening) setStatus("listening");
    return;
  }

  if (message.type === "STATUS") {
    if (message.status === "error") {
      setStatus("error");
      appendTranscript("agent", `Connection error: ${message.message || "unknown"}`);
    }
    return;
  }

  if (message.type === "MIC_READY") {
    isListening = true;
    micBtn.classList.remove("mic-on");
    micBtn.classList.add("mic-listening");
    return;
  }

  if (message.type === "MIC_ERROR") {
    appendTranscript("agent", `Mic error: ${message.error}`);
    isListening = false;
    micBtn.classList.remove("mic-on", "mic-listening");
    micBtn.classList.add("mic-off");
    setStatus("error");
    return;
  }

  // Intent detected by Gemini Live — background already dispatched; just show transcript
  if (message.type === "INTENT_DETECTED") {
    appendTranscript("user", message.intentText);
    return;
  }

  // Workflow recording markers from Gemini Live
  if (message.type === "BG_TASKS_UPDATED") {
    loadBgTasks();
    return;
  }

  if (message.type === "RECORD_START") {
    isRecording = true;
    recordingSteps = [];
    recordBtn.classList.add("active");
    recordingBanner.classList.remove("hidden");
    appendLog("🔴", "Recording started (voice triggered)", "recording");
    return;
  }
  if (message.type === "RECORD_STOP") {
    stopRecording();
    return;
  }

  // Agent events from background
  if (message.type === "AGENT_EVENT") {
    handleAgentEvent(message.event);
    // Refresh bg tasks panel on task lifecycle events
    const ev = message.event;
    if (ev && (ev.type === "TASK_COMPLETE" || ev.type === "TASK_FAILED" || ev.type === "TASK_ABORTED" ||
               ev.type === "FIELD_QUESTION" || ev.type === "FIELD_ANSWERED" || ev.type === "TASK_DISPATCHED")) {
      loadBgTasks();
    }
    return;
  }
});

// ---- Agent event handler ----
function handleAgentEvent(event) {
  switch (event.type) {
    case "ORCHESTRATOR_START":
      setStatus("thinking");
      showTaskCard(event.intentText);
      abortBtn.classList.remove("hidden");
      appendLog("🧠", `Planning: ${event.intentText}`, "thinking");
      break;

    case "ORCHESTRATOR_DONE": {
      const { decision } = event;
      if (decision.skill) {
        skillBadge.textContent = decision.skill;
        skillBadge.classList.remove("hidden");
      }
      appendLog("🧠", `Skill: ${decision.skill || "none"} | Type: ${decision.taskType}`, "thinking");
      break;
    }

    case "TASK_DISPATCHED":
      setStatus("thinking");
      showTaskCard(event.intentText);
      abortBtn.classList.remove("hidden");
      break;

    case "SCREEN_ANALYZING":
      setStatus("thinking");
      appendLog("📸", "Analyzing screen...", "thinking");
      break;

    case "SCREEN_ANALYZED":
      appendLog("📸", `Screen: ${event.description}`, "");
      appendTranscript("agent", `👁 ${event.description}`);
      break;

    case "PLAN_ANNOUNCED":
      setStatus("listening");
      if (event.steps?.length) {
        stepCounter.textContent = `${event.steps.length} steps planned`;
        stepCounter.classList.remove("hidden");
      }
      appendLog("📋", event.planText, "thinking");
      appendTranscript("agent", `📋 ${event.planText}`);
      break;

    case "TASK_STARTED":
      setStatus("acting");
      if (event.tabs?.length) {
        tabBadges.innerHTML = event.tabs.map(t =>
          `<span class="tab-badge">${new URL(t.url).hostname}</span>`
        ).join("");
      }
      break;

    case "AGENT_START":
      setStatus("acting");
      appendLog("🔍", `Agent: ${event.goal}`, "");
      break;

    case "PERCEIVING":
      appendLog("🔍", `Perceiving page (round ${event.round})`, "");
      break;

    case "THINKING":
      appendLog("🧠", "Analyzing screenshot...", "thinking");
      break;

    case "THOUGHT":
      if (event.thought) {
        appendLog("💭", event.thought.slice(0, 120), "thinking");
      }
      break;

    case "EXECUTING": {
      const desc = describeAction(event.action, event.elementName);
      appendLog(actionIcon(event.action.type), desc, "");
      setStatus("acting");
      // Record step if recording
      if (isRecording && event.action.elementIndex) {
        recordingSteps.push({
          type: event.action.type,
          elementRole: event.elementRole,
          elementName: event.elementName,
          value: event.action.value,
          url: event.action.url
        });
      }
      break;
    }

    case "ACTION_DENIED":
      appendLog("🚫", `Denied: ${describeAction(event.action)}`, "failed");
      break;

    case "ACTION_VERIFIED":
      appendLog("✅", event.observation || "Action confirmed", "verified");
      break;

    case "ACTION_FAILED":
      appendLog("❌", event.observation || event.error || "Action failed", "failed");
      break;

    case "STEP_START":
      stepCounter.textContent = `Step ${event.step}/${event.total}`;
      stepCounter.classList.remove("hidden");
      appendLog("▶", `Step ${event.step}: ${event.desc}`, "");
      break;

    case "STEP_DONE":
      appendLog("✅", `Step ${event.step} complete`, "verified");
      break;

    case "FIELD_QUESTION":
      showFieldQuestion(event.question, event.fieldKey, event.isSubjective);
      appendTranscript("agent", `❓ ${event.question}`);
      break;

    case "FIELD_ANSWERED":
      hideFieldQuestion();
      if (event.answer) {
        appendLog("💬", `Field "${event.fieldKey}": ${event.answer.slice(0, 60)}`, "verified");
      } else if (event.timedOut) {
        appendLog("⏰", `No answer for "${event.fieldKey}" — skipping`, "failed");
      }
      break;

    case "FIELD_AUTO_FILLED":
      appendLog("🗃️", `Profile match for "${event.fieldKey}": ${event.value?.slice(0, 50)}`, "verified");
      break;

    case "DRAFTING_CONTENT":
      appendLog("✍️", `Drafting content for "${event.fieldKey}"...`, "thinking");
      break;

    case "AGENT_DONE":
      setStatus("listening");
      appendLog("✅", "Task complete", "verified");
      break;

    case "AGENT_ABORTED":
      appendLog("🔄", "Task aborted", "failed");
      resetTaskUI();
      break;

    case "TASK_COMPLETE":
      setStatus("listening");
      if (event.summary) appendTranscript("agent", event.summary, event.formatted);
      resetTaskUI();
      break;

    case "TASK_FAILED":
      setStatus("listening");
      appendLog("❌", event.error || "Task failed", "failed");
      resetTaskUI();
      break;

    case "TASK_ABORTED":
      resetTaskUI();
      appendLog("🔄", "Task cancelled", "");
      break;

    case "WORKFLOW_REPLAY_START":
      appendLog("▶", `Replaying: ${event.name}`, "");
      break;

    case "WORKFLOW_REPLAY_DONE":
      appendLog("✅", `Workflow complete: ${event.name}`, "verified");
      resetTaskUI();
      break;
  }
}

// ---- Gemini Live audio + text handler ----
function handleGeminiServerMessage(parsed) {
  const modelTurn = parsed?.serverContent?.modelTurn;
  if (!modelTurn?.parts) return;

  for (const part of modelTurn.parts) {
    // Audio
    if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
      queueAudio(part.inlineData.data);
    }
    // Text (spoken response)
    if (part.text) {
      // Strip out [INTENT: ...] and control markers — don't show them raw
      const clean = part.text
        .replace(/\[INTENT:[^\]]*\]/g, "")
        .replace(/\[RECORD_START\]/g, "")
        .replace(/\[RECORD_STOP\]/g, "")
        .replace(/\[TASK_DONE:[^\]]*\]/g, "")
        .replace(/\[TASK_FAILED:[^\]]*\]/g, "")
        .trim();
      if (clean) {
        currentAgentText += clean;
      }
    }
  }

  // Flush text on turn complete
  if (parsed?.serverContent?.turnComplete && currentAgentText.trim()) {
    appendTranscript("agent", currentAgentText.trim());
    currentAgentText = "";
  }
}

// ---- Audio playback ----
function queueAudio(b64) {
  if (!playbackContext) return;
  try {
    const raw = atob(b64);
    const buf = new Int16Array(raw.length / 2);
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (raw.charCodeAt(i * 2)) | (raw.charCodeAt(i * 2 + 1) << 8);
    }
    const float32 = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) float32[i] = buf[i] / 32768;

    const audioBuf = playbackContext.createBuffer(1, float32.length, 24000);
    audioBuf.getChannelData(0).set(float32);

    const source = playbackContext.createBufferSource();
    source.buffer = audioBuf;
    source.connect(playbackContext.destination);

    const now = playbackContext.currentTime;
    const start = Math.max(now, nextStartTime);
    source.start(start);
    nextStartTime = start + audioBuf.duration;
  } catch (e) {
    console.warn("Audio queue error", e);
  }
}

// ---- UI helpers ----
function setStatus(state) {
  statusBadge.className = `badge ${state}`;
  const labels = {
    idle: "Idle",
    listening: "Listening",
    thinking: "Thinking",
    acting: "Acting",
    error: "Error"
  };
  statusBadge.textContent = labels[state] || state;
  if (robotWrap) robotWrap.className = `state-${state}`;
}

function showTaskCard(text) {
  taskCard.classList.remove("hidden");
  taskText.textContent = text;
  skillBadge.classList.add("hidden");
  stepCounter.classList.add("hidden");
  tabBadges.innerHTML = "";
}

function resetTaskUI() {
  taskCard.classList.add("hidden");
  abortBtn.classList.add("hidden");
  setStatus(isListening ? "listening" : "idle");
}

function appendTranscript(role, text, formatted = false) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  if (formatted) {
    // Render **bold**, bullet points (•), and line breaks
    div.innerHTML = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  } else {
    div.textContent = text;
  }
  transcript.appendChild(div);
  transcript.scrollTop = transcript.scrollHeight;
}

const MAX_LOG_ENTRIES = 200;

function appendLog(icon, desc, type = "") {
  // Trim old entries
  while (actionLog.children.length >= MAX_LOG_ENTRIES) {
    actionLog.removeChild(actionLog.firstChild);
  }

  const entry = document.createElement("div");
  entry.className = `log-entry${type ? " " + type : ""}`;

  const iconEl = document.createElement("span");
  iconEl.className = "log-icon";
  iconEl.textContent = icon;

  const descEl = document.createElement("span");
  descEl.className = "log-desc";
  descEl.textContent = desc;

  const timeEl = document.createElement("span");
  timeEl.className = "log-time";
  timeEl.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  entry.append(iconEl, descEl, timeEl);
  actionLog.appendChild(entry);
  actionLog.scrollTop = actionLog.scrollHeight;
}

function actionIcon(type) {
  const icons = {
    click: "🖱️", type: "⌨️", scroll: "📜", navigate: "🌐",
    keypress: "⌨️", select: "🖱️", extract: "📋", wait: "⏳"
  };
  return icons[type] || "▶";
}

function describeAction(action, elementName) {
  if (!action) return "unknown action";
  switch (action.type) {
    case "click": return `Click "${elementName || `element ${action.elementIndex}`}"`;
    case "type": return `Type "${action.value?.slice(0, 40)}" into "${elementName || `element ${action.elementIndex}`}"`;
    case "scroll": return `Scroll ${action.direction || "down"} ${action.amount || 400}px`;
    case "navigate": return `Navigate to ${action.url}`;
    case "keypress": return `Press ${action.key}`;
    case "select": return `Select "${action.value}" in element ${action.elementIndex}`;
    case "extract": return `Extract: ${Object.keys(action.fields || {}).join(", ")}`;
    case "wait": return `Wait ${action.ms}ms`;
    case "dismiss_popup": return "Dismiss popup / press Escape";
    default: return action.type;
  }
}

// ---- Skills list ----
async function loadSkillsList() {
  if (!skillsList) return;
  const res = await msgBg({ type: "GET_SKILLS" });
  const skills = res?.skills || [];
  skillsList.innerHTML = skills.map(s =>
    `<div class="skill-item"><span class="skill-item-name">${s.name}</span><span class="skill-item-type">built-in</span></div>`
  ).join("") || "<span class='hint'>No skills loaded</span>";
}

// ---- Workflows list ----
async function loadWorkflowsList() {
  if (!workflowsList) return;
  const { workflows = {} } = await chrome.storage.local.get("workflows");
  const wfs = Object.values(workflows);
  workflowsList.innerHTML = wfs.map(w =>
    `<div class="workflow-item">
      <span class="workflow-item-name">${w.name}</span>
      <span class="workflow-item-date">${new Date(w.createdAt).toLocaleDateString()}</span>
    </div>`
  ).join("") || "<span class='hint'>No saved workflows</span>";
}

// ---- Background Tasks UI ----
async function loadBgTasks() {
  const res = await msgBg({ type: "GET_BG_TASKS" });
  const tasks = res?.tasks || [];
  renderBgTasks(tasks);
}

function renderBgTasks(tasks) {
  const active = tasks.filter(t => t.status === 'running' || t.status === 'awaiting_input' || t.status === 'pending');
  if (!bgTasksWrap || !bgTasksList) return;
  if (active.length === 0) {
    bgTasksWrap.classList.add("hidden");
    return;
  }
  bgTasksWrap.classList.remove("hidden");
  bgTasksList.innerHTML = "";
  for (const task of active) {
    const item = document.createElement("div");
    item.className = "bg-task-item";

    const statusLabel = { running: "⚙ running", awaiting_input: "❓ needs input", pending: "⏳ pending" }[task.status] || task.status;
    item.innerHTML = `
      <div class="bg-task-top">
        <span class="bg-task-text" title="${task.intentText}">${task.intentText.slice(0, 55)}</span>
        <span class="bg-task-status">${statusLabel}</span>
        <button class="bg-task-cancel" data-id="${task.taskId}">✕</button>
      </div>
      ${task.hasPendingQuestion ? `
        <div class="bg-task-question">❓ ${task.question}</div>
        <div class="bg-task-answer-row">
          <input type="text" class="bg-task-answer-input" placeholder="Type your answer…" data-id="${task.taskId}" data-key="${task.fieldKey}"/>
          <button class="bg-task-answer-send" data-id="${task.taskId}">Send</button>
        </div>
      ` : ""}
    `;

    item.querySelector(".bg-task-cancel").onclick = () => {
      msgBg({ type: "ABORT_BG_TASK", taskId: task.taskId });
      loadBgTasks();
    };

    if (task.hasPendingQuestion) {
      const input = item.querySelector(".bg-task-answer-input");
      const sendBtn = item.querySelector(".bg-task-answer-send");
      const submitAnswer = () => {
        const text = input.value.trim();
        if (!text) return;
        msgBg({ type: "BG_FIELD_ANSWER", taskId: task.taskId, text });
        appendLog("💬", `BG task answer: ${text.slice(0, 60)}`, "");
        loadBgTasks();
      };
      sendBtn.onclick = submitAnswer;
      input.addEventListener("keydown", e => { if (e.key === "Enter") submitAnswer(); });
    }

    bgTasksList.appendChild(item);
  }
}

// ---- Utility ----
function msgBg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(res));
    } catch {
      resolve(null);
    }
  });
}
