const youtubeSummarize = {
  name: "youtube-summarize",
  description: "Summarize YouTube videos, answer questions about video content, extract key points or timestamps from a YouTube video",

  systemPromptAddition: `
YOUTUBE-SUMMARIZE SKILL ACTIVE. You are summarizing or answering questions about a YouTube video.

STEP 1 — Get to the right video:
- If the CURRENT URL already contains "youtube.com/watch" → stay on this page, skip navigation. Proceed to STEP 2.
- If the user mentioned a specific YouTube URL → output: {"type":"navigate","url":"<that url>"} as your FIRST action.
- Otherwise → output as your FIRST action: {"type":"navigate","url":"https://www.youtube.com"} then search for the video title in YouTube's search box and open the top result.
- Do NOT click the address bar. Do NOT try to type a URL. Output the navigate action directly.

STEP 2 — Open the transcript:
- On the video page, look for the "..." (three dots / more options) button below the video title.
- Click it to open the options menu.
- Look for "Open transcript" in the menu and click it.
- If "Open transcript" is not visible, scroll within the menu or look for it in the video description area.

STEP 3 — Extract the transcript:
- Once the transcript panel opens (usually on the right side), use extract to capture the text:
  {"type":"extract","fields":{"transcript":"full transcript text from the panel","videoTitle":"title of the video"}}
- If the transcript is long, scroll down within the transcript panel and extract again to capture more.

STEP 4 — Summarize:
- After extracting the transcript text, set done=true.
- The extracted transcript text will be used by the conversation agent to answer the user's question.
- If the user asked a specific question about the video, include that context in the extract fields.

DONE when transcript text has been extracted, or if transcript is unavailable, when key points from the video description and comments have been extracted.

FALLBACK — If transcript is not available:
- Extract the video description text and visible comments.
- Extract chapter markers if shown.
- Use these as a proxy for the content.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default youtubeSummarize;
