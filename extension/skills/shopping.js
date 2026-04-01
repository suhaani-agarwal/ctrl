const shopping = {
  name: "shopping",
  description: "Search for products, compare prices, add to cart, checkout, find deals, apply coupon codes, track orders, browse by category, use filters, or any e-commerce task on Amazon, Flipkart, IKEA, eBay, Etsy, Myntra, Meesho, Nykaa, Shopify stores, or other shopping sites",

  systemPromptAddition: `
SHOPPING SKILL ACTIVE.

IMPORTANT — CONTEXT AWARENESS:
If the user says "find something similar", "like this", "like the one on screen", "find this on Amazon", etc.:
- You will see TWO screenshots: the INITIAL SCREEN (what the user was looking at) and the CURRENT SCREEN.
- First analyze the INITIAL SCREEN to identify the product: name, brand, color, type, key features.
- Use those details as your search query on the target site.
- Do NOT guess or use a generic query — extract the actual product details from the initial screenshot.

STEP 1 — Navigate (if needed):
- Check CURRENT URL. If not on the target shopping site, navigate there first.
- Supported sites: amazon.com / amazon.in, flipkart.com, ikea.com, ebay.com, etsy.com, myntra.com, meesho.com, nykaa.com, croma.com, or any Shopify store the user mentions.
- Example: {"type":"navigate","url":"https://www.amazon.com"}

STEP 2 — Search (ignore ALL pop-ups and banners):
- IGNORE location banners, delivery popups, cookie notices, sign-in prompts.
- DO NOT click them. Go straight to the search bar.
- Type the product query: {"type":"type","index":N,"value":"query","clear":true}
- Submit with Enter targeting the SAME search bar element: {"type":"keypress","key":"Enter","index":N}
- The index N in keypress MUST match the search bar index — do NOT use a bare keypress.

STEP 3 — Apply filters (if user requested):
- After results load, look for filter panels (Brand, Price Range, Rating, Category, Color, Size, etc.)
- Amazon: filters are in the left sidebar. Click checkboxes or use sliders.
- Flipkart: filters are in the left sidebar under "Filters".
- IKEA: use the filter/sort options at the top of results.
- Price filter: find min/max price inputs or range sliders and fill them.
- Rating filter: click "4 stars & above" or similar.
- Always apply filters the user asked for before selecting a product.

STEP 3.5 — Visual match (when user showed a product on screen):
- If you can see the INITIAL SCREEN, compare product result IMAGES visually against it.
- Look at shape, color, material, form factor — not just the text title.
- Eliminate results that clearly differ in silhouette or dominant color from the initial screen.
- Prefer the result whose product photo most closely resembles the item in INITIAL SCREEN.
- Only fall back to text/title matching if no clear visual match is available.

STEP 4 — Select product:
- From results, pick the most relevant product by visual similarity (see 3.5), title, rating, and reviews. Click it.
- Prefer results with 4+ star ratings and many reviews.

STEP 5 — Product page:
- Extract: {"type":"extract","fields":{"price":"displayed price","title":"product name","rating":"star rating","reviews":"review count"}}
- If asked to add to cart: scroll to "Add to Cart"/"Buy Now". Handle size/color selectors first.

STEP 6 — Ask for missing specs (when needed):
- If you reach a product page and a required selection is missing (size, color, quantity) that the user didn't specify, use:
  {"type":"ask_user","fieldKey":"product_spec","question":"Which size/color do you prefer for this product?"}
- Wait for the answer, then select accordingly.
- For checkout: always confirm before submitting with {"type":"ask_user","fieldKey":"submit_confirm","question":"Ready to place the order?"}

DONE when: search results or a product page is visible with the relevant item, and any requested filters have been applied.
NEVER set done=true before searching has actually happened on the target site.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default shopping;
