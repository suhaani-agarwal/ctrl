// offscreen.js — runs in the offscreen document, has full getUserMedia access
let audioContext = null;
let workletNode = null;
let micStream = null;
let capturing = false;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "OFFSCREEN_START_MIC") {
    startCapture();
  }
  if (message.type === "OFFSCREEN_STOP_MIC") {
    stopCapture();
  }
});

async function startCapture() {
  if (capturing) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(micStream);

    const processorUrl = chrome.runtime.getURL("audio-processor.js");
    await audioContext.audioWorklet.addModule(processorUrl);
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

    workletNode.port.onmessage = (e) => {
      if (!capturing) return;
      const pcm = convertFloat32ToInt16(e.data);
      const b64 = arrayBufferToBase64(pcm.buffer);
      // Send chunk to background which forwards to Gemini
      chrome.runtime.sendMessage({ type: "AUDIO_CHUNK", data: b64 });
    };

    source.connect(workletNode);
    capturing = true;
    chrome.runtime.sendMessage({ type: "MIC_READY" });
    console.log("Offscreen: mic capturing");
  } catch (err) {
    console.error("Offscreen: mic error", err);
    chrome.runtime.sendMessage({ type: "MIC_ERROR", error: err.message });
  }
}

function stopCapture() {
  capturing = false;
  micStream?.getTracks().forEach(t => t.stop());
  workletNode?.disconnect();
  audioContext?.close();
  micStream = null;
  workletNode = null;
  audioContext = null;
  console.log("Offscreen: mic stopped");
}

function convertFloat32ToInt16(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}