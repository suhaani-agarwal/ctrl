let audioContext = null;
let workletNode = null;
let micStream = null;

async function init() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    audioContext = new AudioContext({ sampleRate: 24000 });
    const source = audioContext.createMediaStreamSource(micStream);
    
    await audioContext.audioWorklet.addModule('audio-processor.js');
    workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
    
    workletNode.port.onmessage = (e) => {
      const pcmData = convertFloat32ToInt16(e.data);
      const base64 = arrayBufferToBase64(pcmData.buffer);
      chrome.runtime.sendMessage({
        type: "SEND_TO_GEMINI",
        data: {
          realtimeInput: {
            mediaChunks: [{ mimeType: "audio/pcm;rate=24000", data: base64 }]
          }
        }
      });
    };

    source.connect(workletNode);
    workletNode.connect(audioContext.destination);
    
    chrome.runtime.sendMessage({ type: "MIC_READY" });
  } catch (err) {
    chrome.runtime.sendMessage({ type: "MIC_ERROR", error: err.message });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "START_CAPTURE") init();
  if (message.type === "STOP_CAPTURE") {
    micStream?.getTracks().forEach(t => t.stop());
    workletNode?.disconnect();
    audioContext?.close();
  }
});

function convertFloat32ToInt16(buffer) {
  const buf = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
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