// background.js
let socket = null;
let apiKey = null;
let intentionalClose = false;
let reconnectCount = 0;
const MAX_RECONNECTS = 3;
let nativePort = null;

// ---- Side panel ----
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- Native host ----
function getNativePort() {
  if (nativePort) return nativePort;
  try {
    nativePort = chrome.runtime.connectNative("com.ctrl.ai_agent_host");
    nativePort.onDisconnect.addListener(() => { nativePort = null; });
  } catch (e) {
    nativePort = null;
  }
  return nativePort;
}

// ---- WebSocket ----
function connectWebSocket(key) {
  if (!key) return;
  apiKey = key;
  if (socket) { socket.onclose = null; socket.close(); }

  console.log("BG: connecting WebSocket...");
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    console.log("BG: WebSocket open");
    reconnectCount = 0;
    socket.send(JSON.stringify({
      setup: {
        model: "models/gemini-2.5-flash-native-audio-latest",
        generation_config: { response_modalities: "audio" },
        system_instruction: {
          parts: [{
            text:
              "You are a browser AI agent with eyes on the user\'s screen. You receive:\n" +
              "1. A DOM_PREVIEW listing interactive elements as N1, N2, N3... with their selectors\n" +
              "2. Screenshots of the current page\n\n" +
              "CRITICAL RULES:\n" +
              "- When the user asks you to do something on the page, you MUST output an ACTION line\n" +
              "- OUTPUT THE ACTION LINE ON ITS OWN LINE, no backticks, no markdown\n" +
              "- Use EXACTLY this format (case sensitive, colons only as separators):\n" +
              "ACTION:click:SELECTOR\n" +
              "ACTION:fill:SELECTOR:TEXT TO TYPE\n" +
              "ACTION:scroll::500\n" +
              "ACTION:navigate::https://example.com\n" +
              "ACTION:scrollTo:SELECTOR\n\n" +
              "- Use the selector from the DOM_PREVIEW (e.g. input#search, button.submit)\n" +
              "- You can also use N1, N2 etc from the DOM_PREVIEW as shorthand selectors\n" +
              "- ALWAYS speak naturally about what you are doing AND include the ACTION line\n" +
              "- If the user says \'click the search bar\' or \'go to YouTube\' — OUTPUT AN ACTION LINE\n" +
              "- Never say you cannot perform actions. You CAN. Just output the ACTION line."
          }]
        }
      }
    }));
    broadcastToPanel({ type: "WEBSOCKET_CONNECTED" });
  };

  socket.onmessage = async (event) => {
    try {
      const text = event.data instanceof Blob ? await event.data.text() : event.data;
      broadcastToPanel({ type: "SERVER_MESSAGE", data: text });
    } catch (e) { console.error("BG: parse error", e); }
  };

  socket.onclose = (event) => {
    console.log("BG: WebSocket closed", event.code, event.reason);
    if (event.code === 1008) {
      broadcastToPanel({ type: "STATUS", status: "error", message: event.reason });
      return;
    }
    if (!intentionalClose && reconnectCount < MAX_RECONNECTS) {
      reconnectCount++;
      broadcastToPanel({ type: "STATUS", status: "reconnecting" });
      setTimeout(() => connectWebSocket(apiKey), 2000);
    } else {
      broadcastToPanel({ type: "STATUS", status: "disconnected" });
    }
  };

  socket.onerror = (e) => console.error("BG: WebSocket error", e);
}

function broadcastToPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---- Offscreen document for mic ----
async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: ["USER_MEDIA"],
      justification: "Capture microphone audio for Gemini Live API"
    });
  }
}

async function closeOffscreen() {
  try {
    const has = await chrome.offscreen.hasDocument();
    if (has) await chrome.offscreen.closeDocument();
  } catch (e) {}
}

// ---- Message handler ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "CONNECT_WEBSOCKET") {
    connectWebSocket(message.apiKey);
    sendResponse({ success: true });
    return;
  }

  if (message.type === "SEND_TO_GEMINI") {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message.data));
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "WebSocket not open" });
    }
    return;
  }

  // --- MIC via offscreen ---
  if (message.type === "START_MIC") {
    ensureOffscreen().then(() => {
      // Small delay to let offscreen page load
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "OFFSCREEN_START_MIC" }).catch(() => {});
      }, 300);
      sendResponse({ success: true });
    }).catch(e => {
      console.error("BG: offscreen create failed", e);
      sendResponse({ success: false, error: e.message });
    });
    return true;
  }

  if (message.type === "STOP_MIC") {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_MIC" }).catch(() => {});
    setTimeout(() => closeOffscreen(), 500);
    sendResponse({ success: true });
    return;
  }

  // --- Audio chunks forwarded from offscreen to Gemini ---
  if (message.type === "AUDIO_CHUNK") {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: message.data }]
        }
      }));
    }
    // Flash mic indicator in panel
    broadcastToPanel({ type: "MIC_CHUNK_SENT" });
    return;
  }

  // Mic ready/error forwarded from offscreen to panel
  if (message.type === "MIC_READY") {
    broadcastToPanel({ type: "MIC_READY" });
    return;
  }
  if (message.type === "MIC_ERROR") {
    broadcastToPanel({ type: "MIC_ERROR", error: message.error });
    return;
  }

  // --- Screen capture ---
  if (message.type === "CAPTURE_SCREEN") {
    chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 60 }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ success: false, error: chrome.runtime.lastError?.message });
        return;
      }
      sendResponse({ success: true, data: dataUrl.split(",")[1] });
    });
    return true;
  }

  // --- DOM preview ---
  if (message.type === "GET_DOM_PREVIEW") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || tabs[0].url.startsWith("chrome://")) {
        sendResponse({ nodes: [], title: "", url: "" });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: "GET_DOM_PREVIEW", maxNodes: message.maxNodes || 60 }, (resp) => {
        sendResponse(resp || { nodes: [], title: "", url: "" });
      });
    });
    return true;
  }

  // --- Execute browser action ---
  if (message.type === "EXECUTE_ACTION") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ success: false, error: "No active tab" }); return; }
      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: "EXECUTE", kind: message.kind, selector: message.selector, value: message.value },
        (resp) => {
          if (chrome.runtime.lastError) {
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            sendResponse(resp || { success: false, error: "No response from content script" });
          }
        }
      );
    });
    return true;
  }

  // --- Permission banner ---
  if (message.type === "SHOW_PERMISSION") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || tabs[0].url.startsWith("chrome://")) {
        sendResponse("GRANT"); // auto-grant if we can't show banner
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: "SHOW_PERMISSION", description: message.description }, (resp) => {
        sendResponse(chrome.runtime.lastError ? "DENY" : (resp || "DENY"));
      });
    });
    return true;
  }

  // --- OS action via native host ---
  if (message.type === "OS_ACTION") {
    const port = getNativePort();
    if (!port) { sendResponse({ success: false, error: "Native host not running" }); return; }
    try {
      port.postMessage({ type: "os_action", kind: message.kind, payload: message.payload || {} });
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }
});