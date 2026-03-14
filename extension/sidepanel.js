// sidepanel.js

let apiKey = "";
let audioContext = null;
let workletNode = null;
let micStream = null;
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

// Listen for server messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SERVER_MESSAGE") {
    handleServerMessage(message.data);
  }
  if (message.type === "WEBSOCKET_CONNECTED") {
    console.log("WebSocket connected in background");
    statusText.innerText = "Connected";
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
    chrome.runtime.sendMessage(
      { type: "CONNECT_WEBSOCKET", apiKey: apiKey },
      (response) => {
        console.log("Connect response:", response);
      }
    );
  } else {
    settingsPanel.classList.remove("hidden");
    statusText.innerText = "Please enter API Key";
    console.log("No API key in storage");
  }
});

settingsToggle.onclick = () => settingsPanel.classList.toggle("hidden");

apiKeyInput.onchange = (e) => {
  apiKey = e.target.value.trim();
  if (apiKey) {
    chrome.storage.sync.set({ gemini_api_key: apiKey });
    statusText.innerText = "Connecting...";
    console.log("New API key set, connecting...");
    chrome.runtime.sendMessage(
      { type: "CONNECT_WEBSOCKET", apiKey: apiKey },
      (response) => {
        console.log("Connect response:", response);
      }
    );
  }
};

// Enable Microphone button handler
const enableMicBtn = document.getElementById("enable-mic-btn");
if (enableMicBtn) {
  enableMicBtn.onclick = async () => {
    try {
      // Just calling getUserMedia will trigger Chrome's permission prompt
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop()); // stop the test stream
      statusText.innerText = "Microphone permission granted! Click 🎤 to start";
      enableMicBtn.style.display = "none";
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        statusText.innerText = "Microphone permission denied";
      } else {
        console.error("Permission request error:", err);
        statusText.innerText = "Error: " + err.message;
      }
    }
  };
}

let currentAgentTurnText = "";

async function handleServerMessage(msg) {
  console.log("Server message:", JSON.stringify(msg).slice(0, 200));

  if (msg.setupComplete) {
    console.log("Setup Complete");
    statusText.innerText = isListening ? "Listening" : "Idle";
    return;
  }

  if (msg.error) {
    console.error("Server error:", msg.error);
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
      console.log("Agent interrupted");
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
    const description = getHumanReadableDescription(kind, selector, value);
    executeActionFlow(kind, selector, value, description);
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
    const screenshot = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN" });

    const screenshotMsg = {
      realtimeInput: {
        mediaChunks: [{ mimeType: "image/png", data: screenshot.data }],
      },
    };
    chrome.runtime.sendMessage({
      type: "SEND_TO_GEMINI",
      data: screenshotMsg,
    });

    const result = await chrome.runtime.sendMessage({ type: "EXECUTE_ACTION", kind, selector, value });
    screenshotIndicator.classList.remove("active");

    if (!result.success) {
      sendUserTextToGemini(`The action failed: ${result.error}`);
    } else {
      sendUserTextToGemini(`I have successfully performed the action: ${description}`);
    }
  } else {
    const denyMsg = {
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "The user denied that action." }] }],
        turnComplete: true,
      },
    };
    chrome.runtime.sendMessage({
      type: "SEND_TO_GEMINI",
      data: denyMsg,
    });
  }
}

function sendUserTextToGemini(text) {
  const msg = {
    clientContent: {
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: true,
    },
  };
  chrome.runtime.sendMessage({
    type: "SEND_TO_GEMINI",
    data: msg,
  });
}

// Audio Capture Pipeline
micBtn.onclick = async () => {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  }
  if (playbackContext.state === 'suspended') {
    await playbackContext.resume();
  }

  if (isListening) {
    stopListening();
    return;
  }

  // Check if we already have mic permission
  try {
    const permResult = await navigator.permissions.query({ name: 'microphone' });
    if (permResult.state === 'granted') {
      await startListening();
      return;
    }
  } catch(e) {}

  // Request via active tab injection
  statusText.innerText = "Requesting mic permission...";
  const result = await chrome.runtime.sendMessage({ type: "REQUEST_MIC_PERMISSION" });
  
  if (result?.granted) {
    statusText.innerText = "Permission granted!";
    await startListening();
  } else {
    statusText.innerText = "Mic denied. Open any webpage first, then try again.";
  }
};

async function startListening() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(micStream);

    const processorUrl = chrome.runtime.getURL('audio-processor.js');
    console.log("Loading audio worklet from:", processorUrl);
    await audioContext.audioWorklet.addModule(processorUrl);
    workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
    console.log("Audio worklet loaded successfully");

    workletNode.port.onmessage = (e) => {
      if (!isListening) return;
      const pcmData = convertFloat32ToInt16(e.data);
      const base64 = arrayBufferToBase64(pcmData.buffer);
      chrome.runtime.sendMessage({
        type: "SEND_TO_GEMINI",
        data: {
          realtimeInput: {
            mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64 }],
          },
        },
      });
    };

    source.connect(workletNode);
    workletNode.connect(audioContext.destination);

    isListening = true;
    micBtn.classList.add("listening");
    statusText.innerText = "Listening";
    console.log("Microphone active");
  } catch (err) {
    console.error("Mic access error:", err);
    statusText.innerText = "Mic Error: " + err.message;
  }
}

function stopListening() {
  if (micStream) micStream.getTracks().forEach(track => track.stop());
  if (workletNode) workletNode.disconnect();
  if (audioContext) audioContext.close();

  isListening = false;
  micBtn.classList.remove("listening");
  statusText.innerText = "Idle";
  console.log("Microphone stopped");
}

function convertFloat32ToInt16(buffer) {
  const l = buffer.length;
  const buf = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    let s = Math.max(-1, Math.min(1, buffer[i]));
    buf[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return buf;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Audio Playback Pipeline
function queueAudio(base64) {
  if (!playbackContext) return;

  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);

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
  if (playbackContext) {
    nextStartTime = playbackContext.currentTime;
  }
}
