const booking = {
  name: "booking",
  description: "Book restaurants, hotels, flights, event tickets, concert seats, doctor appointments, haircuts, or any reservation-based service",

  systemPromptAddition: `
BOOKING SKILL ACTIVE.
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
