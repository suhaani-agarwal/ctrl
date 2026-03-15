let apiKey = "";
let isListening = false;

// Audio Playback State
let playbackContext = null;
let nextStartTime = 0;

// UI Elements
const transcript = document.getElementById("transcript");
const statusText = document.getElementById("status-text");
const micBtn = document.getElementById("mic-btn");
const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const apiKeyInput = document.getElementById("api-key");
const screenshotIndicator = document.getElementById("screenshot-indicator");
const micIndicator = document.getElementById("mic-indicator");

// Listen for messages from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "MIC_READY") {
    isListening = true;
    micBtn.classList.add("listening");
    statusText.innerText = "Listening";
  }
  if (message.type === "MIC_CHUNK_SENT") {
    // briefly flash mic indicator so user knows audio is being forwarded
    if (micIndicator) {
      micIndicator.style.background = '#ff5b5b';
      micIndicator.style.border = '1px solid #ff2b2b';
      setTimeout(() => {
        micIndicator.style.background = 'transparent';
        micIndicator.style.border = '1px solid #666';
      }, 300);
    }
  }
  if (message.type === "MIC_ERROR") {
    statusText.innerText = "Mic error: " + message.error;
  }
  if (message.type === "SERVER_MESSAGE") {
    handleServerMessage(JSON.parse(message.data));
  }
  if (message.type === "WEBSOCKET_CONNECTED") {
    statusText.innerText = "Connected — press mic to start";
  }
});

// Initialize
chrome.storage.sync.get(["gemini_api_key"], (result) => {
  console.log("Storage check - found key:", !!result.gemini_api_key);
  if (result.gemini_api_key) {
    apiKey = result.gemini_api_key;
    apiKeyInput.value = apiKey;
    console.log("API Key loaded from storage, connecting...");
    statusText.innerText = "Connecting...";
    chrome.runtime.sendMessage({ type: "CONNECT_WEBSOCKET", apiKey }, (response) => {
      console.log("Connect response:", response);
    });
  } else {
    settingsPanel.classList.remove("hidden");
    statusText.innerText = "Please enter API Key";
  }
});

settingsToggle.onclick = () => settingsPanel.classList.toggle("hidden");

apiKeyInput.onchange = (e) => {
  apiKey = e.target.value.trim();
  if (apiKey) {
    chrome.storage.sync.set({ gemini_api_key: apiKey });
    statusText.innerText = "Connecting...";
    chrome.runtime.sendMessage({ type: "CONNECT_WEBSOCKET", apiKey }, (response) => {
      console.log("Connect response:", response);
    });
  }
};

// Mic button — all audio capture now happens in audio-capture.js background tab
micBtn.onclick = async () => {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  }
  if (playbackContext.state === "suspended") {
    await playbackContext.resume();
  }

  if (isListening) {
    isListening = false;
    micBtn.classList.remove("listening");
    statusText.innerText = "Idle";
    chrome.runtime.sendMessage({ type: "STOP_MIC" });
    return;
  }

  // Before starting a new spoken turn, send a lightweight DOM preview of the current page
  try {
    statusText.innerText = "Capturing screen context...";
    const domPreview = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_DOM_PREVIEW", maxNodes: 60 }, (resp) => resolve(resp || {}));
    });

    const previewTextParts = [];
    if (domPreview.title) previewTextParts.push(`Title: ${domPreview.title}`);
    if (domPreview.url) previewTextParts.push(`URL: ${domPreview.url}`);
    if (domPreview.viewport) {
      previewTextParts.push(
        `Viewport: ${domPreview.viewport.width}x${domPreview.viewport.height}`
      );
    }
    if (Array.isArray(domPreview.nodes)) {
      const nodeLines = domPreview.nodes.slice(0, 40).map((n, idx) => {
        const bits = [];
        if (n.role) bits.push(`role=${n.role}`);
        bits.push(`tag=${n.tag}`);
        if (n.text) bits.push(`text="${n.text}"`);
        if (n.href) bits.push(`href=${n.href}`);
        if (n.selector) bits.push(`selector=${n.selector}`);
        return `N${idx + 1}: ${bits.join(" | ")}`;
      });
      if (nodeLines.length) {
        previewTextParts.push("DOM_PREVIEW:\n" + nodeLines.join("\n"));
      }
    }

    const previewText = previewTextParts.join(" | ").slice(0, 4000);
    if (previewText) {
      chrome.runtime.sendMessage({
        type: "SEND_TO_GEMINI",
        data: {
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text:
                      "Here is a compact DOM-based preview of the current page. Use these selectors when proposing actions.\n" +
                      previewText,
                  },
                ],
              },
            ],
            turnComplete: true,
          },
        },
      });
    }
  } catch (e) {
    console.error("Failed to build/send DOM preview", e);
  }

  statusText.innerText = "Checking mic permission...";
  chrome.runtime.sendMessage({ type: "REQUEST_MIC_PERMISSION" }, (resp) => {
    if (resp && resp.granted) {
      statusText.innerText = "Starting mic...";
      chrome.runtime.sendMessage({ type: "START_MIC" });
    } else {
      statusText.innerText = "Mic permission denied";
      console.error('Mic permission denied or error:', resp?.error);
    }
  });
};

// ---- Server message handling ----
let currentAgentTurnText = "";

async function handleServerMessage(msg) {
  console.log("Server message:", JSON.stringify(msg).slice(0, 200));

  if (msg.setupComplete) {
    statusText.innerText = "Idle";
    return;
  }

  if (msg.error) {
    statusText.innerText = "Error: " + (msg.error.message || JSON.stringify(msg.error));
    return;
  }

  if (msg.serverContent) {
    const turn = msg.serverContent.modelTurn;
    if (turn && turn.parts) {
      for (const part of turn.parts) {
        if (part.text) {
          currentAgentTurnText += part.text;
          updateTranscript("Agent", currentAgentTurnText);
          checkForActions(part.text);
        }
        if (part.inline_data && part.inline_data.mime_type?.includes("audio")) {
          queueAudio(part.inline_data.data);
        }
      }
    }
    if (msg.serverContent.turnComplete) {
      statusText.innerText = isListening ? "Listening" : "Idle";
      currentAgentTurnText = "";
    }
    if (msg.serverContent.interrupted) {
      stopAudioPlayback();
    }
  }
}

function updateTranscript(role, text) {
  let lastBubble = transcript.lastElementChild;
  if (lastBubble && lastBubble.dataset.role === role && role === "Agent") {
    lastBubble.innerText = `${role}: ${text}`;
  } else {
    const bubble = document.createElement("div");
    bubble.className = `bubble ${role.toLowerCase()}`;
    bubble.dataset.role = role;
    bubble.innerText = `${role}: ${text}`;
    transcript.appendChild(bubble);
  }
  transcript.scrollTop = transcript.scrollHeight;
}

function checkForActions(text) {
  const actionRegex = /ACTION:(\w+):([^:]+):?(.*)/g;
  let match;
  while ((match = actionRegex.exec(text)) !== null) {
    const [_, kind, selector, value] = match;
    executeActionFlow(kind, selector, value, getHumanReadableDescription(kind, selector, value));
  }
}

function getHumanReadableDescription(kind, selector, value) {
  switch (kind) {
    case "click": return `click on ${selector}`;
    case "fill": return `type "${value}" into ${selector}`;
    case "scroll": return `scroll the page by ${value} pixels`;
    case "navigate": return `go to ${value}`;
    default: return `perform a ${kind} action`;
  }
}

async function executeActionFlow(kind, selector, value, description) {
  statusText.innerText = "Thinking";
  const permission = await chrome.runtime.sendMessage({ type: "SHOW_PERMISSION", description });

  if (permission === "GRANT") {
    screenshotIndicator.classList.add("active");
    // Get a small textual page context first (title, url, selector snippet)
    const pageContext = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT', selector }, (resp) => resolve(resp || {}));
    });

    const screenshot = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN" });
    // Send a minimal payload: short page-context text + compressed screenshot
    const contextTextParts = [];
    if (pageContext.title) contextTextParts.push(`Title: ${pageContext.title}`);
    if (pageContext.url) contextTextParts.push(`URL: ${pageContext.url}`);
    if (pageContext.element && pageContext.element.text) contextTextParts.push(`Element: ${pageContext.element.text.slice(0,200)}`);
    if (pageContext.selection) contextTextParts.push(`Selection: ${pageContext.selection}`);
    const contextText = contextTextParts.join(' | ');

    chrome.runtime.sendMessage({
      type: "SEND_TO_GEMINI",
      data: {
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: `PAGE_CONTEXT: ${contextText}` }] }],
          turnComplete: true
        },
        realtimeInput: { mediaChunks: [{ mimeType: 'image/jpeg', data: screenshot.data }] }
      }
    });

    const result = await chrome.runtime.sendMessage({ type: "EXECUTE_ACTION", kind, selector, value });
    screenshotIndicator.classList.remove("active");
    sendUserTextToGemini(result.success
      ? `Successfully performed: ${description}`
      : `Action failed: ${result.error}`
    );
  } else {
    chrome.runtime.sendMessage({
      type: "SEND_TO_GEMINI",
      data: { clientContent: { turns: [{ role: "user", parts: [{ text: "The user denied that action." }] }], turnComplete: true } }
    });
  }
}

function sendUserTextToGemini(text) {
  chrome.runtime.sendMessage({
    type: "SEND_TO_GEMINI",
    data: { clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } }
  });
}

// ---- Audio playback (still lives here since sidepanel plays the response) ----
function queueAudio(base64) {
  if (!playbackContext) return;
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;
  const audioBuffer = playbackContext.createBuffer(1, float32.length, 24000);
  audioBuffer.getChannelData(0).set(float32);
  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackContext.destination);
  const currentTime = playbackContext.currentTime;
  if (nextStartTime < currentTime) nextStartTime = currentTime;
  source.start(nextStartTime);
  nextStartTime += audioBuffer.duration;
}

function stopAudioPlayback() {
  if (playbackContext) nextStartTime = playbackContext.currentTime;
}