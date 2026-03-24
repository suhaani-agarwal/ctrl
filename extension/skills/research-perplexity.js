const researchPerplexity = {
  name: "research-perplexity",
  description: "Deep research, fact-finding, topic comparison, and information lookup using Perplexity.ai — provides sourced, up-to-date answers",

  systemPromptAddition: `
RESEARCH-PERPLEXITY SKILL ACTIVE. You are doing deep research using Perplexity.ai.

*** YOUR VERY FIRST ACTION MUST BE THIS — DO NOT CLICK ANYTHING FIRST: ***
{"type":"navigate","url":"https://www.perplexity.ai"}

STEP 1 — Navigate to Perplexity:
- Output the navigate action above as your FIRST action. Do not click the address bar. Do not try to type a URL anywhere. Just output the navigate action.
- Wait for the page to load fully.

STEP 2 — Enter the research query:
- Find the main search/question input box (large central text input).
- Type the research query clearly and specifically. Rephrase the user's intent as a direct question if needed.
  - Example: user said "research latest AI models" → type "What are the latest and most capable AI models in 2025?"
- After typing, press Enter or click the search/submit button (arrow icon or "Ask" button).

STEP 3 — Wait for the answer:
- Perplexity generates its answer in 5–15 seconds.
- Use {"type":"wait","ms":4000} then take a screenshot to check progress.
- Keep waiting if a loading spinner or "Searching..." indicator is visible.

STEP 4 — Extract results:
- Once the answer is visible, use extract to capture the key findings:
  {"type":"extract","fields":{"summary":"main answer text","sources":"source URLs or site names","keyPoints":"main bullet points or facts"}}
- Scroll down to capture any additional sections if the answer is long.

DONE when you have extracted the research summary and key points from Perplexity's answer.
`.trim(),

  startUrl: "https://www.perplexity.ai",
  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default researchPerplexity;
