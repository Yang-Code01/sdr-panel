'use strict';

const $ = (id) => document.getElementById(id);

let state = null;
let segSignature = '';
let sceneSignature = '';
let dragging = false;
let pendingStep = null;
let lastSent = 0;
let hdrTimer = null;

function current() {
  if (!state) return null;
  return state.displays.find((d) => d.key === state.selectedKey) || state.displays[0] || null;
}

function renderSegs() {
  const sig = state.displays.map((d) => d.key).join('|');
  const wrap = $('segs');
  if (sig !== segSignature) {
    segSignature = sig;
    wrap.textContent = '';
    state.displays.forEach((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg';
      b.dataset.key = d.key;
      b.setAttribute('role', 'tab');
      const head = document.createElement('b');
      const dot = document.createElement('i');
      head.append(dot, document.createTextNode(d.name));
      const meta = document.createElement('span');
      b.append(head, meta);
      b.addEventListener('click', () => window.api.selectDisplay(d.key));
      wrap.append(b);
    });
  }
  [...wrap.children].forEach((el) => {
    const d = state.displays.find((x) => x.key === el.dataset.key);
    if (!d) return;
    el.classList.toggle('on', d.key === state.selectedKey);
    el.setAttribute('aria-selected', String(d.key === state.selectedKey));
    el.querySelector('i').classList.toggle('off', !d.hdrEnabled);
    el.querySelector('span').textContent = `${d.step}% · HDR ${d.hdrEnabled ? '开' : '关'}${d.selected ? '' : ''}`;
  });
}

function renderScenes() {
  const sig = JSON.stringify(state.scenes) + '|' + state.selectedKey;
  if (sig === sceneSignature) return;
  sceneSignature = sig;
  const box = $('scenes');
  box.textContent = '';
  if (!state.scenes.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    empty.innerHTML = '<div class="t"><span>还没有场景，点右上「保存当前状态」</span></div>';
    box.append(empty);
    return;
  }
  state.scenes.forEach((s, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'scene';
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = i < 3 ? `Alt ${i + 1}` : '—';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = s.name;
    const v = document.createElement('span');
    v.className = 'v';
    const d = current();
    const own = d && s.per && s.per[d.key];
    const step = own ? own.step : s.step;
    v.textContent = `${step}%${typeof (own ? own.hdr : s.hdr) === 'boolean' ? ' · HDR ' + ((own ? own.hdr : s.hdr) ? '开' : '关') : ''}`;
    row.append(key, nm, v);
    row.addEventListener('click', () => window.api.applyScene(s.id));
    box.append(row);
  });
}

function render() {
  if (!state) return;
  document.body.classList.toggle('dark', !!state.dark);
  const d = current();
  renderSegs();
  renderScenes();

  if (!d) {
    $('subtitle').textContent = '没有找到活动的显示器';
    $('value').textContent = '--';
    $('slider').disabled = true;
    return;
  }

  $('slider').disabled = false;
  $('subtitle').textContent = `${d.name} · ${d.hdrEnabled ? 'HDR 已开启' : 'HDR 关闭'} · ${d.gdiName || ''}`.trim();
  $('capSub').textContent = `${d.nits} nits`;

  if (!dragging) {
    $('value').textContent = d.step;
    $('slider').value = d.step;
    $('slider').style.setProperty('--p', d.step + '%');
  }

  const sw = $('hdr');
  sw.classList.toggle('on', d.hdrEnabled);
  sw.setAttribute('aria-checked', String(d.hdrEnabled));
  sw.disabled = !d.hdrSupported || !!hdrTimer;
  sw.classList.toggle('busy', !!hdrTimer);
  $('hdrSub').textContent = !d.hdrSupported
    ? '此显示器不支持 HDR'
    : d.hdrEnabled
      ? '正在输出 HDR，内容亮度对 SDR 画面生效'
      : '当前是 SDR 输出，内容亮度暂不起作用';
  $('bits').textContent = d.bitsPerColor ? `${d.bitsPerColor}-bit` : '—';
}

function sendStep(step, final) {
  pendingStep = step;
  const now = Date.now();
  if (!final && now - lastSent < 60) return;
  lastSent = now;
  pendingStep = null;
  window.api.setStep(step, final);
}

$('slider').addEventListener('pointerdown', () => {
  dragging = true;
});
$('slider').addEventListener('input', (e) => {
  const step = Number(e.target.value);
  dragging = true;
  $('value').textContent = step;
  e.target.style.setProperty('--p', step + '%');
  sendStep(step, false);
});
$('slider').addEventListener('change', (e) => {
  const step = Number(e.target.value);
  dragging = false;
  sendStep(step, true);
});
addEventListener('pointerup', () => {
  if (dragging && pendingStep != null) sendStep(pendingStep, true);
  dragging = false;
});

$('hdr').addEventListener('click', () => {
  const d = current();
  if (!d) return;
  hdrTimer = setTimeout(() => {
    hdrTimer = null;
    render();
  }, 2200);
  window.api.toggleHdr(d.key);
  render();
});

$('close').addEventListener('click', () => window.api.hidePanel());
$('saveScene').addEventListener('click', () => window.api.saveScene(null));

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.hidePanel();
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const d = current();
    if (!d) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(100, d.step + (e.key === 'ArrowUp' ? 5 : -5)));
    dragging = false;
    $('value').textContent = next;
    $('slider').value = next;
    $('slider').style.setProperty('--p', next + '%');
    window.api.setStep(next, true);
  }
});

window.api.onState((next) => {
  state = next;
  render();
});

window.api.getState().then((s) => {
  state = s;
  render();
});
