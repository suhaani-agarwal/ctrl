## ctrl – Your autonomous AI copilot for the browser
ctrl is a Chrome extension that puts a fully autonomous AI agent right inside your browser — one that sees what you see, hears what you say, and acts on your behalf in real time.
You pick your avatar. You give it a name if you want. And then it's just... there. Always listening, always ready, never in the way unless you need it.
---
### Why ctrl?
Here’s what makes **ctrl** different from anything else:
- **Live, interruptible conversation**  
  Powered by Gemini Live, your agent talks with you, not at you. Mid‑sentence? Change your mind? Just say so. It adapts instantly without losing context.
- **Screen awareness (on your terms)**  
  You decide exactly which parts of your screen the agent can see. It uses that live context (DOM + screenshots + focused app) to understand what’s in front of you without overstepping your boundaries.
- **Real browser actions**  
  It doesn't just suggest. It does. Open tabs, fill forms, navigate pages, click buttons, edit documents, trigger UI workflows — **ctrl executes actions directly in your browser**.
- **Multi‑agent delegation**  
  Under the hood, a planner agent breaks your request into tasks and delegates them to specialized sub‑agents. One might draft content, another formats a slide, another searches the web — all in parallel, all coordinated.
- **End‑to‑end workflows**  
  Ask ctrl to *“build me a presentation on climate tech”* and it will:
  - Open Google Slides.
  - Create a new deck with a title and outline.
  - Research and draft per‑slide content.
  - Lay out and format the slides.
  - Iterate on structure and style with you — all inside your existing browser tab.
---
## High‑level capabilities
- **Voice‑first control**
  - Wake phrase or mic button to start.
  - Full duplex voice: you speak, it speaks back, while acting in parallel.
  - Interruptible at any time — just talk over it.
- **Agentic loop over your screen**
  - Repeated cycle of: *observe → plan → act → observe → refine*.
  - Uses DOM previews, accessibility tree and visual screenshots.
  - Robust selector heuristics (including `N1`, `N2` DOM indexing) to hit the right element.
- **Real actions, not just suggestions**
  - Click buttons, links, icons.
  - Fill and submit forms.
  - Scroll / scrollTo specific sections.
  - Navigate to URLs or app routes.
  - Interact with rich apps: Slides, Docs, Notion, dashboards, SaaS tools, etc.
- **Planner + worker agents**
  - A **planner** decomposes your request into steps and monitors progress.
  - **Worker agents** handle:
    - Web search and knowledge lookup.
    - Text generation and rewriting.
    - UI interaction and navigation.
    - Domain‑specific tasks (e.g., slide design, copywriting, email drafting).
  - The planner coordinates them and decides when the whole workflow is “done”.
- **Safety & control**
  - Permission prompts before sensitive actions (fills, destructive operations).
  - Configurable visibility (which tabs, which windows, which sites).
  - Clear visual indicators when the agent is “looking” at the page or listening.
---
## Architecture
At a high level, ctrl is made of:
- **Chrome extension (frontline runtime)**  
  - Side panel UI + overlay components.
  - Background service worker.
  - Content scripts injected into pages.
  - Offscreen document for low‑latency microphone access.
- **Agent runtime (hosted on Gemini)**
  - Gemini Live session for realtime conversation.
  - Planner & worker agents implemented via prompt‑orchestration and tools.
  - Tools for:
    - Browser actions (via extension messages).
    - Web search / retrieval.
    - Content generation and formatting.
- **Optional native host**
  - Chrome Native Messaging host for OS‑level tasks (window focus, app launching, etc).
### Data‑flow / architecture diagram
```mermaid
flowchart LR
  subgraph Browser[Chrome + ctrl Extension]
    SP[Side Panel UI\n(voice + status + preview)]
    BG[Background Service Worker\n(background.js)]
    CS[Content Script(s)\n(content.js, overlays)]
    OFF[Offscreen Doc\nmic capture]
    PAGE[Active Tab\nWeb App / Site]
  end
  subgraph Gemini[Gemini Agent Runtime]
    LIVE[Gemini Live\n(conversational loop)]
    PLAN[Planner Agent]
    W1[UI Worker\n(browser-action tool)]
    W2[Content Worker\n(copy, text, slides)]
    W3[Search / Tools\nweb + APIs]
  end
  subgraph OS[Host OS]
    NH[Native Host\n(optional)]
  end
  %% Browser internals
  SP <---> BG
  BG <---> CS
  BG <---> OFF
  CS <---> PAGE
  %% Live conversation
  OFF -- audio chunks --> BG
  BG -- bidi websocket --> LIVE
  LIVE -- text + audio --> BG
  BG -- server messages --> SP
  %% Planner & workers
  LIVE <---> PLAN
  PLAN <---> W1
  PLAN <---> W2
  PLAN <---> W3
  %% Browser action tool
  W1 -- "click/fill/scroll/navigate" --> BG
  BG -- EXECUTE / PREVIEW --> CS
  CS -- actions --> PAGE
  CS -- DOM snapshot + state --> BG
  BG -- page context --> LIVE
  %% Native host
  PLAN --> NH
  NH --> BG
# ctrl

## Conceptually

You speak → microphone audio goes through the extension into Gemini Live.  
Gemini Live + the planner parses intent and maintains the conversation.  
Planner delegates sub-tasks to worker agents (UI, content, search).  
UI worker uses the browser-action tool, which routes back into the extension.  
Extension captures DOM + screenshots, executes actions, and returns updated state.  
Planner monitors progress and decides when the workflow is complete.

---

# Repository layout (high-level)

Names may differ slightly depending on your copy of the repo, but the roles are consistent.

```
extension/
  manifest.json        – Chrome extension manifest (Manifest V3).
  background.js        – service worker, WebSocket, message router, content-script injector, offscreen manager.
  sidepanel.html / sidepanel.js – side panel UI, transcript, agentic loop driver.
  content.js           – DOM preview, action execution, permission banners, overlays.
  offscreen.html / offscreen.js – microphone capture and audio streaming.
  assets               – icons, avatar images, CSS, etc.

native/ (optional)
  Native messaging host implementation (com.ctrl.ai_agent_host).

README.md
LICENSE
```

---

# Running ctrl locally (extension only)

## 1. Prerequisites

Chrome (or Chromium-based browser) with:

- Extension support
- Side panel API
- Offscreen documents (`chrome.offscreen`)

A Gemini API key with access to:

- `models/gemini-2.5-flash-native-audio-latest` (for Live)
- `models/gemini-2.5-flash` or similar for fast JSON / planning calls

Node.js and npm if you want to run build tooling (optional but recommended).

---

## 2. Clone the repository

```bash
git clone https://github.com/<your-org-or-user>/ctrl.git
cd ctrl
```

---

## 3. Install dependencies (if the project uses a build step)

If the extension files are already built JS, you can skip this.

Otherwise:

```bash
npm install
npm run build   # or whatever build script the project defines
```

This should produce or update the JS bundle(s) in the `extension/` directory.

---

## 4. Load the extension into Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked**.
4. Select the `extension/` folder inside this repo.
5. Verify the extension appears with no manifest errors.

---

## 5. Configure Gemini

Click the extension icon or open the side panel (depending on your setup).

In the side panel:

- Paste your Gemini API key into the API key field.
- The status should show **“Connecting…”** and then **“Ready — press mic to talk”**.

Optionally, open the DevTools console for:

- the **background service worker** (`background.js`)
- the **side panel** (`sidepanel.js`)

---

# Testing ctrl locally – step-by-step

Below is a simple but thorough test plan you can follow locally.

---

## A. Smoke test: voice + conversation

Open any regular web page (e.g. https://example.com).

Open the ctrl side panel.

Press the mic button.

Say something like:

> “Hey ctrl, can you hear me?”

Expected:

- You see your speech transcribed (if transcriptions are surfaced).
- The agent responds with audio.
- No browser actions yet, just conversation.

---

## B. Screen awareness + DOM preview

With the same page open, press the mic and say:

> “Look at this page and tell me what main actions you see.”

Expected:

- Side panel shows a DOM preview list (`N1`, `N2`, …) for interactive elements.
- You may see a screenshot thumbnail.
- The agent describes buttons/links and may propose actions.

---

## C. Real browser actions (click + scroll)

Browse to a page with obvious buttons (YouTube, docs, a dashboard, etc.).

With ctrl open, say:

> “Scroll down a bit.”  
> “Now click the Subscribe button.”

or

> “Click N7.” (if N7 is the Subscribe button in the DOM preview)

Expected:

- The page scrolls down.
- Ctrl triggers a click on the target button.
- Side panel logs show the inferred or parsed action and its success.
- A new screenshot reflects the post-click state.

---

## D. Form-filling and search

Go to a search site (Google, YouTube, internal search).

Say:

> “Search for ‘autonomous browser agents’.”

Expected:

- Ctrl identifies a text input.
- Prompts for permission if the action is sensitive.
- Types the query and submits (`ENTER` or search button).
- Opens results and captures the updated page.

---

## E. End-to-end workflow (Slides example)

Open **Google Slides** and create (or open) a presentation.

Say:

> “Create a 5-slide presentation on climate tech with a title slide, overview, three content slides, and a conclusion.”

Expected behavior (at a high level):

Planner breaks this into steps:

- Ensure you’re in Slides / new deck.
- Generate an outline and slide titles.
- Create/duplicate slides as needed.
- Populate content fields via text workers.

UI worker navigates within Slides to:

- Insert/duplicate slides.
- Select and edit title and body text boxes.

Agent keeps you in the loop verbally:

> “I’ve created the outline, now I’m adding the first content slide…”

When done, it summarizes:

> “All set — I built a 5-slide climate tech deck with structured content.”

You can experiment with similar workflows in **Docs, Notion, Trello, Jira, etc.**

---

# Advanced usage & customization ideas

You can extend ctrl in multiple directions.

---

## New tools for planner / workers

Add more specialized worker tools:

- Calendar / email integration
- Code review or repo navigation (via web apps)
- Data dashboard interaction (filters, exports)

---

## Custom prompts & personas

- Define personalities and domain expertise for particular avatars.
- Configure different planners for different tasks  
  (e.g., **“research mode”** vs **“execution mode”**).

---

## Policy & safety layers

- Domain-specific allow/deny rules for actions.
- Site-level visibility rules  
  (e.g., **no DOM capture on banking sites**).
- Extra confirmation for destructive flows  
  (**delete, submit, publish**).

---

# Security & privacy

ctrl:

- Captures microphone audio **only when the mic is on**.
- Captures **DOM snapshots and screenshots for the active tab only** when needed for tasks.
- Sends this data to **Gemini over HTTPS** for processing and action planning.

It does **not**:

- Automatically inspect every tab/window.
- Perform actions without going through its permission and planning layers.

You should review and adapt the privacy model to your own threat model and policies before distributing ctrl broadly.

For example:

- add **site allowlists**
- more **granular permissions**
- additional **user-visible controls**

---