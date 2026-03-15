// content.js

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SHOW_PERMISSION") {
    const banner = document.createElement("div");
    banner.id = "ai-agent-permission-banner";
    Object.assign(banner.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      backgroundColor: "#1a1a1a",
      color: "#f0f0f0",
      padding: "15px",
      zIndex: "2147483647",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      gap: "20px",
      boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
      fontFamily: "system-ui, -apple-system, sans-serif",
      borderBottom: "2px solid #00bcd4"
    });

    const text = document.createElement("span");
    text.innerText = `AI Agent wants to: ${message.description}. Do you allow this?`;
    
    const btnContainer = document.createElement("div");
    btnContainer.style.display = "flex";
    btnContainer.style.gap = "10px";

    const allowBtn = document.createElement("button");
    allowBtn.innerText = "Allow";
    Object.assign(allowBtn.style, {
      backgroundColor: "#4caf50",
      color: "white",
      border: "none",
      padding: "8px 16px",
      borderRadius: "4px",
      cursor: "pointer",
      fontWeight: "bold"
    });

    const denyBtn = document.createElement("button");
    denyBtn.innerText = "Deny";
    Object.assign(denyBtn.style, {
      backgroundColor: "#f44336",
      color: "white",
      border: "none",
      padding: "8px 16px",
      borderRadius: "4px",
      cursor: "pointer",
      fontWeight: "bold"
    });

    btnContainer.appendChild(allowBtn);
    btnContainer.appendChild(denyBtn);
    banner.appendChild(text);
    banner.appendChild(btnContainer);
    document.body.appendChild(banner);

    let resolved = false;
    const cleanup = (result) => {
      if (resolved) return;
      resolved = true;
      document.body.removeChild(banner);
      sendResponse(result);
    };

    allowBtn.onclick = () => cleanup("GRANT");
    denyBtn.onclick = () => cleanup("DENY");

    // Auto-deny after 15 seconds
    setTimeout(() => cleanup("DENY"), 15000);

    return true; // Async response
  }

  if (message.type === "EXECUTE") {
    try {
      const { kind, selector, value } = message;
      let element = null;
      if (selector && selector !== "null") {
        element = document.querySelector(selector);
      }

      switch (kind) {
        case "click":
          if (element) {
            element.click();
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: "Element not found" });
          }
          break;
        case "fill":
          if (element) {
            element.value = value;
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: "Element not found" });
          }
          break;
        case "scroll":
          window.scrollBy(0, parseInt(value) || 0);
          sendResponse({ success: true });
          break;
        case "navigate":
          window.location.href = value;
          sendResponse({ success: true });
          break;
        default:
          sendResponse({ success: false, error: "Unknown action kind" });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.message });
    }
  }
  if (message.type === "GET_PAGE_CONTEXT") {
    try {
      const selector = message.selector;
      const title = document.title || '';
      const url = location.href || '';
      const selection = window.getSelection ? window.getSelection().toString().slice(0, 300) : '';
      let elementInfo = null;
      if (selector && selector !== "null") {
        const el = document.querySelector(selector);
        if (el) {
          elementInfo = {
            tag: el.tagName,
            id: el.id || null,
            class: el.className || null,
            text: (el.innerText || el.textContent || '').trim().slice(0, 500),
            value: el.value || null,
            href: el.href || null
          };
        }
      }
      sendResponse({ title, url, selection, element: elementInfo });
    } catch (e) {
      sendResponse({ error: e.message });
    }
    return true;
  }
});
