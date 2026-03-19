// background.js — Service worker. Central hub for all agent logic.
// Imports skills registry (module type declared in manifest).
import { initSkillRegistry, getAllSkills, getSkill, getSkillManifest } from "./skills/index.js";

// ---- Constants ----
const MAX_ROUNDS = 15;
const SETTLE_MS = 150;
const NAVIGATE_SETTLE_MS = 1200;
const SENSITIVE_ACTIONS = new Set(["type"]);
const GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions";

// ---- State ----
let geminiSocket = null;
let geminiApiKey = null;
let groqApiKey = null;
let intentionalClose = false;
let reconnectCount = 0;
const MAX_RECONNECTS = 3;
let nativePort = null;
let abortController = null; // abort current task loop

// CDP: tabId → { attached: boolean }
const cdpSessions = new Map();
// Per-round element map: tabId → Map<index, { backendNodeId, x, y, w, h, role, name }>
const elementMaps = new Map();

// Task contexts: taskId → TaskContext
const taskContexts = new Map();

// ---- Init ----
chrome.action.onClicked.addListener((tab) => chrome.sidePanel.open({ windowId: tab.windowId }));
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Load skills and restore API keys on startup (service workers restart frequently)
async function onStartup() {
  await initSkillRegistry().catch(console.error);
  const { groq_key, gemini_key } = await chrome.storage.local.get(["groq_key", "gemini_key"]);
  if (groq_key) { groqApiKey = groq_key; console.log("BG: Groq key restored from storage"); }
  if (gemini_key) { geminiApiKey = gemini_key; console.log("BG: Gemini key restored from storage"); }
}
onStartup();

// ---- Event broadcast ----
// Sends { type: "AGENT_EVENT", event: { type, ...fields } } to the side panel.
function broadcastEvent(event) {
  chrome.runtime.sendMessage({ type: "AGENT_EVENT", event }).catch(() => {});
}
function broadcastRaw(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ---- Gemini Live WebSocket ----
function connectGeminiLive(gKey) {
  if (!gKey) return;
  geminiApiKey = gKey;
  if (geminiSocket) { geminiSocket.onclose = null; geminiSocket.close(); }

  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${geminiApiKey}`;
  geminiSocket = new WebSocket(url);

  geminiSocket.onopen = () => {
    console.log("BG: Gemini Live open");
    reconnectCount = 0;
    geminiSocket.send(JSON.stringify({
      setup: {
        model: "models/gemini-2.5-flash-native-audio-latest",
        generation_config: {
          response_modalities: ["AUDIO"],
          speech_config: { voice_config: { prebuilt_voice_config: { voice_name: "Aoede" } } }
        },
        // inputAudioTranscription: get user's speech as text so we can route it to Groq
        input_audio_transcription: {},
        system_instruction: {
          parts: [{
            text:
              "You are ctrl, a voice interface for browser automation.\n\n" +
              "RULE 1 — Browser tasks (navigate, click, search, fill, book, buy, compare, scroll, play, open, etc.):\n" +
              "  a) Say a VERY short acknowledgement: 'Sure!', 'On it!', 'Got it.', 'Searching!' (3-5 words max)\n" +
              "  b) On the next line output EXACTLY: [INTENT: plain description of what to do]\n" +
              "  Example: user says 'fill out this form' → speak 'On it!' then output [INTENT: fill out the form on the current page]\n" +
              "  Example: user says 'go to youtube' → speak 'Sure!' then output [INTENT: navigate to https://youtube.com]\n" +
              "  Example: user says 'compare prices on amazon and flipkart' → speak 'Got it!' then output [INTENT: compare prices on Amazon and Flipkart]\n\n" +
              "RULE 2 — Pure conversation (greetings, jokes, questions about you, weather, trivia):\n" +
              "  Just respond naturally. Do NOT output [INTENT: ...] for these.\n\n" +
              "RULE 3 — When you receive [TASK_DONE: result]:\n" +
              "  Speak the result in 1 natural sentence. No JSON, no lists.\n\n" +
              "RULE 4 — When you receive [TASK_FAILED: reason]:\n" +
              "  Apologize in 1 sentence and mention the reason.\n\n" +
              "RULE 5 — Never output markdown, bullet points, bold text, or structured data in spoken responses.\n" +
              "RULE 6 — Keep ALL spoken responses to 1-2 sentences maximum."
          }]
        }
      }
    }));
    broadcastRaw({ type: "WEBSOCKET_CONNECTED" });
  };

  geminiSocket.onmessage = async (event) => {
    try {
      const text = event.data instanceof Blob ? await event.data.text() : event.data;
      // Forward raw message to panel (for audio playback)
      broadcastRaw({ type: "SERVER_MESSAGE", data: text });
      // Parse for [INTENT:], [RECORD_START], [RECORD_STOP]
      handleGeminiLiveMessage(text);
    } catch (e) { console.error("BG: Gemini parse error", e); }
  };

  geminiSocket.onclose = (event) => {
    console.log("BG: Gemini closed", event.code);
    if (event.code === 1008) {
      broadcastRaw({ type: "STATUS", status: "error", message: event.reason });
      return;
    }
    if (!intentionalClose && reconnectCount < MAX_RECONNECTS) {
      reconnectCount++;
      broadcastRaw({ type: "STATUS", status: "reconnecting" });
      setTimeout(() => connectGeminiLive(geminiApiKey), 2000);
    } else {
      broadcastRaw({ type: "STATUS", status: "disconnected" });
    }
  };

  geminiSocket.onerror = (e) => console.error("BG: Gemini error", e);
}

function sendToGeminiLive(textContent) {
  if (geminiSocket?.readyState === WebSocket.OPEN) {
    geminiSocket.send(JSON.stringify({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: textContent }] }],
        turnComplete: true
      }
    }));
  }
}

// Accumulate text across partial model turn messages before parsing for [INTENT:]
let geminiTextBuffer = "";
// Accumulate user speech transcription chunks
let geminiInputTranscriptBuffer = "";

function handleGeminiLiveMessage(rawText) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return; }

  // inputTranscription — accumulate partial chunks
  const inputTranscription = parsed?.serverContent?.inputTranscription;
  if (inputTranscription?.text?.trim()) {
    geminiInputTranscriptBuffer += inputTranscription.text;
    console.log("BG: inputTranscription:", inputTranscription.text.slice(0, 80));
  }

  // Accumulate text parts from modelTurn
  const parts = parsed?.serverContent?.modelTurn?.parts || [];
  for (const part of parts) {
    if (part.text) {
      geminiTextBuffer += part.text;
    }
  }

  // On turnComplete — parse the accumulated text for [INTENT: ...]
  if (parsed?.serverContent?.turnComplete) {
    const fullText = geminiTextBuffer.trim();
    const userTranscript = geminiInputTranscriptBuffer.trim();
    geminiTextBuffer = "";
    geminiInputTranscriptBuffer = "";

    if (fullText) {
      console.log("BG: Gemini full turn:", fullText.slice(0, 200));
    }

    // Primary path: model outputs [INTENT: ...]
    const intentMatch = fullText.match(/\[INTENT:\s*([\s\S]+?)(?:\]|$)/);
    if (intentMatch) {
      const intentText = intentMatch[1].trim().replace(/\]$/, "");
      console.log("BG: [INTENT] detected:", intentText);
      broadcastRaw({ type: "INTENT_DETECTED", intentText });
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        dispatchTask(intentText, tab).catch(e => console.error("BG: dispatchTask error:", e));
      });
    } else if (userTranscript) {
      // Fallback: model didn't output [INTENT:], use the user's transcribed speech directly
      console.log("BG: No [INTENT] marker, routing transcript:", userTranscript.slice(0, 80));
      checkAndDispatchIntent(userTranscript);
    }

    if (fullText.includes("[RECORD_START]")) broadcastRaw({ type: "RECORD_START" });
    if (fullText.includes("[RECORD_STOP]"))  broadcastRaw({ type: "RECORD_STOP" });
  }
}

// Decide if the user's speech is a browser task and dispatch directly.
// Uses fast keyword check first, then llama-4-scout for ambiguous cases.
const TASK_KEYWORDS = /\b(go to|navigate|open|search|click|type|fill|book|buy|find|scroll|close|play|pause|send|email|compose|compare|look up|check|download|sign in|log in|logout|submit|add to cart|checkout)\b/i;

async function checkAndDispatchIntent(userText) {
  // Always broadcast so sidepanel can show the user transcript
  broadcastRaw({ type: "INTENT_DETECTED", intentText: userText });

  // Fast keyword check — obvious browser tasks skip the LLM call
  if (TASK_KEYWORDS.test(userText)) {
    console.log("BG: Task detected (keyword match), dispatching:", userText);
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      dispatchTask(userText, tab).catch(e => console.error("BG: dispatchTask error:", e));
    });
    return;
  }

  // Ambiguous — ask llama-4-scout (very fast, ~200ms)
  if (!groqApiKey) {
    console.warn("BG: No Groq key, can't classify intent");
    return;
  }
  try {
    const raw = await callGroq("meta-llama/llama-4-scout-17b-16e-instruct", [{
      role: "user",
      content: `Is this a browser automation request (navigate, click, search, fill form, etc.)? Reply ONLY with JSON {"actionable": true} or {"actionable": false}.\n\nText: "${userText}"`
    }], { jsonMode: true });
    const { actionable } = JSON.parse(raw);
    console.log("BG: Intent check:", userText, "→ actionable:", actionable);
    if (actionable) {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        dispatchTask(userText, tab).catch(e => console.error("BG: dispatchTask error:", e));
      });
    }
  } catch (e) {
    console.warn("BG: Intent check failed:", e.message);
  }
}

// ---- Offscreen document (mic) ----
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
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch {}
}

// ---- CDP Manager ----
chrome.debugger.onDetach.addListener((source) => {
  cdpSessions.set(source.tabId, { attached: false });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (cdpSessions.get(tabId)?.attached) {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
  cdpSessions.delete(tabId);
  elementMaps.delete(tabId);
});

async function ensureAttached(tabId) {
  const session = cdpSessions.get(tabId);
  if (session?.attached) return;
  console.log("BG: Attaching CDP to tab", tabId);
  await chrome.debugger.attach({ tabId }, "1.3");
  cdpSessions.set(tabId, { attached: true });
  // Enable domains required for our pipeline
  await chrome.debugger.sendCommand({ tabId }, "Page.enable", {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Accessibility.enable", {}).catch(() => {});
  console.log("BG: CDP attached and domains enabled for tab", tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ---- Annotated Screenshot Pipeline ----
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox",
  "menuitem", "checkbox", "radio", "slider", "spinbutton", "tab",
  "option", "treeitem", "columnheader", "menuitemcheckbox", "menuitemradio",
  "switch", "gridcell"
]);

const ROLE_COLORS = {
  button: [59, 130, 246],     // blue
  link: [234, 179, 8],         // yellow
  textbox: [34, 197, 94],      // green
  searchbox: [34, 197, 94],    // green
  combobox: [34, 197, 94],     // green
  checkbox: [249, 115, 22],    // orange
  radio: [249, 115, 22],       // orange
  default: [168, 85, 247]      // purple
};

async function buildAnnotatedScreenshot(tabId) {
  // 1. Raw screenshot
  const { data: screenshotB64 } = await cdp(tabId, "Page.captureScreenshot", {
    format: "jpeg", quality: 75
  });

  // 2. Accessibility tree
  let interactiveNodes = [];
  try {
    const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
    interactiveNodes = nodes.filter(n =>
      n.role?.value && INTERACTIVE_ROLES.has(n.role.value) && !n.ignored && n.backendDOMNodeId
    );
  } catch (e) {
    console.warn("BG: AXTree failed", e);
  }

  // 3. Bounding boxes — fetch in parallel (much faster than sequential)
  const capped = interactiveNodes.slice(0, 60);
  const boxResults = await Promise.all(capped.map(async (node) => {
    try {
      const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
      return { node, model };
    } catch { return null; }
  }));

  const elements = [];
  for (const res of boxResults) {
    if (!res) continue;
    const { node, model } = res;
    const border = model.border; // [x1,y1, x2,y2, x3,y3, x4,y4]
    const xs = [border[0], border[2], border[4], border[6]];
    const ys = [border[1], border[3], border[5], border[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (w > 2 && h > 2) {
      const name = node.name?.value || node.description?.value || "";
      elements.push({
        index: elements.length + 1,
        backendNodeId: node.backendDOMNodeId,
        role: node.role.value,
        name: name.slice(0, 80),
        x: Math.round(x), y: Math.round(y),
        w: Math.round(w), h: Math.round(h)
      });
    }
  }

  // 4. Annotate with OffscreenCanvas
  let annotatedB64 = screenshotB64; // fallback: unannotated
  try {
    // const bytes = Uint8Array.from(atob(screenshotB64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const img = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    for (const el of elements) {
      const [r, g, b] = ROLE_COLORS[el.role] || ROLE_COLORS.default;
      ctx.fillStyle = `rgba(${r},${g},${b},0.35)`;
      ctx.fillRect(el.x, el.y, el.w, el.h);
      ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.lineWidth = 2;
      ctx.strokeRect(el.x, el.y, el.w, el.h);

      // Number label background
      const labelW = el.index >= 10 ? 26 : 20;
      ctx.fillStyle = `rgba(${r},${g},${b},0.95)`;
      ctx.fillRect(el.x, el.y, labelW, 18);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px monospace";
      ctx.fillText(String(el.index), el.x + 3, el.y + 13);
    }

    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    const arrBuf = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(arrBuf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    annotatedB64 = btoa(binary);
  } catch (e) {
    console.warn("BG: annotation failed, using raw screenshot", e);
  }

  // 5. Build numbered element list text
  const elementList = elements.map(el => {
    const roleLabel = el.role.charAt(0).toUpperCase() + el.role.slice(1);
    return `${el.index}. ${roleLabel} "${el.name || "(no label)"}"`;
  }).join("\n") || "(no interactive elements detected)";

  // 6. Store element map for this tab
  const elementMap = new Map(elements.map(el => [el.index, el]));
  elementMaps.set(tabId, elementMap);

  return { annotatedB64, elementList, elementMap };
}

// ---- CDP Action Execution ----
async function executeCdpAction(tabId, action, elementMap) {
  const el = action.elementIndex ? elementMap.get(action.elementIndex) : null;

  switch (action.type) {
    case "click": {
      if (!el) throw new Error(`Element ${action.elementIndex} not in map`);
      const cx = el.x + el.w / 2;
      const cy = el.y + el.h / 2;
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
      await sleep(80);
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: cx, y: cy, clickCount: 1 });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", x: cx, y: cy, clickCount: 1 });
      break;
    }

    case "type": {
      if (!el) throw new Error(`Element ${action.elementIndex} not in map`);
      // Focus element
      await cdp(tabId, "DOM.focus", { backendNodeId: el.backendNodeId });
      if (action.clear) {
        // Select all + delete
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 8 });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 8 });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
      }
      // Try insertText first (fast path for plain inputs)
      try {
        await cdp(tabId, "Input.insertText", { text: action.value });
      } catch {
        // Fallback: character-by-character (React/Vue controlled inputs)
        for (const char of action.value) {
          await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
          await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", key: char, text: char });
          await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: char, text: char });
        }
      }
      break;
    }

    case "scroll": {
      const amount = action.amount || 400;
      const deltaY = action.direction === "up" ? -amount : amount;
      // Scroll at center of viewport
      const { result } = await cdp(tabId, "Runtime.evaluate", {
        expression: `[window.innerWidth / 2, window.innerHeight / 2]`,
        returnByValue: true
      });
      const [cx, cy] = result.value;
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY
      });
      break;
    }

    case "navigate": {
      await cdp(tabId, "Page.navigate", { url: action.url });
      break;
    }

    case "keypress": {
      const target = el;
      if (target) {
        await cdp(tabId, "DOM.focus", { backendNodeId: target.backendNodeId });
      }
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: action.key, code: action.key });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: action.key, code: action.key });
      break;
    }

    case "select": {
      if (!el) throw new Error(`Element ${action.elementIndex} not in map`);
      // Use Runtime to set native select value
      const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId: el.backendNodeId });
      if (object?.objectId) {
        await cdp(tabId, "Runtime.callFunctionOn", {
          functionDeclaration: `function(v) { this.value = v; this.dispatchEvent(new Event('change', {bubbles:true})); this.dispatchEvent(new Event('input', {bubbles:true})); }`,
          objectId: object.objectId,
          arguments: [{ value: action.value }]
        });
      }
      break;
    }

    case "wait": {
      await sleep(action.ms || 500);
      break;
    }

    case "extract": {
      // No-op: model reads data from AXTree via its own vision; extractedData returned in response
      break;
    }

    default:
      console.warn("BG: unknown action type", action.type);
  }
}

// ---- Page settle detection ----
async function waitForPageSettle(tabId, timeout = 8000) {
  try {
    await cdp(tabId, "Network.enable");
  } catch {}

  return new Promise((resolve) => {
    let lastActivity = Date.now();
    let settled = false;

    const onEvent = (source, method) => {
      if (source.tabId === tabId && method.startsWith("Network.loading")) {
        lastActivity = Date.now();
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);

    const check = setInterval(() => {
      if (Date.now() - lastActivity > 600) {
        clearInterval(check);
        chrome.debugger.onEvent.removeListener(onEvent);
        if (!settled) { settled = true; resolve({ settled: true }); }
      }
    }, 100);

    setTimeout(() => {
      clearInterval(check);
      chrome.debugger.onEvent.removeListener(onEvent);
      if (!settled) { settled = true; resolve({ settled: false, timedOut: true }); }
    }, timeout);
  });
}

// ---- Groq API caller ----
async function callGroq(model, messages, { jsonMode = false } = {}) {
  if (!groqApiKey) throw new Error("Groq API key not set");

  const body = {
    model,
    messages,
    temperature: 0.1,
    max_tokens: 4096,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(GROQ_BASE, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${groqApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (res.status === 429) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Groq ${res.status}: ${err}`);
      }

      const data = await res.json();
      return data.choices[0].message.content;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1000);
    }
  }
  throw lastErr;
}

// ---- Orchestrator ----
async function runOrchestrator(intentText, currentTab) {
  console.log("BG: Orchestrator start:", intentText);
  broadcastEvent({ type: "ORCHESTRATOR_START", intentText });

  const skillManifest = getSkillManifest();
  const skillList = skillManifest.map(s => `- ${s.name}: ${s.description}`).join("\n");

  const systemPrompt = `You are an intent router for a browser automation agent.
Given the user's intent and current page context, return a JSON object with:
- taskType: "simple" | "multi-step" | "multi-tab-parallel" | "workflow-replay"
- skill: the skill name that best matches (or null if none applies)
- steps: array of step descriptions for multi-step tasks (1-5 steps)
- parallelSubtasks: array of {subGoal, startUrl} for multi-tab-parallel tasks
- workflowName: the workflow name if taskType is workflow-replay

Available skills:
${skillList}

Rules:
- Use "simple" for tasks requiring fewer than 4 actions (navigate somewhere, click a button, scroll, play a video)
- Use "multi-step" for complex tasks requiring 4+ distinct actions (fill a form, complete a checkout, etc.)
- Use "multi-tab-parallel" ONLY when explicitly comparing across 2+ different websites simultaneously
- Use "workflow-replay" only when user says "do [workflow name]" or references a saved workflow
- Match skill semantically, not just by keywords
- For "simple" tasks that require going to a different website, the agent will handle navigation itself — do NOT add a navigate step in steps[]
- Return ONLY valid JSON, no commentary`;

  const userMsg = `Intent: "${intentText}"
Current URL: ${currentTab?.url || "unknown"}
Page title: ${currentTab?.title || "unknown"}

Important: if the task requires a website the user is NOT currently on, the vision agent will navigate there automatically. You just need to describe WHAT to do, not HOW to navigate.`;

  try {
    const raw = await callGroq("openai/gpt-oss-20b", [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg }
    ], { jsonMode: true });

    const decision = JSON.parse(raw);
    broadcastEvent({ type: "ORCHESTRATOR_DONE", decision });
    return decision;
  } catch (e) {
    console.error("BG: orchestrator failed", e);
    // Fallback: treat as simple task
    return { taskType: "simple", skill: null, steps: [], parallelSubtasks: [] };
  }
}

// ---- Vision Action Agent Loop ----
const VISION_SYSTEM_PROMPT = `You are a precise browser automation agent controlling a real browser via CDP.

Each round you receive:
1. An annotated screenshot — colored numbered boxes mark every interactive element
2. A numbered element list matching those boxes
3. CURRENT URL and page title
4. The task/goal, round number, previously failed elements, extracted data so far

OUTPUT — always return exactly this JSON shape:
{
  "thought": "1-2 sentence reasoning: where am I, what do I see, what's my next move",
  "actions": [...],
  "done": false,
  "extractedData": {}
}

ACTION TYPES:
- {"type": "navigate", "url": "https://..."}           ← go to a URL directly
- {"type": "click", "elementIndex": N}
- {"type": "type", "elementIndex": N, "value": "text", "clear": true}
- {"type": "scroll", "direction": "down"|"up", "amount": 400}
- {"type": "keypress", "key": "Enter"|"Tab"|"Escape"|"ArrowDown", "elementIndex": N}
- {"type": "select", "elementIndex": N, "value": "option text"}
- {"type": "extract", "fields": {"fieldName": "description of value to capture"}}
- {"type": "wait", "ms": 500}

NAVIGATION RULES — READ CAREFULLY:
- If the task requires a website different from CURRENT URL, your FIRST action MUST be navigate to that site's URL. Do NOT use any search box on the current page to get there.
- Examples:
    task="open YouTube", current url="chatgpt.com" → {"type":"navigate","url":"https://youtube.com"}
    task="go to gmail", current url="google.com"   → {"type":"navigate","url":"https://mail.google.com"}
    task="search cat videos on youtube", current url="chatgpt.com" → FIRST navigate to https://youtube.com, THEN search
- Always construct the correct full URL yourself. Never rely on the current page's search.

EXECUTION RULES:
1. Reference elements by NUMBER ONLY — never guess coordinates.
2. Do not retry failed elements — find an alternative approach.
3. Set done=true only when the task is fully complete or truly impossible.
4. Extract data before navigating away from a page that has it.
5. For SPAs/dynamic pages: after clicking something that loads content, add {"type":"wait","ms":800} before the next action.
6. Return only the JSON object — no markdown, no commentary.`;

async function runVisionActionAgent(tabId, goal, skillName, taskContext, subAgentIndex = null, signal = null) {
  console.log("BG: VisionActionAgent start — tab:", tabId, "goal:", goal, "skill:", skillName);
  const skill = skillName ? getSkill(skillName) : null;
  const systemPrompt = VISION_SYSTEM_PROMPT + (skill?.systemPromptAddition ? "\n\n" + skill.systemPromptAddition : "");

  let failedElements = [];
  let extractedData = {};
  let round = 0;
  let lastThought = "";

  broadcastEvent({ type: "AGENT_START", tabId, goal, skill: skillName });

  while (round < MAX_ROUNDS) {
    if (signal?.aborted) {
      broadcastEvent({ type: "AGENT_ABORTED", tabId });
      return { aborted: true };
    }

    round++;
    broadcastEvent({ type: "PERCEIVING", tabId, round });

    // Build annotated screenshot
    console.log("BG: Building annotated screenshot, round", round);
    let annotatedB64, elementList, elementMap;
    try {
      ({ annotatedB64, elementList, elementMap } = await buildAnnotatedScreenshot(tabId));
      console.log("BG: Screenshot built, elements:", elementMap.size);
    } catch (e) {
      console.error("BG: screenshot failed", e);
      await sleep(1000);
      continue;
    }

    // Get current tab URL and title for context
    let currentUrl = "unknown", currentTitle = "unknown";
    try {
      const tab = await chrome.tabs.get(tabId);
      currentUrl = tab.url || "unknown";
      currentTitle = tab.title || "unknown";
    } catch {}

    // Build prompt
    const userContent = [
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${annotatedB64}` }
      },
      {
        type: "text",
        text: [
          `CURRENT URL: ${currentUrl}`,
          `PAGE TITLE: ${currentTitle}`,
          `TASK: ${goal}`,
          `Round: ${round}/${MAX_ROUNDS}`,
          failedElements.length ? `Failed elements (do NOT retry): [${failedElements.join(", ")}]` : "",
          Object.keys(extractedData).length ? `Data extracted so far: ${JSON.stringify(extractedData)}` : "",
          lastThought ? `Previous thought: ${lastThought}` : "",
          "",
          "INTERACTIVE ELEMENTS ON PAGE:",
          elementList
        ].filter(Boolean).join("\n")
      }
    ];

    // Call 120b
    console.log("BG: Calling 120b for action decision...");
    broadcastEvent({ type: "THINKING", tabId });
    let response;
    try {
      response = await callGroq("meta-llama/llama-4-scout-17b-16e-instruct", [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ], { jsonMode: true });
    } catch (e) {
      console.error("BG: 120b call failed:", e.message);
      broadcastEvent({ type: "ACTION_FAILED", tabId, error: e.message });
      if (signal?.aborted) break;
      await sleep(2000);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch {
      console.warn("BG: 120b returned non-JSON", response);
      continue;
    }

    const { thought, actions = [], done = false, extractedData: newData = {} } = parsed;
    lastThought = thought || "";
    Object.assign(extractedData, newData);
    console.log("BG: 120b thought:", lastThought, "| actions:", actions.length, "| done:", done);

    broadcastEvent({ type: "THOUGHT", tabId, thought: lastThought });

    if (done) {
      broadcastEvent({ type: "AGENT_DONE", tabId, extractedData });
      break;
    }

    // Execute each action
    for (const action of actions) {
      if (signal?.aborted) break;

      // Permission check for sensitive actions
      if (SENSITIVE_ACTIONS.has(action.type)) {
        const desc = action.type === "navigate"
          ? `navigate to ${action.url}`
          : `type "${action.value}" into element ${action.elementIndex}`;
        const perm = await showPermissionAndWait(tabId, desc);
        if (!perm) {
          broadcastEvent({ type: "ACTION_DENIED", tabId, action });
          continue;
        }
      }

      // Before screenshot for confirmation
      let beforeB64;
      try {
        const s = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 40 });
        beforeB64 = s.data;
      } catch {}

      broadcastEvent({ type: "EXECUTING", tabId, action, elementName: elementMap.get(action.elementIndex)?.name });

      try {
        await executeCdpAction(tabId, action, elementMap);
      } catch (e) {
        console.warn("BG: action failed", action, e);
        if (action.elementIndex) failedElements.push(action.elementIndex);
        broadcastEvent({ type: "ACTION_FAILED", tabId, action, error: e.message });
        continue;
      }

      // Settle
      if (action.type === "navigate") {
        await waitForPageSettle(tabId);
        await sleep(NAVIGATE_SETTLE_MS);
      } else if (action.type !== "wait" && action.type !== "extract") {
        await sleep(SETTLE_MS);
      }

      // After screenshot
      let afterB64;
      try {
        const s = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 40 });
        afterB64 = s.data;
      } catch {}

      // Confirm action (non-blocking for wait/extract)
      if (action.type !== "wait" && action.type !== "extract" && beforeB64 && afterB64) {
        runConfirmation(action, beforeB64, afterB64, tabId, failedElements);
      } else {
        broadcastEvent({ type: "ACTION_VERIFIED", tabId, action });
      }
    }
  }

  // Write result to task context if sub-agent
  if (subAgentIndex !== null && taskContext) {
    taskContext.tabs[subAgentIndex].extractedData = extractedData;
    taskContext.tabs[subAgentIndex].status = "done";
  }

  return extractedData;
}

// ---- Confirmation Agent (fire-and-update, non-blocking) ----
async function runConfirmation(action, beforeB64, afterB64, tabId, failedElements) {
  const actionDesc = action.type === "click"
    ? `click on element ${action.elementIndex}`
    : action.type === "type"
    ? `type "${action.value}" into element ${action.elementIndex}`
    : action.type;

  const prompt = `You are verifying if a browser action succeeded.
Action taken: ${actionDesc}

Compare the before and after screenshots.
Return JSON: {"success": boolean, "observation": "brief description of what changed", "retry_hint": ""}

If the page changed meaningfully (new content appeared, form submitted, navigation occurred, element state changed) → success: true.
If nothing changed or an error appeared → success: false with retry_hint explaining what to try instead.`;

  try {
    const raw = await callGroq("meta-llama/llama-4-scout-17b-16e-instruct", [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${beforeB64}` } },
          { type: "text", text: "AFTER:" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${afterB64}` } }
        ]
      }
    ], { jsonMode: true });

    const { success, observation, retry_hint } = JSON.parse(raw);
    if (!success && action.elementIndex) {
      failedElements.push(action.elementIndex);
    }
    broadcastEvent({
      type: success ? "ACTION_VERIFIED" : "ACTION_FAILED",
      tabId, action, observation, retry_hint
    });
  } catch (e) {
    // Confirmation failed — assume success to not block the loop
    broadcastEvent({ type: "ACTION_VERIFIED", tabId, action });
  }
}

// ---- Permission banner ----
async function showPermissionAndWait(tabId, description) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "SHOW_PERMISSION", description }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve(true); // auto-grant if content script unavailable
      } else {
        resolve(resp === "GRANT");
      }
    });
  });
}

// ---- Multi-tab task runner ----
async function runMultiTabTask(decision, intentText, signal) {
  const { parallelSubtasks = [], skill } = decision;
  if (!parallelSubtasks.length) return null;

  const taskId = crypto.randomUUID();
  const taskContext = {
    taskId,
    goalText: intentText,
    skill,
    status: "executing",
    tabs: parallelSubtasks.map((sub, i) => ({
      tabId: null, url: sub.startUrl, subGoal: sub.subGoal, status: "pending", extractedData: {}
    })),
    actionLog: [],
    startTime: Date.now()
  };
  taskContexts.set(taskId, taskContext);

  // Create tabs
  const tabIds = await Promise.all(parallelSubtasks.map(async (sub, i) => {
    const tab = await chrome.tabs.create({ url: sub.startUrl, active: false });
    taskContext.tabs[i].tabId = tab.id;
    return tab.id;
  }));

  // Group tabs
  try {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, {
      title: `ctrl: ${intentText.slice(0, 25)}`,
      color: "blue",
      collapsed: false
    });
  } catch {}

  broadcastEvent({ type: "TASK_STARTED", taskId, tabs: taskContext.tabs });

  // Run sub-agents in parallel
  const results = await Promise.allSettled(tabIds.map((tabId, i) =>
    runVisionActionAgent(tabId, parallelSubtasks[i].subGoal, skill, taskContext, i, signal)
  ));

  // Merge results
  const extractedParts = results.map((r, i) =>
    r.status === "fulfilled" ? taskContext.tabs[i].extractedData : { error: r.reason?.message }
  );

  try {
    const mergePrompt = `The user asked: "${intentText}"

Data collected from each source:
${extractedParts.map((d, i) => `Source ${i + 1} (${parallelSubtasks[i].startUrl}): ${JSON.stringify(d)}`).join("\n")}

Write a clear, concise answer comparing the data. Be specific with numbers and names.`;

    const summary = await callGroq("openai/gpt-oss-20b", [
      { role: "user", content: mergePrompt }
    ]);

    taskContext.status = "done";
    broadcastEvent({ type: "TASK_COMPLETE", taskId, summary });
    sendToGeminiLive(`[TASK_DONE: ${summary}]`);
    return summary;
  } catch (e) {
    taskContext.status = "failed";
    broadcastEvent({ type: "TASK_FAILED", taskId, error: e.message });
    sendToGeminiLive(`[TASK_FAILED: Could not merge results]`);
    return null;
  }
}

// ---- Main task dispatcher (called from sidepanel via DISPATCH_TASK message) ----
async function dispatchTask(intentText, currentTab) {
  console.log("BG: dispatchTask:", intentText, "| tab:", currentTab?.url);
  // Abort any running task
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const { signal } = abortController;

  broadcastEvent({ type: "TASK_DISPATCHED", intentText });

  let decision;
  try {
    decision = await runOrchestrator(intentText, currentTab);
  } catch (e) {
    broadcastEvent({ type: "TASK_FAILED", error: "Orchestrator error: " + e.message });
    return;
  }

  if (signal.aborted) return;

  const { taskType, skill, steps, parallelSubtasks } = decision;

  if (taskType === "workflow-replay") {
    await replayWorkflow(decision.workflowName, currentTab?.id, signal);
    return;
  }

  if (taskType === "multi-tab-parallel") {
    await runMultiTabTask(decision, intentText, signal);
    return;
  }

  // Single-tab tasks (simple or multi-step)
  const tabId = currentTab?.id;
  if (!tabId) {
    broadcastEvent({ type: "TASK_FAILED", error: "No active tab" });
    return;
  }

  if (taskType === "simple" || !steps?.length) {
    const result = await runVisionActionAgent(tabId, intentText, skill, null, null, signal);
    if (!signal.aborted) {
      const summary = typeof result === "object" && Object.keys(result).length
        ? `Done. ${JSON.stringify(result)}`
        : "Done.";
      sendToGeminiLive(`[TASK_DONE: ${summary}]`);
    }
    return;
  }

  // Multi-step: run steps sequentially
  for (let i = 0; i < steps.length; i++) {
    if (signal.aborted) break;
    broadcastEvent({ type: "STEP_START", step: i + 1, total: steps.length, desc: steps[i] });
    await runVisionActionAgent(tabId, steps[i], skill, null, null, signal);
    broadcastEvent({ type: "STEP_DONE", step: i + 1, total: steps.length });
  }

  if (!signal.aborted) {
    sendToGeminiLive(`[TASK_DONE: Completed all ${steps.length} steps for: ${intentText}]`);
  }
}

// ---- Workflow recording storage ----
async function saveWorkflow(name, steps) {
  const { workflows = {} } = await chrome.storage.local.get("workflows");
  workflows[name.toLowerCase().replace(/\s+/g, "-")] = { name, steps, createdAt: Date.now() };
  await chrome.storage.local.set({ workflows });
}

async function replayWorkflow(workflowName, tabId, signal) {
  const { workflows = {} } = await chrome.storage.local.get("workflows");
  const key = workflowName?.toLowerCase().replace(/\s+/g, "-");
  const wf = workflows[key] || Object.values(workflows).find(w =>
    w.name.toLowerCase().includes(workflowName?.toLowerCase())
  );

  if (!wf) {
    sendToGeminiLive(`[TASK_FAILED: No workflow named "${workflowName}" found]`);
    return;
  }

  broadcastEvent({ type: "WORKFLOW_REPLAY_START", name: wf.name });

  for (const step of wf.steps) {
    if (signal?.aborted) break;
    // Find element by role + name in AXTree, then execute
    try {
      const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
      const match = nodes.find(n =>
        n.role?.value === step.elementRole &&
        (n.name?.value || "").toLowerCase().includes(step.elementName?.toLowerCase())
      );
      if (match) {
        const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: match.backendDOMNodeId });
        const border = model.border;
        const x = Math.min(border[0], border[2], border[4], border[6]);
        const y = Math.min(border[1], border[3], border[5], border[7]);
        const w = Math.max(border[0], border[2], border[4], border[6]) - x;
        const h = Math.max(border[1], border[3], border[5], border[7]) - y;
        const fakeEl = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), backendNodeId: match.backendDOMNodeId };
        const fakeMap = new Map([[1, fakeEl]]);
        await executeCdpAction(tabId, { ...step, elementIndex: 1 }, fakeMap);
        await sleep(SETTLE_MS);
      }
    } catch (e) {
      console.warn("BG: workflow step failed", step, e);
    }
  }

  broadcastEvent({ type: "WORKFLOW_REPLAY_DONE", name: wf.name });
  sendToGeminiLive(`[TASK_DONE: Completed workflow "${wf.name}"]`);
}

// ---- Utility ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Message Handler ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "CONNECT_WEBSOCKET") {
    connectGeminiLive(message.apiKey);
    sendResponse({ success: true });
    return;
  }

  if (message.type === "DISCONNECT_WEBSOCKET") {
    intentionalClose = true;
    geminiSocket?.close();
    geminiSocket = null;
    intentionalClose = false;
    sendResponse({ success: true });
    return;
  }

  if (message.type === "SET_GROQ_KEY") {
    groqApiKey = message.apiKey;
    chrome.storage.local.set({ groq_key: message.apiKey });
    console.log("BG: Groq key set");
    sendResponse({ success: true });
    return;
  }

  if (message.type === "SEND_TO_GEMINI") {
    if (geminiSocket?.readyState === WebSocket.OPEN) {
      geminiSocket.send(JSON.stringify(message.data));
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "WebSocket not open" });
    }
    return;
  }

  if (message.type === "START_MIC") {
    ensureOffscreen().then(() => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "OFFSCREEN_START_MIC" }).catch(() => {});
      }, 300);
      sendResponse({ success: true });
    }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === "STOP_MIC") {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_MIC" }).catch(() => {});
    setTimeout(() => closeOffscreen(), 500);
    if (geminiSocket?.readyState === WebSocket.OPEN) {
      geminiSocket.send(JSON.stringify({ clientContent: { turns: [], turnComplete: true } }));
    }
    sendResponse({ success: true });
    return;
  }

  if (message.type === "AUDIO_CHUNK") {
    if (geminiSocket?.readyState === WebSocket.OPEN) {
      geminiSocket.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: message.data }]
        }
      }));
    }
    return;
  }

  if (message.type === "MIC_READY") { broadcastRaw({ type: "MIC_READY" }); return; }
  if (message.type === "MIC_ERROR") { broadcastRaw({ type: "MIC_ERROR", error: message.error }); return; }

  // Dispatch a task from sidepanel (called when INTENT_DETECTED received by panel)
  if (message.type === "DISPATCH_TASK") {
    console.log("BG: DISPATCH_TASK received:", message.intentText);
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      console.log("BG: Active tab:", tab?.url);
      dispatchTask(message.intentText, tab).catch(e => console.error("BG: dispatchTask error:", e));
    });
    sendResponse({ success: true });
    return;
  }

  if (message.type === "ABORT_TASK") {
    abortController?.abort();
    broadcastEvent({ type: "TASK_ABORTED" });
    sendToGeminiLive("[TASK_FAILED: Task was cancelled by user]");
    sendResponse({ success: true });
    return;
  }

  if (message.type === "SAVE_WORKFLOW") {
    saveWorkflow(message.name, message.steps).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.type === "GET_DOM_PREVIEW") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || tabs[0].url?.startsWith("chrome://")) {
        sendResponse({ nodes: [], title: "", url: "" });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: "GET_DOM_PREVIEW", maxNodes: message.maxNodes || 60 }, (resp) => {
        sendResponse(resp || { nodes: [], title: "", url: "" });
      });
    });
    return true;
  }

  if (message.type === "SHOW_PERMISSION") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || tabs[0].url?.startsWith("chrome://")) {
        sendResponse("GRANT");
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { type: "SHOW_PERMISSION", description: message.description }, (resp) => {
        sendResponse(chrome.runtime.lastError ? "DENY" : (resp || "DENY"));
      });
    });
    return true;
  }

  // OS action via native host
  if (message.type === "OS_ACTION") {
    if (!nativePort) {
      try {
        nativePort = chrome.runtime.connectNative("com.ctrl.ai_agent_host");
        nativePort.onDisconnect.addListener(() => { nativePort = null; });
      } catch { nativePort = null; }
    }
    if (!nativePort) { sendResponse({ success: false, error: "Native host not running" }); return; }
    try {
      nativePort.postMessage({ type: "os_action", kind: message.kind, payload: message.payload || {} });
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
    return;
  }

  // Direct CDP passthrough (for panel to query page state)
  if (message.type === "CDP") {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab) { sendResponse({ ok: false, error: "no active tab" }); return; }
      try {
        const result = await cdp(tab.id, message.cmd, message.params || {});
        sendResponse({ ok: true, data: result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }

  // Install community skill
  if (message.type === "INSTALL_SKILL") {
    installCommunitySkill(message.url).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === "GET_SKILLS") {
    sendResponse({ skills: getSkillManifest() });
    return;
  }
});

// ---- Community skill installation ----
const BANNED_PATTERNS = ["eval(", "Function(", "chrome.storage.clear", "document.cookie"];

async function installCommunitySkill(url) {
  if (!url.startsWith("https://raw.githubusercontent.com/") &&
      !url.startsWith("https://gist.githubusercontent.com/")) {
    return { success: false, error: "Only GitHub raw URLs are allowed" };
  }

  const resp = await fetch(url);
  if (!resp.ok) return { success: false, error: `Fetch failed: ${resp.status}` };
  const code = await resp.text();

  for (const banned of BANNED_PATTERNS) {
    if (code.includes(banned)) {
      return { success: false, error: `Skill uses banned API: ${banned}` };
    }
  }

  // Extract name from code (basic)
  const nameMatch = code.match(/name\s*:\s*["']([^"']+)["']/);
  const name = nameMatch?.[1] || "community-skill";

  const { communitySkillsData = [] } = await chrome.storage.local.get("communitySkillsData");
  // Remove existing skill with same name
  const filtered = communitySkillsData.filter(s => s.name !== name);
  filtered.push({ url, name, code, installedAt: Date.now() });
  await chrome.storage.local.set({ communitySkillsData: filtered });

  // Re-init skill registry to pick up new skill
  await initSkillRegistry();

  return { success: true, name };
}
