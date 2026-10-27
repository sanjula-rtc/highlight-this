const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const excludedEl = document.getElementById("excluded");

function render(highlights, excluded) {
  listEl.innerHTML = "";
  excludedEl.hidden = !excluded;
  if (excluded) {
    emptyEl.hidden = true;
    return;
  }
  if (!highlights || !highlights.length) {
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;

  highlights.forEach((h) => {
    const li = document.createElement("li");
    li.className = "hl-item";

    const swatch = document.createElement("span");
    swatch.className = "hl-swatch";

    const text = document.createElement("span");
    text.className = "hl-text";
    text.textContent = h.text.length > 80 ? h.text.slice(0, 80) + "…" : h.text;
    text.title = h.text;

    const removeBtn = document.createElement("button");
    removeBtn.className = "hl-remove";
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage(
        { type: "REMOVE_HIGHLIGHT_REQUEST", id: h.id },
        () => load()
      );
    });

    li.appendChild(swatch);
    li.appendChild(text);
    li.appendChild(removeBtn);
    listEl.appendChild(li);
  });
}

function load() {
  chrome.runtime.sendMessage({ type: "GET_HIGHLIGHTS_REQUEST" }, (response) => {
    render(response && response.highlights, response && response.excluded);
  });
}

load();
