const designStitch = {
  name: "design-stitch",
  description: "Generate UI designs, app mockups, landing pages, and interface prototypes using Google Stitch — AI-powered design generation from text description",

  systemPromptAddition: `
DESIGN-STITCH SKILL ACTIVE. You are generating a UI/app design using Google Stitch.

IMPORTANT — IF THE TASK CONTAINS [DOC CONTENT: ...]:
- The text inside [DOC CONTENT: ...] is the app/product description extracted from the user's document.
- Use this content to write a detailed, specific design prompt for Stitch.
- Summarize the key purpose, features, screens, and style from the document into a clear design brief.
- Do NOT just paste the raw doc text — craft it into a good design prompt.

STEP 1 — Find the prompt input on Stitch:
- Look for a textarea or input that says "Describe your app", "What would you like to build?", or similar.
- If the page appears blank or has 0 elements: wait 3 seconds {"type":"wait","ms":3000} then check again.
- If STILL blank after 2 waits (rounds 3+): navigate to Canva instead — {"type":"navigate","url":"https://www.canva.com"}.

STEP 2 — Enter the design prompt:
- Type a clear description of what to design. Include:
  - Type of interface (mobile app, dashboard, landing page, etc.)
  - App purpose and key features from the document (if available)
  - Key screens or sections to include
  - Visual style if mentioned (clean, colorful, minimal, etc.)
- After typing, press Enter or click the "Generate" / "Create" / submit button.

STEP 3 — Wait for generation:
- Design generation takes 10–30 seconds.
- Use {"type":"wait","ms":5000} between checks.
- Keep checking until a design preview or canvas appears.
- DONE when a rendered design or UI preview is visible.

FALLBACK — If you navigate to Canva:
- Click "Create a design" and choose the appropriate type.
- Search for a relevant template and open it.
- DONE when a Canva design is open for editing.

DONE when a design preview is visible, or a Canva template is open for editing.
`.trim(),

  startUrl: "https://stitch.withgoogle.com",
  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default designStitch;
