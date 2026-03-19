const shopping = {
  name: "shopping",
  description: "Search for products, compare prices, add to cart, checkout, find deals, apply coupon codes, track orders, or any e-commerce task on Amazon, Flipkart, Etsy, eBay, or other shopping sites",

  systemPromptAddition: `
SHOPPING SKILL ACTIVE.
Common patterns:
- Product search: find the search bar (usually element with placeholder "Search..."), type query, press Enter.
- Product selection: look for product titles, prices, and ratings in the element list. Click the most relevant.
- Price extraction: use extract action to capture price, title, seller name before navigating away.
- Add to Cart: look for "Add to Cart", "Buy Now", "Add to Bag" buttons. They may be below the fold — scroll down first.
- Quantity selector: often a <select> element or +/- buttons near the Add to Cart button.
- Coupon codes: look for "Apply Coupon" or "Promo Code" input in cart/checkout pages.
- Size/variant selection: dropdowns or button groups for size/color must be selected BEFORE adding to cart.
- Always extract: { price, title, seller, availability } from product pages.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default shopping;
