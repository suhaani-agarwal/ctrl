const research = {
  name: "research",
  description: "Research topics, find information, compare options, read articles, extract data from websites, summarize content, or answer factual questions by browsing the web",

  systemPromptAddition: `
RESEARCH SKILL ACTIVE.
Strategy:
- Use extract action liberally to capture text, numbers, dates, names from pages.
- Navigate to the most authoritative source for the question (Wikipedia, official sites, news sites).
- For comparisons: extract data from each source into extractedData with clear keys.
- Avoid clicking ads or sponsored content — prefer organic search results.
- If a page requires login or paywall appears: skip and try another source.
- Summarize findings in extractedData.summary before setting done=true.
- Always include extractedData.sources as an array of URLs visited.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default research;
