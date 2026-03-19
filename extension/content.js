// content.js — DOM preview + permission banner only.
// All action execution is handled via CDP in background.js.

// ---- DOM preview builder ----
// Prioritises interactive + visible elements. Works on YouTube, SPAs, shadow-root pages.
function buildDomPreview(maxNodes = 120) {
  const results = [];
  const seen = new Set();

  const interactiveTags = ["a", "button", "input", "select", "textarea", "video", "summary"];
  const interactiveRoles = ["button","link","menuitem","tab","option","checkbox","radio","textbox","searchbox","combobox","slider","spinbutton","switch","treeitem","gridcell"];

  const allInteractive = [
    ...document.querySelectorAll(interactiveTags.join(",")),
    ...document.querySelectorAll("[role]"),
    ...document.querySelectorAll("[onclick]"),
    ...document.querySelectorAll("[tabindex]"),
  ];

  for (const el of allInteractive) {
    if (results.length >= maxNodes) break;
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    const node = describeNode(el);
    if (node) results.push(node);
  }

  const contextEls = document.querySelectorAll("h1,h2,h3,h4,[aria-label],[aria-labelledby],[data-title],ytd-video-renderer,ytd-compact-video-renderer,ytd-rich-item-renderer");
  for (const el of contextEls) {
    if (results.length >= maxNodes) break;
    if (seen.has(el) || !isVisible(el)) continue;
    seen.add(el);
    const node = describeNode(el);
    if (node) results.push(node);
  }

  if (results.length < maxNodes) {
    const queue = [{ el: document.body, depth: 0 }];
    while (queue.length && results.length < maxNodes) {
      const { el, depth } = queue.shift();
      if (!el || depth > 12) continue;
      if (!seen.has(el) && el !== document.body && isVisible(el)) {
        seen.add(el);
        const node = describeNode(el);
        if (node) results.push(node);
      }
      for (const child of el.children) {
        queue.push({ el: child, depth: depth + 1 });
      }
    }
  }

  return {
    title: document.title,
    url: location.href,
    scrollY: Math.round(window.scrollY),
    pageHeight: Math.round(document.body.scrollHeight),
    nodes: results
  };
}

function isVisible(el) {
  try {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) < 0.1) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > -200 && r.top < window.innerHeight + 200;
  } catch { return false; }
}

function describeNode(el) {
  const tag = el.tagName.toLowerCase();
  const text = getNodeText(el);
  const id = el.id;
  const ariaLabel = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || null;
  const dataTitle = el.getAttribute("data-title") || el.getAttribute("title") || null;
  const role = el.getAttribute("role") || null;
  const href = el.href || null;
  const type = el.type || null;
  const placeholder = el.placeholder || null;

  const hasContent = text || ariaLabel || dataTitle || href || placeholder;
  const isInteractive = ["a","button","input","select","textarea","video"].includes(tag) || role;
  if (!hasContent && !isInteractive) return null;

  let selector;
  if (id && !id.match(/^\d/) && id.length < 80) {
    selector = `${tag}#${id}`;
  } else if (ariaLabel) {
    const escaped = ariaLabel.replace(/"/g, '\\"').slice(0, 60);
    selector = `${tag}[aria-label="${escaped}"]`;
  } else {
    const cls = typeof el.className === "string"
      ? el.className.trim().split(/\s+/).filter(c => c.length > 0 && c.length < 40 && !c.match(/^\d/)).slice(0, 2).join(".")
      : "";
    selector = cls ? `${tag}.${cls}` : tag;
  }

  return {
    tag, role,
    text: text?.slice(0, 100) || null,
    ariaLabel: ariaLabel?.slice(0, 80) || null,
    dataTitle: dataTitle?.slice(0, 80) || null,
    href: href?.slice(0, 120) || null,
    type, placeholder, selector
  };
}

function getNodeText(el) {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.replace(/\s+/g, " ").trim();
  const title = el.getAttribute("title");
  if (title) return title.replace(/\s+/g, " ").trim();
  if (el.children.length <= 3) {
    const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > 0 && t.length < 200) return t;
  }
  return null;
}

// ---- Message listener ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SHOW_PERMISSION") {
    showPermissionBanner(message.description, sendResponse);
    return true;
  }

  if (message.type === "GET_DOM_PREVIEW") {
    try {
      sendResponse(buildDomPreview(message.maxNodes || 60));
    } catch {
      sendResponse({ nodes: [], title: document.title, url: location.href });
    }
    return;
  }
});

// ---- Permission banner ----
function showPermissionBanner(description, sendResponse) {
  document.getElementById("ctrl-perm-banner")?.remove();

  const banner = document.createElement("div");
  banner.id = "ctrl-perm-banner";
  Object.assign(banner.style, {
    position: "fixed", top: "0", left: "0", width: "100%", zIndex: "2147483647",
    background: "#111", color: "#f0f0f0", padding: "14px 20px",
    display: "flex", alignItems: "center", justifyContent: "center", gap: "16px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.6)", borderBottom: "2px solid #6366f1",
    fontFamily: "system-ui, sans-serif", fontSize: "14px"
  });

  const msg = document.createElement("span");
  msg.textContent = `ctrl wants to: ${description}`;

  const allow = makeBtn("Allow", "#6366f1", "#fff");
  const deny  = makeBtn("Deny", "#333", "#fff");

  banner.append(msg, allow, deny);
  document.body.prepend(banner);

  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    banner.remove();
    sendResponse(result);
  };

  allow.onclick = () => finish("GRANT");
  deny.onclick  = () => finish("DENY");
  setTimeout(() => finish("DENY"), 15000);
}

function makeBtn(label, bg, color) {
  const b = document.createElement("button");
  b.textContent = label;
  Object.assign(b.style, {
    background: bg, color, border: "none", padding: "7px 18px",
    borderRadius: "6px", cursor: "pointer", fontWeight: "600", fontSize: "13px"
  });
  return b;
}
