const email = {
  name: "email",
  description: "Read, compose, send, reply to, forward, label, archive, delete, or search emails in Gmail or other webmail clients",

  systemPromptAddition: `
EMAIL SKILL ACTIVE.
Gmail patterns:
- Compose: click the "Compose" button (usually top-left). A compose window appears at bottom-right.
- To/CC/BCC: click the respective fields and type email addresses.
- Subject: click the Subject field and type.
- Body: click the large text area below subject and type the email body.
- Send: click the blue "Send" button.
- Reply: open an email, click "Reply" at the bottom of the thread.
- Search: click the search bar at top, type query, press Enter.
- Label: open email, click the label icon (tag icon) in toolbar.
- Archive: open email, click the archive button (box with down arrow).
- Important: after composing, always verify To/Subject fields before clicking Send.
- If 2FA or security prompts appear: stop and set extractedData.requiresAuth=true, done=true.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default email;
