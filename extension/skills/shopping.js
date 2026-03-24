const shopping = {
  name: "shopping",
  description: "Search for products, compare prices, add to cart, checkout, find deals, apply coupon codes, track orders, or any e-commerce task on Amazon, Flipkart, Etsy, eBay, or other shopping sites",

  systemPromptAddition: `
SHOPPING SKILL ACTIVE.

STEP 1 — Navigate (if needed):
- Check CURRENT URL. If not on the target shopping site, navigate there immediately.
- Example: {"type": "navigate", "url": "https://www.amazon.com"}

STEP 2 — Search (ignore ALL pop-ups and banners):
- IGNORE location banners, delivery address popups, cookie notices, sign-in prompts, "Deliver to" widgets.
- DO NOT click on them. Go straight to the search bar.
- Search bar on Amazon: look for a Searchbox or Textbox near the top of the page (usually labeled "Search Amazon" or similar).
- Action sequence: {"type":"type","elementIndex":N,"value":"query","clear":true} then {"type":"keypress","key":"Enter"}

STEP 3 — Select product:
- From search results, pick the most relevant product by title, rating, and reviews. Click it.
- Prefer results with 4+ star ratings and many reviews.

STEP 4 — Product page:
- Extract: {"type":"extract","fields":{"price":"displayed price","title":"product name","rating":"star rating","reviews":"review count"}}
- If asked to add to cart: scroll down to find "Add to Cart"/"Buy Now". Handle size/color selectors first.

DONE when: search results or a product page is visible on the target site with the relevant item.
NEVER set done=true before searching has actually happened on the target site.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default shopping;
