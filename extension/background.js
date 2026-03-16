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
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Aoede" }
            }
          }
        },
        systemInstruction: {
          parts: [{
            text:
              "You are a friendly voice assistant for a browser automation tool. " +
              "The user speaks tasks; a separate system executes them in the browser.\n\n" +
              "WHEN the user speaks a task:\n" +
              "- Acknowledge in one short, natural sentence. Be warm, not robotic.\n" +
              "- Do NOT describe what steps you will take.\n" +
              "- Do NOT output commands, structured data, or ACTION lines.\n\n" +
              "WHEN you receive a message starting with [TASK_DONE]:\n" +
              "- Summarize what was accomplished in 1-2 natural, friendly sentences.\n" +
              "- Example: 'Done! I searched for cats and opened the top result.'\n" +
              "- Do NOT repeat the raw data or say 'TASK_DONE'.\n\n" +
              "If the user says 'stop' or 'cancel', acknowledge briefly.\n" +
              "If the user gives a new instruction mid-task, acknowledge the change."
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

// Inject content.js into a tab if it hasn't loaded yet (e.g. after extension reload)
function ensureContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["content.js"] },
          () => {
            if (chrome.runtime.lastError) {
              console.warn("BG: could not inject content script:", chrome.runtime.lastError.message);
              resolve(false);
            } else {
              resolve(true);
            }
          }
        );
      } else {
        resolve(true);
      }
    });
  });
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
    // Tell Gemini we stopped sending audio
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        clientContent: { turns: [], turnComplete: true }
      }));
    }
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
    chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 75 }, (dataUrl) => {
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
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0] || tabs[0].url.startsWith("chrome://") || tabs[0].url.startsWith("chrome-extension://")) {
        sendResponse({ nodes: [], title: "", url: "" });
        return;
      }
      await ensureContentScript(tabs[0].id);
      chrome.tabs.sendMessage(tabs[0].id, { type: "GET_DOM_PREVIEW", maxNodes: message.maxNodes || 60 }, (resp) => {
        sendResponse(resp || { nodes: [], title: "", url: "" });
      });
    });
    return true;
  }

  // --- Execute browser action ---
  if (message.type === "EXECUTE_ACTION") {
    // Tab management actions are handled here — no content script needed
    if (message.kind === "new_tab") {
      const url = message.value && message.value.startsWith("http") ? message.value : undefined;
      chrome.tabs.create({ url, active: true }, () => sendResponse({ success: true }));
      return true;
    }
    if (message.kind === "switch_tab") {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        const q = (message.value || "").toLowerCase();
        const target = tabs.find(t =>
          t.title?.toLowerCase().includes(q) || t.url?.toLowerCase().includes(q)
        );
        if (target) {
          chrome.tabs.update(target.id, { active: true }, () => sendResponse({ success: true }));
        } else {
          sendResponse({ success: false, error: `No tab matching "${message.value}"` });
        }
      });
      return true;
    }
    if (message.kind === "close_tab") {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) chrome.tabs.remove(tabs[0].id, () => sendResponse({ success: true }));
        else sendResponse({ success: false, error: "No active tab" });
      });
      return true;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) { sendResponse({ success: false, error: "No active tab" }); return; }
      if (tabs[0].url.startsWith("chrome://") || tabs[0].url.startsWith("chrome-extension://")) {
        sendResponse({ success: false, error: "Cannot execute on chrome:// pages" }); return;
      }
      await ensureContentScript(tabs[0].id);
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
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0] || tabs[0].url.startsWith("chrome://") || tabs[0].url.startsWith("chrome-extension://")) {
        sendResponse("GRANT"); // auto-grant if we can't show banner
        return;
      }
      await ensureContentScript(tabs[0].id);
      chrome.tabs.sendMessage(tabs[0].id, { type: "SHOW_PERMISSION", description: message.description }, (resp) => {
        sendResponse(chrome.runtime.lastError ? "DENY" : (resp || "DENY"));
      });
    });
    return true;
  }

  // --- Unified Gemini REST call (action planning + task decomposition) ---
  if (message.type === "CALL_GEMINI") {
    const model = message.model || "gemini-2.5-flash-lite";
    const parts = (message.parts || [{ text: message.prompt || "" }]).map(p =>
      p.inline_data ? { inlineData: { mimeType: p.inline_data.mime_type, data: p.inline_data.data } } : p
    );
    const body = {
      contents: [{ parts }],
      generationConfig: {
        temperature: message.temperature ?? 0,
        maxOutputTokens: message.maxTokens || 512,
        responseMimeType: "application/json",
        responseSchema: message.schema
      }
    };
    fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    )
      .then(r => r.json())
      .then(data => {
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
          console.error("BG: CALL_GEMINI empty:", JSON.stringify(data).slice(0, 400));
          sendResponse({ success: false, error: data?.error?.message || "Empty response" });
          return;
        }
        try { sendResponse({ success: true, data: JSON.parse(text) }); }
        catch (e) { sendResponse({ success: false, error: "JSON parse failed: " + e.message }); }
      })
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  // --- Page ready check (for smart settle after navigation) ---
  if (message.type === "READY_CHECK") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0] || tabs[0].url.startsWith("chrome://") || tabs[0].url.startsWith("chrome-extension://")) {
        sendResponse({ ready: false });
        return;
      }
      await ensureContentScript(tabs[0].id);
      chrome.tabs.sendMessage(tabs[0].id, { type: "READY_CHECK" }, (resp) => {
        sendResponse(chrome.runtime.lastError ? { ready: false } : (resp || { ready: false }));
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