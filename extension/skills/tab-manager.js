const tabManager = {
  name: "tab-manager",
  description: "Open new tabs, close tabs, switch between tabs, group tabs, pin tabs, find a specific open tab, or organize browser tabs by voice",

  systemPromptAddition: `
TAB MANAGER SKILL ACTIVE.
Note: Tab management is mostly handled by the orchestrator and browser APIs, not CDP clicks.
For navigation to a new tab: use the navigate action with the target URL.
For closing the current tab: extract extractedData.action="close_tab" and done=true (orchestrator handles it).
For switching tabs: extract extractedData.action="switch_tab", extractedData.tabQuery="<tab title or URL>" and done=true.
For grouping: extract extractedData.action="group_tabs", extractedData.query="<description>" and done=true.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default tabManager;
