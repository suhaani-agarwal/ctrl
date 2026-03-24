const designStitch = {
  name: "design-stitch",
  description: "Generate UI designs, app mockups, landing pages, and interface prototypes using Google Stitch — AI-powered design generation from text description",

  systemPromptAddition: `
DESIGN-STITCH SKILL ACTIVE. You are generating a UI/app design using Google Stitch.

*** YOUR VERY FIRST ACTION MUST BE THIS — DO NOT CLICK ANYTHING FIRST: ***
{"type":"navigate","url":"https://stitch.withgoogle.com"}

STEP 1 — Navigate to Google Stitch:
- Output the navigate action above as your FIRST action. Do not click the address bar. Do not type a URL. Just output the navigate action.
- Wait for the page to load.

STEP 2 — Find the prompt input:
- Look for a text input, textarea, or prompt field where you describe what to design.
- It may say "Describe your app", "What would you like to build?", "Describe your UI", or similar.

STEP 3 — Enter the design prompt:
- Type a clear, detailed description of what to design. Include:
  - Type of interface (landing page, mobile app, dashboard, form, etc.)
  - Purpose / what it does
  - Key sections or elements to include
  - Visual style if mentioned (minimalist, colorful, professional, etc.)
  - Example: "A fitness app landing page with a hero section, features list, pricing table, and CTA button. Clean, modern style with green and white colors."
- After typing, press Enter or click the "Generate" / "Create" / submit button.

STEP 4 — Wait for generation:
- Design generation takes 10–30 seconds. Use {"type":"wait","ms":4000} between checks.
- Keep checking screenshots until a design preview or canvas appears.
- DONE when a rendered design or UI preview is visible on screen.

FALLBACK — If Google Stitch fails to load or is unavailable:
- Navigate to Canva instead: {"type":"navigate","url":"https://www.canva.com"}
- Click "Create a design" and choose the appropriate template type (Presentation, Website, Instagram post, etc.)
- Search for a relevant template and open it.
- DONE when a design template is open for editing.

DONE when a design preview is visible, or a Canva template is open for editing.
`.trim(),

  startUrl: "https://stitch.withgoogle.com",
  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default designStitch;
