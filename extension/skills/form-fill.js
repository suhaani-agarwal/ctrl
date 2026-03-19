const formFill = {
  name: "form-fill",
  description: "Fill out web forms, registration pages, checkout forms, contact forms, surveys, sign-up pages, or any page with input fields",

  systemPromptAddition: `
FORM-FILL SKILL ACTIVE.
Strategy:
- Identify all visible input fields first (use extract to note field labels/placeholders).
- Fill fields in logical order: name → email → phone → address → other.
- For required fields with no value, skip and note in extractedData.
- After filling all fields, look for a submit/continue/next button.
- If a CAPTCHA appears, stop and set done=true with extractedData.captchaBlocked=true.
- Confirm the final form state before submitting — check for validation errors.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default formFill;
