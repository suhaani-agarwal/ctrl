const formFill = {
  name: "form-fill",
  description: "Fill out web forms, registration pages, checkout forms, job applications, contact forms, surveys, sign-up pages, or any page with input fields",

  systemPromptAddition: `
FORM-FILL SKILL ACTIVE.

USER PROFILE (if provided in goal):
- The goal text may include a "User profile:" section with pre-known values like Name, Email, Phone, Address, etc.
- Use these values to fill matching form fields WITHOUT asking the user.
- Match intelligently: "Full Name" → use Name value; "Mobile" or "Contact" → use Phone value; "PIN" or "ZIP" → use Pincode value.

Strategy:
- Identify all visible input fields first (use extract to note field labels/placeholders).
- Fill fields in logical order: name → email → phone → address → other.
- For required fields with no value in the profile, skip them and note in extractedData.missingFields.
- After filling all fields, look for a submit/continue/next button.
- If a CAPTCHA appears, stop and set done=true with extractedData.captchaBlocked=true.
- Confirm the final form state before submitting — check for validation errors.
- Do a final extract: {"type":"extract","fields":{"filledFields":"list of fields filled","missingFields":"list of required fields left blank"}}
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default formFill;
