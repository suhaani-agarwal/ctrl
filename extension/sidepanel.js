// sidepanel.js
let apiKey = "";
let isListening = false;
let currentAgentTurnText = "";
let lastDomNodes = [];

// Agentic loop state
let loopRunning = false;
let loopAborted = false;
let currentLoopId = 0;
let pendingUserInterrupt = null;
let taskAutoApproved = false;
const MAX_ROUNDS = 15;
const SETTLE_MS = 150;
const NAVIGATE_SETTLE_MS = 1200;
const MAX_DOM_NODES = 100;
const SENSITIVE_ACTIONS = new Set(["navigate", "fill", "keypress", "select"]);

// Audio playback
let playbackContext = null;
let nextStartTime = 0;

// Prevents task completion speech from re-triggering the agentic loop
let awaitingTaskDoneResponse = false;

// Accumulates user speech transcription chunks
let userTranscriptBuffer = "";

// UI
const transcript         = document.getElementById("transcript");
const statusText         = document.getElementById("status-text");
const micBtn             = document.getElementById("mic-btn");
const settingsToggle     = document.getElementById("settings-toggle");
const settingsPanel      = document.getElementById("settings-panel");
const apiKeyInput        = document.getElementById("api-key");
const screenshotIndicator = document.getElementById("screenshot-indicator");
const screenshotThumb    = document.getElementById("screenshot-thumb");
const actionBadges       = document.getElementById("action-badges");
const detailsToggle      = document.getElementById("details-toggle");
const detailsBody        = document.getElementById("details-body");
const pagePreview        = document.getElementById("page-preview");

// ---- Init ----
chrome.storage.sync.get(["gemini_api_key"], (result) => {
  if (result.gemini_api_key) {
    apiKey = result.gemini_api_key;
    apiKeyInput.value = apiKey;
    statusText.innerText = "Connecting...";
    chrome.runtime.sendMessage({ type: "CONNECT_WEBSOCKET", apiKey });
  } else {
    settingsPanel.classList.remove("hidden");
    statusText.innerText = "Enter your API key to start";
  }
});

settingsToggle.onclick = () => settingsPanel.classList.toggle("hidden");

detailsToggle.onclick = () => {
  const open = detailsBody.classList.toggle("hidden");
  detailsToggle.textContent = open ? "Details ▸" : "Details ▾";
  if (!open) detailsBody.scrollTop = detailsBody.scrollHeight;
};

screenshotThumb?.addEventListener("click", () => {
  screenshotThumb.classList.toggle("expanded");
});

apiKeyInput.onchange = (e) => {
  apiKey = e.target.value.trim();
  if (!apiKey) return;
  chrome.storage.sync.set({ gemini_api_key: apiKey });
  statusText.innerText = "Connecting...";
  chrome.runtime.sendMessage({ type: "CONNECT_WEBSOCKET", apiKey });
};

// ---- Messages from background ----
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "WEBSOCKET_CONNECTED") {
    statusText.innerText = "Ready — press mic to talk";
  }
  if (message.type === "STATUS") {
    statusText.innerText = message.status === "reconnecting" ? "Reconnecting..." : "Disconnected";
  }
  if (message.type === "MIC_READY") {
    isListening = true;
    micBtn.classList.add("listening");
    statusText.innerText = "Listening...";
  }
  if (message.type === "MIC_ERROR") {
    isListening = false;
    micBtn.classList.remove("listening");
    statusText.innerText = "Mic error: " + message.error;
  }
  if (message.type === "MIC_CHUNK_SENT") {
    // small visual pulse
  }
  if (message.type === "SERVER_MESSAGE") {
    try { handleServerMessage(JSON.parse(message.data)); } catch (e) {}
  }
});

// ---- Mic button ----
micBtn.onclick = async () => {
  // Init playback context on first gesture
  if (!playbackContext) {
    playbackContext = new AudioContext({ sampleRate: 24000 });
  }
  if (playbackContext.state === "suspended") await playbackContext.resume();

  // Cancel any running agentic loop
  if (loopRunning) {
    loopAborted = true;
    currentLoopId++;
    updateTranscript("System", "Cancelling current task...");
  }

  if (isListening) {
    isListening = false;
    micBtn.classList.remove("listening");
    statusText.innerText = "Ready";
    chrome.runtime.sendMessage({ type: "STOP_MIC" });
    return;
  }

  // Start mic — Flash handles page context, no need to send DOM/screenshot to Live
  statusText.innerText = "Starting mic...";
  chrome.runtime.sendMessage({ type: "START_MIC" });
};

// ---- Server message handler ----
function handleServerMessage(msg) {
  if (msg.setupComplete) {
    statusText.innerText = "Ready — press mic to talk";
    return;
  }
  if (msg.error) {
    statusText.innerText = "Error: " + (msg.error.message || JSON.stringify(msg.error));
    return;
  }
  if (msg.serverContent) {
    // User speech transcription — accumulate for intent detection
    if (msg.serverContent.inputTranscription) {
      const t = msg.serverContent.inputTranscription;
      if (t.text) {
        userTranscriptBuffer += t.text;
        updateTranscript("You", userTranscriptBuffer);
      }
    }

    // Gemini speech transcription — display in transcript
    if (msg.serverContent.outputTranscription) {
      const t = msg.serverContent.outputTranscription;
      if (t.text) {
        currentAgentTurnText += t.text;
        updateTranscript("Agent", currentAgentTurnText);
      }
    }

    const turn = msg.serverContent.modelTurn;
    if (turn?.parts) {
      for (const part of turn.parts) {
        console.log("SP: part keys", Object.keys(part));
        if (part.text) {
          currentAgentTurnText += part.text;
          updateTranscript("Agent", currentAgentTurnText);
        }
        const blob = part.inlineData || part.inline_data;
        if (blob?.mimeType?.includes("audio") || blob?.mime_type?.includes("audio")) {
          queueAudio(blob.data);
        }
      }
    }

    if (msg.serverContent.turnComplete) {
      const intentText = (userTranscriptBuffer || currentAgentTurnText).trim();
      userTranscriptBuffer = "";
      currentAgentTurnText = "";

      // Ignore Gemini's vocal response to [TASK_DONE] — don't re-trigger loop
      if (awaitingTaskDoneResponse) {
        awaitingTaskDoneResponse = false;
        if (!loopRunning) statusText.innerText = isListening ? "Listening..." : "Ready";
        return;
      }

      if (intentText) {
        if (loopRunning) {
          const lower = intentText.toLowerCase();
          if (lower.includes("stop") || lower.includes("cancel") || lower.includes("never mind")) {
            loopAborted = true;
            currentLoopId++;
            updateTranscript("System", "Stopping task.");
          } else {
            pendingUserInterrupt = intentText;
            updateTranscript("System", "Updating task...");
          }
        } else if (hasActionableIntent(intentText)) {
          runAgenticLoop(intentText);
        }
      }
      if (!loopRunning) {
        statusText.innerText = isListening ? "Listening..." : "Ready";
      }
    }
    if (msg.serverContent.interrupted) {
      stopPlayback();
      currentAgentTurnText = "";
      userTranscriptBuffer = "";
    }
  }
}

// ---- Intent detection ----
function hasActionableIntent(text) {
  const actionWords = [
    "click", "navigate", "go to", "open", "scroll", "type", "search",
    "fill", "press", "select", "submit", "play", "pause", "like",
    "subscribe", "watch", "create", "make", "write", "delete", "close",
    "new", "sign in", "log in", "download", "upload", "send", "reply",
    "got it", "sure", "i'll", "heading to", "searching", "navigating",
    "opening", "clicking", "i will", "let me", "going to"
  ];
  const lower = text.toLowerCase();
  return actionWords.some(w => lower.includes(w));
}

// ---- Agentic Loop ----
async function runAgenticLoop(intentText) {
  if (loopRunning) return;
  loopRunning = true;
  loopAborted = false;
  taskAutoApproved = false;
  pendingUserInterrupt = null;
  const loopId = ++currentLoopId;
  const actionHistory = [];

  // Reset per-task UI
  if (actionBadges) actionBadges.innerHTML = "";
  if (screenshotThumb) { screenshotThumb.src = ""; screenshotThumb.classList.remove("expanded"); }
  if (pagePreview) pagePreview.classList.add("hidden");

  statusText.innerText = "Planning actions...";
  updateTranscript("System", "Task: " + intentText.slice(0, 120));

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Check abort
      if (loopAborted || loopId !== currentLoopId) {
        updateTranscript("System", "Task cancelled.");
        break;
      }

      // Check for user interrupt — update intent
      if (pendingUserInterrupt) {
        intentText = pendingUserInterrupt;
        pendingUserInterrupt = null;
        updateTranscript("System", "New task: " + intentText.slice(0, 120));
      }

      // 1. Capture current page state
      statusText.innerText = `Round ${round + 1}: Reading page...`;
      const [preview, shot] = await Promise.all([
        msgBg({ type: "GET_DOM_PREVIEW", maxNodes: MAX_DOM_NODES }),
        msgBg({ type: "CAPTURE_SCREEN" })
      ]);
      if (preview?.nodes) lastDomNodes = preview.nodes;

      // Show live screenshot thumbnail
      if (shot?.success && shot.data && screenshotThumb) {
        screenshotThumb.src = "data:image/jpeg;base64," + shot.data;
        pagePreview?.classList.remove("hidden");
      }

      // 2. Build prompt and call Flash
      statusText.innerText = `Round ${round + 1}: Planning...`;
      const parts = buildFlashPrompt(intentText, preview, shot, actionHistory);
      const result = await msgBg({ type: "CALL_FLASH", parts });

      if (!result?.success || !result.data) {
        console.error("Flash call failed:", result?.error);
        if (round < MAX_ROUNDS - 1) {
          await delay(1000);
          continue;
        }
        updateTranscript("System", "Planning failed: " + (result?.error || "unknown"));
        break;
      }

      const plan = result.data;
      console.log(`Round ${round + 1}:`, plan);

      // 3. Check if done
      if (plan.done || (plan.actions.length === 1 && plan.actions[0].action === "done")) {
        const summary = buildCompletionSummary(intentText, actionHistory, plan.thought);
        updateTranscript("System", "Complete: " + (plan.thought || "Done"));
        awaitingTaskDoneResponse = true;
        msgBg({ type: "SPEAK_TO_GEMINI_LIVE", text: `[TASK_DONE] ${summary}` });
        break;
      }

      // 4. Execute each action in the batch
      let hadScreenChange = false;
      for (const step of plan.actions) {
        if (loopAborted || loopId !== currentLoopId) break;

        if (step.action === "wait") {
          statusText.innerText = `Round ${round + 1}: Waiting for page...`;
          await delay(1500);
          continue;
        }
        if (step.action === "done") {
          break;
        }

        // Resolve N-index shorthand
        let sel = step.selector || null;
        if (sel) {
          const nMatch = sel.match(/^N(\d+)$/i);
          if (nMatch) {
            const node = lastDomNodes[parseInt(nMatch[1]) - 1];
            if (node?.selector) sel = node.selector;
          }
        }

        const desc = humanDesc(step.action, sel, step.value);
        statusText.innerText = desc;
        updateTranscript("Action", desc);

        // Permission: ask once per task, only for sensitive actions
        if (!taskAutoApproved) {
          taskAutoApproved = true;
          if (SENSITIVE_ACTIONS.has(step.action)) {
            const permission = await msgBg({ type: "SHOW_PERMISSION", description: desc });
            if (permission !== "GRANT") {
              updateTranscript("System", "Action denied. Stopping.");
              awaitingTaskDoneResponse = true;
              msgBg({ type: "SPEAK_TO_GEMINI_LIVE", text: "[TASK_DONE] The user denied the action, so I stopped." });
              loopAborted = true;
              break;
            }
          }
        }

        // Execute
        const execResult = await msgBg({
          type: "EXECUTE_ACTION",
          kind: step.action,
          selector: sel,
          value: step.value || null
        });

        console.log("Action result:", step.action, sel, execResult);

        // Record history
        actionHistory.push({
          step: actionHistory.length + 1,
          action: step.action,
          selector: sel,
          value: step.value,
          success: execResult?.success || false,
          error: execResult?.error || null
        });
        if (actionHistory.length > 5) actionHistory.shift();

        // Add action badge to UI
        addActionBadge(step.action, execResult?.success !== false);

        // Determine if this action changes the screen
        const isScreenChange = ["navigate", "click"].includes(step.action);
        if (isScreenChange) hadScreenChange = true;

        // Settle: smart wait after navigation, short delay otherwise
        if (isScreenChange) {
          await delay(600);
          const readyCheck = await msgBg({ type: "READY_CHECK" });
          if (!readyCheck?.ready) await delay(600);
        } else {
          await delay(20);
        }
      }

      // Abort check after batch
      if (loopAborted || loopId !== currentLoopId) {
        updateTranscript("System", "Task cancelled.");
        break;
      }

      // Wait for page to settle after batch
      if (!hadScreenChange) {
        await delay(SETTLE_MS);
      }
    }
  } catch (e) {
    console.error("Agentic loop error:", e);
    updateTranscript("System", "Error: " + e.message);
  } finally {
    loopRunning = false;
    taskAutoApproved = false;
    statusText.innerText = isListening ? "Listening..." : "Ready";
  }
}

// ---- Flash prompt builder ----
function buildFlashPrompt(intent, preview, screenshot, history) {
  const parts = [];
  let text = `You are a browser automation agent. You receive the user's task, the current page state, and action history. Return a batch of actions to perform on the CURRENT page.

TASK: "${intent.slice(0, 400)}"

`;

  if (history.length > 0) {
    text += "RECENT ACTIONS:\n";
    for (const h of history) {
      text += `- Step ${h.step}: ${h.action}`;
      if (h.selector) text += ` on "${h.selector}"`;
      if (h.value) text += ` value="${h.value}"`;
      text += h.success ? " [OK]" : ` [FAILED: ${h.error}]`;
      text += "\n";
    }
    text += "\n";
  }

  if (preview?.nodes?.length) {
    const lines = preview.nodes.slice(0, MAX_DOM_NODES).map((n, i) => {
      const bits = [`N${i + 1}`];
      if (n.tag) bits.push(n.tag);
      if (n.role) bits.push(`role=${n.role}`);
      if (n.ariaLabel) bits.push(`label="${n.ariaLabel.slice(0, 50)}"`);
      if (n.text && n.text !== n.ariaLabel) bits.push(`text="${n.text.slice(0, 40)}"`);
      if (n.href) bits.push(`href=${n.href.slice(0, 50)}`);
      if (n.placeholder) bits.push(`ph="${n.placeholder}"`);
      if (n.type) bits.push(`type=${n.type}`);
      bits.push(`sel="${n.selector}"`);
      return bits.join(" | ");
    });
    text += `PAGE: ${preview.title}\nURL: ${preview.url}\nScroll: ${preview.scrollY}/${preview.pageHeight}\n`;
    text += "DOM ELEMENTS:\n" + lines.join("\n") + "\n\n";
  }

  text += `RULES:
- Return multiple actions that work on the CURRENT page state
- If an action will change the page (navigate, form submit, click a link), make it the LAST action in the batch
- selector MUST be copied EXACTLY from the DOM ELEMENTS list above (the sel= value)
- Use "navigate" to go to a new URL
- Use "keypress" with value "Enter", "Tab", "Escape", etc. for keyboard actions
- Use "select" with selector and value for dropdown options
- Use "hover" to trigger hover menus
- Set done=true when the task is fully complete or you cannot proceed
- If an action failed, try a different selector or approach
- Be efficient — batch as many actions as possible for the current page`;

  parts.push({ text });

  if (screenshot?.success && screenshot.data) {
    parts.push({ inlineData: { mimeType: "image/jpeg", data: screenshot.data } });
  }

  return parts;
}

// ---- Helpers ----
function humanDesc(kind, selector, value) {
  switch (kind) {
    case "click":    return `Click "${selector}"`;
    case "fill":     return `Type "${value}" into "${selector}"`;
    case "scroll":   return `Scroll by ${value}px`;
    case "scrollto":
    case "scrollTo": return `Scroll to "${selector}"`;
    case "navigate": return `Navigate to ${value}`;
    case "keypress": return `Press ${value}`;
    case "select":   return `Select "${value}" in "${selector}"`;
    case "hover":    return `Hover over "${selector}"`;
    case "wait":     return "Waiting...";
    default:         return `${kind} on ${selector}`;
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Transcript ----
function updateTranscript(role, text) {
  // Route internal status messages to the details section, not the main transcript
  const isInternal = role === "Action" || role === "System";
  const target = isInternal ? detailsBody : transcript;

  const last = target?.lastElementChild;
  if (last?.dataset.role === role && (role === "Agent" || role === "You")) {
    last.innerText = text;
  } else {
    const b = document.createElement("div");
    b.className = `bubble ${role.toLowerCase()}`;
    b.dataset.role = role;
    b.innerText = isInternal ? `${role}: ${text}` : text;
    target?.appendChild(b);
  }

  if (isInternal) {
    detailsBody?.scrollTo({ top: detailsBody.scrollHeight });
  } else {
    transcript.scrollTop = transcript.scrollHeight;
  }
}

// ---- Audio playback ----
function queueAudio(base64) {
  if (!playbackContext) return;
  statusText.innerText = "Speaking...";
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const f32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;
  const buf = playbackContext.createBuffer(1, f32.length, 24000);
  buf.getChannelData(0).set(f32);
  const src = playbackContext.createBufferSource();
  src.buffer = buf;
  src.connect(playbackContext.destination);
  const now = playbackContext.currentTime;
  if (nextStartTime < now) nextStartTime = now;
  src.start(nextStartTime);
  nextStartTime += buf.duration;
}

function stopPlayback() {
  if (playbackContext) nextStartTime = playbackContext.currentTime;
}

// ---- Action badge ----
function addActionBadge(action, success) {
  if (!actionBadges) return;
  const icons = {
    navigate: "↗", click: "↖", fill: "✏", scroll: "↕",
    keypress: "⌨", select: "▾", hover: "◎", scrollTo: "⤵", scrollto: "⤵"
  };
  const badge = document.createElement("span");
  badge.className = "action-badge" + (success ? "" : " failed");
  badge.textContent = (icons[action] || "•") + " " + action;
  actionBadges.appendChild(badge);
  // Keep only last 10 badges visible
  while (actionBadges.children.length > 10) actionBadges.removeChild(actionBadges.firstChild);
}

// ---- Completion summary for voice ----
function buildCompletionSummary(intentText, actionHistory, planThought) {
  if (planThought) return planThought;
  const actions = actionHistory.map(h => {
    if (h.action === "navigate") return `navigated to ${(h.value || "").slice(0, 60)}`;
    if (h.action === "fill") return `typed "${(h.value || "").slice(0, 40)}"`;
    if (h.action === "click") return `clicked on an element`;
    if (h.action === "keypress") return `pressed ${h.value}`;
    if (h.action === "scroll") return `scrolled`;
    return null;
  }).filter(Boolean);
  if (actions.length > 0) return `Task complete. I ${actions.slice(-3).join(", then ")}.`;
  return `Task complete: ${intentText.slice(0, 100)}`;
}

// ---- Helper: send message to background and await response ----
function msgBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp);
    });
  });
}
