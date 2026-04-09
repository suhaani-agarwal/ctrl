// background.js — Service worker. Central hub for all agent logic.
// Imports skills registry (module type declared in manifest).
import { initSkillRegistry, getAllSkills, getSkill, getSkillManifest } from "./skills/index.js";
import { getUserProfile, saveProfileFields, formatProfileForAgent } from "./storage/user-profile.js";

// ---- Constants ----
const MAX_ROUNDS = 25; // default; skills can override with maxRounds
const SETTLE_MS = 150;
const NAVIGATE_SETTLE_MS = 1200;
const SENSITIVE_ACTIONS = new Set([]);
const GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";

// ---- State ----
let geminiSocket = null;
let geminiApiKey = null;
let groqApiKey = null;
let openRouterApiKey = null;
let intentionalClose = false;
let reconnectCount = 0;
const MAX_RECONNECTS = 3;
let nativePort = null;
let abortController = null; // abort current task loop
let pendingTask = null;     // { intentText, decision, tab, step: "clarify"|"confirm" }
let pendingFieldQuestion = null; // { fieldKey, question, isSubjective, resolve } — pauses agent loop for user input
let isTaskRunning = false;  // blocks ambient speech from aborting an in-progress task
let pendingTaskCooldownUntil = 0; // ignore mic input for N ms after asking a question (prevents Gemini audio feedback)
let currentAgentTabId = null; // tab where the robot overlay is active
let robotMicTabId = null;     // set when mic is started from the robot content script (not sidepanel)

// ---- Background Task Registry ----
const bgTasks = new Map();    // taskId → BackgroundTask
const tabToTask = new Map();  // tabId  → taskId
const MAX_BG_TASKS = 5;
let pendingBackgroundFlag = false; // set by SEND_TO_BACKGROUND; checked at top of executePlan
let foregroundTask = null; // { decision, intentText, currentTab } — live while a foreground task is executing
let fgTaskGeneration = 0; // incremented each time a new foreground task starts; guards finally blocks

// CDP: tabId → { attached: boolean }
const cdpSessions = new Map();
// Per-round element map: tabId → Map<index, { backendNodeId, x, y, w, h, role, name }>
const elementMaps = new Map();

// Task contexts: taskId → TaskContext
const taskContexts = new Map();

// ---- Init ----
chrome.action.onClicked.addListener((tab) => chrome.sidePanel.open({ windowId: tab.windowId }));
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });
chrome.commands.onCommand.addListener((command) => {
  if (command === "open-settings") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) chrome.sidePanel.open({ windowId: tab.windowId });
    });
  }
});

// Load skills and restore API keys on startup (service workers restart frequently)
async function onStartup() {
  await initSkillRegistry().catch(console.error);
  const { groq_key, gemini_key, openrouter_key } = await chrome.storage.local.get(["groq_key", "gemini_key", "openrouter_key"]);
  if (groq_key) { groqApiKey = groq_key; console.log("BG: Groq key restored from storage"); }
  if (gemini_key) { geminiApiKey = gemini_key; console.log("BG: Gemini key restored from storage"); }
  if (openrouter_key) { openRouterApiKey = openrouter_key; console.log("BG: OpenRouter key restored from storage"); }
}
onStartup();

// On service worker restart: any "running" bg tasks are orphaned — mark aborted
chrome.storage.session.get('ctrl_bg_tasks', (res) => {
  const saved = res?.ctrl_bg_tasks || [];
  for (const t of saved) {
    if (t.status === 'running' || t.status === 'awaiting_input') {
      chrome.notifications.create(`ctrl-bg-done-${t.taskId}`, {
        type: 'basic', iconUrl: 'icons/icon128.png',
        title: 'ctrl — Task Interrupted',
        message: `"${t.intentText.slice(0, 80)}" was interrupted (extension restarted).`,
        requireInteraction: false
      }).catch(() => {});
    }
  }
  chrome.storage.session.remove('ctrl_bg_tasks').catch(() => {});
});

// When user clicks "Answer" on a field-question notification, focus the origin tab
chrome.notifications.onButtonClicked.addListener((notifId) => {
  const match = notifId.match(/^ctrl-fq-([^-]+)-(.+)$/);
  if (!match) return;
  const taskId = match[1];
  const bgTask = bgTasks.get(taskId);
  if (bgTask?.originTabId) {
    chrome.tabs.update(bgTask.originTabId, { active: true }).catch(() => {});
    chrome.windows.update(-1, { focused: true }).catch(() => {});
  }
});

// ---- Event broadcast ----
// Sends { type: "AGENT_EVENT", event: { type, ...fields } } to the side panel.
function broadcastEvent(event) {
  chrome.runtime.sendMessage({ type: "AGENT_EVENT", event }).catch(() => { });
  forwardToRobot(event);
}
function broadcastRaw(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { });
}

// ---- Robot relay ----
function sendToRobot(tabId, msg) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => { });
}

function forwardToRobot(event) {
  const tid = event.tabId || currentAgentTabId;
  // Only update currentAgentTabId for foreground tabs.
  // Background task tabs are registered in tabToTask — never let them overwrite the foreground pointer.
  if (event.tabId && !tabToTask.has(event.tabId)) currentAgentTabId = event.tabId;

  switch (event.type) {
    case "ORCHESTRATOR_START":
      sendToRobot(tid, { type: "ROBOT_STATE", state: "thinking" });
      sendToRobot(tid, { type: "ROBOT_MSG", text: "Figuring out what to do…", msgType: "thought" });
      break;
    case "PLAN_ANNOUNCED":
      sendToRobot(tid, { type: "ROBOT_BULB", text: event.planText || "Got a plan!" });
      sendToRobot(tid, { type: "AGENT_EVENT", event }); // triggers bg button in robot.js
      break;
    case "AGENT_START":
      // Only update for foreground tabs
      if (event.tabId && !tabToTask.has(event.tabId)) currentAgentTabId = event.tabId;
      sendToRobot(event.tabId, { type: "ROBOT_STATE", state: "acting" });
      sendToRobot(event.tabId, { type: "ROBOT_MSG", text: event.goal ? event.goal.slice(0, 80) : "On it!", msgType: "shout" });
      break;
    case "THINKING":
      sendToRobot(tid, { type: "ROBOT_STATE", state: "thinking" });
      break;
    case "THOUGHT":
      if (event.thought) sendToRobot(tid, { type: "ROBOT_MSG", text: event.thought.slice(0, 120), msgType: "thought" });
      break;
    case "EXECUTING":
      if (event.action) {
        sendToRobot(tid, { type: "ROBOT_STATE", state: "acting" });
        if (event.action.type === "click" && event.elementName)
          sendToRobot(tid, { type: "ROBOT_MSG", text: `Clicking ${event.elementName}`, msgType: "action" });
        else if (event.action.type === "navigate" && event.action.url)
          sendToRobot(tid, { type: "ROBOT_MSG", text: `Navigating to ${event.action.url}`, msgType: "action" });
        else if (event.elementName)
          sendToRobot(tid, { type: "ROBOT_MSG", text: event.elementName.slice(0, 80), msgType: "action" });
        if (event.action.x != null && event.action.y != null)
          sendToRobot(tid, { type: "ROBOT_ACT_AT", x: event.action.x, y: event.action.y });
      }
      break;
    case "ACTION_VERIFIED":
      sendToRobot(tid, { type: "ROBOT_MSG", text: "✓ Done", msgType: "shout", dur: 1200 });
      break;
    case "ACTION_FAILED":
      sendToRobot(tid, { type: "ROBOT_STATE", state: "error" });
      if (event.error) sendToRobot(tid, { type: "ROBOT_MSG", text: event.error.slice(0, 80), msgType: "speech" });
      break;
    case "TASK_COMPLETE":
    case "AGENT_DONE":
      sendToRobot(tid, { type: "ROBOT_MSG", text: "All done! ✓", msgType: "shout" });
      sendToRobot(tid, { type: "ROBOT_RESET" });
      break;
    case "TASK_FAILED":
      sendToRobot(tid, { type: "ROBOT_STATE", state: "error" });
      sendToRobot(tid, { type: "ROBOT_MSG", text: event.error ? event.error.slice(0, 80) : "Something went wrong", msgType: "speech" });
      sendToRobot(tid, { type: "ROBOT_RESET" });
      break;
    case "TASK_ABORTED":
    case "AGENT_ABORTED":
      sendToRobot(tid, { type: "ROBOT_RESET" });
      break;
    case "STEP_START":
      sendToRobot(tid, { type: "ROBOT_MSG", text: `Step ${event.step}/${event.total}: ${(event.desc || "").slice(0, 80)}`, msgType: "thought" });
      break;
    case "STEP_DONE":
    case "SCREEN_ANALYZING":
    case "SCREEN_ANALYZED":
    case "PERCEIVING":
    case "ACTION_DENIED":
    case "TASK_DISPATCHED":
    case "FIELD_QUESTION":
      // Forward these as AGENT_EVENT so robot.js can handle them
      sendToRobot(tid, { type: "AGENT_EVENT", event });
      break;
  }
}

// ---- Gemini Live WebSocket ----
function connectGeminiLive(gKey) {
  if (!gKey) return;
  geminiApiKey = gKey;
  intentionalClose = false; // reset so auto-reconnect works for this new session
  reconnectCount = 0;
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
              "You are ctrl, a friendly voice assistant for browser automation.\n\n" +
              "OUTPUT FORMAT: Only say words you would speak aloud. No markdown, no asterisks, no bold, no bullet points, no internal reasoning, no step labels, no meta-commentary. NEVER start with words like 'Initiating', 'Processing', 'Analyzing', 'Certainly', 'Absolutely'.\n\n" +
              "BROWSER TASK RULE — When the user asks you to do anything involving a browser, website, or computer (navigate, search, buy, create, make, design, write, research, build, generate, find, watch, book, compare, summarize, open, play, upload, download, or any website action):\n" +
              "  Say ONE short phrase: 'On it!' or 'Sure!' or 'Got it!'\n" +
              "  Then immediately output on a new line: [INTENT: <concise description of what to do>]\n\n" +
              "EXAMPLES (follow this exact format):\n" +
              "  User: 'create a presentation on climate change' → On it!\n[INTENT: create a 10-slide presentation on climate change using Gamma]\n" +
              "  User: 'search amazon for headphones' → Sure!\n[INTENT: search amazon for headphones]\n" +
              "  User: 'research best laptops under 50000' → Got it!\n[INTENT: research best laptops under 50000 rupees on Perplexity]\n" +
              "  User: 'go to youtube' → Sure!\n[INTENT: navigate to youtube.com]\n\n" +
              "CONFIRMATIONS — If you previously said a plan and user says 'yes', 'ok', 'go ahead', 'sure', 'do it': say 'Great, starting now!' — NO [INTENT:] needed.\n" +
              "STATUS UPDATES — When you receive [STATUS: text]: read it in 5 words or fewer as a progress update.\n" +
              "TASK DONE — When you receive [TASK_DONE: result]: say what was done in one sentence.\n" +
              "FORM FIELD QUESTIONS — When you receive [FIELD_QUESTION: <question>]: read the question naturally and conversationally to the user. Do NOT output [INTENT:]. Just ask the question and wait for their response.\n" +
              "CONVERSATION — Greetings, jokes, general chat: respond naturally, no [INTENT:].\n\n" +
              "CRITICAL: The [INTENT:] line must appear on its own line immediately after your spoken phrase. Never skip it for browser tasks."
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
      // If mic was started from the robot content script (sidepanel not involved),
      // parse audio chunks out of the message and forward them to that tab so the
      // robot can play Gemini's voice locally.
      if (robotMicTabId) {
        try {
          const parsed = JSON.parse(text);
          const parts = parsed?.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
              chrome.tabs.sendMessage(robotMicTabId, {
                type: "ROBOT_AUDIO",
                data: part.inlineData.data
              }).catch(() => {});
            }
          }
        } catch (_) {}
      }
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

// ---- Form-fill: interactive user input ----

/**
 * Pauses the form-fill agent loop and asks the user a question via voice + sidepanel UI.
 * Returns a Promise that resolves with the user's answer string (or null on timeout).
 */
function waitForUserFieldInput(question, fieldKey, isSubjective = false, timeout = 90000) {
  return new Promise((resolve) => {
    pendingFieldQuestion = { fieldKey, question, isSubjective, resolve };
    // Speak the question via Gemini Live voice agent
    sendToGeminiLive(`[FIELD_QUESTION: ${question}]`);
    // Show text input UI in sidepanel
    broadcastEvent({ type: "FIELD_QUESTION", question, fieldKey, isSubjective });
    // Cooldown so Gemini's own audio isn't mistaken for the user's answer
    pendingTaskCooldownUntil = Date.now() + 3500;
    // Auto-timeout
    setTimeout(() => {
      if (pendingFieldQuestion?.resolve === resolve) {
        console.log("BG: Field question timed out:", fieldKey);
        pendingFieldQuestion = null;
        broadcastEvent({ type: "FIELD_ANSWERED", fieldKey, answer: null, timedOut: true });
        resolve(null);
      }
    }, timeout);
  });
}

/**
 * For subjective/creative form fields: takes the user's raw notes and drafts
 * polished content using the LLM.
 */
async function draftSubjectiveContent(rawInput, fieldContext) {
  const prompt = `You help users fill out form fields professionally.
Field: "${fieldContext}"
User's raw notes: "${rawInput}"
Write a polished, natural response to fill this field. Be concise and compelling. Return ONLY the final text — no explanation, no quotes, no preamble.`;
  try {
    const result = await callGroq("meta-llama/llama-4-scout-17b-16e-instruct", [
      { role: "user", content: prompt }
    ]);
    return result.trim();
  } catch (e) {
    console.warn("BG: draftSubjectiveContent failed:", e.message);
    return rawInput;
  }
}

/**
 * Semantic matching: maps a vision-agent fieldKey to a stored profile value.
 * Returns the value string or null.
 */
function findProfileMatch(profile, fieldKey) {
  if (!profile) return null;
  // Direct key match (e.g. agent used exact profile key)
  if (profile[fieldKey]) return profile[fieldKey];

  const norm = fieldKey.toLowerCase().replace(/[_\-\s]/g, "");
  const ALIASES = {
    fullname:        ["fullName"],
    name:            ["fullName"],
    yourname:        ["fullName"],
    firstname:       ["firstName"],
    givenname:       ["firstName"],
    lastname:        ["lastName"],
    surname:         ["lastName"],
    familyname:      ["lastName"],
    email:           ["email"],
    emailaddress:    ["email"],
    phone:           ["phone"],
    mobile:          ["phone"],
    phonenumber:     ["phone"],
    contactnumber:   ["phone"],
    website:         ["website"],
    portfolio:       ["website"],
    portfoliourl:    ["website"],
    websiteurl:      ["website"],
    personalwebsite: ["website"],
    linkedin:        ["linkedin", "linkedinUrl"],
    linkedinurl:     ["linkedin", "linkedinUrl"],
    linkedinprofile: ["linkedin", "linkedinUrl"],
    github:          ["github", "githubUrl"],
    githuburl:       ["github", "githubUrl"],
    githubprofile:   ["github", "githubUrl"],
    city:            ["city"],
    location:        ["city"],
    state:           ["state"],
    country:         ["country"],
    pincode:         ["pincode"],
    zipcode:         ["pincode"],
    postalcode:      ["pincode"],
    company:         ["company"],
    organization:    ["company"],
    employer:        ["company"],
    occupation:      ["occupation"],
    jobtitle:        ["occupation"],
    title:           ["occupation"],
    role:            ["occupation"],
    gender:          ["gender"],
    dob:             ["dateOfBirth"],
    dateofbirth:     ["dateOfBirth"],
    birthday:        ["dateOfBirth"],
    fathername:      ["fatherName"],
    mothername:      ["motherName"],
    address:         ["addressLine1"],
    addressline1:    ["addressLine1"],
    addressline2:    ["addressLine2"],
  };

  const candidates = ALIASES[norm];
  if (candidates) {
    for (const k of candidates) {
      if (profile[k]) return profile[k];
    }
  }
  return null;
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

    // If waiting for a form field answer, route user speech there first
    if (pendingFieldQuestion && userTranscript) {
      const cleanAnswer = userTranscript.trim();
      const cooldownPassed = Date.now() > pendingTaskCooldownUntil;
      if (cooldownPassed && cleanAnswer.length > 0) {
        console.log("BG: Routing speech to pending field question:", pendingFieldQuestion.fieldKey, "->", cleanAnswer.slice(0, 60));
        const { fieldKey, resolve } = pendingFieldQuestion;
        pendingFieldQuestion = null;
        broadcastEvent({ type: "FIELD_ANSWERED", fieldKey, answer: cleanAnswer });
        resolve(cleanAnswer);
        return;
      } else {
        console.log("BG: Field question in cooldown, ignoring:", cleanAnswer.slice(0, 40));
      }
    }

    // If a background task is awaiting input from the current robot-mic tab, route there
    if (!pendingFieldQuestion && userTranscript) {
      const cooldownPassed = Date.now() > pendingTaskCooldownUntil;
      if (cooldownPassed) {
        for (const bgTask of bgTasks.values()) {
          if (bgTask.pendingFieldQuestion && bgTask.originTabId === robotMicTabId) {
            const cleanAnswer = userTranscript.trim();
            if (cleanAnswer.length > 0) {
              console.log("BG: Routing speech to bg task field question:", bgTask.taskId, bgTask.pendingFieldQuestion.fieldKey);
              const { fieldKey, resolve } = bgTask.pendingFieldQuestion;
              bgTask.pendingFieldQuestion = null;
              bgTask.status = 'running';
              chrome.action.setBadgeText({ text: '' }).catch(() => {});
              persistBgTasks();
              broadcastEvent({ type: 'FIELD_ANSWERED', fieldKey, answer: cleanAnswer });
              resolve(cleanAnswer);
              return;
            }
            break;
          }
        }
      }
    }

    // If waiting for user reply to a plan/clarification, route there first
    // BUT skip if still in cooldown period (Gemini's own audio being picked up by mic)
    if (pendingTask && userTranscript) {
      const cleanForPending = userTranscript.replace(/[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/g, "").replace(/\s+/g, " ").trim() || userTranscript;
      const isConfirmWord = /^\s*(yes|yeah|yep|yup|sure|ok|okay|go|no|nope|cancel|stop)\s*[.!]?\s*$/i.test(cleanForPending);
      const cooldownPassed = Date.now() > pendingTaskCooldownUntil;
      // Bypass cooldown for obvious yes/no words — they can't be Gemini's own audio
      if (cleanForPending.split(/\s+/).length < 1) {
        console.log("BG: Ignoring too-short pending response:", cleanForPending);
      } else if (cooldownPassed || isConfirmWord) {
        console.log("BG: Routing to pending task handler:", cleanForPending.slice(0, 80));
        handlePendingTaskResponse(cleanForPending);
      } else {
        console.log("BG: Pending response in cooldown, ignoring:", cleanForPending.slice(0, 40));
      }
      if (fullText.includes("[RECORD_START]")) broadcastRaw({ type: "RECORD_START" });
      if (fullText.includes("[RECORD_STOP]")) broadcastRaw({ type: "RECORD_STOP" });
      return;
    }

    // Primary path: model outputs [INTENT: ...]
    const intentMatch = fullText.match(/\[INTENT:\s*([\s\S]+?)(?:\]|$)/);
    if (intentMatch) {
      const intentText = intentMatch[1].trim().replace(/\]$/, "");
      // Discard garbage/meta-commentary that Gemini sometimes emits instead of a real intent
      const isGarbage = intentText.length < 5
        || intentText.startsWith("]")
        || /output is needed|move forward naturally|conversation flow|per the rules|naturally with|fluidly/i.test(intentText);
      if (isGarbage) {
        console.log("BG: Discarding garbage [INTENT]:", intentText.slice(0, 80));
      } else if (isTaskRunning || pendingTask) {
        // Never let Gemini's echo fire a second dispatch while a task is running/pending
        console.log("BG: [INTENT] blocked — task running or pending confirmation:", intentText.slice(0, 60));
      } else {
        console.log("BG: [INTENT] detected:", intentText);
        broadcastRaw({ type: "INTENT_DETECTED", intentText });
        chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
          dispatchTask(intentText, tab).catch(e => console.error("BG: dispatchTask error:", e));
        });
      }
    } else if (userTranscript) {
      // Strip non-Latin script characters (Hindi, Arabic, CJK etc.) — transcription artifacts
      // when Gemini mishears audio. Keep ASCII + extended Latin (accented chars like é, ñ).
      const cleanTranscript = userTranscript
        .replace(/[^\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const textToRoute = cleanTranscript || userTranscript; // fallback to raw if cleaning wipes everything
      console.log("BG: No [INTENT] marker, routing transcript:", textToRoute.slice(0, 80));
      checkAndDispatchIntent(textToRoute);
    }

    if (fullText.includes("[RECORD_START]")) broadcastRaw({ type: "RECORD_START" });
    if (fullText.includes("[RECORD_STOP]")) broadcastRaw({ type: "RECORD_STOP" });
  }
}

// Decide if the user's speech is a browser task and dispatch directly.
// Uses fast keyword check first, then llama-4-scout for ambiguous cases.
const TASK_KEYWORDS = new RegExp(
  "\\b(" + [
    // Navigation / browser actions
    "go to", "navigate", "open", "search", "click", "type", "fill", "browse",
    "scroll", "close", "back", "refresh", "reload",
    // Commerce
    "book", "buy", "purchase", "order", "shop", "shopping", "checkout", "add to cart",
    // Creation / generation
    "create", "make", "build", "generate", "design", "write", "draft", "prepare",
    "produce", "compose", "develop", "set up", "put together",
    // Presentation / docs
    "presentation", "slide", "deck", "ppt", "document", "report", "essay", "summary",
    // Research / information
    "research", "find", "find me", "show me", "get me", "look for", "look up",
    "search for", "tell me about", "what is", "how to", "explain", "analyze",
    "compare", "check", "summarize", "translate", "read",
    // Media
    "play", "watch", "listen", "pause", "resume", "download", "upload",
    // Communication
    "send", "email", "message", "post", "tweet", "share",
    // Auth
    "sign in", "log in", "log out", "logout", "sign out", "register",
    // Specific sites (auto-dispatch without LLM)
    "reddit", "twitter", "youtube", "amazon", "flipkart", "instagram", "linkedin",
    "github", "google", "chatgpt", "perplexity", "gamma", "notion", "figma",
    // Intent phrases
    "want to", "need to", "help me", "can you", "please", "i'd like", "i would like",
    "could you", "i need", "i want",
    // Scheduling / time
    "schedule", "remind", "timer", "alarm", "calendar",
    // Info lookups
    "weather", "news", "price", "stock", "flight", "hotel", "restaurant"
  ].join("|") + ")\\b",
  "i"
);

async function checkAndDispatchIntent(userText) {
  // Don't interrupt a running task or pending confirmation with ambient audio/noise
  if (isTaskRunning || pendingTask) {
    console.log("BG: Task running/pending, ignoring ambient speech:", userText.slice(0, 60));
    return;
  }

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

  // No keyword match — treat as ambient conversation, don't dispatch
  console.log("BG: No task keywords, treating as conversation:", userText.slice(0, 60));
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
  } catch { }
}

// ---- CDP Manager ----
chrome.debugger.onDetach.addListener((source) => {
  cdpSessions.set(source.tabId, { attached: false });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (cdpSessions.get(tabId)?.attached) {
    chrome.debugger.detach({ tabId }).catch(() => { });
  }
  cdpSessions.delete(tabId);
  elementMaps.delete(tabId);

  // Clean up background task ownership
  const taskId = tabToTask.get(tabId);
  tabToTask.delete(tabId);
  if (taskId) {
    const bgTask = bgTasks.get(taskId);
    if (bgTask) {
      bgTask.ownedTabIds = bgTask.ownedTabIds.filter(t => t !== tabId);
      if (bgTask.ownedTabIds.length === 0 && (bgTask.status === 'running' || bgTask.status === 'awaiting_input')) {
        bgTask.abortController.abort();
        finalizeBgTask(taskId, 'aborted', 'All task tabs were closed');
      }
    }
  }
});

async function ensureAttached(tabId) {
  const session = cdpSessions.get(tabId);
  if (session?.attached) return;
  console.log("BG: Attaching CDP to tab", tabId);
  await chrome.debugger.attach({ tabId }, "1.3");
  cdpSessions.set(tabId, { attached: true });
  // Enable domains required for our pipeline
  await chrome.debugger.sendCommand({ tabId }, "Page.enable", {}).catch(() => { });
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {}).catch(() => { });
  await chrome.debugger.sendCommand({ tabId }, "Accessibility.enable", {}).catch(() => { });
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
  // 1. Get CSS viewport dimensions + devicePixelRatio so canvas coordinates match CDP mouse events
  let vpW = 1280, vpH = 800, dpr = 1;
  try {
    const { result: vp } = await cdp(tabId, "Runtime.evaluate", {
      expression: "JSON.stringify([window.innerWidth,window.innerHeight,window.devicePixelRatio])",
      returnByValue: true
    });
    [vpW, vpH, dpr] = JSON.parse(vp.value);
  } catch { }

  // 2. Raw screenshot
  const { data: screenshotB64 } = await cdp(tabId, "Page.captureScreenshot", {
    format: "jpeg", quality: 75
  });

  // 3. Accessibility tree — primary source
  let interactiveNodes = [];
  try {
    const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree");
    interactiveNodes = nodes.filter(n =>
      n.role?.value && INTERACTIVE_ROLES.has(n.role.value) && !n.ignored && n.backendDOMNodeId
    );
  } catch (e) {
    console.warn("BG: AXTree failed", e);
  }

  // 4a. Bounding boxes from AX tree
  const capped = interactiveNodes.slice(0, 60);
  const boxResults = await Promise.all(capped.map(async (node) => {
    try {
      const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
      return { node, model };
    } catch { return null; }
  }));

  const elements = [];
  const seenBackendIds = new Set();

  for (const res of boxResults) {
    if (!res) continue;
    const { node, model } = res;
    const border = model.border;
    const xs = [border[0], border[2], border[4], border[6]];
    const ys = [border[1], border[3], border[5], border[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    if (w > 2 && h > 2 && x < vpW && y < vpH && x + w > 0 && y + h > 0) {
      const name = node.name?.value || node.description?.value || "";
      seenBackendIds.add(node.backendDOMNodeId);
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

  // 4b. DOM fallback — catches React/SPA elements the AX tree misses.
  // Uses a single JS evaluation to collect all interactive elements with their rect + backendNodeId.
  // This is critical for SPAs like Gamma where the AX tree is nearly empty.
  try {
    // Step 1: collect rects + labels in one JS call and tag each element with a temp index
    const { result: tagRes } = await cdp(tabId, "Runtime.evaluate", {
      expression: `(function() {
        const vw = window.innerWidth, vh = window.innerHeight;
        const SELECTORS = 'button:not([disabled]),[role="button"],[role="tab"],[role="menuitem"],[role="option"],input:not([type="hidden"]):not([disabled]),textarea:not([disabled]),[contenteditable="true"],[contenteditable=""],a[href],select:not([disabled]),[role="textbox"],[role="searchbox"],[role="combobox"]';
        const seen = new Set();
        const out = [];
        let i = 0;
        try {
          for (const el of document.querySelectorAll(SELECTORS)) {
            if (seen.has(el)) continue; seen.add(el);
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
            const tag = 'ctrldom' + (i++);
            el.dataset.ctrlTag = tag;
            const role = el.getAttribute('role') || (el.tagName==='BUTTON'?'button':el.tagName==='A'?'link':el.tagName==='INPUT'?(el.type==='checkbox'?'checkbox':el.type==='radio'?'radio':'textbox'):el.tagName==='TEXTAREA'?'textbox':el.tagName==='SELECT'?'combobox':el.hasAttribute('contenteditable')?'textbox':'button');
            const name = (el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('title')||el.textContent?.trim()||el.tagName.toLowerCase()).slice(0,80);
            out.push({ tag, role, name, x:Math.round(r.left), y:Math.round(r.top), w:Math.round(r.width), h:Math.round(r.height) });
          }
        } catch(e){}
        return JSON.stringify(out);
      })()`,
      returnByValue: true
    });

    const domItems = JSON.parse(tagRes.value || "[]");

    if (domItems.length > 0) {
      // Step 2: get document root once, then resolve each tag to backendNodeId via DOM.querySelector
      const { root } = await cdp(tabId, "DOM.getDocument", { depth: 0 });
      const rootNodeId = root.nodeId;

      // Resolve in batches (parallel per item is fine, CDP handles it)
      const resolveResults = await Promise.all(domItems.map(async (item) => {
        try {
          const { nodeId } = await cdp(tabId, "DOM.querySelector", {
            nodeId: rootNodeId,
            selector: `[data-ctrl-tag="${item.tag}"]`
          });
          if (!nodeId) return null;
          const { node } = await cdp(tabId, "DOM.describeNode", { nodeId, depth: 0 });
          return { item, backendNodeId: node.backendNodeId };
        } catch { return null; }
      }));

      for (const res of resolveResults) {
        if (!res) continue;
        const { item, backendNodeId } = res;
        if (!backendNodeId || seenBackendIds.has(backendNodeId)) continue;
        seenBackendIds.add(backendNodeId);
        elements.push({
          index: elements.length + 1,
          backendNodeId,
          role: item.role,
          name: item.name,
          x: item.x, y: item.y, w: item.w, h: item.h
        });
      }

      // Cleanup temp data attributes
      await cdp(tabId, "Runtime.evaluate", {
        expression: `document.querySelectorAll('[data-ctrl-tag]').forEach(e=>delete e.dataset.ctrlTag)`,
        returnByValue: false
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("BG: DOM fallback failed:", e.message);
  }

  // 5. Annotate — draw screenshot scaled to CSS viewport (so annotation coords align with CDP)
  let annotatedB64 = screenshotB64;
  try {
    const screenshotBytes = Uint8Array.from(atob(screenshotB64), c => c.charCodeAt(0));
    const blob = new Blob([screenshotBytes], { type: "image/jpeg" });
    const img = await createImageBitmap(blob);

    // Canvas is in CSS pixel space — scale screenshot down if dpr > 1
    const canvas = new OffscreenCanvas(vpW, vpH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, vpW, vpH); // scales physical pixels → CSS pixels

    for (const el of elements) {
      const [r, g, b] = ROLE_COLORS[el.role] || ROLE_COLORS.default;
      ctx.fillStyle = `rgba(${r},${g},${b},0.25)`;
      ctx.fillRect(el.x, el.y, el.w, el.h);
      ctx.strokeStyle = `rgba(${r},${g},${b},1)`;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(el.x, el.y, el.w, el.h);

      // Number label at top-left of element
      const label = String(el.index);
      const labelW = label.length > 1 ? 22 : 16;
      ctx.fillStyle = `rgba(${r},${g},${b},1)`;
      ctx.fillRect(el.x, el.y, labelW, 16);
      ctx.fillStyle = "#fff";
      ctx.font = "bold 10px monospace";
      ctx.fillText(label, el.x + 2, el.y + 11);
    }

    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const arrBuf = await outBlob.arrayBuffer();
    const outBytes = new Uint8Array(arrBuf);
    let binary = "";
    for (let i = 0; i < outBytes.length; i++) binary += String.fromCharCode(outBytes[i]);
    annotatedB64 = btoa(binary);
  } catch (e) {
    console.warn("BG: annotation failed, using raw screenshot", e);
  }

  // 6. Build element list — index is what the model uses in actions; coords are reference only
  const elementList = elements.map(el => {
    const roleLabel = el.role.charAt(0).toUpperCase() + el.role.slice(1);
    const cx = Math.round(el.x + el.w / 2);
    const cy = Math.round(el.y + el.h / 2);
    return `[${el.index}] ${roleLabel} "${el.name || "(no label)"}" (x:${cx} y:${cy})`;
  }).join("\n") || "(no interactive elements visible in viewport)";

  // 7. Store element map (kept for backward compat but coords are now primary)
  const elementMap = new Map(elements.map(el => [el.index, el]));
  elementMaps.set(tabId, elementMap);

  return { annotatedB64, elementList, elementMap, vpW, vpH };
}

// ---- CDP Action Execution ----
// Click at raw CSS pixel coordinates (used by scroll, dismiss_popup, legacy paths)
async function cdpClick(tabId, x, y) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(60);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x, y, clickCount: 1 });
  await sleep(30);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", x, y, clickCount: 1 });
}

// Click by backendNodeId — scroll into view first, then re-derive coordinates.
// Much more reliable than coordinate-based clicks on SPAs after scroll/reflow.
async function cdpClickElement(tabId, backendNodeId) {
  // Scroll the element into the center of the viewport
  const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function() { this.scrollIntoView({ block: 'center', inline: 'nearest' }); }",
    silent: true
  });
  await sleep(150); // allow reflow

  // Get fresh bounding box AFTER scroll
  const { model } = await cdp(tabId, "DOM.getBoxModel", { backendNodeId });
  const b = model.border;
  const x = Math.round((b[0] + b[2] + b[4] + b[6]) / 4);
  const y = Math.round((b[1] + b[3] + b[5] + b[7]) / 4);
  await cdpClick(tabId, x, y);
  return { x, y };
}

// JS-level click fallback — triggers React/SPA synthetic event system.
// Only used when CDP mouse events have no visible effect (detected post-click).
async function jsClickElement(tabId, backendNodeId) {
  const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  await cdp(tabId, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (this.focus) this.focus();
      this.click();
      this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      this.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      this.dispatchEvent(new PointerEvent('pointerup',   { bubbles: true, cancelable: true }));
    }`,
    silent: true
  });
}

async function executeCdpAction(tabId, action, elementMap) {
  switch (action.type) {

    case "click": {
      // Preferred: index-based — scroll into view + fresh coordinates (most reliable)
      let clickIdx = action.index ?? action.elementIndex;
      // Elements are 1-based; model sometimes returns 0 meaning "first element"
      if (clickIdx === 0) clickIdx = 1;
      if (clickIdx != null) {
        const el = elementMap.get(Number(clickIdx));
        if (!el?.backendNodeId) throw new Error(`Element [${clickIdx}] not in map — use an index shown in the CLICKABLE ELEMENTS list (1-based)`);
        await cdpClickElement(tabId, el.backendNodeId);
        break;
      }
      // Coordinate fallback (legacy / navigate-bar avoidance)
      if (action.x != null && action.y != null) {
        await cdpClick(tabId, action.x, action.y);
        break;
      }
      throw new Error("click action missing index and x,y");
    }

    case "type": {
      // Preferred: index-based focus
      const typeIdx = action.index ?? action.elementIndex;
      if (typeIdx != null) {
        const el = elementMap.get(Number(typeIdx));
        if (!el?.backendNodeId) throw new Error(`Element [${typeIdx}] not in map`);
        // Scroll into view + coordinate click (activates the element in the browser)
        await cdpClickElement(tabId, el.backendNodeId);
        await sleep(80);
        // Also use DOM.focus to ensure the element is keyboard-focused
        try { await cdp(tabId, "DOM.focus", { backendNodeId: el.backendNodeId }); } catch {}
      } else if (action.x != null && action.y != null) {
        await cdpClick(tabId, action.x, action.y);
      } else {
        throw new Error("type action missing index and x,y");
      }
      await sleep(200); // longer settle for focus, especially on custom/shadow-DOM inputs

      // Select-all + delete to clear if requested
      if (action.clear) {
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 8 });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp",   key: "a", code: "KeyA", modifiers: 8 });
        await sleep(30);
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
        await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp",   key: "Backspace", code: "Backspace" });
        await sleep(30);
      }

      // insertText is fastest; fall back to char-by-char for React/Vue controlled inputs
      try {
        await cdp(tabId, "Input.insertText", { text: action.value });
      } catch {
        for (const char of action.value) {
          await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", key: char, text: char });
          await sleep(8);
        }
      }
      await sleep(50);

      // Fire React/Vue synthetic events so controlled inputs pick up the new value.
      // For index-based: use backendNodeId. For coordinate-based: target document.activeElement.
      try {
        const indexedEl = elementMap.get(Number(action.index ?? action.elementIndex));
        if (indexedEl?.backendNodeId) {
          const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId: indexedEl.backendNodeId });
          await cdp(tabId, "Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: `function(val) {
              const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype, 'value')?.set;
              const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype, 'value')?.set;
              const setter = this.tagName === 'TEXTAREA' ? textareaSetter : inputSetter;
              if (setter) setter.call(this, val);
              this.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            }`,
            arguments: [{ value: action.value }],
            silent: true
          });
        } else {
          // Coordinate-based: fire events on whatever element currently has focus
          await cdp(tabId, "Runtime.evaluate", {
            expression: `(function(val) {
              const el = document.activeElement;
              if (!el || el === document.body) return;
              try {
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                  const s = Object.getOwnPropertyDescriptor(
                    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
                  if (s) s.call(el, val);
                } else if (el.isContentEditable) {
                  // contenteditable (Stitch, Notion, etc.)
                  el.textContent = val;
                }
              } catch(e) {}
              el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            })(${JSON.stringify(action.value)})`,
            returnByValue: false
          });
        }
      } catch { /* non-critical */ }
      break;
    }

    case "scroll": {
      const amount = action.amount || 400;
      const deltaY = action.direction === "up" ? -amount : amount;
      const { result } = await cdp(tabId, "Runtime.evaluate", {
        expression: "[window.innerWidth/2, window.innerHeight/2]",
        returnByValue: true
      });
      const [cx, cy] = result.value;
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: cx, y: cy, deltaX: 0, deltaY });
      break;
    }

    case "navigate": {
      await cdp(tabId, "Page.navigate", { url: action.url });
      break;
    }

    case "keypress": {
      const KEY_CODES = {
        Enter:      { code: "Enter",      windowsVirtualKeyCode: 13 },
        Tab:        { code: "Tab",        windowsVirtualKeyCode: 9  },
        Escape:     { code: "Escape",     windowsVirtualKeyCode: 27 },
        ArrowDown:  { code: "ArrowDown",  windowsVirtualKeyCode: 40 },
        ArrowUp:    { code: "ArrowUp",    windowsVirtualKeyCode: 38 },
        ArrowLeft:  { code: "ArrowLeft",  windowsVirtualKeyCode: 37 },
        ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
        Backspace:  { code: "Backspace",  windowsVirtualKeyCode: 8  },
      };
      // If an element index is provided, refocus it before sending the key.
      // Use a physical click (not just DOM.focus) to dismiss any autocomplete dropdown
      // that may have stolen focus, then soft-focus to ensure keyboard routing is correct.
      const keypressIdx = action.index ?? action.elementIndex;
      if (keypressIdx != null) {
        const el = elementMap.get(Number(keypressIdx));
        if (el?.backendNodeId) {
          try { await cdpClickElement(tabId, el.backendNodeId); } catch {}
          await sleep(80);
          try { await cdp(tabId, "DOM.focus", { backendNodeId: el.backendNodeId }); } catch {}
          await sleep(50);
        }
      } else if (action.x != null && action.y != null) {
        // Coordinate-based refocus before sending key
        await cdpClick(tabId, action.x, action.y);
        await sleep(100);
      }
      const keyInfo = KEY_CODES[action.key] || { code: action.key, windowsVirtualKeyCode: 0 };
      // Include text/unmodifiedText for Enter so form-submission handlers fire correctly
      const extraKeyFields = action.key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {};
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: action.key, ...keyInfo, ...extraKeyFields });
      await sleep(30);
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp",   key: action.key, ...keyInfo });
      // For Enter on coordinate-based targets: also fire via JS on activeElement (handles custom submit handlers)
      if (action.key === "Enter" && keypressIdx == null) {
        await cdp(tabId, "Runtime.evaluate", {
          expression: `document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}))`,
          returnByValue: false
        }).catch(() => {});
      }
      break;
    }

    case "dismiss_popup": {
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp",   key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(200);
      await cdpClick(tabId, 10, 10).catch(() => {});
      break;
    }

    case "wait": {
      await sleep(action.ms || 500);
      break;
    }

    case "extract": {
      // No-op: model reads extracted data from the screenshot
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
  } catch { }

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

  let lastErr = new Error("Groq: all attempts failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(GROQ_BASE, {
        method: "POST",
        signal: AbortSignal.timeout(45000),
        headers: {
          "Authorization": `Bearer ${groqApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      if (res.status === 429) {
        lastErr = new Error("Groq: rate limited (429)");
        await sleep(1500 * Math.pow(2, attempt));
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

// ---- Gemini REST Vision ----
// Uses the existing Gemini API key for vision tasks — free, reliable, excellent at UI screenshots.
// Converts OpenAI-style messages (with image_url) to Gemini's generateContent format.
async function callGeminiVision(messages, { jsonMode = false } = {}) {
  if (!geminiApiKey) throw new Error("Gemini API key not set");

  // Build Gemini parts from OpenAI-style messages
  const geminiContents = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      // Gemini doesn't have system role in basic API — prepend as user text
      geminiContents.push({ role: "user", parts: [{ text: "[SYSTEM INSTRUCTIONS]\n" + msg.content }] });
      geminiContents.push({ role: "model", parts: [{ text: "Understood." }] });
      continue;
    }
    const parts = [];
    const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
    for (const part of content) {
      if (part.type === "text") {
        parts.push({ text: part.text });
      } else if (part.type === "image_url") {
        // image_url.url is "data:image/jpeg;base64,<b64>"
        const dataUrl = part.image_url?.url || "";
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }
    }
    if (parts.length) geminiContents.push({ role: msg.role === "assistant" ? "model" : "user", parts });
  }

  const body = {
    contents: geminiContents,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      ...(jsonMode ? { responseMimeType: "application/json" } : {})
    }
  };

  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

  let lastErr = new Error("Gemini vision: all attempts failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(60000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`Gemini vision: ${res.status} (attempt ${attempt + 1})`);
        await sleep(2000 * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini vision ${res.status}: ${err}`);
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(1000);
    }
  }

  // Gemini overloaded — fall back to OpenRouter vision model
  if (openRouterApiKey) {
    console.warn("BG: Gemini vision failed, falling back to OpenRouter...");
    try {
      return await callOpenRouter("google/gemini-2.5-flash", messages, { jsonMode });
    } catch (e2) {
      console.warn("BG: OpenRouter vision fallback also failed:", e2.message);
      throw lastErr;
    }
  }

  throw lastErr;
}

async function callOpenRouter(model, messages, { jsonMode = false } = {}) {
  if (!openRouterApiKey) throw new Error("OpenRouter API key not set");

  const body = {
    model,
    messages,
    temperature: 0.1,
    max_tokens: 4096,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  let lastErr = new Error("OpenRouter: all attempts failed");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(OPENROUTER_BASE, {
        method: "POST",
        signal: AbortSignal.timeout(60000),
        headers: {
          "Authorization": `Bearer ${openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/ctrl-agent",
          "X-Title": "ctrl"
        },
        body: JSON.stringify(body)
      });

      if (res.status === 429) {
        lastErr = new Error("OpenRouter: rate limited (429)");
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${err}`);
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

  const systemPrompt = `You are an intent router for a browser automation agent. Return a JSON object with these fields:

- taskType: "simple" | "multi-step" | "multi-tab-parallel" | "workflow-replay"
- skill: matching skill name or null
- startUrl: the full URL to navigate to BEFORE starting (include whenever the task clearly requires a specific website the user is NOT currently on — e.g. "book flights" → "https://www.google.com/flights"). Omit or null if the current page is already the right place.
- steps: ALWAYS include 2-5 ordered steps describing what you will do, even for simple tasks. E.g. ["Navigate to Perplexity.ai", "Enter the research query", "Extract key findings and sources"]
- parallelSubtasks: [{subGoal, startUrl}] for multi-tab-parallel only
- workflowName: string for workflow-replay only
- clarificationNeeded: true if you need more info from the user before planning
- clarificationQuestion: the question to ask the user (short, voice-friendly, 1 sentence)
- planSummary: a voice-friendly 1-sentence summary referencing the tool or site being used. E.g. "I'll use Perplexity to research best laptops under 50,000 rupees." or "I'll open Gamma.app and generate a 10-slide deck on climate change."

Available skills:
${skillList}

Rules:
- "simple" = fewer than 4 actions (navigate, scroll, play, click something)
- "multi-step" = 4+ distinct actions in sequence (fill form, book something, complete checkout)
- "multi-tab-parallel" = user explicitly wants to compare across 2+ different websites at once
- "workflow-replay" = user references a saved workflow by name

Clarification rules — DEFAULT is clarificationNeeded=false. ONLY set true when:
- The request names absolutely NO product, topic, or subject (e.g. bare "buy something" with nothing else)
- AND no site is mentioned
- NEVER ask if ANY site is mentioned (amazon, youtube, flipkart, reddit, etc.)
- NEVER ask if ANY product, topic, or action word is present
- NEVER ask for tasks that mention a specific URL or search query
- When in doubt: clarificationNeeded=false and just attempt the task


planSummary rules:
- Keep it one short sentence: "I'll [action] on [site]."
- Do NOT ask questions in planSummary — it's a statement, not a question

AI TOOL ROUTING — for these tasks, ALWAYS prefer the specialized skill listed:
- "presentation", "slides", "deck", "ppt", "pitch deck", "slideshow" → skill: ppt-gamma
- "research", "deep search", "look up", "find information about", "learn about" → skill: research-perplexity
- "compare prices", "price compare", "best price", "best deal", "how much does X cost", "find a cheaper", "compare X vs Y price" → skill: price-compare, taskType: multi-tab-parallel. ONLY use this for physical products (electronics, clothing, appliances, etc.) that can be found on shopping sites. NEVER use price-compare for hotels, flights, trains, buses, cabs, food delivery, or any travel/accommodation/service. For parallelSubtasks: if the user explicitly names specific sites (e.g. "Amazon or Flipkart", "on Amazon and Myntra"), use ONLY those sites. Otherwise default to Amazon India (amazon.in), Flipkart, and the most relevant third site for the category (electronics→croma.com, furniture/home→ikea.com/in, fashion→myntra.com). Each subGoal must say "find the CHEAPEST matching product and extract its price and title from search results".
- "buy", "shop", "find on amazon", "search on flipkart", "find on ikea", "find similar", "find something like this", "add to cart", "order this", "find this product" → skill: shopping
- "summarize video", "summarize this youtube", "what is this video about", "video summary" → skill: youtube-summarize
- "design", "UI mockup", "landing page design", "app design", "interface" → skill: design-stitch
- "fill this form", "apply", "sign up", "register", "checkout form" → skill: form-fill

SITE ROUTING — when no skill matches but the task clearly requires a specific site, set startUrl and taskType: "multi-step":
- "book flight", "flight ticket", "fly to", "search flights", "cheap flights", "cheapest flight", "budget flight", "flight from", "flights to" → startUrl: "https://www.google.com/flights"
- "book train", "train ticket", "irctc", "rail ticket" → startUrl: "https://www.irctc.co.in"
- "book hotel", "hotel booking", "find hotel", "stay in", "accommodation", "cheap hotel", "budget hotel", "hotel in", "hotels in", "cheapest hotel" → startUrl: "https://www.booking.com"
- "book bus", "bus ticket" → startUrl: "https://www.redbus.in"
- "food delivery", "order food", "zomato", "swiggy" → startUrl: "https://www.zomato.com"
- "cab", "uber", "ola", "taxi" → startUrl: "https://www.olacabs.com"
- "movie ticket", "book movie" → startUrl: "https://in.bookmyshow.com"

CURRENT PAGE AWARENESS: If the current URL is already on the right site for the task, do NOT set startUrl. If it is on a completely unrelated page (e.g., user is on deepseek.com but wants to book flights), always set startUrl to the correct site.

The vision agent handles all navigation — just describe WHAT to do.
Return ONLY valid JSON.`;

  const userMsg = `Intent: "${intentText}"
Current URL: ${currentTab?.url || "unknown"}
Page title: ${currentTab?.title || "unknown"}`;

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

// Helper: run a promise with a timeout (returns null on timeout)
function withTimeout(promise, ms) {
  return Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms))
  ]);
}

// ---- Vision Action Agent Loop ----
const VISION_SYSTEM_PROMPT = `You are a precise browser automation agent controlling a real Chrome browser via CDP.

Each round you receive:
1. An annotated screenshot — numbered colored boxes mark every interactive element
2. A CLICKABLE ELEMENTS list — each line is "[N] Role "Name" (x:CX y:CY)" where N is the index
3. Current URL, page title, task, round number

OUTPUT — return exactly this JSON (no markdown, no extra keys):
{
  "thought": "1-2 sentences: what page am I on, which element do I need, what INDEX will I use",
  "actions": [...],
  "done": false
}
When using extract, fill the fields with ACTUAL VALUES you see on screen — not descriptions:
  WRONG: {"type":"extract","fields":{"price":"price of the first result"}}
  RIGHT: {"type":"extract","fields":{"price":"₹24,990","title":"STRANDMON Wing Chair","site":"IKEA","url":"https://www.ikea.com/..."}}

ACTIONS:
{"type":"navigate","url":"https://..."}                     ← navigate to URL
{"type":"click","index":N}                                  ← click element N from CLICKABLE ELEMENTS list
{"type":"type","index":N,"value":"text","clear":true}       ← focus element N and type
{"type":"scroll","direction":"down","amount":400}            ← scroll page
{"type":"keypress","key":"Enter","index":N}                  ← sends key to element N (ALWAYS pass index for search bars — dropdowns steal focus)
{"type":"wait","ms":2000}                                    ← wait (use for page loads, AI generation)
{"type":"extract","fields":{"price":"₹24,990","title":"Product Name","site":"Amazon","url":"https://..."}} ← fill fields with ACTUAL VALUES you see — not descriptions
{"type":"dismiss_popup"}                                     ← Escape + click away to close overlays
{"type":"ask_user","fieldKey":"field_name","question":"What is your X?","elementIndex":N,"isSubjective":false} ← pause and ask user for a value you cannot determine; use when a form field's value is unknown and not visible on screen. fieldKey must be a short snake_case identifier (e.g. "first_name", "cover_letter"). Set elementIndex to the input's index so the answer is typed immediately. Set isSubjective=true for open-ended/creative fields (bio, cover letter, essay).

FORM FILLING RULES:
- For every form field whose value you do NOT know and cannot infer: output {"type":"ask_user",...} — do NOT guess or leave blank
- Profile data (name, email, phone, address, etc.) may already be stored — use ask_user anyway; the system will auto-fill from memory if available
- Never invent personal data — always ask_user for any field whose value you are uncertain about

HOW TO USE THE ELEMENT LIST:
- Indices are 1-BASED: [1] is the first element. NEVER use [0] — it does not exist.
- Find the element you want in the CLICKABLE ELEMENTS list by its role and name description
- Use its NUMBER as the "index" value: {"type":"click","index":3}
- For text inputs (Textbox, Searchbox, Combobox): use {"type":"type","index":N,"value":"text","clear":true} DIRECTLY — the type action handles focus automatically, do NOT click them first
- NEVER click a Textbox or Searchbox — always use the type action on them
- SEARCH BAR PATTERN: after typing into a search bar, ALWAYS submit with {"type":"keypress","key":"Enter","index":N} using the SAME index as the search bar — dropdowns steal focus and a bare Enter will not work
- NEVER copy x,y coordinates into your actions — use the index number only
- The (x:, y:) shown are for visual reference only

NAVIGATION — READ CAREFULLY:
- Check CURRENT URL before every round. If it is NOT the right site for the task, your VERY FIRST action MUST be {"type":"navigate","url":"https://correct-site.com"} — no exceptions.
- NEVER type into or click any element on a page that is unrelated to the task. If you are on deepseek.com, google.com, reddit.com, or ANY page that is not the booking/shopping/service site the task requires, navigate away immediately.
- NEVER use the current page's search bar to navigate to a different website — use the navigate action only.
- NEVER click the browser address bar — always use the navigate action.

WAITING FOR AI GENERATION:
- After triggering generation (Gamma slides, Perplexity search, etc.), use {"type":"wait","ms":5000}
- Then take a screenshot to check progress. Repeat waiting if still loading.
- Generation can take 10-30 seconds — be patient and keep checking

RULES:
1. Output at least one action every round unless done=true
2. Set done=true ONLY when the task is fully and visibly complete on screen
3. After navigation or clicks that load new content, add {"type":"wait","ms":1500}
4. If an element is not in the list, scroll down and look for it
5. If a click has no effect, try a different element or approach — do NOT keep clicking the same thing
6. Return ONLY the JSON object — no markdown, no extra text`;

async function runVisionActionAgent(tabId, goal, skillName, taskContext, subAgentIndex = null, signal = null, referenceB64 = null, { fieldInputFn = null, silent = false } = {}) {
  console.log("BG: VisionActionAgent start — tab:", tabId, "goal:", goal, "skill:", skillName);
  const skill = skillName ? getSkill(skillName) : null;
  const systemPrompt = VISION_SYSTEM_PROMPT + (skill?.systemPromptAddition ? "\n\n" + skill.systemPromptAddition : "");
  const maxRounds = skill?.maxRounds ?? MAX_ROUNDS;

  let extractedData = {};
  let round = 0;
  let lastThought = "";
  let consecutiveFailures = 0;
  let noActionRounds = 0;
  let lastClickKey = null;      // stuck-detection: tracks "idx:N" or "xy:X,Y"
  let sameClickCount = 0;
  let clickNoEffectCount = 0;   // change-detection: consecutive clicks with no URL/title change
  let lastClickedIdx = null;
  // Running log of completed actions — shown to the model each round so it doesn't backtrack
  const completedActions = [];
  // Screenshot cache — reuse when last round's actions didn't change the DOM
  const DOM_CHANGING_ACTIONS = new Set(["click", "navigate", "type", "keypress", "dismiss_popup", "scroll", "wait"]);
  let cachedScreenshot = null;   // { annotatedB64, elementList, elementMap }
  let prevActionsChangedDom = true; // force fresh screenshot on round 1

  broadcastEvent({ type: "AGENT_START", tabId, goal, skill: skillName });

  // Initial context screenshot: use the caller-provided reference image (e.g. the original
  // Pepperfry page for a price-compare sub-agent) if available; otherwise capture from own tab.
  let initialContextB64 = referenceB64 || null;
  if (!initialContextB64) {
    try {
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab.url && !currentTab.url.startsWith("chrome://") && !currentTab.url.startsWith("about:")) {
        ({ annotatedB64: initialContextB64 } = await buildAnnotatedScreenshot(tabId));
        console.log("BG: Initial context screenshot captured");
      }
    } catch (e) {
      console.warn("BG: initial context screenshot failed:", e.message);
    }
  } else {
    console.log("BG: Using caller-provided reference screenshot as initial context");
  }

  // If the skill requires a specific starting URL, navigate there NOW via CDP
  // before round 1. This is guaranteed — the LLM cannot skip it.
  if (skill?.startUrl) {
    try {
      const currentTab = await chrome.tabs.get(tabId);
      const currentUrl = currentTab.url || "";
      const targetHost = new URL(skill.startUrl).hostname.replace(/^www\./, "");
      if (!currentUrl.includes(targetHost)) {
        console.log("BG: Pre-navigating to skill startUrl:", skill.startUrl);
        broadcastEvent({ type: "EXECUTING", tabId, action: { type: "navigate", url: skill.startUrl }, elementName: `Navigate to ${skill.startUrl}` });
        await executeCdpAction(tabId, { type: "navigate", url: skill.startUrl }, new Map());
        await waitForPageSettle(tabId);
        await sleep(NAVIGATE_SETTLE_MS);
        broadcastEvent({ type: "ACTION_VERIFIED", tabId, action: { type: "navigate", url: skill.startUrl } });
      }
    } catch (e) {
      console.warn("BG: pre-navigate failed, continuing anyway:", e.message);
    }
  }

  while (round < maxRounds) {
    if (signal?.aborted) {
      broadcastEvent({ type: "AGENT_ABORTED", tabId });
      return { aborted: true };
    }

    round++;
    broadcastEvent({ type: "PERCEIVING", tabId, round });

    // Build annotated screenshot — skip if last round's actions were all non-DOM-changing
    // (scroll, wait, extract don't change the page; reusing the screenshot saves ~500-800ms)
    let annotatedB64, elementList, elementMap, vpW = 1280, vpH = 800;
    if (prevActionsChangedDom || cachedScreenshot === null) {
      console.log("BG: Building annotated screenshot, round", round);
      try {
        ({ annotatedB64, elementList, elementMap, vpW, vpH } = await buildAnnotatedScreenshot(tabId));
        cachedScreenshot = { annotatedB64, elementList, elementMap, vpW, vpH };
        console.log("BG: Screenshot built, elements:", elementMap.size);
      } catch (e) {
        console.error("BG: screenshot failed", e);
        await sleep(1000);
        continue;
      }
    } else {
      console.log("BG: Reusing cached screenshot, round", round, "(no DOM-changing actions last round)");
      ({ annotatedB64, elementList, elementMap, vpW, vpH } = cachedScreenshot);
    }

    // Get current tab URL and title for context
    let currentUrl = "unknown", currentTitle = "unknown";
    try {
      const tab = await chrome.tabs.get(tabId);
      currentUrl = tab.url || "unknown";
      currentTitle = tab.title || "unknown";
    } catch { }

    // Build prompt — element list now includes exact (x, y) coordinates
    const userContent = [];

    // For shopping/price-compare, keep the initial context screenshot visible through
    // round 3 so the model can visually compare product images in search results.
    const isVisualSkill = skillName === "shopping" || skillName === "price-compare" || skillName === "design-stitch";
    if ((round === 1 || (isVisualSkill && round <= 3)) && initialContextB64) {
      userContent.push({
        type: "text",
        text: "INITIAL SCREEN (what was on screen when the user made their request — analyze this to understand what product/item/content they are referring to before navigating):"
      });
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${initialContextB64}` }
      });
      userContent.push({ type: "text", text: "CURRENT SCREEN (after any navigation):" });
    }

    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${annotatedB64}` }
    });
    userContent.push(
      {
        type: "text",
        text: [
          `CURRENT URL: ${currentUrl}`,
          `PAGE TITLE: ${currentTitle}`,
          `TASK: ${goal}`,
          `Round: ${round}/${maxRounds}`,
          Object.keys(extractedData).length ? `Data extracted so far: ${JSON.stringify(extractedData)}` : "",
          completedActions.length ? `Steps already completed (DO NOT repeat these):\n${completedActions.map((a, i) => `  ${i + 1}. ${a}`).join("\n")}` : "",
          lastThought ? `Previous thought: ${lastThought}` : "",
          "",
          "CLICKABLE ELEMENTS (indices are 1-based — [1] is first, never use [0]):",
          elementList,
          elementMap.size === 0 ? [
            "",
            "⚠ 0 ELEMENTS DETECTED — DOM inspector found nothing, but you may see UI in the screenshot.",
            "Use COORDINATE-BASED actions. Viewport is " + vpW + "×" + vpH + " CSS px.",
            '  Click:    {"type":"click","x":CX,"y":CY}',
            '  Type:     {"type":"type","x":CX,"y":CY,"value":"your text","clear":true}',
            '  Submit:   {"type":"keypress","key":"Enter","x":CX,"y":CY}',
            "Look at the screenshot, estimate (x,y) of the element's center. Do NOT scroll or wait — act immediately.",
          ].join("\n") : ""
        ].filter(Boolean).join("\n")
      }
    );

    // Call vision action model — Gemini 2.0 Flash (free, excellent at UI screenshots)
    console.log("BG: Calling vision model for action decision...");
    broadcastEvent({ type: "THINKING", tabId });
    let response;
    try {
      response = await callGeminiVision([
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ], { jsonMode: true });
    } catch (e) {
      const msg = e?.message || String(e) || "Unknown API error";
      console.error("BG: Vision model call failed:", msg);
      broadcastEvent({ type: "ACTION_FAILED", tabId, error: msg });
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

    // Every 4 rounds, send a voice update so the user knows we're still working
    if (!silent && round % 4 === 0 && !done) {
      const shortThought = lastThought?.split(".")[0] || "Still working on it";
      sendToGeminiLive(`[STATUS: ${shortThought}]`);
    }

    if (done) {
      broadcastEvent({ type: "AGENT_DONE", tabId, extractedData });
      break;
    }

    // No actions returned — give the model one more chance then bail
    if (actions.length === 0) {
      noActionRounds++;
      console.warn("BG: Model returned 0 actions, noActionRounds:", noActionRounds);
      broadcastEvent({ type: "ACTION_FAILED", tabId, observation: "No actions returned" });
      if (noActionRounds >= 2) {
        console.error("BG: Agent stuck — 2 rounds with no actions, aborting");
        broadcastEvent({ type: "TASK_FAILED", error: "Agent stuck: no actions produced" });
        if (!silent) sendToGeminiLive("[TASK_FAILED: Agent could not determine next action]");
        break;
      }
      lastThought = "You must output at least one action. If the page needs navigation, navigate now.";
      await sleep(500);
      continue;
    }
    noActionRounds = 0;

    // Execute each action
    for (const action of actions) {
      if (signal?.aborted) break;

      // ---- ask_user: pause loop, check profile, then ask user if needed ----
      if (action.type === "ask_user") {
        const { fieldKey = "field", question = "What should I enter here?", isSubjective = false } = action;
        broadcastEvent({ type: "EXECUTING", tabId, action, elementName: `Ask user: ${question.slice(0, 60)}` });

        // 1. Check stored profile for a match
        const profile = await getUserProfile();
        let answer = findProfileMatch(profile, fieldKey);

        if (answer) {
          broadcastEvent({ type: "ACTION_VERIFIED", tabId, action, observation: `Using saved profile value for "${fieldKey}"` });
          broadcastEvent({ type: "THOUGHT", tabId, thought: `Found "${fieldKey}" in saved profile: "${answer.slice(0, 60)}"` });
          completedActions.push(`Auto-filled [${fieldKey}] from profile: "${answer.slice(0, 60)}"`);
        } else {
          // 2. Ask user via voice + sidepanel text input (or bg notification if running silently)
          broadcastEvent({ type: "THOUGHT", tabId, thought: `No profile match for "${fieldKey}" — asking user` });
          answer = await (fieldInputFn || waitForUserFieldInput)(question, fieldKey, isSubjective);

          if (!answer) {
            broadcastEvent({ type: "ACTION_FAILED", tabId, action, error: `No answer received for "${fieldKey}"` });
            lastThought = fieldKey === "submit_confirm"
              ? "User did not confirm submit — do NOT submit the form. Ask if they want to review anything."
              : `User did not answer for "${fieldKey}". Skip this field and continue with the remaining fields.`;
            continue;
          }

          // submit_confirm: check if user approved
          if (fieldKey === "submit_confirm") {
            const confirmed = /\b(yes|yep|yeah|ok|okay|go|sure|do it|submit|confirm|proceed)\b/i.test(answer);
            if (!confirmed) {
              broadcastEvent({ type: "ACTION_VERIFIED", tabId, action, observation: "Submit cancelled by user" });
              lastThought = "User said no to submitting. Do NOT submit. Ask if they want to change anything.";
              completedActions.push("User declined submit — do NOT submit the form");
              continue;
            }
            // Immediately click the submit button if the model included its element index
            const submitIndex = action.elementIndex ?? null;
            if (submitIndex != null) {
              try {
                broadcastEvent({ type: "EXECUTING", tabId, action: { type: "click", index: submitIndex }, elementName: "Submit form" });
                await executeCdpAction(tabId, { type: "click", index: submitIndex }, elementMap);
                await sleep(NAVIGATE_SETTLE_MS);
                broadcastEvent({ type: "ACTION_VERIFIED", tabId, action, observation: "Form submitted" });
                completedActions.push(`Clicked submit button [${submitIndex}] — form submitted`);
                lastThought = "Form submitted successfully.";
              } catch (e) {
                console.warn("BG: Immediate submit click failed:", e.message);
                completedActions.push("User confirmed submit — now click the submit button");
                lastThought = "User confirmed. Click the submit/apply button now.";
              }
            } else {
              completedActions.push("User confirmed submit — now click the submit button");
              lastThought = "User confirmed. Click the submit/apply button now. Do NOT ask again.";
            }
            continue;
          }

          // 3. For subjective/creative fields: draft polished content from raw notes
          if (isSubjective) {
            broadcastEvent({ type: "THOUGHT", tabId, thought: `Drafting polished content for "${fieldKey}" from user notes...` });
            answer = await draftSubjectiveContent(answer, question);
            broadcastEvent({ type: "ACTION_VERIFIED", tabId, action, observation: `Drafted content for "${fieldKey}"` });
          }

          // 4. Save to profile so future forms can reuse it
          try { await saveProfileFields({ [fieldKey]: answer }); } catch {}
          completedActions.push(`User provided [${fieldKey}]: "${answer.slice(0, 60)}"`);
        }

        // 5. Store answer so vision model sees it next round
        extractedData[`answer_${fieldKey}`] = answer;

        // 6. If model supplied the element index, type immediately — skips a full vision round
        const typeIndex = action.elementIndex ?? null;
        if (typeIndex != null && fieldKey !== "submit_confirm") {
          try {
            broadcastEvent({ type: "EXECUTING", tabId, action: { type: "type", index: typeIndex, value: answer }, elementName: `Fill "${fieldKey}"` });
            await executeCdpAction(tabId, { type: "type", index: typeIndex, value: answer }, elementMap);
            await sleep(SETTLE_MS);
            broadcastEvent({ type: "ACTION_VERIFIED", tabId, action, observation: `Typed value for "${fieldKey}"` });
            completedActions.push(`Typed "${answer.slice(0, 60)}" into element [${typeIndex}]`);
            lastThought = `Successfully filled "${fieldKey}". Continue with the next unfilled field or scroll to find more.`;
          } catch (e) {
            console.warn("BG: Immediate type after ask_user failed:", e.message);
            lastThought = `Got value for "${fieldKey}": "${answer.slice(0, 120)}". Now find the corresponding form field and type this value into it.`;
          }
        } else {
          lastThought = `Got value for "${fieldKey}": "${answer.slice(0, 120)}". Now find the corresponding form field and type this value into it immediately.`;
        }
        continue;
      }

      // Permission check for sensitive actions
      if (SENSITIVE_ACTIONS.has(action.type)) {
        const desc = action.type === "navigate"
          ? `navigate to ${action.url}`
          : `type "${action.value}"`;
        const perm = await showPermissionAndWait(tabId, desc);
        if (!perm) {
          broadcastEvent({ type: "ACTION_DENIED", tabId, action });
          continue;
        }
      }

      // Describe action for the log (prefer index over coordinates)
      const clickRef = action.index != null ? `[${action.index}]` : `(${action.x},${action.y})`;
      const actionLabel = action.type === "click"
        ? `Click ${clickRef}`
        : action.type === "type"
          ? `Type "${action.value?.slice(0, 40)}" on ${action.index != null ? `[${action.index}]` : `(${action.x},${action.y})`}`
          : action.type === "navigate"
            ? `Navigate to ${action.url}`
            : action.type;
      broadcastEvent({ type: "EXECUTING", tabId, action, elementName: actionLabel });

      // Snapshot URL+title before click for change-detection
      let preUrl = null, preTitle = null;
      if (action.type === "click") {
        try { const t = await chrome.tabs.get(tabId); preUrl = t.url || ""; preTitle = t.title || ""; } catch {}
      }

      try {
        await executeCdpAction(tabId, action, elementMap);
        consecutiveFailures = 0;
      } catch (e) {
        consecutiveFailures++;
        const msg = e?.message || String(e);
        console.warn("BG: action failed", action.type, msg);
        broadcastEvent({ type: "ACTION_FAILED", tabId, action, error: msg });
        if (consecutiveFailures >= 3) {
          try { await executeCdpAction(tabId, { type: "scroll", direction: "down", amount: 400 }, new Map()); } catch {}
          consecutiveFailures = 0;
          lastThought = "Multiple actions failed. Scrolled down. Reassess what is visible and try a different element or approach.";
          await sleep(600);
        }
        continue;
      }

      // Settle after action
      if (action.type === "navigate") {
        await waitForPageSettle(tabId);
        await sleep(NAVIGATE_SETTLE_MS);
      } else if (action.type !== "wait" && action.type !== "extract") {
        await sleep(SETTLE_MS);
      }

      broadcastEvent({ type: "ACTION_VERIFIED", tabId, action });

      // Merge extract action fields directly into extractedData.
      // The model fills action.fields with ACTUAL values it reads from the page.
      // This is the primary mechanism for capturing prices, titles, URLs, etc.
      if (action.type === "extract" && action.fields && typeof action.fields === "object") {
        Object.assign(extractedData, action.fields);
        console.log("BG: Extracted data from action.fields:", action.fields);
        broadcastEvent({ type: "DATA_EXTRACTED", tabId, fields: action.fields });
      }

      // Log meaningful completed actions so the model doesn't backtrack
      if (action.type === "navigate") {
        completedActions.push(`Navigated to ${action.url}`);
      } else if (action.type === "type") {
        completedActions.push(`Typed "${action.value?.slice(0, 60)}" into element [${action.index ?? action.elementIndex}]`);
      } else if (action.type === "click") {
        const elForLog = (action.index ?? action.elementIndex) != null
          ? elementMap.get(Number(action.index ?? action.elementIndex))
          : null;
        const elDesc = elForLog ? `"${elForLog.name || elForLog.role}" [${action.index ?? action.elementIndex}]` : `[${action.index ?? action.elementIndex}]`;
        completedActions.push(`Clicked ${elDesc}`);
      } else if (action.type === "wait") {
        completedActions.push(`Waited ${action.ms}ms`);
      }

      // ---- Post-click change detection ----
      if (action.type === "click" && preUrl !== null) {
        let postUrl = "", postTitle = "";
        try { const t = await chrome.tabs.get(tabId); postUrl = t.url || ""; postTitle = t.title || ""; } catch {}
        const unchanged = postUrl === preUrl && postTitle === preTitle;
        const clickIdx = action.index ?? null;

        // Clicking a textbox/searchbox/combobox only focuses it — URL/title won't change.
        // This is a valid and expected effect, so skip no-effect detection for input roles.
        const clickedEl = clickIdx != null ? elementMap.get(Number(clickIdx)) : null;
        const INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
        const isInputFocus = clickedEl && INPUT_ROLES.has(clickedEl.role);

        if (unchanged && !isInputFocus) {
          clickNoEffectCount++;
          if (clickNoEffectCount >= 3 && clickIdx === lastClickedIdx) {
            // Escalate to JS click — triggers React/SPA synthetic events
            console.warn("BG: 3 no-effect clicks on same element, escalating to JS click for index", clickIdx);
            const el = clickIdx != null ? elementMap.get(Number(clickIdx)) : null;
            if (el?.backendNodeId) {
              try {
                await jsClickElement(tabId, el.backendNodeId);
                await sleep(SETTLE_MS * 2);
                clickNoEffectCount = 0;
                lastThought = `JS click was used on element [${clickIdx}] because CDP mouse events had no effect. Check if anything changed and continue accordingly.`;
              } catch (e2) {
                console.warn("BG: JS click fallback also failed:", e2.message);
                lastThought = `Both CDP and JS click on element [${clickIdx}] had no effect. This element may not be interactive. Try a completely different approach, scroll to find other elements, or navigate away.`;
              }
            } else {
              lastThought = `Click at ${clickRef} had no visible effect 3 times. Try a different element or approach.`;
            }
          } else {
            lastThought = `Click on ${clickRef} had no visible effect (URL and title unchanged). If this keeps happening, try scrolling, clicking a different element, or using navigate.`;
          }
        } else {
          clickNoEffectCount = 0; // click worked — reset
        }
        lastClickedIdx = clickIdx;
      }

      // ---- Stuck-detection: same element/coord clicked 3+ times in a row ----
      if (action.type === "click") {
        const key = action.index != null ? `idx:${action.index}` : `xy:${action.x},${action.y}`;
        if (key === lastClickKey) {
          sameClickCount++;
          if (sameClickCount >= 4) {
            console.warn("BG: stuck — same element clicked 4x, injecting strong hint");
            lastThought = `You have clicked element ${clickRef} ${sameClickCount} times with no progress. STOP. This element is either unresponsive or the wrong target. Try: scroll down to find different elements, use a navigate action to go to a different URL, or re-read the task and choose a completely different approach.`;
            sameClickCount = 0;
          }
        } else {
          lastClickKey = key;
          sameClickCount = 1;
        }
      } else if (action.type === "navigate") {
        lastClickKey = null;
        sameClickCount = 0;
        clickNoEffectCount = 0;
      }
    }
    // Track whether this round's actions may have changed the DOM
    prevActionsChangedDom = actions.some(a => DOM_CHANGING_ACTIONS.has(a.type));
  }

  // Write result to task context if sub-agent
  if (subAgentIndex !== null && taskContext) {
    taskContext.tabs[subAgentIndex].extractedData = extractedData;
    taskContext.tabs[subAgentIndex].status = "done";
  }

  return extractedData;
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
async function runMultiTabTask(decision, intentText, signal, referenceB64 = null) {
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
  } catch { }

  broadcastEvent({ type: "TASK_STARTED", taskId, tabs: taskContext.tabs });

  // Run sub-agents in parallel
  // For price-compare each tab handles ONE site only — prepend that constraint so the
  // sub-agent doesn't try to navigate to multiple sites using the full skill prompt.
  const results = await Promise.allSettled(tabIds.map((tabId, i) => {
    const sub = parallelSubtasks[i];
    const effectiveGoal = (skill === "price-compare")
      ? `${sub.subGoal}. IMPORTANT: You are one of ${parallelSubtasks.length} parallel agents each handling a different site. Search ONLY ${sub.startUrl} — do NOT navigate to any other shopping site. You MUST finish with an extract action containing the actual price and title values you see on screen (e.g. {"type":"extract","fields":{"price":"₹499","title":"Green Cushion Cover","site":"Flipkart","url":"..."}}). Only AFTER the extract action, set done=true.`
      : sub.subGoal;
    return runVisionActionAgent(tabId, effectiveGoal, skill, taskContext, i, signal, referenceB64);
  }));

  // Merge results
  const extractedParts = results.map((r, i) => {
    if (r.status !== "fulfilled") return { error: r.reason?.message };
    const d = taskContext.tabs[i].extractedData;
    // If the agent finished but never ran an extract action, mark as not found
    if (!d || Object.keys(d).length === 0) return { error: "Agent completed without extracting data" };
    return d;
  });

  try {
    const isPriceCompare = skill === "price-compare";
    const mergePrompt = isPriceCompare
      ? `The user asked: "${intentText}"

Price data collected from each site:
${extractedParts.map((d, i) => `${parallelSubtasks[i].startUrl}: ${JSON.stringify(d)}`).join("\n")}

Produce a price comparison. Format it EXACTLY like this (fill in real values, skip sites with no data):
**Price Comparison**
• Amazon: ₹[price] — [product title]
• Flipkart: ₹[price] — [product title]
• [Site3]: ₹[price] — [product title]

**Best Deal:** [site name] at ₹[lowest price]
**Recommendation:** [1 sentence: which to buy and why]

Use only data provided above. If a site has no price, write "Not found".`
      : `The user asked: "${intentText}"

Data collected:
${extractedParts.map((d, i) => `Source ${i + 1} (${parallelSubtasks[i].startUrl}): ${JSON.stringify(d)}`).join("\n")}

Write a clear, concise answer comparing the data. Be specific with numbers and names.`;

    const summary = await callGroq("openai/gpt-oss-20b", [
      { role: "user", content: mergePrompt }
    ]);

    taskContext.status = "done";
    broadcastEvent({ type: "TASK_COMPLETE", taskId, summary, formatted: true });
    // Voice summary is a shorter version without markdown symbols
    const voiceSummary = summary.replace(/\*\*/g, "").replace(/•/g, "-");
    sendToGeminiLive(`[TASK_DONE: ${voiceSummary}]`);

    // For price-compare: offer to open the best deal URL if we have one
    if (isPriceCompare) {
      const parsePrice = (str) => {
        if (!str || typeof str !== "string") return Infinity;
        const n = parseFloat(str.replace(/[^0-9.]/g, ""));
        return isNaN(n) ? Infinity : n;
      };
      const bestDeal = extractedParts
        .filter(d => d && !d.error && d.price && parsePrice(d.price) < Infinity)
        .sort((a, b) => parsePrice(a.price) - parsePrice(b.price))[0];

      if (bestDeal?.url && bestDeal.url.startsWith("http")) {
        const label = `${bestDeal.title ? bestDeal.title.slice(0, 50) : "the product"} at ${bestDeal.price} on ${bestDeal.site || "the site"}`;
        const answer = await waitForUserFieldInput(
          `Best deal is ${label}. Want me to open it for you?`,
          "open_best_deal",
          false,
          30000
        );
        const wantsOpen = /\b(yes|yeah|yep|ok|okay|sure|go|open|show|please|do it)\b/i.test(answer || "");
        if (wantsOpen) {
          chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
            if (activeTab) chrome.tabs.update(activeTab.id, { url: bestDeal.url, active: true });
          });
        }
      }
    }

    return summary;
  } catch (e) {
    taskContext.status = "failed";
    broadcastEvent({ type: "TASK_FAILED", taskId, error: e.message });
    sendToGeminiLive(`[TASK_FAILED: Could not merge results]`);
    return null;
  }
}

// ---- Screen description (for visual-reference intents) ----
const SCREEN_REF = /\b(on screen|on the screen|this page|current page|what i see|what('s| is) on|like this|this one|looking at|can you see|see this|visible|showing|displayed|screenshot|this tab|current tab)\b/i;

// Matches when user references a text document open in the current tab
const DOC_REF = /\b(this document|in this doc|from this doc|this doc|the document|in the document|from the document|this file|in this file|on this page|from this page|description (is |are )?(in|on|from)|specs? (are |is )?(in|on|from)|requirements? (are |is )?(in|on|from))\b/i;

// Extract readable text from the current tab (for docs, articles, etc.)
async function extractPageText(tabId, maxChars = 4000) {
  try {
    const { result } = await cdp(tabId, "Runtime.evaluate", {
      expression: `
        (function() {
          // Google Docs: get text from the canvas-rendered doc area
          const gdoc = document.querySelector('.kix-appview-editor');
          if (gdoc) return gdoc.innerText.slice(0, ${maxChars});
          // Notion, Confluence, etc.
          const article = document.querySelector('article, [role="main"], main, .notion-page-content');
          if (article) return article.innerText.slice(0, ${maxChars});
          // Fallback: body text
          return document.body.innerText.slice(0, ${maxChars});
        })()
      `,
      returnByValue: true
    });
    const text = result?.value?.trim();
    return text?.length > 50 ? text : null;
  } catch (e) {
    console.warn("BG: extractPageText failed:", e.message);
    return null;
  }
}

async function describeCurrentScreen(tabId) {
  try {
    const { data: b64 } = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const raw = await callGeminiVision([{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
        { type: "text", text: "Describe what is on this webpage in 1-2 sentences. Focus on the main content, product, or subject that is visible. Be specific about names, prices, or key details." }
      ]
    }]);
    return raw?.trim() || null;
  } catch (e) {
    console.warn("BG: screen describe failed", e);
    return null;
  }
}

// ---- Local skill routing (no API call needed) ----
// Matches intent text to a skill name using keyword rules — same logic as orchestrator
// but instant and offline. Used as fast-path before / fallback after orchestrator.
function inferSkillFromIntent(intentText) {
  const t = intentText.toLowerCase();
  if (/\b(presentation|slides?|deck|ppt|pitch deck|slideshow|gamma)\b/.test(t)) return "ppt-gamma";
  if (/\b(research|deep search|look up|find information|learn about|perplexity)\b/.test(t)) return "research-perplexity";
  // Don't route travel/accommodation "cheap" requests to price-compare
  const isTravelContext = /\b(hotel|flight|fly|train|bus|ticket|accommodation|stay|room|hostel|resort|cab|taxi|uber|ola)\b/.test(t);
  if (!isTravelContext && /\b(compare prices?|cheapest|best price|best deal|how much does|price compare)\b/.test(t)) return "price-compare";
  if (/\b(summarize (this |the )?video|youtube summary|what is this video|video summary)\b/.test(t)) return "youtube-summarize";
  if (/\b(design|ui mockup|landing page design|app design|interface design|stitch)\b/.test(t)) return "design-stitch";
  if (/\b(fill (this |the )?form|apply|sign up|register|checkout form|form fill)\b/.test(t)) return "form-fill";
  return null;
}

// ---- Main task dispatcher ----
async function dispatchTask(intentText, currentTab) {
  console.log("BG: dispatchTask:", intentText, "| tab:", currentTab?.url);
  if (abortController) abortController.abort();
  abortController = new AbortController();

  broadcastEvent({ type: "TASK_DISPATCHED", intentText, tabId: currentTab?.id });

  // Augment with screen context FIRST — must happen before fast-path so skills like
  // price-compare and shopping know what product is on screen before routing.
  if (currentTab?.id) {
    const tabUrl = currentTab.url || "";
    // Always extract text when on a known document platform — regardless of how Gemini phrased the intent
    const IS_DOC_PAGE = /docs\.google\.com|notion\.so|confluence|quip\.com|coda\.io|dropbox\.com\/.*\.(doc|txt)/.test(tabUrl);
    if (IS_DOC_PAGE || DOC_REF.test(intentText)) {
      const pageText = await extractPageText(currentTab.id).catch(() => null);
      if (pageText && !intentText.includes("[DOC CONTENT:")) {
        intentText = `${intentText} [DOC CONTENT: ${pageText}]`;
        console.log("BG: Injected doc text, chars:", pageText.length);
        broadcastEvent({ type: "INTENT_DETECTED", intentText });
      }
    }
    // Visual/product reference: describe the current screen via screenshot
    if (SCREEN_REF.test(intentText) && !IS_DOC_PAGE) {
      const screenDesc = await describeCurrentScreen(currentTab.id).catch(() => null);
      if (screenDesc) {
        intentText = `${intentText} [SCREEN SHOWS: ${screenDesc}]`;
        console.log("BG: Augmented intent with screen:", intentText.slice(0, 100));
        broadcastEvent({ type: "INTENT_DETECTED", intentText });
      }
    }
  }

  // Fast-path skill routing — runs before orchestrator so we never block on API failure
  const fastSkill = inferSkillFromIntent(intentText);
  if (fastSkill) {
    console.log("BG: Fast-path skill:", fastSkill, "for:", intentText.slice(0, 80));
    // Best-effort: ask the orchestrator to confirm or override the fast-path choice,
    // but don't block the user for long. If orchestrator responds quickly and
    // suggests a different skill, prefer that decision.
    let orchestratorDecision = null;
    try {
      orchestratorDecision = await withTimeout(runOrchestrator(intentText, currentTab), 1400);
    } catch (e) {
      console.warn("BG: quick orchestrator check failed:", e?.message || e);
      orchestratorDecision = null;
    }

    if (orchestratorDecision && orchestratorDecision.skill && orchestratorDecision.skill !== fastSkill) {
      console.log("BG: Orchestrator overrode fast-skill:", orchestratorDecision.skill, "replacing", fastSkill);
      const planText = orchestratorDecision.planSummary || `Working on: ${intentText}`;
      broadcastEvent({ type: "PLAN_ANNOUNCED", steps: orchestratorDecision.steps, planText, tabId: currentTab?.id });
      sendToGeminiLive(`[STATUS: ${planText}]`);
      await sleep(1200);
      if (abortController.signal.aborted) return;
      await executePlan(orchestratorDecision, intentText, currentTab);
      return;
    }

    const planText = `On it — using ${fastSkill}.`;
    broadcastEvent({ type: "PLAN_ANNOUNCED", planText, tabId: currentTab?.id });
    sendToGeminiLive(`[STATUS: Starting now.]`);
    // Brief pause so the user can click "do in background" if they want
    await sleep(1200);
    if (abortController.signal.aborted) return;
    await executePlan({ taskType: "simple", skill: fastSkill, steps: [] }, intentText, currentTab);
    return;
  }

  // Run orchestrator for routing decisions (best-effort — never blocks execution on failure)
  let decision;
  try {
    decision = await runOrchestrator(intentText, currentTab);
  } catch (e) {
    console.warn("BG: Orchestrator failed, using simple fallback:", e.message);
    decision = { taskType: "simple", skill: null, steps: [] };
  }

  if (abortController.signal.aborted) return;

  // Never ask for confirmation — always execute immediately.
  // The agent announces the plan via STATUS and gets to work.
  const planText = decision.planSummary || `Working on: ${intentText}`;
  broadcastEvent({ type: "PLAN_ANNOUNCED", steps: decision.steps, planText, tabId: currentTab?.id });
  sendToGeminiLive(`[STATUS: ${planText}]`);
  // Brief pause so the user can click "do in background" if they want
  await sleep(1200);
  if (abortController.signal.aborted) return;
  await executePlan(decision, intentText, currentTab);
}

// ---- Execute a decided plan ----
async function executePlan(decision, intentText, currentTab) {
  // User pressed "do in background" before execution started — fork to bg mode
  if (pendingBackgroundFlag) {
    pendingBackgroundFlag = false;
    if (bgTasks.size >= MAX_BG_TASKS) {
      sendToRobot(currentTab?.id, {
        type: 'ROBOT_MSG',
        text: `Already running ${MAX_BG_TASKS} background tasks. Wait for one to finish.`,
        msgType: 'speech'
      });
      return;
    }
    const bgTask = createBgTask(intentText, currentTab?.id);
    runBgTask(bgTask, decision, intentText, currentTab).catch(e => {
      finalizeBgTask(bgTask.taskId, 'failed', null, e?.message);
    });
    return;
  }

  if (abortController) abortController.abort();
  abortController = new AbortController();
  const { signal } = abortController;
  isTaskRunning = true;
  foregroundTask = { decision, intentText, currentTab };
  const myGen = ++fgTaskGeneration;
  chrome.storage.session.set({ ctrl_robot_display: { state: 'acting', isRunning: true } }).catch(() => {});

  try {
    const { taskType, skill, steps, parallelSubtasks } = decision;

    if (taskType === "workflow-replay") {
      await replayWorkflow(decision.workflowName, currentTab?.id, signal);
      return;
    }

    // price-compare always runs in parallel tabs — fallback if orchestrator missed it
    if (skill === "price-compare" && taskType !== "multi-tab-parallel") {
      decision.taskType = "multi-tab-parallel";
      if (!decision.parallelSubtasks?.length) {
        // Extract the product description from SCREEN SHOWS so sub-agents get a real search term
        const screenMatch = intentText.match(/\[SCREEN SHOWS:\s*([^\]]+)\]/);
        const productHint = screenMatch
          ? screenMatch[1].slice(0, 200)
          : intentText.replace(/\[SCREEN SHOWS:[^\]]*\]/g, "").trim().slice(0, 120);

        // Detect explicitly mentioned sites — if user said "Amazon or Flipkart", use only those
        const it = intentText.toLowerCase();
        const SITE_MAP = [
          { re: /\bamazon\b/,   label: "Amazon India",  url: "https://www.amazon.in" },
          { re: /\bflipcart\b|\bflipkart\b/, label: "Flipkart", url: "https://www.flipkart.com" },
          { re: /\bikea\b/,     label: "IKEA India",    url: "https://www.ikea.com/in" },
          { re: /\bmyntra\b/,   label: "Myntra",        url: "https://www.myntra.com" },
          { re: /\bcroma\b/,    label: "Croma",         url: "https://www.croma.com" },
          { re: /\bmeesho\b/,   label: "Meesho",        url: "https://www.meesho.com" },
          { re: /\bnykaa\b/,    label: "Nykaa",         url: "https://www.nykaa.com" },
        ];
        const mentionedSites = SITE_MAP.filter(s => s.re.test(it));

        let sites;
        if (mentionedSites.length >= 2) {
          // User explicitly named specific sites — use only those
          sites = mentionedSites;
        } else if (mentionedSites.length === 1) {
          // User named one site — add a second sensible default
          const other = mentionedSites[0].url.includes("amazon") ? SITE_MAP[1] : SITE_MAP[0];
          sites = [mentionedSites[0], other];
        } else {
          // No explicit sites — default to Amazon + Flipkart + category-appropriate third
          sites = [
            { label: "Amazon India", url: "https://www.amazon.in" },
            { label: "Flipkart",     url: "https://www.flipkart.com" },
            { label: "IKEA India",   url: "https://www.ikea.com/in" },
          ];
        }

        decision.parallelSubtasks = sites.map(s => ({
          subGoal: `Search for a product matching this description on ${s.label} and extract the CHEAPEST matching price and title from search results: "${productHint}"`,
          startUrl: s.url
        }));
      }
    }

    if (taskType === "multi-tab-parallel" || decision.taskType === "multi-tab-parallel") {
      // Capture the original tab's screenshot to share with sub-agents as a visual reference
      let referenceB64 = null;
      try {
        if (currentTab?.id) {
          ({ annotatedB64: referenceB64 } = await buildAnnotatedScreenshot(currentTab.id));
        }
      } catch (e) {
        console.warn("BG: Failed to capture reference screenshot for sub-agents:", e.message);
      }
      await runMultiTabTask(decision, intentText, signal, referenceB64);
      return;
    }

    const tabId = currentTab?.id;
    if (!tabId) {
      broadcastEvent({ type: "TASK_FAILED", error: "No active tab" });
      sendToGeminiLive("[TASK_FAILED: No active tab found]");
      return;
    }

    // Pre-navigate for non-skill tasks when orchestrator says the current page is wrong
    if (!skill && decision.startUrl) {
      try {
        const tab = await chrome.tabs.get(tabId);
        const targetHost = new URL(decision.startUrl).hostname.replace(/^www\./, "");
        if (!(tab.url || "").includes(targetHost)) {
          console.log("BG: Pre-navigating non-skill task to:", decision.startUrl);
          broadcastEvent({ type: "EXECUTING", tabId, action: { type: "navigate", url: decision.startUrl }, elementName: `Navigating to ${decision.startUrl}` });
          await executeCdpAction(tabId, { type: "navigate", url: decision.startUrl }, new Map());
          await waitForPageSettle(tabId);
          await sleep(NAVIGATE_SETTLE_MS);
          broadcastEvent({ type: "ACTION_VERIFIED", tabId, action: { type: "navigate", url: decision.startUrl } });
        }
      } catch (e) {
        console.warn("BG: pre-navigate failed, agent will handle navigation:", e.message);
      }
    }

    // Helper: run agent and handle errors cleanly
    const runAgent = async (goal, skillName) => {
      try {
        return await runVisionActionAgent(tabId, goal, skillName, null, null, signal);
      } catch (e) {
        const msg = e?.message || String(e) || "Agent error";
        console.error("BG: agent crashed:", msg);
        broadcastEvent({ type: "TASK_FAILED", error: msg });
        sendToGeminiLive(`[TASK_FAILED: ${msg}]`);
        return null;
      }
    };

    // If a skill is matched, always run as a SINGLE agent regardless of step count.
    if (skill) {
      const stepPreview = decision?.steps?.length
        ? `Starting now. First: ${decision.steps[0]}.`
        : `Starting now. I'll handle it step by step.`;
      sendToGeminiLive(`[STATUS: ${stepPreview}]`);

      // Augment the goal with stored user profile for form-fill
      let agentGoal = intentText;
      if (skill === "form-fill") {
        try {
          const profile = await getUserProfile();
          const profileStr = formatProfileForAgent(profile);
          if (profileStr) agentGoal = agentGoal + "\n\nUser profile for form filling: " + profileStr;
        } catch (e) {
          console.warn("BG: failed to load user profile for form-fill", e);
        }
      }

      const result = await runAgent(agentGoal, skill);
      if (result !== null && !signal.aborted) {
        const summary = typeof result === "object" && Object.keys(result).length
          ? `Done. ${JSON.stringify(result)}`
          : "Done.";
        sendToGeminiLive(`[TASK_DONE: ${summary}]`);
      }
      return;
    }

    if (taskType === "simple" || !steps?.length) {
      const result = await runAgent(intentText, null);
      if (result !== null && !signal.aborted) {
        const summary = typeof result === "object" && Object.keys(result).length
          ? `Done. ${JSON.stringify(result)}`
          : "Done.";
        sendToGeminiLive(`[TASK_DONE: ${summary}]`);
      }
      return;
    }

    // True multi-step (no skill): run steps sequentially
    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) break;
      broadcastEvent({ type: "STEP_START", step: i + 1, total: steps.length, desc: steps[i] });
      sendToGeminiLive(`[STATUS: Step ${i + 1} of ${steps.length}: ${steps[i]}]`);
      const stepGoal = `Overall goal: ${intentText}\nCurrent step ${i + 1} of ${steps.length}: ${steps[i]}`;
      const res = await runAgent(stepGoal, null);
      if (res === null) return; // agent crashed, already reported
      broadcastEvent({ type: "STEP_DONE", step: i + 1, total: steps.length });
      if (!signal.aborted && i < steps.length - 1) {
        sendToGeminiLive(`[STATUS: Step ${i + 1} done. Moving to step ${i + 2}: ${steps[i + 1]}]`);
      }
    }

    if (!signal.aborted) {
      sendToGeminiLive(`[TASK_DONE: Completed all ${steps.length} steps for: ${intentText}]`);
    }
  } finally {
    if (fgTaskGeneration === myGen) {
      isTaskRunning = false;
      foregroundTask = null;
      chrome.storage.session.set({ ctrl_robot_display: { state: 'idle', isRunning: false } }).catch(() => {});
    }
  }
}

// ---- Handle user reply to a pending plan/clarification ----
const CONFIRM_YES = /\b(yes|yeah|yep|yup|sure|ok|okay|go|proceed|do it|let's go|let's do it|continue|sounds good|go ahead|perfect|great|fine|correct|right|exactly)\b/i;
const CONFIRM_NO  = /\b(no|nope|nah|cancel|stop|don't|abort|nevermind|never mind|wait|hold on|actually)\b/i;

async function handlePendingTaskResponse(userText) {
  if (!pendingTask) return;
  const { intentText, decision, tab, step } = pendingTask;
  pendingTask = null;

  if (step === "clarify") {
    // User answered the clarification — re-orchestrate with the enriched intent
    const enriched = `${intentText} — user specified: ${userText}`;
    console.log("BG: Clarification received, re-dispatching:", enriched);
    broadcastRaw({ type: "INTENT_DETECTED", intentText: enriched });
    chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
      dispatchTask(enriched, activeTab || tab).catch(console.error);
    });
    return;
  }

  if (step === "confirm") {
    if (CONFIRM_NO.test(userText)) {
      console.log("BG: Plan rejected by user");
      sendToGeminiLive("[TASK_FAILED: Cancelled by user]");
      broadcastEvent({ type: "TASK_ABORTED" });
      return;
    }
    if (CONFIRM_YES.test(userText)) {
      console.log("BG: Plan confirmed, executing");
      await executePlan(decision, intentText, tab);
      return;
    }
    // User gave a modification (e.g. "but use Flipkart instead")
    const enriched = `${intentText} — modified: ${userText}`;
    console.log("BG: Plan modified:", enriched);
    broadcastRaw({ type: "INTENT_DETECTED", intentText: enriched });
    chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
      dispatchTask(enriched, activeTab || tab).catch(console.error);
    });
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

// ---- Background Task Helpers ----

function persistBgTasks() {
  const serializable = [...bgTasks.values()].map(t => ({
    taskId: t.taskId, intentText: t.intentText, status: t.status,
    originTabId: t.originTabId, ownedTabIds: t.ownedTabIds,
    tabGroupId: t.tabGroupId, startTime: t.startTime, summary: t.summary,
    hasPendingQuestion: !!t.pendingFieldQuestion,
    question: t.pendingFieldQuestion?.question,
    fieldKey: t.pendingFieldQuestion?.fieldKey
  }));
  chrome.storage.session.set({ ctrl_bg_tasks: serializable }).catch(() => {});
}

function createBgTask(intentText, originTabId) {
  const taskId = crypto.randomUUID();
  const bgTask = {
    taskId, intentText, status: 'pending',
    originTabId: originTabId || null,
    ownedTabIds: [], tabGroupId: null,
    abortController: new AbortController(),
    pendingFieldQuestion: null,
    startTime: Date.now(), summary: null
  };
  bgTasks.set(taskId, bgTask);
  if (originTabId) tabToTask.set(originTabId, taskId);
  persistBgTasks();
  broadcastRaw({ type: 'BG_TASKS_UPDATED' });
  return bgTask;
}

function finalizeBgTask(taskId, status, summary = null, errorMsg = null) {
  const bgTask = bgTasks.get(taskId);
  if (!bgTask) return;
  bgTask.status = status;
  bgTask.summary = summary;

  const notifTitle = status === 'done' ? 'ctrl — Task Complete' : 'ctrl — Task ' + (status === 'aborted' ? 'Cancelled' : 'Failed');
  const notifMsg = (summary || errorMsg || bgTask.intentText).slice(0, 150);
  chrome.notifications.create(`ctrl-bg-done-${taskId}`, {
    type: 'basic', iconUrl: 'icons/icon128.png',
    title: notifTitle, message: notifMsg, requireInteraction: false
  }).catch(() => {});

  // Update badge to reflect remaining running tasks
  const runningCount = [...bgTasks.values()].filter(t => t.status === 'running' || t.status === 'awaiting_input').length;
  chrome.action.setBadgeText({ text: runningCount > 0 ? String(runningCount) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#818cf8' }).catch(() => {});

  sendToRobot(bgTask.originTabId, {
    type: 'ROBOT_BG_COMPLETE', taskId, status,
    summary: summary?.slice(0, 120), intentText: bgTask.intentText
  });
  for (const tabId of bgTask.ownedTabIds) {
    sendToRobot(tabId, { type: 'ROBOT_BG_IDLE', taskId });
  }

  persistBgTasks();
  broadcastRaw({ type: 'BG_TASKS_UPDATED' });
}

function waitForBgTaskFieldInput(bgTask, question, fieldKey, isSubjective = false, timeout = 90000) {
  return new Promise((resolve) => {
    bgTask.pendingFieldQuestion = { fieldKey, question, isSubjective, resolve };
    bgTask.status = 'awaiting_input';
    persistBgTasks();

    chrome.notifications.create(`ctrl-fq-${bgTask.taskId}-${fieldKey}`, {
      type: 'basic', iconUrl: 'icons/icon128.png',
      title: 'ctrl needs your input',
      message: question.slice(0, 100),
      requireInteraction: true,
      buttons: [{ title: 'Answer' }]
    }).catch(() => {});

    chrome.action.setBadgeText({ text: '?' }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }).catch(() => {});

    sendToRobot(bgTask.originTabId, {
      type: 'ROBOT_BG_QUESTION',
      taskId: bgTask.taskId,
      question, fieldKey
    });
    broadcastRaw({ type: 'BG_TASKS_UPDATED' });

    setTimeout(() => {
      if (bgTask.pendingFieldQuestion?.resolve === resolve) {
        bgTask.pendingFieldQuestion = null;
        bgTask.status = 'running';
        chrome.action.setBadgeText({ text: '' }).catch(() => {});
        persistBgTasks();
        broadcastEvent({ type: 'FIELD_ANSWERED', fieldKey, answer: null, timedOut: true });
        resolve(null);
      }
    }, timeout);
  });
}

// Runs a decided plan in a background tab (non-blocking, isolated from foreground task)
async function runBgTask(bgTask, decision, intentText, currentTab) {
  bgTask.status = 'running';
  persistBgTasks();

  const runningCount = [...bgTasks.values()].filter(t => t.status === 'running' || t.status === 'awaiting_input').length;
  chrome.action.setBadgeText({ text: String(runningCount) }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#818cf8' }).catch(() => {});

  const { signal } = bgTask.abortController;
  const fieldInputFn = (question, fieldKey, isSubjective) =>
    waitForBgTaskFieldInput(bgTask, question, fieldKey, isSubjective);

  try {
    let { taskType, skill, steps, parallelSubtasks } = decision;

    // Multi-tab parallel: run existing logic but mute all spawned tabs and track them
    if (taskType === 'multi-tab-parallel' || (skill === 'price-compare' && taskType !== 'multi-tab-parallel')) {
      const tabsBefore = new Set((await chrome.tabs.query({})).map(t => t.id));
      const result = await runMultiTabTask(decision, intentText, signal);
      const tabsAfter = await chrome.tabs.query({});
      const newTabIds = [];
      for (const tab of tabsAfter) {
        if (!tabsBefore.has(tab.id)) {
          bgTask.ownedTabIds.push(tab.id);
          tabToTask.set(tab.id, bgTask.taskId);
          chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
          newTabIds.push(tab.id);
        }
      }
      // Group the new tabs if not already grouped
      if (newTabIds.length > 0) {
        try {
          const groupId = await chrome.tabs.group({ tabIds: newTabIds });
          await chrome.tabGroups.update(groupId, {
            title: `ctrl: ${intentText.slice(0, 22)}`,
            color: 'purple',
            collapsed: true
          });
          bgTask.tabGroupId = groupId;
        } catch {}
      }
      const summary = typeof result === 'string' ? result.slice(0, 120) : `"${intentText.slice(0, 60)}" complete`;
      finalizeBgTask(bgTask.taskId, 'done', summary);
      return;
    }

    // Single-tab: create a fresh background tab in a named tab group
    const startUrl = decision.startUrl || 'about:blank';
    const bgTab = await chrome.tabs.create({ url: startUrl, active: false });
    await chrome.tabs.update(bgTab.id, { muted: true });
    bgTask.ownedTabIds.push(bgTab.id);
    tabToTask.set(bgTab.id, bgTask.taskId);

    // Put the tab in its own named group so it stays organised
    try {
      const groupId = await chrome.tabs.group({ tabIds: [bgTab.id] });
      await chrome.tabGroups.update(groupId, {
        title: `ctrl: ${intentText.slice(0, 22)}`,
        color: 'purple',
        collapsed: false
      });
      bgTask.tabGroupId = groupId;
    } catch { /* tabGroups API may not be available on some builds */ }

    persistBgTasks();

    sendToRobot(bgTask.originTabId, {
      type: 'ROBOT_BG_STARTED', taskId: bgTask.taskId, intentText
    });

    const tabId = bgTab.id;
    if (startUrl !== 'about:blank') {
      await waitForPageSettle(tabId).catch(() => {});
      await sleep(NAVIGATE_SETTLE_MS);
    }

    const runAgent = async (goal, skillName) => {
      try {
        return await runVisionActionAgent(tabId, goal, skillName, null, null, signal, null,
          { fieldInputFn, silent: true });
      } catch (e) {
        const msg = e?.message || String(e);
        console.error('BG: bg task agent error:', msg);
        broadcastEvent({ type: 'TASK_FAILED', tabId, error: msg });
        return null;
      }
    };

    let result = null;
    if (skill) {
      let agentGoal = intentText;
      if (skill === 'form-fill') {
        try {
          const profile = await getUserProfile();
          const profileStr = formatProfileForAgent(profile);
          if (profileStr) agentGoal += '\n\nUser profile for form filling: ' + profileStr;
        } catch {}
      }
      result = await runAgent(agentGoal, skill);
    } else if (taskType === 'simple' || !steps?.length) {
      result = await runAgent(intentText, null);
    } else {
      for (let i = 0; i < steps.length; i++) {
        if (signal.aborted) break;
        broadcastEvent({ type: 'STEP_START', step: i + 1, total: steps.length, desc: steps[i], tabId });
        const stepGoal = `Overall goal: ${intentText}\nCurrent step ${i + 1} of ${steps.length}: ${steps[i]}`;
        const res = await runAgent(stepGoal, null);
        if (res === null) {
          finalizeBgTask(bgTask.taskId, 'failed', null, 'Agent step failed');
          return;
        }
        broadcastEvent({ type: 'STEP_DONE', step: i + 1, total: steps.length, tabId });
      }
      result = {};
    }

    if (signal.aborted) { finalizeBgTask(bgTask.taskId, 'aborted'); return; }

    const summary = result && typeof result === 'object' && Object.keys(result).length
      ? `Done: ${Object.entries(result).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`).join(', ')}`
      : `Done: ${intentText.slice(0, 80)}`;
    finalizeBgTask(bgTask.taskId, 'done', summary);

  } catch (e) {
    if (!signal.aborted) {
      console.error('BG: runBgTask error:', e);
      finalizeBgTask(bgTask.taskId, 'failed', null, e?.message || 'Unknown error');
    } else {
      finalizeBgTask(bgTask.taskId, 'aborted');
    }
  }
}

// ---- Message Handler ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === "CONNECT_WEBSOCKET") {
    connectGeminiLive(message.apiKey);
    sendResponse({ success: true });
    return;
  }

  if (message.type === "DISCONNECT_WEBSOCKET") {
    intentionalClose = true;
    if (geminiSocket) {
      geminiSocket.onclose = null; // prevent auto-reconnect handler from firing
      geminiSocket.close();
      geminiSocket = null;
    }
    // intentionalClose stays true until connectGeminiLive is called next time
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

  if (message.type === "SET_OPENROUTER_KEY") {
    openRouterApiKey = message.apiKey;
    chrome.storage.local.set({ openrouter_key: message.apiKey });
    console.log("BG: OpenRouter key set");
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
    // If sent from a content script (robot), track the tab for robot forwarding
    if (sender?.tab?.id) {
      currentAgentTabId = sender.tab.id;
      robotMicTabId = sender.tab.id; // enable audio forwarding to this tab
      console.log("BG: START_MIC from robot in tab", sender.tab.id);
    } else {
      robotMicTabId = null; // sidepanel handles its own audio
    }
    ensureOffscreen().then(() => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "OFFSCREEN_START_MIC" }).catch(() => { });
      }, 300);
      sendResponse({ success: true });
    }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (message.type === "STOP_MIC") {
    robotMicTabId = null; // stop forwarding audio to robot
    chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_MIC" }).catch(() => { });
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

  if (message.type === "FIELD_ANSWER_TEXT") {
    if (pendingFieldQuestion) {
      const { fieldKey, resolve } = pendingFieldQuestion;
      pendingFieldQuestion = null;
      const answer = message.text?.trim() || "";
      broadcastEvent({ type: "FIELD_ANSWERED", fieldKey, answer });
      resolve(answer || null);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "ABORT_TASK") {
    pendingTask = null;
    if (pendingFieldQuestion) {
      const { resolve } = pendingFieldQuestion;
      pendingFieldQuestion = null;
      resolve(null);
    }
    isTaskRunning = false;
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

  // ---- Background task messages ----

  if (message.type === "SEND_TO_BACKGROUND") {
    if (isTaskRunning && foregroundTask) {
      // Task is mid-execution — abort it and re-spawn immediately as a bg task
      const { decision, intentText, currentTab } = foregroundTask;
      foregroundTask = null;
      isTaskRunning = false;
      pendingBackgroundFlag = false; // clear any stale flag to prevent double-spawn
      fgTaskGeneration++; // invalidate the running executePlan's finally block
      if (pendingFieldQuestion) { pendingFieldQuestion.resolve(null); pendingFieldQuestion = null; }
      abortController?.abort();
      chrome.storage.session.set({ ctrl_robot_display: { state: 'idle', isRunning: false } }).catch(() => {});
      if (bgTasks.size < MAX_BG_TASKS) {
        const bgTask = createBgTask(intentText, currentTab?.id);
        runBgTask(bgTask, decision, intentText, currentTab).catch(e => {
          finalizeBgTask(bgTask.taskId, 'failed', null, e?.message);
        });
      }
    } else {
      // Between plan-announced and execution start — set flag for executePlan to fork
      pendingBackgroundFlag = true;
    }
    sendResponse({ success: true });
    return;
  }

  if (message.type === "BG_FIELD_ANSWER") {
    const bgTask = bgTasks.get(message.taskId);
    if (bgTask?.pendingFieldQuestion) {
      const { fieldKey, resolve } = bgTask.pendingFieldQuestion;
      bgTask.pendingFieldQuestion = null;
      bgTask.status = 'running';
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
      persistBgTasks();
      broadcastEvent({ type: 'FIELD_ANSWERED', fieldKey, answer: message.text });
      resolve(message.text || null);
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "ABORT_BG_TASK") {
    const bgTask = bgTasks.get(message.taskId);
    if (bgTask) {
      bgTask.abortController.abort();
      if (bgTask.pendingFieldQuestion) {
        bgTask.pendingFieldQuestion.resolve(null);
        bgTask.pendingFieldQuestion = null;
      }
      for (const tabId of bgTask.ownedTabIds) {
        chrome.tabs.remove(tabId).catch(() => {});
      }
      if (bgTask.tabGroupId) {
        chrome.tabGroups.update(bgTask.tabGroupId, { collapsed: true }).catch(() => {});
      }
      finalizeBgTask(message.taskId, 'aborted');
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "GET_BG_TASKS") {
    const tasks = [...bgTasks.values()].map(t => ({
      taskId: t.taskId, intentText: t.intentText, status: t.status,
      startTime: t.startTime, summary: t.summary,
      hasPendingQuestion: !!t.pendingFieldQuestion,
      question: t.pendingFieldQuestion?.question,
      fieldKey: t.pendingFieldQuestion?.fieldKey
    }));
    sendResponse({ tasks });
    return true;
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
