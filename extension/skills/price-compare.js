const priceCompare = {
  name: "price-compare",
  description: "Compare prices of a product across Amazon, Flipkart, IKEA, eBay, Etsy, and other online stores to find the best deal",

  systemPromptAddition: `
PRICE-COMPARE SKILL ACTIVE. You are ONE parallel agent assigned to ONE shopping site.
Your job: search → browse results → extract the CHEAPEST matching product → done=true.
You have up to 10 rounds. Be thorough but efficient.

STEP 1 — SEARCH (round 1):
- Use a SHORT SIMPLIFIED query based on product type and color only (e.g. "green cushion cover").
- Do NOT use brand/model names — they likely don't exist here.
- Type into the search bar and submit with {"type":"keypress","key":"Enter","index":N} (SAME index as search bar).
- Ignore ALL popups, banners, location prompts — go straight to the search bar.

STEP 2 — FIND CHEAPEST MATCHING RESULT (rounds 2-5):
- After results load, scan ALL visible product cards.
- If cards are cut off or you can only see a few, scroll down to reveal more: {"type":"scroll","direction":"down","amount":600}
- Among cards that match the product category and color, identify the one with the LOWEST PRICE.
- If there are NO matching results at all, try a simpler/broader query (e.g. "cushion" instead of "green cushion cover") and search again.

STEP 3 — EXTRACT (same round as done=true):
- Read the actual price and title text from the product card you identified.
- Use an extract action with REAL VALUES you see on screen — never descriptions:
  CORRECT: {"type":"extract","fields":{"price":"₹349","title":"Story@Home Green Cushion Cover 16x16","site":"Amazon","url":"https://www.amazon.in/..."}}
  WRONG:   {"type":"extract","fields":{"price":"cheapest price","title":"product title"}}
- In the SAME JSON response, set done=true.

RULES:
- Do NOT click into any product page — extract from the search results page.
- NEVER set done=true without an extract action containing actual price and title values visible on screen.
- If after 2 searches there are genuinely no relevant results, extract {"price":"not found","title":"no results","site":"...","url":"..."} and set done=true.
`.trim(),

  maxRounds: 10,

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default priceCompare;
