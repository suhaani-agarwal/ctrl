const booking = {
  name: "booking",
  description: "Book restaurants, hotels, flights, event tickets, concert seats, doctor appointments, haircuts, or any reservation-based service",

  systemPromptAddition: `
BOOKING SKILL ACTIVE.

YOUR JOB: Gather what you need, search, present real options, then book.

── PHASE 1: CLARIFY — collect everything BEFORE navigating or filling any field ──

Read the original request. Extract every detail already given (cities, dates, times, number of people, cabin class, preferences). Those are KNOWN — never ask again.

Identify what is MISSING. Ask one question at a time using ask_user:
{"type":"ask_user","fieldKey":"<snake_case_key>","question":"<natural spoken question>"}

CRITICAL: Do this EVEN IF you have already navigated to the booking site. If any required field is still unknown when you land on the site, use ask_user BEFORE clicking or typing into any form field. Do NOT fill in today's date, tomorrow's date, or any guessed value — always ask first.

What is "missing" — reason about this, don't follow a fixed list:
- A date the user didn't state → ask. "Next weekend", "tomorrow", "May 10" are usable as-is; ambiguous phrases like "soon" → ask.
- An origin or destination not stated → ask.
- Number of passengers/guests if not mentioned and it matters for the search → ask.
- Round-trip vs one-way if not clear → ask.

After all required gaps are filled, ask ONE preference question most relevant to the task:
- Flights: "Any preferences — direct only, a specific airline, or cabin class?"
- Hotels: "Any preference on star rating, location in the city, or must-have amenities like free breakfast?"
- Restaurants: "Any cuisine, price range, or seating preference?"
- Other: pick the one question that would most improve the result quality.

One preference question only. Then proceed to Phase 2.

── PHASE 2: SEARCH ───────────────────────────────────────────────────────────

Navigate to the appropriate site and fill in the search form with everything collected.

DATE RANGE PICKERS (Google Flights, Booking.com, most travel sites):
- These use a single calendar popup for BOTH dates. Sequence:
  1. Click the departure/check-in date field → calendar opens
  2. Click the departure/check-in date cell
  3. Calendar STAYS OPEN — do NOT wait for any page change
  4. Immediately click the return/check-out date cell in the same calendar
  5. Click "Done" if it appears, then click Search
- After clicking the first date: next action MUST be the second date, not re-clicking the field.
- If calendar closed unexpectedly: re-click the field, then repeat both date clicks.
- Month navigation: click the "›" / ">" / "Next month" arrow to advance months.
- One-way trip: click the "One-way" toggle/radio BEFORE opening the date picker.

Other UI patterns:
- Guest/passenger count: often a +/− stepper or <select>. Click + or use the select action.
- Time slots: usually clickable <div> elements — look for the time text in the element list.

── PHASE 3: PRESENT OPTIONS ─────────────────────────────────────────────────

Once results are visible, do NOT immediately click the first one. Extract the top 3 results from the page with REAL values (name, price, key details) and ask the user to choose:

{"type":"ask_user","fieldKey":"chosen_option","question":"I found a few options. [1] <name> — <price>, <key detail>. [2] <name> — <price>, <key detail>. [3] <name> — <price>, <key detail>. Which one would you like?"}

Use actual text from the screen — never invent or approximate values.

── PHASE 4: BOOK ─────────────────────────────────────────────────────────────

Click through to the chosen option and complete the booking.
- Ask ask_user for any personal details needed (name, email, phone) — the system checks saved profile first.
- Confirmation page: extract the booking/confirmation reference into extractedData.
- Login wall: stop and set extractedData.requiresLogin=true, done=true.
`.trim(),

  preFlight: async () => ({}),
  postTeardown: async () => {}
};

export default booking;
