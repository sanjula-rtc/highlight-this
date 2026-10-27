// Content script: applies highlights on the page, lets the user create new
// ones from a text selection, and removes them on request. Highlights are
// persisted in chrome.storage.local, keyed by page URL (minus hash and
// tracking query params).

(() => {
  if (
    location.hostname === "mail.google.com" ||
    location.hostname.endsWith(".mail.google.com")
  ) {
    return;
  }

  const STORAGE_KEY = "highlights";
  const CONTEXT_CHARS = 32;
  const MARK_CLASS = "hlthis-mark";
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "IFRAME",
  ]);
  const TRACKING_PARAM = /^(utm_|utm$|fbclid|gclid|gclsrc|dclid|msclkid|twclid|yclid|mc_|igshid|_ga|_gl|ref|referrer|source|ncid|ocid)/i;

  let bubble = null;
  let bubbleMode = null; // "highlight" | "remove"
  let bubbleTargetId = null;
  let lastPageKey = getPageKey();
  let restoreTimer = null;
  let restoring = false;

  // ---------- storage helpers ----------

  function getPageKey(url = location.href) {
    try {
      const u = new URL(url, location.href);
      const params = new URLSearchParams();
      u.searchParams.forEach((value, key) => {
        if (!TRACKING_PARAM.test(key)) params.append(key, value);
      });
      const qs = params.toString();
      return u.origin + u.pathname + (qs ? "?" + qs : "");
    } catch (e) {
      return url;
    }
  }

  function getAllHighlights() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (data) => {
        resolve((data && data[STORAGE_KEY]) || {});
      });
    });
  }

  async function getPageHighlights(pageKey) {
    const all = await getAllHighlights();
    if (all[pageKey] && all[pageKey].length) return all[pageKey].slice();

    // Migrate older keys that included tracking params or used the raw href.
    const migrated = [];
    const staleKeys = [];
    for (const [key, list] of Object.entries(all)) {
      if (!Array.isArray(list) || !list.length) continue;
      let normalized = key;
      try {
        normalized = getPageKey(key);
      } catch (e) {
        continue;
      }
      if (normalized === pageKey) {
        migrated.push(...list);
        if (key !== pageKey) staleKeys.push(key);
      }
    }
    if (migrated.length && staleKeys.length) {
      all[pageKey] = migrated;
      staleKeys.forEach((key) => delete all[key]);
      await setAllHighlights(all);
    }
    return migrated;
  }

  function setAllHighlights(all) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: all }, resolve);
    });
  }

  async function savePageHighlights(pageKey, list) {
    const all = await getAllHighlights();
    if (list.length) {
      all[pageKey] = list;
    } else {
      delete all[pageKey];
    }
    await setAllHighlights(all);
  }

  function generateId() {
    return "h_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- text walking / matching (used to restore highlights) ----------

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`.${MARK_CLASS}`)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".hlthis-bubble")) return NodeFilter.FILTER_REJECT;
        if (parent.closest("[contenteditable='true']")) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function buildFlatText(root) {
    const nodes = collectTextNodes(root);
    let text = "";
    const map = [];
    for (const node of nodes) {
      const value = node.nodeValue;
      for (let i = 0; i < value.length; i++) {
        map.push({ node, offset: i });
      }
      text += value;
    }
    return { text, map };
  }

  function buildNorm(text) {
    let norm = "";
    const toRaw = [];
    let pendingSpace = false;
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) {
        pendingSpace = norm.length > 0;
        continue;
      }
      if (pendingSpace) {
        norm += " ";
        toRaw.push(i);
        pendingSpace = false;
      }
      norm += text[i];
      toRaw.push(i);
    }
    return { norm, toRaw };
  }

  function scoreMatch(haystack, start, end, prefix, suffix) {
    const actualPrefix = haystack.slice(Math.max(0, start - prefix.length), start);
    const actualSuffix = haystack.slice(end, end + suffix.length);
    let score = 0;
    if (prefix && actualPrefix === prefix) score += 2;
    else if (prefix && actualPrefix.endsWith(prefix.slice(-8))) score += 1;
    if (suffix && actualSuffix === suffix) score += 2;
    else if (suffix && actualSuffix.startsWith(suffix.slice(0, 8))) score += 1;
    return score;
  }

  function findAllIndexes(haystack, needle) {
    const out = [];
    if (!needle) return out;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      out.push(idx);
      idx = haystack.indexOf(needle, idx + 1);
    }
    return out;
  }

  function findBestRange(flat, quote, prefix, suffix) {
    if (!quote) return null;
    const { text } = flat;

    let best = null;
    let bestScore = -1;
    for (const idx of findAllIndexes(text, quote)) {
      const start = idx;
      const end = idx + quote.length;
      const score = scoreMatch(text, start, end, prefix || "", suffix || "");
      if (score > bestScore) {
        bestScore = score;
        best = { start, end };
      }
    }
    if (best) return best;

    const h = buildNorm(text);
    const q = (quote || "").replace(/\s+/g, " ").trim();
    const p = (prefix || "").replace(/\s+/g, " ");
    const s = (suffix || "").replace(/\s+/g, " ");
    if (!q) return null;
    for (const idx of findAllIndexes(h.norm, q)) {
      const startNorm = idx;
      const endNorm = idx + q.length;
      const score = scoreMatch(h.norm, startNorm, endNorm, p, s);
      if (score > bestScore) {
        bestScore = score;
        const rawIndexes = [];
        for (let i = startNorm; i < endNorm; i++) {
          if (h.toRaw[i] != null) rawIndexes.push(h.toRaw[i]);
        }
        if (!rawIndexes.length) continue;
        best = {
          start: rawIndexes[0],
          end: rawIndexes[rawIndexes.length - 1] + 1,
        };
      }
    }
    return best;
  }

  function flatRangeToDomRange(map, start, end) {
    if (start < 0 || end > map.length || start >= end) return null;
    const startInfo = map[start];
    const endInfo = map[end - 1];
    const range = document.createRange();
    range.setStart(startInfo.node, startInfo.offset);
    range.setEnd(endInfo.node, endInfo.offset + 1);
    return range;
  }

  function rangeToFlatOffsets(range, flat) {
    let start = -1;
    let end = -1;
    for (let i = 0; i < flat.map.length; i++) {
      const { node, offset } = flat.map[i];
      let inside = false;
      try {
        inside = range.isPointInRange(node, offset);
      } catch (e) {
        inside = false;
      }
      if (inside) {
        if (start === -1) start = i;
        end = i + 1;
      }
    }
    if (start === -1 || end <= start) return null;
    return { start, end };
  }

  function serializeRange(range) {
    const flat = buildFlatText(document.body);
    const offsets = rangeToFlatOffsets(range, flat);
    if (offsets) {
      return {
        text: flat.text.slice(offsets.start, offsets.end),
        prefix: flat.text.slice(Math.max(0, offsets.start - CONTEXT_CHARS), offsets.start),
        suffix: flat.text.slice(offsets.end, offsets.end + CONTEXT_CHARS),
      };
    }
    const text = range.toString();
    return { text, ...getContext(range, CONTEXT_CHARS) };
  }

  // ---------- wrapping / unwrapping ----------

  function wrapTextNode(node, id) {
    if (!node || !node.nodeValue) return null;
    const mark = document.createElement("mark");
    mark.className = MARK_CLASS;
    mark.dataset.highlightId = id;
    node.parentNode.insertBefore(mark, node);
    mark.appendChild(node);
    return mark;
  }

  function wrapRange(range, id) {
    const marks = [];
    if (!range || range.collapsed) return marks;

    // Capture everything we need before mutating the DOM: splitText()
    // live-adjusts this same Range's boundaries as soon as it runs, so
    // re-reading range.startOffset/endOffset/startContainer/endContainer
    // after the first split can observe already-shifted values.
    const startContainer = range.startContainer;
    const startOffset = range.startOffset;
    const endContainer = range.endContainer;
    const endOffset = range.endOffset;

    if (startContainer === endContainer && startContainer.nodeType === Node.TEXT_NODE) {
      const middle = startContainer.splitText(startOffset);
      middle.splitText(endOffset - startOffset);
      const mark = wrapTextNode(middle, id);
      if (mark) marks.push(mark);
      return marks;
    }

    const root =
      range.commonAncestorContainer.nodeType === Node.TEXT_NODE
        ? range.commonAncestorContainer.parentNode
        : range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodesToWrap = [];
    let node;
    while ((node = walker.nextNode())) {
      if (range.intersectsNode(node) && node.nodeValue) {
        nodesToWrap.push(node);
      }
    }

    for (const textNode of nodesToWrap) {
      let targetNode = textNode;
      if (textNode === startContainer) {
        targetNode = textNode.splitText(startOffset);
      }
      if (targetNode === endContainer) {
        targetNode.splitText(endOffset);
      } else if (textNode === endContainer) {
        targetNode.splitText(endOffset);
      }
      const mark = wrapTextNode(targetNode, id);
      if (mark) marks.push(mark);
    }

    return marks;
  }

  function removeHighlightFromDom(id) {
    const marks = document.querySelectorAll(
      `mark.${MARK_CLASS}[data-highlight-id="${CSS.escape(id)}"]`
    );
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  function unwrapAllHighlights() {
    document.querySelectorAll(`mark.${MARK_CLASS}`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  // ---------- context capture (for saving new highlights) ----------

  function getContext(range, n) {
    let prefix = "";
    let suffix = "";
    try {
      const preRange = document.createRange();
      preRange.selectNodeContents(document.body);
      preRange.setEnd(range.startContainer, range.startOffset);
      prefix = preRange.toString().slice(-n);
    } catch (e) {
      // ignore
    }
    try {
      const postRange = document.createRange();
      postRange.selectNodeContents(document.body);
      postRange.setStart(range.endContainer, range.endOffset);
      suffix = postRange.toString().slice(0, n);
    } catch (e) {
      // ignore
    }
    return { prefix, suffix };
  }

  // ---------- public actions ----------

  async function highlightCurrentSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    const serialized = serializeRange(range);
    const text = (serialized.text || "").replace(/\s+/g, " ").trim();
    if (!text) return;

    const id = generateId();

    try {
      wrapRange(range.cloneRange(), id);
    } catch (e) {
      console.warn("[highlight-this] could not wrap selection", e);
      return;
    }
    selection.removeAllRanges();
    hideBubble();

    const pageKey = getPageKey();
    const list = await getPageHighlights(pageKey);
    list.push({
      id,
      text: serialized.text,
      prefix: serialized.prefix,
      suffix: serialized.suffix,
      color: "yellow",
      createdAt: Date.now(),
    });
    await savePageHighlights(pageKey, list);
  }

  async function removeHighlight(id) {
    removeHighlightFromDom(id);
    const pageKey = getPageKey();
    const list = await getPageHighlights(pageKey);
    const next = list.filter((h) => h.id !== id);
    await savePageHighlights(pageKey, next);
  }

  async function restoreHighlights() {
    if (restoring) return;
    if (!document.body) return;
    restoring = true;
    try {
      const pageKey = getPageKey();
      const list = await getPageHighlights(pageKey);
      if (!list.length) return;

      for (const item of list) {
        if (
          document.querySelector(
            `mark.${MARK_CLASS}[data-highlight-id="${CSS.escape(item.id)}"]`
          )
        ) {
          continue;
        }
        const flat = buildFlatText(document.body);
        const match = findBestRange(
          flat,
          item.text,
          item.prefix || "",
          item.suffix || ""
        );
        if (!match) continue;
        const range = flatRangeToDomRange(flat.map, match.start, match.end);
        if (!range) continue;
        try {
          wrapRange(range, item.id);
        } catch (e) {
          console.warn("[highlight-this] failed to restore highlight", e);
        }
      }
    } finally {
      restoring = false;
    }
  }

  function scheduleRestore() {
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      restoreHighlights();
    }, 250);
  }

  // ---------- floating action bubble (Highlight / Remove) ----------

  function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement("div");
    bubble.className = "hlthis-bubble";
    bubble.hidden = true;
    bubble.addEventListener("mousedown", (e) => e.preventDefault());
    bubble.addEventListener("click", onBubbleClick);
    document.documentElement.appendChild(bubble);
    return bubble;
  }

  function showBubbleAt(rect, label, mode, targetId) {
    const el = ensureBubble();
    el.textContent = label;
    bubbleMode = mode;
    bubbleTargetId = targetId;
    const top = Math.max(8, rect.top - 36);
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - 40),
      window.innerWidth - 88
    );
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.hidden = false;
  }

  function hideBubble() {
    if (bubble) bubble.hidden = true;
    bubbleMode = null;
    bubbleTargetId = null;
  }

  function onBubbleClick() {
    if (bubbleMode === "highlight") {
      highlightCurrentSelection();
    } else if (bubbleMode === "remove" && bubbleTargetId) {
      removeHighlight(bubbleTargetId);
      hideBubble();
    }
  }

  document.addEventListener("mouseup", (e) => {
    if (e.target && e.target.closest && e.target.closest(".hlthis-bubble")) return;
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        if (bubbleMode === "highlight") hideBubble();
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      showBubbleAt(rect, "Highlight", "highlight", null);
    }, 0);
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target && e.target.closest && e.target.closest(".hlthis-bubble")) return;
    if (bubbleMode === "highlight") hideBubble();
  });

  document.addEventListener("scroll", () => hideBubble(), true);

  document.addEventListener("mouseover", (e) => {
    const mark = e.target && e.target.closest && e.target.closest(`mark.${MARK_CLASS}`);
    if (!mark) return;
    const rect = mark.getBoundingClientRect();
    showBubbleAt(rect, "Remove", "remove", mark.dataset.highlightId);
  });

  document.addEventListener("mouseout", (e) => {
    const mark = e.target && e.target.closest && e.target.closest(`mark.${MARK_CLASS}`);
    if (!mark || bubbleMode !== "remove") return;
    const to = e.relatedTarget;
    if (
      to &&
      to.closest &&
      (to.closest(`mark.${MARK_CLASS}`) === mark || to.closest(".hlthis-bubble"))
    ) {
      return;
    }
    hideBubble();
  });

  // ---------- messages from background / popup ----------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === "HIGHLIGHT_SELECTION") {
      highlightCurrentSelection();
      return undefined;
    }
    if (message.type === "REMOVE_HIGHLIGHT" && message.id) {
      removeHighlight(message.id);
      return undefined;
    }
    if (message.type === "GET_HIGHLIGHTS") {
      getPageHighlights(getPageKey()).then((list) => {
        sendResponse({ highlights: list, pageKey: getPageKey() });
      });
      return true; // async response
    }
    return undefined;
  });

  // ---------- SPA navigation + late-loading content ----------

  function checkForUrlChange() {
    const pageKey = getPageKey();
    if (pageKey === lastPageKey) {
      scheduleRestore();
      return;
    }
    lastPageKey = pageKey;
    unwrapAllHighlights();
    scheduleRestore();
  }

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    checkForUrlChange();
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    checkForUrlChange();
    return result;
  };
  window.addEventListener("popstate", checkForUrlChange);
  window.addEventListener("hashchange", checkForUrlChange);
  window.addEventListener("pageshow", () => scheduleRestore());

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const target = mutation.target;
      if (target && target.closest) {
        if (target.closest(`.${MARK_CLASS}`) || target.closest(".hlthis-bubble")) {
          continue;
        }
      }
      scheduleRestore();
      return;
    }
  });

  function startObserver() {
    if (!document.body) return;
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // ---------- init ----------

  restoreHighlights();
  startObserver();
  [400, 1200, 3000].forEach((ms) => setTimeout(() => restoreHighlights(), ms));
})();
