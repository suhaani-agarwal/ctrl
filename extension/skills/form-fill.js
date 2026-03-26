const formFill = {
  name: "form-fill",
  description: "Fill out web forms, registration pages, checkout forms, job applications, contact forms, surveys, sign-up pages, or any page with input fields",

  systemPromptAddition: `
FORM-FILL SKILL ACTIVE.

USER PROFILE (provided in goal):
- The goal text includes a "User profile:" section with pre-known values (Name, Email, Phone, Address, etc.).
- Use these values to fill matching fields WITHOUT asking the user.
- Match intelligently: "Full Name" → Name; "Mobile/Contact" → Phone; "PIN/ZIP" → Pincode; "Organisation" → Company.

NEW ACTION — ask_user:
Use this when a field has NO matching value in the profile. This pauses the agent and waits for user input.
{"type":"ask_user","fieldKey":"<snake_case_key>","question":"<voice-friendly question>","isSubjective":<true|false>,"elementIndex":<N or null>}

- fieldKey: a consistent snake_case identifier for this field (e.g. "email", "portfolio_url", "years_experience", "about_yourself")
- question: a natural, conversational question the voice agent will speak aloud.
  - For dropdowns: list ALL options clearly — e.g. "Which country should I select? The options are: India, United States, United Kingdom, Canada, Australia."
  - For URLs: "What is your [LinkedIn / portfolio / GitHub] URL?"
  - For factual: "What is your [field name]?"
- isSubjective: set true ONLY for creative/essay fields where the user gives raw notes and AI should draft polished content (e.g. cover letter, about me, project description, motivation statement). Set false for factual fields.
- elementIndex: the [N] index of the input field to type into immediately after the user answers. Set to the element number from the CLICKABLE ELEMENTS list, or null if you don't know yet.

SPEED STRATEGY — fill as many fields as possible per round:
1. ROUND 1 — SCAN AND BATCH FILL:
   - Look at ALL visible fields on the current screen at once.
   - For every field that has a profile match: return all fill actions together in a single actions array. Do NOT do one field per round.
   - For dropdowns visible on screen: click each one, read its options, and include the ask_user for ALL dropdowns in one round (one ask_user at a time, but queue them by returning the click actions immediately).
   - After batch-filling all profile fields, return a SINGLE ask_user for the first unknown field.

2. DROPDOWN HANDLING (fast path):
   - Click to open the dropdown so options are visible.
   - Read the options directly from the element list — do NOT wait another round.
   - If profile has a match, click the matching option immediately (same round).
   - If no match, return ask_user listing ALL options.

3. SCROLL AND CONTINUE:
   - After all visible fields are handled, scroll down to reveal the next set.
   - Batch-fill the new visible fields immediately.

4. URL / LINK FIELDS:
   - Common fieldKeys: "linkedin_url", "portfolio_url", "github_url", "website_url", "resume_url"
   - Check profile first. If present, fill directly.
   - If asking: "What URL should I enter for [field label]? For example: https://..."

5. FILE UPLOADS: skip and note in missingFields — cannot be handled automatically.
6. CAPTCHA: stop immediately, set done=true, extractedData.captchaBlocked=true.
7. SUBMIT CONFIRMATION (REQUIRED): Before clicking any submit/save/apply/next/continue button, ALWAYS use ask_user first:
   {"type":"ask_user","fieldKey":"submit_confirm","question":"All fields look good. Should I submit the form now?","isSubjective":false,"elementIndex":<N>}
   Set elementIndex to the [N] of the submit button so it can be clicked immediately after the user says yes.
   If completedActions already contains "User confirmed submit", skip ask_user and do NOT ask again — the user already said yes.
8. FINAL EXTRACT: {"type":"extract","fields":{"filledFields":"comma-separated list","missingFields":"comma-separated list"}}

IMPORTANT RULES:
- BATCH profile-matched fills: return multiple fill actions per round, never one at a time.
- ALWAYS include elementIndex in ask_user — look at the CLICKABLE ELEMENTS list and set elementIndex to the [N] of the input field being asked about.
- Only use ask_user for ONE field at a time. After the user answers, the agent will immediately type into elementIndex — no extra round needed.
- Never ask for something already visible in the profile section of the goal.
- After an ask_user, the answer is in extractedData and completedActions — use it immediately to type into the field.
- If the form has multiple pages, handle each page fully before navigating to the next.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default formFill;
