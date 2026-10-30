// External file: the page's CSP (default-src 'self') blocks inline scripts.
// Read the failed URL from the query string
const params = new URLSearchParams(window.location.search);
const failedUrl = params.get('url') || '';
document.getElementById('error-url').textContent = failedUrl;

// A refused address is not a connection problem: say so, and offer no Retry for it.
if (params.get('reason') === 'insecure') {
  document.getElementById('error-title').textContent = 'Address refused';
  document.getElementById('error-detail-text').textContent =
    'Turnstone loads https addresses, and plain http only on this computer. Open Settings to change it.';
  document.getElementById('error-hint').style.display = 'none';
  document.getElementById('btn-retry').style.display = 'none';
}

// A redirect to another site was cancelled. Retry stays, because the address itself may be fine.
if (params.get('reason') === 'redirect') {
  document.getElementById('error-title').textContent = 'Redirect refused';
  document.getElementById('error-detail-text').textContent =
    'This address redirected to another site, and Turnstone did not follow the redirect.';
  document.getElementById('error-hint').style.display = 'none';
}

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
