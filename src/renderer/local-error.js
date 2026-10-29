// External file: error pages run under a CSP that blocks inline scripts.
const params = new URLSearchParams(window.location.search);
document.getElementById('error-title').textContent = params.get('code') || '';
document.getElementById('error-message').textContent = params.get('message') || '';
document.getElementById('error-detail').textContent = params.get('detail') || '';

document.getElementById('btn-retry').addEventListener('click', () => {
  window.electronAPI.retryLocal();
});
document.getElementById('btn-settings').addEventListener('click', () => {
  window.electronAPI.openSettings();
});

const preferLight = window.matchMedia('(prefers-color-scheme: light)').matches;
document.documentElement.dataset.theme = preferLight ? 'light' : '';
