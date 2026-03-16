// sidepanel.js
let apiKey = "";
let isListening = false;
let currentAgentTurnText = "";
let lastDomNodes = [];

// Agentic loop state
let loopRunning = false;
let loopAborted = false;
let currentLoopId = 0;
let pendingUserInterrupt = null;
let taskAutoApproved = false;
const MAX_ROUNDS = 15;
const SETTLE_MS = 150;
const NAVIGATE_SETTLE_MS = 1200;
const MAX_DOM_NODES = 100;
const SENSITIVE_ACTIONS = new Set(["fill"]);

// Audio playback
let playbackContext = null;
let nextStartTime = 0;

// Prevents task-completion turn from re-triggering the loop
let awaitingTaskDoneResponse = false;

// Accumulates user speech transcription chunks
let userTranscriptBuffer = "";

// UI
const transcript         = document.getElementById("transcript");
const statusText         = document.getElementById("status-text");
const micBtn             = document.getElementById("mic-btn");
const settingsToggle     = document.getElementById("settings-toggle");
const settingsPanel      = document.getElementById("settings-panel");
const apiKeyInput        = document.getElementById("api-key");
const screenshotIndicator = document.getElementById("screenshot-indicator");
const screenshotThumb    = document.getElementById("screenshot-thumb");
const actionBadges       = document.getElementById("action-badges");
const detailsToggle      = document.getElementById("details-toggle");
const detailsBody        = document.getElementById("details-body");
const pagePreview        = document.getElementById("page-preview");

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

detailsToggle.onclick = () => {
  const open = detailsBody.classList.toggle("hidden");
  detailsToggle.textContent = open ? "Details ▸" : "Details ▾";
  if (!open) detailsBody.scrollTop = detailsBody.scrollHeight;
};

screenshotThumb?.addEventListener("click", () => {
  screenshotThumb.classList.toggle("expanded");
});

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
    // small visual pulse
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

  // Cancel any running agentic loop
  if (loopRunning) {
    loopAborted = true;
    currentLoopId++;
    updateTranscript("System", "Cancelling current task...");
  }

  if (isListening) {
    isListening = false;
    micBtn.classList.remove("listening");
    statusText.innerText = "Ready";
    chrome.runtime.sendMessage({ type: "STOP_MIC" });
    return;
  }

  // Start mic — Flash handles page context, no need to send DOM/screenshot to Live
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
    // User speech transcription — accumulate for intent detection
    if (msg.serverContent.inputTranscription) {
      const t = msg.serverContent.inputTranscription;
      if (t.text) {
        userTranscriptBuffer += t.text;
        updateTranscript("You", userTranscriptBuffer);
      }
    }

    // Gemini speech transcription — display in transcript
    // Also: start the agentic loop immediately when the model begins responding
    // (don't wait for turnComplete — saves 1–2 s of latency)
    if (msg.serverContent.outputTranscription) {
      const t = msg.serverContent.outputTranscription;
      if (t.text) {
        if (!loopRunning && !awaitingTaskDoneResponse) {
          const pending = userTranscriptBuffer.trim();
          if (pending && hasActionableIntent(pending)) {
            userTranscriptBuffer = "";
            runAgenticLoop(pending);
          }
        }
        currentAgentTurnText += t.text;
        updateTranscript("Agent", currentAgentTurnText);
      }
    }

    const turn = msg.serverContent.modelTurn;
    if (turn?.parts) {
      for (const part of turn.parts) {
        console.log("SP: part keys", Object.keys(part));
        if (part.text) {
          currentAgentTurnText += part.text;
          updateTranscript("Agent", currentAgentTurnText);
        }
        const blob = part.inlineData || part.inline_data;
        if (blob?.mimeType?.includes("audio") || blob?.mime_type?.includes("audio")) {
          queueAudio(blob.data);
        }
      }
    }

    if (msg.serverContent.turnComplete) {
      const intentText = (userTranscriptBuffer || currentAgentTurnText).trim();
      userTranscriptBuffer = "";
      currentAgentTurnText = "";

      // Skip one turn after task completion — that turn is Gemini's ack of the task
      if (awaitingTaskDoneResponse) {
        awaitingTaskDoneResponse = false;
        if (!loopRunning) statusText.innerText = isListening ? "Listening..." : "Ready";
        return;
      }

      if (intentText) {
        if (loopRunning) {
          const lower = intentText.toLowerCase();
          if (lower.includes("stop") || lower.includes("cancel") || lower.includes("never mind")) {
            loopAborted = true;
            currentLoopId++;
            updateTranscript("System", "Stopping task.");
          } else {
            pendingUserInterrupt = intentText;
            updateTranscript("System", "Updating task...");
          }
        } else if (hasActionableIntent(intentText)) {
          runAgenticLoop(intentText);
        }
      }
      if (!loopRunning) {
        statusText.innerText = isListening ? "Listening..." : "Ready";
      }
    }
    if (msg.serverContent.interrupted) {
      stopPlayback();
      currentAgentTurnText = "";
      userTranscriptBuffer = "";
    }
  }
}

// ---- Intent detection ----
function hasActionableIntent(text) {
  const lower = text.toLowerCase();
  // Direct user commands + Gemini's acknowledgment phrases (both contain the task)
  const triggers = [
    "click", "navigate", "go to", "open", "scroll", "type", "search",
    "fill", "press", "select", "submit", "play", "pause", "like",
    "subscribe", "watch", "create", "make", "write", "delete", "close",
    "sign in", "log in", "download", "upload", "send", "find", "show me",
    "switch to", "refresh", "new tab",
    "i'll", "i will", "let me", "going to", "navigating", "opening",
    "searching", "heading to", "clicking"
  ];
  return triggers.some(w => lower.includes(w));
}

// ---- Local TTS (fallback — speechSynthesis may not be available in all extension contexts) ----
function speakText(text) {
  if (!text) return;
  try {
    speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 1.1;
    speechSynthesis.speak(utt);
  } catch (e) {
    console.log("speakText unavailable:", e.message);
  }
}

// ---- Plan display ----
let planBubble = null;

function showPlanSteps(steps) {
  planBubble?.remove();
  planBubble = document.createElement("div");
  planBubble.className = "bubble plan";
  const title = document.createElement("div");
  title.className = "plan-title";
  title.textContent = `Plan — ${steps.length} step${steps.length > 1 ? "s" : ""}`;
  planBubble.appendChild(title);
  steps.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "plan-step";
    row.dataset.step = i;
    row.dataset.status = "pending";
    row.innerHTML = `<span class="step-icon">○</span><span class="step-text">${s.slice(0, 80)}</span>`;
    planBubble.appendChild(row);
  });
  transcript.appendChild(planBubble);
  transcript.scrollTop = transcript.scrollHeight;
}

function setPlanStep(index, status) {
  if (!planBubble) return;
  const row = planBubble.querySelector(`[data-step="${index}"]`);
  if (!row) return;
  row.dataset.status = status;
  const icons = { pending: "○", active: "▶", done: "✓", failed: "✗" };
  row.querySelector(".step-icon").textContent = icons[status] || "○";
}

function showThought(thought) {
  if (!thought || !detailsBody) return;
  const b = document.createElement("div");
  b.className = "bubble thought";
  b.textContent = "💭 " + thought.slice(0, 120);
  detailsBody.appendChild(b);
  detailsBody.scrollTop = detailsBody.scrollHeight;
}

// ---- Task planner: decompose complex tasks into steps ----
async function planTask(intentText, currentUrl, currentTitle) {
  const prompt =
    `You are a browser task orchestrator. Decompose the user's goal into the minimum ordered steps.\n\n` +
    `USER GOAL: "${intentText.slice(0, 400)}"\n` +
    `CURRENT PAGE: ${currentTitle}\nCURRENT URL: ${currentUrl}\n\n` +
    `KNOWN URL SHORTCUTS — use these directly, never navigate to the homepage then search:\n` +
    `  YouTube search:    https://www.youtube.com/results?search_query=your+terms\n` +
    `  Google search:     https://www.google.com/search?q=your+terms\n` +
    `  Google Slides new: https://docs.google.com/presentation/create\n` +
    `  Google Docs new:   https://docs.google.com/document/create\n` +
    `  Google Sheets new: https://docs.google.com/spreadsheets/create\n` +
    `  For any other known site, construct the URL directly (e.g. reddit → https://www.reddit.com,\n` +
    `  amazon → https://www.amazon.com, twitter/X → https://www.x.com, github → https://github.com).\n` +
    `  For completely unknown sites, use: https://www.google.com/search?q=site+name\n\n` +
    `RULES:\n` +
    `- Each step = everything achievable on ONE page without a page change.\n` +
    `- If a different site is needed, step 1 MUST be "Navigate to <exact URL>".\n` +
    `- Encode spaces as + in search URLs (never %20).\n` +
    `- Split sequential interactions: navigate → click result → interact with result page.\n` +
    `- Never combine navigation AND post-navigation clicks into the same step.\n` +
    `- Simple tasks = 1 step. Multi-site workflows = 2–5 steps. Never over-decompose.\n` +
    `- Write each step as a single imperative sentence (what to do on THAT page only).\n\n` +
    `EXAMPLES:\n` +
    `  "search cat videos on youtube"\n` +
    `  → ["Navigate to https://www.youtube.com/results?search_query=cat+videos"]\n\n` +
    `  "open cat videos and subscribe to the first channel"\n` +
    `  → ["Navigate to https://www.youtube.com/results?search_query=cat+videos",\n` +
    `     "Click the first video in the search results",\n` +
    `     "Click the Subscribe button below the video"]\n\n` +
    `  "like the first video on the page"\n` +
    `  → ["Click the Like button on the first video"]\n\n` +
    `  "make a slides deck about climate change"\n` +
    `  → ["Navigate to https://docs.google.com/presentation/create",\n` +
    `     "Click the Blank presentation thumbnail",\n` +
    `     "Click the title placeholder and type Climate Change"]\n\n` +
    `Return JSON only — no explanation outside the JSON.`;

  const result = await msgBg({
    type: "CALL_GEMINI",
    model: "gemini-2.5-flash-lite",
    prompt,
    temperature: 0.1,
    maxTokens: 1024,
    schema: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" } },
        start_url: { type: "string" }
      },
      required: ["steps"]
    }
  });
  if (result?.success && result.data?.steps?.length > 0) {
    return result.data.steps;
  }
  return [intentText]; // fallback: whole intent as one step
}

// ---- Agentic Loop ----
async function runAgenticLoop(intentText) {
  if (loopRunning) return;
  loopRunning = true;
  loopAborted = false;
  taskAutoApproved = false;
  pendingUserInterrupt = null;
  const loopId = ++currentLoopId;
  const actionHistory = []; // shared across all steps

  // Reset per-task UI
  planBubble?.remove();
  planBubble = null;
  if (actionBadges) actionBadges.innerHTML = "";
  if (screenshotThumb) { screenshotThumb.src = ""; screenshotThumb.classList.remove("expanded"); }
  if (pagePreview) pagePreview.classList.add("hidden");

  statusText.innerText = "Planning...";
  updateTranscript("You", intentText.slice(0, 200));

  try {
    // 1. Get initial page context
    const initPreview = await msgBg({ type: "GET_DOM_PREVIEW", maxNodes: 5 });
    const initUrl = initPreview?.url || "";
    const initTitle = initPreview?.title || "";

    // 2. Decompose into steps
    statusText.innerText = "Building plan...";
    const steps = await planTask(intentText, initUrl, initTitle);
    showPlanSteps(steps);

    // 3. Execute each step
    for (let si = 0; si < steps.length; si++) {
      if (loopAborted || loopId !== currentLoopId) break;

      // Handle user interrupt between steps
      if (pendingUserInterrupt) {
        intentText = pendingUserInterrupt;
        pendingUserInterrupt = null;
        loopAborted = true; // abort current plan, loop will restart via new call
        break;
      }

      const stepGoal = steps[si];
      setPlanStep(si, "active");
      statusText.innerText = steps.length > 1 ? `Step ${si + 1}/${steps.length}` : "Working...";
      if (steps.length > 1) speakText(`Step ${si + 1}: ${stepGoal.slice(0, 60)}`);

      const failedSelectors = new Map();
      let consecutiveNoProgress = 0;
      let stepDone = false;
      const MAX_STEP_ROUNDS = steps.length > 1 ? 8 : MAX_ROUNDS;

      for (let round = 0; round < MAX_STEP_ROUNDS; round++) {
        if (loopAborted || loopId !== currentLoopId || pendingUserInterrupt) break;

        // Capture current page
        statusText.innerText = `${steps.length > 1 ? `Step ${si + 1}: ` : ""}Round ${round + 1}...`;
        const [preview, shot] = await Promise.all([
          msgBg({ type: "GET_DOM_PREVIEW", maxNodes: MAX_DOM_NODES }),
          msgBg({ type: "CAPTURE_SCREEN" })
        ]);
        if (preview?.nodes) lastDomNodes = preview.nodes;

        if (shot?.success && shot.data && screenshotThumb) {
          screenshotThumb.src = "data:image/jpeg;base64," + shot.data;
          pagePreview?.classList.remove("hidden");
        }

        // Plan actions for this step
        const parts = buildFlashPrompt(stepGoal, preview, shot, actionHistory.slice(-8), failedSelectors, consecutiveNoProgress);
        const result = await msgBg({
          type: "CALL_GEMINI",
          model: "gemini-2.5-flash-lite",
          parts,
          maxTokens: 2048,
          schema: {
            type: "object",
            properties: {
              thought: { type: "string" },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    action: { type: "string", enum: ["click","fill","type","scroll","scrollTo","navigate","keypress","select","hover","wait","new_tab","switch_tab","close_tab","done"] },
                    selector: { type: "string" },
                    value: { type: "string" }
                  },
                  required: ["action"]
                }
              },
              done: { type: "boolean" }
            },
            required: ["thought", "actions", "done"]
          }
        });

        if (!result?.success || !result.data) {
          console.error("Flash call failed:", result?.error);
          await delay(1000);
          continue;
        }

        const plan = result.data;
        console.log(`[Step ${si + 1}] Round ${round + 1}:`, plan);

        // Show Flash's reasoning in details panel
        if (plan.thought) showThought(plan.thought);

        // Check if this step is done
        if (plan.done || (plan.actions.length === 1 && plan.actions[0]?.action === "done")) {
          setPlanStep(si, "done");
          break; // advance to next step
        }

        // Execute actions
        let hadScreenChange = false;
        let roundActionCount = 0;
        let roundFailCount = 0;
        let navigated = false;

        for (const step of plan.actions) {
          if (loopAborted || loopId !== currentLoopId) break;

          if (step.action === "wait") { await delay(1500); continue; }
          if (step.action === "done") { break; }

          // Resolve N-index shorthand
          let sel = step.selector || null;
          if (sel) {
            const nMatch = sel.match(/^N(\d+)$/i);
            if (nMatch) {
              const node = lastDomNodes[parseInt(nMatch[1]) - 1];
              if (node?.selector) sel = node.selector;
            }
          }

          const desc = humanDesc(step.action, sel, step.value);
          statusText.innerText = desc;
          updateTranscript("Action", desc);
          // Narrate major actions via voice
          if (step.action === "navigate") {
            try { speakText("Navigating to " + new URL(step.value).hostname.replace("www.", "")); } catch (_) {}
          } else if (step.action === "new_tab") {
            speakText("Opening new tab");
          } else if (step.action === "switch_tab") {
            speakText("Switching tab");
          }

          // Permission: ask once per task, only for fill actions
          if (!taskAutoApproved) {
            taskAutoApproved = true;
            if (SENSITIVE_ACTIONS.has(step.action)) {
              const permission = await msgBg({ type: "SHOW_PERMISSION", description: desc });
              if (permission !== "GRANT") {
                updateTranscript("System", "Action denied. Stopping.");
                speakText("Action was denied, stopping.");
                loopAborted = true;
                break;
              }
            }
          }

          const execResult = await msgBg({
            type: "EXECUTE_ACTION",
            kind: step.action,
            selector: sel,
            value: step.value || null
          });

          console.log("Action result:", step.action, sel, execResult);

          const actionOk = execResult?.success !== false && !execResult?.error;
          if (!actionOk && sel) failedSelectors.set(sel, (failedSelectors.get(sel) || 0) + 1);

          roundActionCount++;
          if (!actionOk) roundFailCount++;

          actionHistory.push({
            step: actionHistory.length + 1,
            action: step.action, selector: sel, value: step.value,
            success: actionOk, error: execResult?.error || null
          });
          if (actionHistory.length > 12) actionHistory.shift();

          addActionBadge(step.action, actionOk);

          // Settle timing
          const isPageChange = ["navigate", "new_tab", "switch_tab"].includes(step.action);
          if (isPageChange) {
            hadScreenChange = true;
            navigated = true;
            await delay(700);
            for (let w = 0; w < 8; w++) {
              const rc = await msgBg({ type: "READY_CHECK" });
              if (rc?.ready) break;
              await delay(400);
            }
            // If the entire step goal was just navigation, mark done immediately
            if (actionOk && /^navigate\b/i.test(stepGoal.trim())) {
              setPlanStep(si, "done");
              stepDone = true;
            }
            break; // always re-read page after a page change
          } else if (step.action === "click" && actionOk) {
            hadScreenChange = true;
            await delay(300);
            const rc = await msgBg({ type: "READY_CHECK" });
            if (!rc?.ready) await delay(400);
          } else if (step.action === "type" || step.action === "fill") {
            await delay(50); // minimal settle for text input
          } else {
            await delay(20);
          }
        }

        if (loopAborted || loopId !== currentLoopId || stepDone) break;

        // Track no-progress
        if (roundActionCount > 0 && roundFailCount === roundActionCount && !navigated) {
          consecutiveNoProgress++;
        } else {
          consecutiveNoProgress = 0;
        }

        if (!hadScreenChange) await delay(SETTLE_MS);

        // If all actions failed for 3 consecutive rounds, this step is stuck — move on
        if (consecutiveNoProgress >= 3) {
          updateTranscript("System", `Step ${si + 1}: stuck after ${consecutiveNoProgress} failed rounds — skipping`);
          setPlanStep(si, "failed");
          break;
        }
      }

      // Mark step done if loop ended without explicit done signal
      if (!loopAborted && loopId === currentLoopId) setPlanStep(si, "done");
    }

    // All steps done — speak completion, guard against re-trigger
    if (!loopAborted && loopId === currentLoopId) {
      const summary = buildCompletionSummary(intentText, actionHistory, null);
      updateTranscript("Agent", summary);
      awaitingTaskDoneResponse = true;
      speakText(summary);
    }

  } catch (e) {
    console.error("Agentic loop error:", e);
    updateTranscript("System", "Error: " + e.message);
  } finally {
    loopRunning = false;
    taskAutoApproved = false;
    statusText.innerText = isListening ? "Listening..." : "Ready";
  }
}

// ---- Flash prompt builder ----
function buildFlashPrompt(intent, preview, screenshot, history, failedSelectors, noProgressRounds) {
  const parts = [];
  const currentUrl = preview?.url || "";
  const currentTitle = preview?.title || "";
  const scrollPct = preview?.pageHeight > 0
    ? Math.round((preview.scrollY / preview.pageHeight) * 100) : 0;

  let text =
    `You are an expert browser automation agent with vision. Analyze the screenshot + DOM to choose the exact correct actions.\n\n` +
    `CURRENT STEP GOAL: "${intent.slice(0, 300)}"\n` +
    `PAGE: ${currentTitle}\nURL: ${currentUrl}\nScroll: ${preview?.scrollY ?? 0}px / ${preview?.pageHeight ?? 0}px (${scrollPct}% down)\n\n`;

  if (failedSelectors?.size > 0) {
    text += `BLOCKED (tried & failed — pick something else entirely):\n`;
    for (const [sel, n] of failedSelectors) text += `  ✗ ${sel} (${n}x)\n`;
    text += "\n";
  }

  if (noProgressRounds >= 2) {
    text += `⚠️ STUCK ${noProgressRounds} rounds — you MUST change strategy: try scrolling, use a different element, or navigate directly.\n\n`;
  }

  if (history.length > 0) {
    text += "HISTORY (most recent last):\n";
    for (const h of history) {
      text += `  ${h.success ? "✓" : "✗"} ${h.action}`;
      if (h.selector) text += ` [${h.selector}]`;
      if (h.value) text += ` = "${h.value}"`;
      if (!h.success) text += ` → ${h.error || "no effect"}`;
      text += "\n";
    }
    text += "\n";
  }

  if (preview?.nodes?.length) {
    const lines = preview.nodes.slice(0, MAX_DOM_NODES).map((n, i) => {
      const bits = [`N${i + 1}`, n.tag];
      if (n.role) bits.push(`[${n.role}]`);
      if (n.ariaLabel) bits.push(`"${n.ariaLabel.slice(0, 50)}"`);
      else if (n.text) bits.push(`"${n.text.slice(0, 50)}"`);
      if (n.placeholder) bits.push(`ph:"${n.placeholder}"`);
      if (n.href) bits.push(`→${n.href.slice(0, 60)}`);
      bits.push(`sel:${n.selector}`);
      return bits.join(" ");
    });
    text += "INTERACTIVE ELEMENTS:\n" + lines.join("\n") + "\n\n";
  }

  text +=
    `AVAILABLE ACTIONS:\n` +
    `  click selector       — click an element\n` +
    `  fill selector value  — type into HTML input/textarea (React-compatible)\n` +
    `  type [selector] value — type text into active/focused element (for Google Slides, Docs, canvas editors)\n` +
    `  navigate value       — go to URL\n` +
    `  scroll value         — scroll page by pixels (positive=down)\n` +
    `  scrollTo selector    — scroll element into view\n` +
    `  keypress value       — press special key (Enter, Tab, Escape, ArrowDown, etc.)\n` +
    `  select selector value — pick option from <select>\n` +
    `  hover selector       — hover over element\n` +
    `  new_tab [url]        — open a new browser tab (optionally with a URL)\n` +
    `  switch_tab value     — switch to tab whose title/URL contains value\n` +
    `  close_tab            — close current tab\n` +
    `  wait                 — pause 1.5 s\n` +
    `  done                 — signal step is complete\n\n` +
    `DECISION RULES (follow strictly):\n` +
    `1. NAVIGATION: If the goal requires a different site, use navigate with the exact URL.\n` +
    `   • YouTube search: navigate https://www.youtube.com/results?search_query=term+here\n` +
    `   • Google search:  navigate https://www.google.com/search?q=term+here\n` +
    `   • Google Slides:  navigate https://docs.google.com/presentation/create\n` +
    `   • Any other site: construct the likely URL directly (reddit.com, amazon.com, etc.).\n` +
    `   • Never look for an address bar in the DOM — use navigate directly.\n\n` +
    `2. CORRECT SELECTORS: Copy the sel: value EXACTLY from INTERACTIVE ELEMENTS above.\n` +
    `   • Never invent selectors — only use ones listed.\n` +
    `   • Never reuse a BLOCKED selector — pick a visually different element.\n` +
    `   • If the target is not visible, scroll first then reassess next round.\n\n` +
    `3. VISUAL / CARD ELEMENTS (thumbnails, template cards, grid items):\n` +
    `   • Identify the target visually in the screenshot, then match it in the DOM list.\n` +
    `   • YouTube results: click the <a> link whose href contains /watch?v= for the first video.\n` +
    `   • Google Slides templates: find an element with aria-label or text "Blank". Do NOT click headings.\n` +
    `   • Grid items with no clear selector: use N-index (N1, N2, …) by visual position.\n\n` +
    `4. TYPING IN GOOGLE SLIDES / DOCS / CANVAS EDITORS:\n` +
    `   • These are NOT HTML inputs. fill will fail on them.\n` +
    `   • Correct sequence: click the text placeholder → then type action with the text in value.\n` +
    `   • Example: [{"action":"click","selector":"div[aria-label='Title']"}, {"action":"type","value":"My Title"}]\n` +
    `   • The type action targets document.activeElement — it works after any successful click.\n\n` +
    `5. ONE PAGE-CHANGE PER BATCH: navigate/new_tab/link-click must be the LAST action in the list.\n` +
    `   After a page change the page reloads — plan nothing beyond it.\n\n` +
    `6. DONE CHECK: Set done=true ONLY when the screenshot confirms the step goal is complete.\n` +
    `   After successful navigation to the right page: done=true.\n` +
    `   After successfully typing text you can see on screen: done=true.\n\n` +
    `7. RECOVERY:\n` +
    `   • 2+ failures on same element → scroll or pick a completely different element.\n` +
    `   • Dropdowns: use select action with the option value.\n` +
    `   • If totally stuck: navigate directly to the target URL.\n\n` +
    `In thought: describe SPECIFICALLY what you see on screen and WHY you chose each action/selector.`;

  parts.push({ text });

  if (screenshot?.success && screenshot.data) {
    parts.push({ inlineData: { mimeType: "image/jpeg", data: screenshot.data } });
  }

  return parts;
}

// ---- Helpers ----
function humanDesc(kind, selector, value) {
  switch (kind) {
    case "click":      return `Click "${selector}"`;
    case "fill":       return `Type "${value}" into "${selector}"`;
    case "type":       return `Type "${(value || "").slice(0, 40)}"`;
    case "scroll":     return `Scroll by ${value}px`;
    case "scrollto":
    case "scrollTo":   return `Scroll to "${selector}"`;
    case "navigate":   return `Navigate to ${value}`;
    case "keypress":   return `Press ${value}`;
    case "select":     return `Select "${value}" in "${selector}"`;
    case "hover":      return `Hover over "${selector}"`;
    case "wait":       return "Waiting...";
    case "new_tab":    return `Open new tab${value ? ": " + value : ""}`;
    case "switch_tab": return `Switch to tab: ${value}`;
    case "close_tab":  return "Close current tab";
    default:           return `${kind} on ${selector}`;
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---- Transcript ----
function updateTranscript(role, text) {
  // Route internal status messages to the details section, not the main transcript
  const isInternal = role === "Action" || role === "System";
  const target = isInternal ? detailsBody : transcript;

  const last = target?.lastElementChild;
  if (last?.dataset.role === role && (role === "Agent" || role === "You")) {
    last.innerText = text;
  } else {
    const b = document.createElement("div");
    b.className = `bubble ${role.toLowerCase()}`;
    b.dataset.role = role;
    b.innerText = isInternal ? `${role}: ${text}` : text;
    target?.appendChild(b);
  }

  if (isInternal) {
    detailsBody?.scrollTo({ top: detailsBody.scrollHeight });
  } else {
    transcript.scrollTop = transcript.scrollHeight;
  }
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

// ---- Action badge ----
function addActionBadge(action, success) {
  if (!actionBadges) return;
  const icons = {
    navigate: "↗", click: "↖", fill: "✏", scroll: "↕",
    keypress: "⌨", select: "▾", hover: "◎", scrollTo: "⤵", scrollto: "⤵"
  };
  const badge = document.createElement("span");
  badge.className = "action-badge" + (success ? "" : " failed");
  badge.textContent = (icons[action] || "•") + " " + action;
  actionBadges.appendChild(badge);
  // Keep only last 10 badges visible
  while (actionBadges.children.length > 10) actionBadges.removeChild(actionBadges.firstChild);
}

// ---- Completion summary for voice ----
function buildCompletionSummary(intentText, actionHistory, planThought) {
  if (planThought) return `Done! ${planThought}`;
  const last = actionHistory.filter(h => h.success).slice(-3);
  const actions = last.map(h => {
    if (h.action === "navigate") return `went to ${(h.value || "").replace(/^https?:\/\//, "").split("/")[0]}`;
    if (h.action === "fill") return `typed "${(h.value || "").slice(0, 30)}"`;
    if (h.action === "click") return `clicked`;
    if (h.action === "keypress") return `pressed ${h.value}`;
    return null;
  }).filter(Boolean);
  if (actions.length > 0) return `Done! I ${actions.join(", then ")}.`;
  return `Done with: ${intentText.slice(0, 80)}`;
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
