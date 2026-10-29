// External file: the loading page runs under a CSP that blocks inline scripts.
// The page starts on the first stage because a stage emitted before this
// listener attaches is not replayed; the start sequence is slow enough that
// the first visible state is the right one.
const STAGE_ORDER = ['machine', 'pod', 'console', 'node'];
const STAGE_LABELS = {
  machine: 'Starting the Podman machine',
  pod: 'Starting Turnstone',
  console: 'Waiting for the console',
  node: 'Waiting for the node to come online (this can take about a minute)',
};

const items = new Map();
document.querySelectorAll('#stages li[data-stage]').forEach((el) => {
  items.set(el.dataset.stage, el);
});
const statusEl = document.getElementById('status');

function showStage(stage) {
  const current = STAGE_ORDER.indexOf(stage);
  if (current === -1) return;
  STAGE_ORDER.forEach((name, index) => {
    const el = items.get(name);
    if (!el) return;
    el.classList.toggle('done', index < current);
    el.classList.toggle('active', index === current);
  });
  statusEl.textContent = STAGE_LABELS[stage];
}

showStage('machine');
window.electronAPI.onLocalProgress(showStage);

const preferLight = window.matchMedia('(prefers-color-scheme: light)').matches;
document.documentElement.dataset.theme = preferLight ? 'light' : '';
