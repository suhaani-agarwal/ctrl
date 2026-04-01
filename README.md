# ctrl — The AI that's smart enough to use AI

> A Chrome extension that doesn't just automate your browser — it knows which AI tool is fastest for each job and uses it for you.

---

## The Problem

Every browser AI agent today — Claude for Chrome, OpenAI Operator, Manus, Do Browser — tries to do everything by itself. Want a presentation? The agent clicks through Google Slides one button at a time. Want to compare prices? It opens tabs sequentially and slowly reads each page. Want a background removed from an image? It tries to navigate Photoshop or Canva's complex UI.

**This approach is fundamentally broken.** LLMs are bad at navigating web pages. The best browser agent in the world scores only 10.4% on complex end-to-end workflows (CUB benchmark). Claude for Chrome's own developer community admits that "the information density of a web page is an order of magnitude lower than code or documents — where LLMs actually shine."

The result: agents that are slow, expensive, inaccurate, and frustrating.

## The Solution

**ctrl doesn't try to be the AI. It orchestrates AIs.**

When you say "make me a presentation," ctrl doesn't click through Slides for 10 minutes. It opens [Gamma](https://gamma.app), writes the perfect prompt, and gets a professional deck in 30 seconds.

When you say "remove this background," it doesn't navigate Canva. It opens [remove.bg](https://remove.bg) and does it in 5 seconds.

When you say "research this topic," it doesn't Google and click links one by one. It opens [Perplexity](https://perplexity.ai) and gets a cited summary in 10 seconds.

When you say "fill this form," it doesn't need an external tool — it reads the form fields directly, matches them against your saved profile, asks you for anything missing, and fills everything in seconds.

**ctrl knows 12+ specialized skills, each using the fastest possible method — whether that's a purpose-built AI tool or direct browser automation. You just talk, and it figures out the rest.**

---

## How It Works

```
You speak (or type)
  → Gemini Live transcribes + understands intent in real-time
  → Orchestrator picks the right skill for the job
  → Skill executes using the fastest method:
      • External AI tool (Gamma, Perplexity, remove.bg, etc.)
      • Direct browser automation (forms, navigation, clicks)
      • Parallel tab operations (price comparison, research)
  → Agent narrates progress via voice as you watch it work
  → Result presented — you approve, correct, or move on
```

The agentic loop for each skill runs up to 25 rounds per step:

```
observe (DOM + accessibility tree + screenshot)
  → plan next action (via LLM)
  → execute action (via Chrome DevTools Protocol)
  → verify result (screenshot → vision model)
  → repeat until step is complete
```

### Why This Is More Accurate Than Other Agents

ctrl uses the **same approach as Claude for Chrome** for browser understanding — the Accessibility Tree (AX tree), not raw DOM or screenshots:

- **AX tree = ~800 tokens per page** vs 10,000+ for full DOM. 12x cheaper, 12x more accurate.
- **Chrome DevTools Protocol (CDP)** for action execution — native mouse/keyboard events that work on React apps, SPAs, and every modern web app.
- **Screenshot verification after every action** — a vision model confirms the action worked before proceeding.
- **Shared login state** — works with your existing sessions. No re-authentication needed.

But unlike Claude for Chrome, ctrl doesn't try to do complex creative tasks via raw DOM clicks. It **delegates to the right tool** and achieves in 30 seconds what other agents fail to do in 10 minutes.

---

## Features

### Voice-First Control
- Powered by **Gemini Live** — full duplex, real-time, interruptible voice conversation.
- Speak in Hindi, English, or Hinglish. Change your mind mid-sentence. The agent adapts.
- Text input also available in the side panel.

### Smart Tool Delegation
- 12+ built-in skills, each using the optimal method for its task type.
- Automatically routes your request to the right skill — you never need to specify which tool to use.
- Community skills can be installed directly from the side panel.

### Real Browser Actions
- Opens tabs, fills forms, clicks buttons, scrolls, navigates — all via CDP.
- Parallel tab operations for tasks like price comparison.
- Works with your existing logins (Gmail, Amazon, Notion — anything you're signed into).

### User Profile Memory
- Save your name, email, phone, address, and other details once.
- ctrl uses this to auto-fill forms without asking every time.
- Missing fields are requested interactively via voice — then saved for next time.

### Safety & Control
- **Permission modes**: strict (ask before every action), smart (ask for sensitive actions only), or auto (full autonomy for trusted sites).
- **Abort button** stops any running task immediately.
- **Submit confirmation** required before any form is submitted.

---

## Skills

Each skill is a self-contained module that handles a specific type of task. Skills can use external AI tools, direct browser automation, or a combination.

| Skill | What It Does | Method |
|-------|-------------|--------|
| `ppt-gamma` | Creates presentations via Gamma.app | External AI tool |
| `design-stitch` | Designs landing pages and UI via Stitch | External AI tool |
| `research-perplexity` | Deep research with citations via Perplexity | External AI tool |
| `youtube-summarize` | Summarizes the current YouTube video | Transcript extraction + LLM |
| `price-compare` | Compares prices across shopping sites | Parallel tabs + AX tree |
| `shopping` | Searches and browses products on any site | Direct browser automation |
| `booking` | Books restaurants, hotels, flights | Direct browser automation |
| `email` | Drafts, reads, and sends emails in Gmail | Direct browser automation |
| `media` | Plays music, podcasts, videos | Direct browser automation |
| `research` | In-page scraping and summarization | AX tree + LLM |
| `tab-manager` | Opens, closes, and switches tabs | Chrome APIs |
| `form-fill` | Fills any web form using saved profile + voice Q&A | Direct browser automation |

### Adding a New Skill

Skills are modular. To add a new skill:

1. Create a new file in `extension/skills/` (e.g., `my-skill.js`)
2. Export an object with `name`, `description`, `triggers`, `canHandle()`, and `execute()`
3. Register it in `extension/skills/index.js`

Community skills can also be installed at runtime via URL from the side panel.

---

## Architecture

```
extension/
  manifest.json            Chrome MV3 manifest
  background.js            Service worker — orchestrator, skill router, CDP, API calls
  sidepanel.html/.js       Side panel UI — voice controls, status, settings, skills manager
  content.js               Content script — DOM snapshots, action execution, permission banners
  offscreen.html/.js       Offscreen document — microphone capture, PCM16 streaming
  audio-processor.js       AudioWorklet — float32 → PCM16 conversion
  audio-capture.js         Mic capture bootstrap
  skills/
    index.js               Skill registry (built-in + community)
    form-fill.js           Generic form-fill skill
    ppt-gamma.js           Presentation skill (via Gamma)
    design-stitch.js       Design skill (via Stitch)
    youtube-summarize.js   YouTube summarization skill
    research-perplexity.js Deep research skill (via Perplexity)
    research.js            In-page research skill
    price-compare.js       Price comparison skill
    shopping.js            Shopping skill
    booking.js             Booking skill
    email.js               Email skill
    media.js               Media playback skill
    tab-manager.js         Tab management skill
  storage/
    user-profile.js        User profile CRUD helpers
```

### Data Flow

```
┌──────────────────────────────────────────────────────────┐
│                    Chrome + ctrl Extension                 │
│                                                           │
│  ┌─────────────┐  ┌────────────────┐  ┌──────────────┐  │
│  │  Side Panel  │  │   Background   │  │   Content    │  │
│  │  (voice UI,  │◄►│  (orchestrator │◄►│   Script     │  │
│  │   settings)  │  │   skill router │  │  (DOM + acts)│  │
│  └─────────────┘  │   CDP control) │  └──────┬───────┘  │
│                    └───────┬────────┘         │          │
│  ┌─────────────┐          │           ┌──────▼───────┐  │
│  │  Offscreen   │──audio──►│           │  Active Tab  │  │
│  │  (mic input) │          │           │  (your page) │  │
│  └─────────────┘          │           └──────────────┘  │
│                            │                             │
└────────────────────────────┼─────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
      ┌───────▼──────┐ ┌────▼─────┐ ┌──────▼───────┐
      │ Gemini Live  │ │  Groq    │ │  OpenRouter  │
      │ (voice +     │ │ (intent  │ │  (action     │
      │  intent)     │ │  routing │ │   planning)  │
      └──────────────┘ │  + draft)│ └──────────────┘
                       └──────────┘
```

### Models

| Role | Model | Via |
|------|-------|----|
| Voice conversation + intent detection | `gemini-2.5-flash-native-audio` | Gemini Live WebSocket |
| Orchestration + content drafting | `llama-4-scout` / `llama-4-maverick` | Groq REST API |
| Per-round action planning | Configurable (default: best available) | OpenRouter REST API |
| Screenshot verification | `llama-4-scout` (multimodal) | Groq REST API |

---

## Setup

### Prerequisites

- Chrome (or Chromium) with Side Panel API support
- **Gemini API key** — [aistudio.google.com](https://aistudio.google.com)
- **Groq API key** — [groq.com](https://groq.com)
- **OpenRouter API key** — [openrouter.ai](https://openrouter.ai)

### Install

```bash
git clone https://github.com/<your-org>/ctrl.git
cd ctrl
```

There is **no build step**. The extension loads directly.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Click the ctrl icon to open the side panel

### Configure

Open ctrl's side panel → **Settings**:
1. Enter your Gemini, Groq, and OpenRouter API keys
2. The status indicator turns green when Gemini Live connects
3. (Optional) Fill in your user profile for automatic form filling

---

## Usage

Just talk to it:

| What you say | What ctrl does |
|-------------|---------------|
| "Make a 10-slide presentation on climate change" | Opens Gamma → writes prompt → generates deck → asks for corrections |
| "Compare iPhone 16 prices on Amazon and Flipkart" | Opens both sites in parallel → extracts prices → tells you the best deal |
| "Fill out this job application" | Reads form fields → fills from your profile → asks for missing info → fills the rest |
| "Summarize this YouTube video" | Extracts transcript → summarizes via LLM → reads summary aloud |
| "Research the best laptops under 80000" | Opens Perplexity → writes query → reads cited results |
| "Remove the background from this image" | Opens remove.bg → uploads → downloads clean result |
| "Book a table for 2 at an Italian place in Delhi" | Searches restaurants → navigates booking flow → confirms with you |
| "Draft a follow-up email to the last meeting" | Opens Gmail → drafts email based on context → waits for your approval |

---

## Security & Privacy

ctrl captures microphone audio **only when the mic button is active**. It captures DOM snapshots and screenshots **only for the active tab during task execution**. All data is sent over HTTPS to Gemini, Groq, and OpenRouter.

ctrl does **not**:
- Inspect tabs you're not actively working in
- Submit forms without your explicit confirmation
- Store audio or screenshots beyond the current session
- Send data to any servers other than the configured AI APIs

---

## Contributing

### Adding a skill

1. Create `extension/skills/your-skill.js`
2. Follow the pattern from existing skills (see `form-fill.js` as a template)
3. Register in `extension/skills/index.js`
4. Submit a PR

### Reporting issues

Open an issue with:
- What you said (voice command)
- What happened vs what you expected
- The site you were on (if relevant)
- Console errors (if any)

---

## License

MIT

---

**ctrl** — Stop clicking. Start talking.