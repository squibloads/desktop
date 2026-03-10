// Apply system theme
function applyTheme() {
  const preferLight = window.matchMedia(
    "(prefers-color-scheme: light)",
  ).matches;
  document.documentElement.dataset.theme = preferLight ? "light" : "";
}
applyTheme();
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", applyTheme);

// ─── Mode selection ──────────────────────────────────────────────────────

function getMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : "both";
}

function updateFieldVisibility() {
  const mode = getMode();
  document
    .getElementById("server-group")
    .classList.toggle("hidden", mode === "console");
  document
    .getElementById("console-group")
    .classList.toggle("hidden", mode === "server");
}

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", updateFieldVisibility);
});

// ─── Load settings ───────────────────────────────────────────────────────

window.electronAPI.getSettings().then((settings) => {
  document.getElementById("server-url").value = settings.serverUrl;
  document.getElementById("console-url").value = settings.consoleUrl;

  const modeRadio = document.getElementById(
    "mode-" + (settings.mode || "both"),
  );
  if (modeRadio) modeRadio.checked = true;

  updateFieldVisibility();
});

// ─── URL validation ──────────────────────────────────────────────────────

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateField(inputId, errorId) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);
  const value = input.value.trim();

  if (!value || !isValidUrl(value)) {
    input.classList.add("invalid");
    error.classList.add("visible");
    return false;
  }
  input.classList.remove("invalid");
  error.classList.remove("visible");
  return true;
}

// Clear errors on input
document.querySelectorAll('input[type="text"]').forEach((input) => {
  input.addEventListener("input", () => {
    input.classList.remove("invalid");
    const error = input.nextElementSibling;
    if (error && error.classList.contains("field-error")) {
      error.classList.remove("visible");
    }
  });
});

// ─── Save ────────────────────────────────────────────────────────────────

const saveBtn = document.getElementById("btn-save");
saveBtn.addEventListener("click", async () => {
  const mode = getMode();
  const needsServer = mode === "server" || mode === "both";
  const needsConsole = mode === "console" || mode === "both";

  let valid = true;
  if (needsServer && !validateField("server-url", "server-url-error"))
    valid = false;
  if (needsConsole && !validateField("console-url", "console-url-error"))
    valid = false;
  if (!valid) return;

  const serverUrl = document
    .getElementById("server-url")
    .value.trim()
    .replace(/\/+$/, "");
  const consoleUrl = document
    .getElementById("console-url")
    .value.trim()
    .replace(/\/+$/, "");

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving\u2026";

  try {
    const result = await window.electronAPI.saveSettings({
      mode,
      serverUrl,
      consoleUrl,
    });
    if (result && result.error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      document.getElementById("server-url-error").textContent = result.error;
      document.getElementById("server-url-error").classList.add("visible");
      return;
    }
    window.close();
  } catch {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
});

// Cancel
document.getElementById("btn-cancel").addEventListener("click", () => {
  window.close();
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.close();
  } else if (e.key === "Enter") {
    if (
      document.activeElement &&
      document.activeElement.tagName === "INPUT" &&
      document.activeElement.type !== "radio"
    ) {
      saveBtn.click();
    }
  }
});
