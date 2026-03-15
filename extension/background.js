// background.js

let socket = null;
let apiKey = null;
let reconnectCount = 0;
const MAX_RECONNECTS = 3;
let intentionalClose = false;
let micTabId = null;
let micOffscreenActive = false;

// Open side panel on icon click
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// Set behavior to open side panel on click (alternative/backup)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));

// Function to connect to Gemini Live API
function connectWebSocket(key) {
  if (!key) return;
  apiKey = key;

  if (socket) {
    socket.onclose = null;
    socket.close();
  }

  console.log("Background: Attempting to connect to Gemini Live API...");


  // const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    console.log("Background: WebSocket Connected - sending setup");
    reconnectCount = 0;

    const setupMessage = {
      setup: {
        model: "models/gemini-2.5-flash-native-audio-latest",
        generation_config: {
          response_modalities: "audio"
        }
      }
    };
    console.log("Background: Sending setup message");
    socket.send(JSON.stringify(setupMessage));

    // Notify sidepanel that connection is ready
    chrome.runtime.sendMessage({ type: "WEBSOCKET_CONNECTED" }).catch(() => { });
  };

  socket.onmessage = async (event) => {
    try {
      let text;
      if (event.data instanceof Blob) {
        text = await event.data.text();
      } else {
        text = event.data;
      }
      const response = JSON.parse(text);
      // broadcast to sidepanel
      chrome.runtime.sendMessage({ type: "SERVER_MESSAGE", data: JSON.stringify(response) });
    } catch (e) {
      console.error("Background: Error parsing message:", e);
    }
  };

  // socket.onclose = (event) => {
  //   console.log("Background: WebSocket Closed - Code:", event.code, "Reason:", event.reason);
  //   if (intentionalClose) {
  //     intentionalClose = false;
  //     return;
  //   }
  //   if (reconnectCount < MAX_RECONNECTS) {
  //     reconnectCount++;
  //     console.log("Background: Will reconnect in 2 seconds");
  //     setTimeout(() => connectWebSocket(apiKey), 2000);
  //   }
  // };
  socket.onclose = (event) => {
    console.log("Background: WebSocket Closed - Code:", event.code, "Reason:", event.reason);

    // 1008 = server rejected setup, don't reconnect
    if (event.code === 1008) {
      chrome.runtime.sendMessage({ type: "STATUS", status: "error", message: event.reason });
      return;
    }

    if (!intentionalClose && reconnectCount < MAX_RECONNECTS) {
      reconnectCount++;
      chrome.runtime.sendMessage({ type: "STATUS", status: "reconnecting" });
      setTimeout(connectWebSocket, 2000);
    } else {
      chrome.runtime.sendMessage({ type: "STATUS", status: "disconnected" });
    }
  };

  socket.onerror = (error) => {
    console.error("Background: WebSocket Error:", error);
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // WebSocket control messages
  if (message.type === "REQUEST_MIC_PERMISSION") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || tabs[0].url.startsWith("chrome://")) {
        sendResponse({ granted: false, error: "Cannot inject into this page" });
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          return navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
              stream.getTracks().forEach(t => t.stop());
              return { granted: true };
            })
            .catch(err => ({ granted: false, error: err.message }));
        }
      }, (results) => {
        const result = results?.[0]?.result || { granted: false };
        sendResponse(result);
      });
    });
    return true;
  }
  if (message.type === "CONNECT_WEBSOCKET") {
    console.log("Background: Received CONNECT_WEBSOCKET");
    connectWebSocket(message.apiKey);
    sendResponse({ success: true });
    return;
  }

  // Mic control messages from sidepanel
  if (message.type === "START_MIC") {
    if (micOffscreenActive || micTabId !== null) {
      sendResponse({ success: true, info: "Mic already started" });
      return;
    }

    // Prefer the Offscreen Document API which allows hidden pages to capture audio
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      chrome.offscreen.hasDocument().then((has) => {
        if (!has) {
          chrome.offscreen.createDocument({
            url: chrome.runtime.getURL('audio-capture.html'),
            reasons: ['AUDIO_CAPTURE'],
            justification: 'Capture microphone for Gemini Live session'
          }).then(() => {
            micOffscreenActive = true;
            // Start capture inside the offscreen document
            chrome.runtime.sendMessage({ type: "START_CAPTURE" });
            sendResponse({ success: true });
          }).catch((err) => {
            // Fallback to creating a hidden tab
            console.error('Offscreen create failed, falling back to tab:', err);
            chrome.tabs.create({ url: chrome.runtime.getURL('audio-capture.html'), active: false }, (tab) => {
              if (chrome.runtime.lastError || !tab) {
                sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Could not create capture tab' });
                return;
              }
              micTabId = tab.id;
              setTimeout(() => chrome.runtime.sendMessage({ type: "START_CAPTURE" }), 200);
              sendResponse({ success: true });
            });
          });
        } else {
          // Offscreen already exists
          micOffscreenActive = true;
          chrome.runtime.sendMessage({ type: "START_CAPTURE" });
          sendResponse({ success: true });
        }
      });
      return true; // indicate async
    }

    // If offscreen API not available, fallback to hidden tab
    chrome.tabs.create({ url: chrome.runtime.getURL('audio-capture.html'), active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Could not create capture tab' });
        return;
      }
      micTabId = tab.id;
      setTimeout(() => chrome.runtime.sendMessage({ type: "START_CAPTURE" }), 200);
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === "STOP_MIC") {
    if (!micOffscreenActive && micTabId === null) {
      sendResponse({ success: true, info: "Mic not running" });
      return;
    }
    // Tell the capture page to stop, then remove/close the offscreen or tab
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }, () => {
      if (micOffscreenActive && chrome.offscreen && chrome.offscreen.closeDocument) {
        chrome.offscreen.closeDocument().then(() => { micOffscreenActive = false; micTabId = null; }).catch(() => { micOffscreenActive = false; });
      }
      if (micTabId !== null) {
        chrome.tabs.remove(micTabId, () => { micTabId = null; });
      }
    });
    sendResponse({ success: true });
    return;
  }

  if (message.type === "GET_PAGE_CONTEXT") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "GET_PAGE_CONTEXT", selector: message.selector }, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse({ error: 'No active tab' });
      }
    });
    return true;
  }

  if (message.type === "SEND_TO_GEMINI") {
    console.log("Background: Forwarding message to Gemini");
    // If this is realtime audio data, emit a short-lived event so UI can show activity
    try {
      if (message.data && message.data.realtimeInput && message.data.realtimeInput.mediaChunks) {
        chrome.runtime.sendMessage({ type: "MIC_CHUNK_SENT" });
      }
    } catch (e) { /* ignore */ }

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message.data));
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "WebSocket not open" });
    }
    return;
  }

  // Original extension functionality
  if (message.type === "CAPTURE_SCREEN") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      const base64 = dataUrl.split(",")[1];
      sendResponse({ data: base64 });
    });
    return true;
  }

  if (message.type === "EXECUTE_ACTION") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "EXECUTE",
          kind: message.kind,
          selector: message.selector,
          value: message.value
        }, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse({ success: false, error: "No active tab found" });
      }
    });
    return true;
  }

  if (message.type === "SHOW_PERMISSION") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "SHOW_PERMISSION",
          description: message.description
        }, (response) => {
          sendResponse(response);
        });
      } else {
        sendResponse("DENY");
      }
    });
    return true;
  }
});
