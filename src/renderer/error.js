// External file: the page's CSP (default-src 'self') blocks inline scripts.
// Read the failed URL from the query string
const params = new URLSearchParams(window.location.search);
const failedUrl = params.get('url') || '';
document.getElementById('error-url').textContent = failedUrl;

document.getElementById('btn-retry').addEventListener('click', () => {
  if (failedUrl) window.location.href = failedUrl;
});

document.getElementById('btn-settings').addEventListener('click', () => {
  window.electronAPI.openSettings();
});

// Theme
function applyTheme() {
  const preferLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = preferLight ? 'light' : '';
}
applyTheme();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
