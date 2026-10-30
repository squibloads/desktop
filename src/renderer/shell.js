const isMac = window.electronAPI.platform === "darwin";

// ─── Platform setup ──────────────────────────────────────────────────────

if (isMac) {
  // macOS: native traffic lights — add spacer
  document.getElementById("drag-spacer").style.width = "72px";
} else {
  // Win/Linux: show custom window controls
  document.getElementById("window-controls").classList.remove("hidden");
}

// ─── Mode-aware UI ───────────────────────────────────────────────────────

window.electronAPI.getSettings().then((settings) => {
  const mode = settings.mode || "both";

  // In single-view mode, hide tabs (title bar becomes just health + controls)
  if (mode !== "both") {
    document.getElementById("tabs").classList.add("hidden");
  }

  // Hide health indicators for disabled services
  if (mode === "server") {
    document.getElementById("console-health-group").classList.add("hidden");
  } else if (mode === "console") {
    document.getElementById("server-health-group").classList.add("hidden");
  }

  // Restore active tab from settings
  if (mode === "both" && settings.activeTab) {
    const target = document.querySelector(
      `.tab[data-tab="${settings.activeTab}"]`,
    );
    if (target) activateTab(target, false);
  }
});

// ─── Tab switching with ARIA and keyboard navigation ─────────────────────

const tabs = Array.from(document.querySelectorAll(".tab"));

function activateTab(tab, notify = true) {
  tabs.forEach((t) => {
    t.classList.remove("active");
    t.setAttribute("aria-selected", "false");
    t.tabIndex = -1;
  });
  tab.classList.add("active");
  tab.setAttribute("aria-selected", "true");
  tab.tabIndex = 0;
  if (notify) {
    tab.focus();
    window.electronAPI.switchTab(tab.dataset.tab);
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab));

  tab.addEventListener("keydown", (e) => {
    const idx = tabs.indexOf(tab);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      activateTab(tabs[(idx + 1) % tabs.length]);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      activateTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
    } else if (e.key === "Home") {
      e.preventDefault();
      activateTab(tabs[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      activateTab(tabs[tabs.length - 1]);
    }
  });
});

// ─── Health status updates ───────────────────────────────────────────────

const stateLabels = {
  ok: "connected",
  degraded: "degraded",
  disconnected: "disconnected",
  error: "error",
  refused: "address refused",
};

const dotNames = {
  "server-health": "Server",
  "console-health": "Console",
};

window.electronAPI.onHealthUpdate((status) => {
  updateDot("server-health", status.server);
  updateDot("console-health", status.console);
});

function updateDot(id, state) {
  const dot = document.getElementById(id);
  if (!dot) return;
  dot.className = "health-dot";

  if (state === "ok") dot.classList.add("connected");
  else if (state === "degraded") dot.classList.add("degraded");
  else if (state === "disconnected") dot.classList.add("disconnected");
  else if (state === "error") dot.classList.add("error");
  // A refused address is a fault, shown in the error colour, not a switched-off service.
  else if (state === "refused") dot.classList.add("error");

  const label = stateLabels[state] || "unknown";
  dot.setAttribute("aria-label", `${dotNames[id]}: ${label}`);
}

// ─── Window controls (Win/Linux) ─────────────────────────────────────────

if (!isMac) {
  document.getElementById("btn-minimize").addEventListener("click", () => {
    window.electronAPI.windowMinimize();
  });
  document.getElementById("btn-maximize").addEventListener("click", () => {
    window.electronAPI.windowMaximize();
  });
  document.getElementById("btn-close").addEventListener("click", () => {
    window.electronAPI.windowClose();
  });
}

// ─── Theme detection ─────────────────────────────────────────────────────

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
