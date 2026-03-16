# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**ctrl** is a Chrome extension (Manifest V3) that acts as a voice-driven browser automation agent powered by the Gemini Live API. The user speaks commands; the agent understands the page and executes browser actions (click, fill, scroll, navigate) on their behalf. An optional native host enables OS-level control via pyautogui.

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
The central hub. Owns the persistent WebSocket connection to the Gemini Live API (`wss://generativelanguage.googleapis.com/...`). Routes all messages between other contexts:
- Forwards audio chunks from offscreen → Gemini WebSocket
- Relays Gemini responses → side panel
- Handles DOM preview and screenshot capture requests from the side panel
- Dispatches browser actions to the content script
- Connects to the native host via `chrome.runtime.connectNative("com.ctrl.ai_agent_host")`

### `sidepanel.js` (Side Panel UI)
The user-facing interface. On mic button press:
1. Captures a DOM preview + JPEG screenshot of the current tab
2. Sends both to Gemini as context
3. Starts microphone capture via offscreen document
4. Receives Gemini's text+audio response
5. Parses `ACTION:kind:selector:value` lines from the response text
6. Runs `runActionFlow()` — shows a permission banner, captures before/after screenshots, executes the action, and feeds results back to Gemini

Action parsing has two layers:
- **Primary**: regex matching for explicit `ACTION:` lines
- **Fallback**: `inferActionFromText()` for natural language (navigate, click N-refs, fill)

### `offscreen.js` (Offscreen Document)
Has `getUserMedia` access. Captures mic audio at 16kHz using an AudioWorklet (`audio-processor.js`), converts float32 → PCM16 → base64, and sends chunks to background.

### `content.js` (Content Script, all URLs)
Injected into every page. Handles:
- `GET_DOM_PREVIEW`: Builds a structured list of interactive/visible elements with CSS selectors optimized for reliability (prefers `id`, then `aria-label`, then class). Uses three strategies: interactive elements first, then headings/context elements, then BFS traversal.
- `EXECUTE`: Performs click/fill/scroll/scrollTo/navigate/focus actions
- `SHOW_PERMISSION`: Injects a permission banner at the top of the page (auto-denies after 15s)

### `native-host/ai_agent_host.py` (Optional Native Host)
A Python process Chrome spawns via Native Messaging (stdio). Provides OS-level actions via pyautogui: click, double_click, right_click, move, drag, type, hotkey, scroll, screenshot (via mss), open_app, get_screen_size.

## Key Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `CONNECT_WEBSOCKET` | panel → bg | Connect/reconnect to Gemini with API key |
| `SEND_TO_GEMINI` | panel → bg | Forward a Gemini API message object |
| `START_MIC` / `STOP_MIC` | panel → bg | Start/stop mic capture via offscreen |
| `CAPTURE_SCREEN` | panel → bg | Get JPEG screenshot of active tab |
| `GET_DOM_PREVIEW` | panel → bg → content | Get structured DOM node list |
| `EXECUTE_ACTION` | panel → bg → content | Execute a browser action |
| `SHOW_PERMISSION` | panel → bg → content | Show allow/deny banner on page |
| `OS_ACTION` | panel → bg → native | Perform OS-level action |
| `AUDIO_CHUNK` | offscreen → bg | PCM16 base64 audio to stream to Gemini |

## Gemini Integration

- Model: `gemini-2.5-flash-native-audio-latest` (supports real-time audio I/O)
- Audio in: PCM 16kHz, streamed as `realtimeInput.mediaChunks`
- Audio out: PCM 24kHz, decoded and played via Web Audio API with a queue (`nextStartTime`)
- The system prompt instructs Gemini to output `ACTION:kind:selector:value` lines on their own line without markdown formatting

## DOM Selector Strategy

`content.js` builds selectors in priority order: `tag#id` → `tag[aria-label="..."]` → `tag.class1.class2` → `tag`. The side panel also supports N-index shorthand (N1, N2, ...) which maps to the corresponding node in `lastDomNodes`.
