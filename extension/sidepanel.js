// sidepanel.js
let apiKey = "";
let isListening = false;
let currentAgentTurnText = "";
let lastDomNodes = [];

// Audio playback
let playbackContext = null;
let nextStartTime = 0;

// UI
const transcript    = document.getElementById("transcript");
const statusText    = document.getElementById("status-text");
const micBtn        = document.getElementById("mic-btn");
const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const apiKeyInput   = document.getElementById("api-key");
const screenshotIndicator = document.getElementById("screenshot-indicator");

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
    // small visual pulse — ignore errors
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

  if (isListening) {
    // Stop
    isListening = false;
    micBtn.classList.remove("listening");
    statusText.innerText = "Ready";
    chrome.runtime.sendMessage({ type: "STOP_MIC" });
    return;
  }

  // Send DOM preview + screenshot so agent can see AND understand the page
  statusText.innerText = "Reading page...";
  try {
    const [preview, shot] = await Promise.all([
      msgBg({ type: "GET_DOM_PREVIEW", maxNodes: 120 }),
      msgBg({ type: "CAPTURE_SCREEN" })
    ]);

    if (preview?.nodes?.length) {
      lastDomNodes = preview.nodes;
    }

    const parts = [];

    // Build DOM text summary
    if (preview?.nodes?.length) {
      const lines = preview.nodes.slice(0, 80).map((n, i) => {
        const bits = [`N${i+1}`];
        if (n.tag) bits.push(`tag=${n.tag}`);
        if (n.role) bits.push(`role=${n.role}`);
        if (n.ariaLabel) bits.push(`label="${n.ariaLabel}"`);
        if (n.text && n.text !== n.ariaLabel) bits.push(`text="${n.text.slice(0,60)}"`);
        if (n.href) bits.push(`href=${n.href.slice(0,60)}`);
        bits.push(`sel=${n.selector}`);
        return bits.join(" | ");
      });
      const domText =
        `Page: ${preview.title}\nURL: ${preview.url}\nScrollY: ${preview.scrollY}\n` +
        `DOM_PREVIEW (use these selectors for actions):\n` + lines.join("\n");
      parts.push({ text: domText });
    }

    // Add screenshot so agent can visually confirm what it sees
    if (shot?.success && shot.data) {
      parts.push({ inline_data: { mime_type: "image/jpeg", data: shot.data } });
      parts.push({ text: "^ This is a screenshot of the current page. Use the DOM_PREVIEW selectors above for actions." });
    }

    if (parts.length) {
      chrome.runtime.sendMessage({
        type: "SEND_TO_GEMINI",
        data: {
          clientContent: {
            turns: [{ role: "user", parts }],
            turnComplete: true
          }
        }
      });
    }
  } catch (e) { console.warn("Page context failed", e); }

  // Start mic
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
    const turn = msg.serverContent.modelTurn;
    if (turn?.parts) {
      for (const part of turn.parts) {
        if (part.text) {
          currentAgentTurnText += part.text;
          updateTranscript("Agent", currentAgentTurnText);
        }
        if (part.inline_data?.mime_type?.includes("audio")) {
          queueAudio(part.inline_data.data);
        }
      }
    }
    // Parse actions only on full turn — avoids broken partial chunk matches
    if (msg.serverContent.turnComplete) {
      console.log("Full agent turn:", currentAgentTurnText);
      if (currentAgentTurnText) parseAndExecuteActions(currentAgentTurnText);
      statusText.innerText = isListening ? "Listening..." : "Ready";
      currentAgentTurnText = "";
    }
    if (msg.serverContent.interrupted) {
      stopPlayback();
      currentAgentTurnText = "";
    }
  }
}

// ---- Action parsing ----
// Runs on the FULL turn text after turnComplete — avoids partial chunk failures
function parseAndExecuteActions(text) {
  console.log("Parsing actions from full turn:", text.slice(0, 300));

  // Strip markdown backticks Gemini sometimes wraps around actions
  const cleaned = text.replace(/`{1,3}/g, "");

  // Very permissive regex: handles spaces around colons, mixed case, etc.
  const re = /ACTION\s*:\s*([\w]+)\s*:\s*([^:\n\r]*?)\s*(?::\s*([^\n\r]*))?$/gim;
  let m;
  let found = 0;

  while ((m = re.exec(cleaned)) !== null) {
    const kind   = m[1].trim().toLowerCase();
    let selector = (m[2] || "").trim();
    const value  = (m[3] || "").trim() || null;

    // For scroll/navigate the selector field is empty — that's fine
    if (!selector || selector === "null") {
      if (kind !== "scroll" && kind !== "navigate") {
        console.warn("Skipping action — empty selector for kind:", kind);
        continue;
      }
      selector = null;
    }

    // Resolve N1/N2 index shorthand from DOM preview
    if (selector) {
      const idxMatch = selector.match(/^N(\d+)$/i);
      if (idxMatch) {
        const node = lastDomNodes[parseInt(idxMatch[1]) - 1];
        if (node?.selector) {
          console.log("Resolved", selector, "->", node.selector);
          selector = node.selector;
        }
      }
    }

    found++;
    console.log("ACTION found:", { kind, selector, value });
    runActionFlow(kind, selector, value, humanDesc(kind, selector, value));
  }

  if (found === 0) {
    console.log("No ACTION lines detected in agent response");
  }
}

function humanDesc(kind, selector, value) {
  switch (kind) {
    case "click":    return `click on "${selector}"`;
    case "fill":     return `type "${value}" into "${selector}"`;
    case "scroll":   return `scroll by ${value} pixels`;
    case "scrollto": return `scroll to "${selector}"`;
    case "navigate": return `navigate to ${value}`;
    default:         return `${kind} on ${selector}`;
  }
}

async function runActionFlow(kind, selector, value, desc) {
  statusText.innerText = "Waiting for permission...";

  const permission = await msgBg({ type: "SHOW_PERMISSION", description: desc });
  if (permission !== "GRANT") {
    chrome.runtime.sendMessage({
      type: "SEND_TO_GEMINI",
      data: { clientContent: { turns: [{ role: "user", parts: [{ text: "User denied that action." }] }], turnComplete: true } }
    });
    statusText.innerText = isListening ? "Listening..." : "Ready";
    return;
  }

  // Capture screenshot for context
  screenshotIndicator?.classList.add("active");
  const shot = await msgBg({ type: "CAPTURE_SCREEN" });
  if (shot?.success && shot.data) {
    chrome.runtime.sendMessage({
      type: "SEND_TO_GEMINI",
      data: {
        clientContent: {
          turns: [{ role: "user", parts: [
            { text: "Current page screenshot:" },
            { inline_data: { mime_type: "image/jpeg", data: shot.data } }
          ]}],
          turnComplete: true
        }
      }
    });
  }

  // Execute in browser
  const result = await msgBg({ type: "EXECUTE_ACTION", kind, selector, value });
  screenshotIndicator?.classList.remove("active");
  console.log("Action result:", result);

  const feedback = result?.success
    ? `Done: ${desc}`
    : `Failed to ${desc}. Error: ${result?.error}`;

  chrome.runtime.sendMessage({
    type: "SEND_TO_GEMINI",
    data: { clientContent: { turns: [{ role: "user", parts: [{ text: feedback }] }], turnComplete: true } }
  });

  statusText.innerText = isListening ? "Listening..." : "Ready";
}

// ---- Transcript ----
function updateTranscript(role, text) {
  const last = transcript.lastElementChild;
  if (last?.dataset.role === role && role === "Agent") {
    last.innerText = `${role}: ${text}`;
  } else {
    const b = document.createElement("div");
    b.className = `bubble ${role.toLowerCase()}`;
    b.dataset.role = role;
    b.innerText = `${role}: ${text}`;
    transcript.appendChild(b);
  }
  transcript.scrollTop = transcript.scrollHeight;
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

// ---- Helper: send message to background and await response ----
function msgBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp);
    });
  });
}