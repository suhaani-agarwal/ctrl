const pptGamma = {
  name: "ppt-gamma",
  description: "Create presentations, slide decks, pitch decks, and slideshows using Gamma.app — AI-generated slides from a text description",
  maxRounds: 30,

  systemPromptAddition: `
PPT-GAMMA SKILL ACTIVE. You are creating a presentation using Gamma.app.

The startUrl is https://gamma.app/create — navigation is already handled. You are on the create page.

CURRENT GAMMA UI FLOW (follow in exact order):

STEP 1 — Type the presentation topic:
- On gamma.app/create there is a large text input field asking what the presentation should be about.
- Find the Textbox or Searchbox element in the CLICKABLE ELEMENTS list.
- Use {"type":"type","index":N,"value":"YOUR PROMPT","clear":true} to type a clear, detailed prompt.
  - Example prompt: "10-slide presentation on climate change: causes, effects, solutions, and individual actions. Include key statistics."
  - Include topic, slide count (default 10), and key sections based on the user's goal.
- After typing, DO NOT press Enter yet — go to Step 2.

STEP 2 — Select "Presentation" format (if not already selected):
- Look for tabs or buttons labeled "Presentation", "Document", "Webpage".
- If "Presentation" is not already highlighted/selected, click it.
- If it looks already selected (active/highlighted), SKIP this step.

STEP 3 — Click "Generate" or "Continue":
- Find a button labeled "Generate", "Continue", "Create", or similar and click it.
- This starts AI generation.

STEP 4 — Wait for generation:
- Generation takes 20–60 seconds. Use {"type":"wait","ms":5000} repeatedly.
- After each wait, take a screenshot to check progress.
- You will see a loading spinner, progress bar, or "Generating..." text while it works.
- KEEP WAITING until you see actual slide thumbnails, a slide editor, or multiple cards.

STEP 5 — Confirm done:
- Once slide thumbnails or the presentation editor is clearly visible, set done=true.
- Use {"type":"extract","fields":{"result":"description of what was created, number of slides visible"}}

IMPORTANT RULES:
- NEVER navigate away from gamma.app once generation starts — just wait.
- If you see a login/signup wall, look for a "Continue as guest" or "Try without account" option.
- If generation errors out, click any "Retry" or "Regenerate" button once.
- NEVER repeat a step you already completed — check the "Steps already completed" list each round.
`.trim(),

  startUrl: "https://gamma.app/create",
  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default pptGamma;
