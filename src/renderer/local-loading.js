// External file: the loading page runs under a CSP that blocks inline scripts.
// The page starts on the first stage; the main process replays the current
// stage once this page has loaded, so a late attach still catches up.
const STAGE_ORDER = ['machine', 'pod', 'console', 'node'];
// A stage shown on another stage's row: on first run, creating the machine is part of the machine step, and
// downloading the image is part of starting Turnstone.
const STAGE_ROW = { create: 'machine', image: 'pod' };
const STAGE_LABELS = {
  create: 'Creating the Podman machine (first run only; this can take several minutes)',
  image: 'Downloading Turnstone (first run only; this can take several minutes)',
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
  const current = STAGE_ORDER.indexOf(STAGE_ROW[stage] || stage);
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
