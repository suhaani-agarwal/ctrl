const priceCompare = {
  name: "price-compare",
  description: "Compare prices of a product across Amazon, Flipkart, and other online stores to find the best deal",

  systemPromptAddition: `
PRICE-COMPARE SKILL ACTIVE. You are comparing prices across multiple shopping sites.

STEP 1 — Search on Amazon:
*** YOUR VERY FIRST ACTION MUST BE THIS — DO NOT CLICK ANYTHING FIRST: ***
{"type":"navigate","url":"https://www.amazon.in"}

- Output the navigate action above as your FIRST action. Do not click the address bar.
- Navigate to Amazon (amazon.in for India, amazon.com for US/global).
- Search for the product name in Amazon's search bar. Press Enter.
- From search results, click the most relevant product listing.
- On the product page, extract the price:
  {"type":"extract","fields":{"amazon_price":"current price shown","amazon_title":"product name","amazon_url":"page URL"}}

STEP 2 — Search on Flipkart:
- Open a new tab: {"type":"navigate","url":"https://www.flipkart.com"}
  (The navigate action will open in the current tab — this is fine for sequential comparison)
- Search for the same product name. Press Enter.
- Click the most relevant result.
- Extract the price:
  {"type":"extract","fields":{"flipkart_price":"current price shown","flipkart_title":"product name"}}

STEP 3 — Check one more site (optional but preferred):
- If the product is electronics or tech → check Croma (croma.com) or Vijay Sales.
- If the product is fashion/apparel → check Myntra (myntra.com).
- If the product is general → check Meesho (meesho.com).
- Navigate to the chosen site, search, find the product, extract price:
  {"type":"extract","fields":{"site3_name":"site name","site3_price":"price shown"}}

STEP 4 — Compile comparison:
- Do a final extract summarizing all prices found:
  {"type":"extract","fields":{"price_comparison":"Amazon: X | Flipkart: Y | [Site3]: Z","best_deal":"site with lowest price","recommendation":"which one to buy and why"}}

DONE when prices from at least 2 sites have been collected and a comparison summary has been extracted.
`.trim(),

  startUrl: "https://www.amazon.in",
  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default priceCompare;
