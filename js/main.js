// Home screen: your animations, new animation, open a backup.
import * as store from './store.js';
import { openEditor } from './editor.js';
import { importBackup } from './exporter.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const SIZES = { '1:1': [1080, 1080], '4:5': [1080, 1350], '9:16': [1080, 1920], '4:3': [1440, 1080] };
const thumbUrls = [];

async function renderHome() {
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const list = await store.listProjects();
  const ul = $('project-list');
  ul.innerHTML = '';
  $('empty-state').hidden = list.length > 0;
  for (const p of list) {
    const li = document.createElement('li');
    li.className = 'card';
    const open = document.createElement('button');
    open.className = 'card-open';
    open.setAttribute('aria-label', `Open ${p.name}`);
    const th = document.createElement('div');
    th.className = 'patch card-thumb';
    if (p.thumb) {
      const paper = document.createElement('span');
      paper.className = 'thumb-paper';
      paper.style.aspectRatio = `${p.w} / ${p.h}`;
      paper.style.width = (p.w >= p.h ? 78 : 78 * p.w / p.h).toFixed(1) + '%';
      const img = document.createElement('img');
      const url = URL.createObjectURL(new Blob([p.thumb], { type: 'image/png' }));
      thumbUrls.push(url);
      img.src = url; img.alt = '';
      paper.appendChild(img);
      th.appendChild(paper);
    }
    const name = document.createElement('span');
    name.className = 'card-name'; name.textContent = p.name;
    open.append(th, name);
    open.onclick = () => openProject(p.id);

    const meta = document.createElement('div');
    meta.className = 'card-meta muted small';
    const backed = p.lastBackup ? 'backed up ' + new Date(p.lastBackup).toLocaleDateString() : 'no backup yet';
    meta.textContent = `${p.frames.length} frame${p.frames.length === 1 ? '' : 's'} · ${p.aspect} · ${backed}`;

    const menu = document.createElement('div');
    menu.className = 'card-menu';
    const ren = document.createElement('button'); ren.textContent = 'Rename';
    ren.onclick = async () => {
      const n = prompt('Animation name', p.name);
      if (n && n.trim()) { p.name = n.trim(); await store.putProject(p); renderHome(); }
    };
    const del = document.createElement('button'); del.textContent = 'Delete'; del.className = 'danger';
    del.onclick = async () => {
      if (!confirm(`Delete “${p.name}”? This can’t be undone (unless you have a backup file).`)) return;
      await store.deleteProject(p.id); renderHome();
    };
    menu.append(ren, del);
    li.append(open, meta, menu);
    ul.appendChild(li);
  }
}

async function openProject(id) {
  const p = await store.getProject(id);
  if (!p) { toast('Couldn’t find that animation'); renderHome(); return; }
  await openEditor(p, renderHome);
}

async function createProject(name, aspect) {
  const [w, h] = SIZES[aspect];
  const lid = store.uid();
  const p = {
    id: store.uid(), name, aspect, w, h, fps: 12,
    layers: [{ id: lid, name: 'Layer 1', visible: true }], activeLayer: lid,
    frames: [store.uid()], current: 0,
    onion: { on: true, back: 1, fwd: 0, opacity: 0.35, tint: true },
    createdAt: Date.now(), updatedAt: Date.now(), lastBackup: null,
  };
  await store.putProject(p);
  store.askPersistentStorage();
  await openEditor(p, renderHome);
}

// ---------- wiring ----------
$('btn-new').onclick = async () => {
  const n = (await store.listProjects()).length + 1;
  $('new-name').value = `Animation ${n}`;
  $('dlg-new').showModal();
};
$('dlg-new').addEventListener('close', () => {
  if ($('dlg-new').returnValue !== 'ok') return;
  const name = $('new-name').value.trim() || 'Untitled';
  const aspect = new FormData($('form-new')).get('aspect') || '4:5';
  createProject(name, aspect);
});

$('btn-open-backup').onclick = () => $('backup-input').click();
$('backup-input').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const meta = await importBackup(file);
    await renderHome();
    toast(`Opened “${meta.name}” from the backup`);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Couldn’t open that file');
  }
};

renderHome().catch((e) => { console.error(e); toast('This browser won’t let Flipout save drawings. Is it a private window?'); });

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
