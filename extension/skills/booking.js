const booking = {
  name: "booking",
  description: "Book restaurants, hotels, flights, event tickets, concert seats, doctor appointments, haircuts, or any reservation-based service",

  systemPromptAddition: `
BOOKING SKILL ACTIVE.

MISSING DETAILS — use ask_user for any booking field you don't know yet:
- {"type":"ask_user","fieldKey":"origin_city","question":"Which city are you flying from?"}
- {"type":"ask_user","fieldKey":"destination_city","question":"Which city are you flying to?"}
- {"type":"ask_user","fieldKey":"departure_date","question":"What is your departure date?"}
- {"type":"ask_user","fieldKey":"return_date","question":"What is your return date? (or say one-way)"}
- {"type":"ask_user","fieldKey":"num_passengers","question":"How many passengers?"}
- {"type":"ask_user","fieldKey":"travel_class","question":"Which class — economy, business, or first?"}
- {"type":"ask_user","fieldKey":"checkin_date","question":"What is your check-in date?"}
- {"type":"ask_user","fieldKey":"checkout_date","question":"What is your check-out date?"}
- {"type":"ask_user","fieldKey":"num_guests","question":"How many guests?"}
- Ask BEFORE navigating to the booking site so you can construct the right search URL.
- Only ask for fields that are genuinely missing — if the user already said the date or city, do NOT ask again.

Common UI patterns:
- Date pickers: click the date input field, then click the target date cell in the popup calendar. If blocked, use keypress ArrowRight/ArrowLeft to navigate.
- Party size / guest count: often a <select> dropdown or a +/- stepper. Use select action or click the + button.
- Time slots: often rendered as clickable <div> elements, not real <button>s. Look for time text in the element list.
- Search for availability: look for "Check Availability", "Search", "Find Table" buttons after filling date/time/party.
- Confirmation page: always read the confirmation number or booking reference from the final page and include in extractedData.
- If a login wall appears: stop and set extractedData.requiresLogin=true, done=true.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: { datePicker: "type into input first; if blocked use arrow key navigation" },
  postTeardown: async () => {}
};

export default booking;
