# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**ctrl** is a Chrome extension (Manifest V3) that acts as a voice-driven browser automation agent. The user speaks commands; a two-model Gemini pipeline understands intent and executes browser actions (click, fill, scroll, navigate) on their behalf. An optional native host enables OS-level control via pyautogui.

## Setup

**Prerequisites:** Node.js, a Gemini API key, Python 3 (for OS control)

1. Load the extension unpacked from `extension/` in Chrome at `chrome://extensions` (enable Developer Mode)
2. Enter your Gemini API key in the extension side panel
3. *(Optional)* Set up the native host for OS-level control:
   ```bash
   cd native-host
   python3 setup.py        # installs the Chrome NativeMessaging manifest
   pip install pyautogui mss Pillow
   ```

There is no build step — the extension files in `extension/` are loaded directly by Chrome.

## Architecture

The extension has four distinct execution contexts that communicate via `chrome.runtime.sendMessage`:

### `background.js` (Service Worker)
The central hub. Manages two Gemini connections:
1. **WebSocket** to Gemini Live API (`gemini-2.5-flash-native-audio-latest`) — handles real-time voice conversation only; the system prompt explicitly tells it NOT to output commands
2. **REST fetch** (`gemini-2.5-flash-lite`) — used by `CALL_GEMINI` messages for action planning and task decomposition, always returns structured JSON via `responseSchema`

Other responsibilities:
- Forwards audio chunks from offscreen → Gemini WebSocket
- Relays Gemini responses → side panel
- Handles DOM preview and screenshot capture requests from the side panel
- Dispatches browser actions to the content script
- Connects to the native host via `chrome.runtime.connectNative("com.ctrl.ai_agent_host")`
- Auto-reconnects WebSocket up to 3 times on non-auth failures

### `sidepanel.js` (Side Panel UI)
The user-facing interface and agentic loop controller. On mic button press, it starts microphone capture. When Gemini's voice transcription detects actionable intent (`hasActionableIntent()`), it runs `runAgenticLoop()`:

1. **`planTask()`** — calls Flash REST to decompose the goal into 1–5 ordered steps
2. **Per-step loop** (up to `MAX_ROUNDS=15` rounds per step):
   - Captures DOM preview + JPEG screenshot of the current tab
   - Calls Flash REST via `buildFlashPrompt()` → returns `{ thought, actions[], done }` JSON
   - Shows the `thought` in a collapsible details panel
   - For `fill` actions: shows a permission banner (auto-denies after 15s unless approved)
   - Executes each action, tracks `failedSelectors` to avoid retries
   - Feeds `[TASK_DONE]` back to Gemini Live when complete (voice assistant then summarizes)

Key constants: `MAX_ROUNDS=15`, `MAX_DOM_NODES=100`, `SETTLE_MS=150`, `NAVIGATE_SETTLE_MS=1200`

`SENSITIVE_ACTIONS` = `{ "fill" }` — these always require user permission.

### `offscreen.js` (Offscreen Document)
Has `getUserMedia` access. Captures mic audio at 16kHz using an AudioWorklet (`audio-processor.js`), converts float32 → PCM16 → base64, and sends chunks to background.

### `content.js` (Content Script, all URLs)
Injected into every page. Handles:
- `GET_DOM_PREVIEW`: Builds a structured list of interactive/visible elements with CSS selectors. Uses three strategies: interactive elements first, then headings/context elements, then BFS traversal.
- `EXECUTE`: Performs click/fill/scroll/scrollTo/navigate/keypress/select/hover/wait actions
- `SHOW_PERMISSION`: Injects a permission banner at the top of the page (auto-denies after 15s)
- `READY_CHECK`: Returns page load state (used after navigation to detect settle)
- `PING`: Responds to confirm content script is alive (background uses this before injecting)

### `native-host/ai_agent_host.py` (Optional Native Host)
A Python process Chrome spawns via Native Messaging (stdio). Provides OS-level actions via pyautogui: click, double_click, right_click, move, drag, type, hotkey, scroll, screenshot (via mss), open_app, get_screen_size.

## Key Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `CONNECT_WEBSOCKET` | panel → bg | Connect/reconnect to Gemini Live with API key |
| `SEND_TO_GEMINI` | panel → bg | Forward a message object to the Live WebSocket |
| `CALL_GEMINI` | panel → bg | REST call to Flash for action planning (returns JSON) |
| `START_MIC` / `STOP_MIC` | panel → bg | Start/stop mic capture via offscreen |
| `CAPTURE_SCREEN` | panel → bg | Get JPEG screenshot of active tab |
| `GET_DOM_PREVIEW` | panel → bg → content | Get structured DOM node list |
| `EXECUTE_ACTION` | panel → bg → content | Execute a browser action |
| `SHOW_PERMISSION` | panel → bg → content | Show allow/deny banner on page |
| `READY_CHECK` | panel → bg → content | Check if page has finished loading |
| `OS_ACTION` | panel → bg → native | Perform OS-level action |
| `AUDIO_CHUNK` | offscreen → bg | PCM16 base64 audio to stream to Gemini |

## Gemini Integration

Two separate Gemini models are used:

**Gemini Live (WebSocket)** — voice conversation only
- Model: `gemini-2.5-flash-native-audio-latest`
- Voice: "Aoede"
- Audio in: PCM 16kHz, streamed as `realtimeInput.mediaChunks`
- Audio out: PCM 24kHz, decoded and played via Web Audio API with a queue (`nextStartTime`)
- System prompt tells it to be a friendly voice assistant — it must NOT output commands or structured data
- Receives `[TASK_DONE] ...` messages from the side panel and summarizes what was accomplished

**Gemini Flash (REST)** — action planning and task decomposition
- Model: `gemini-2.5-flash-lite` (default for `CALL_GEMINI`)
- Called synchronously via `fetch` from background service worker
- Always uses `responseMimeType: "application/json"` + `responseSchema` for typed output
- `planTask()`: returns `{ steps: string[], start_url?: string }`
- Per-round planning: returns `{ thought: string, actions: Action[], done: boolean }`

## DOM Selector Strategy

`content.js` builds selectors in priority order: `tag#id` → `tag[aria-label="..."]` → `tag.class1.class2` → `tag`. The side panel also supports N-index shorthand (N1, N2, ...) which maps to the corresponding node in `lastDomNodes`.
