// Saving on the device: IndexedDB holds project details ("projects") and every
// drawing as a PNG ("cells": one per frame per layer, key "project|frame|layer").

const DB_NAME = 'flipout';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('cells')) d.createObjectStore('cells');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Save cancelled'));
  });
}
function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const cellKey = (pid, fid, lid) => `${pid}|${fid}|${lid}`;
const range = (pid) => IDBKeyRange.bound(pid + '|', pid + '|￿');

export async function listProjects() {
  const d = await db();
  const all = await result(d.transaction('projects').objectStore('projects').getAll());
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getProject(id) {
  const d = await db();
  return result(d.transaction('projects').objectStore('projects').get(id));
}

export async function putProject(meta) {
  const d = await db();
  const tx = d.transaction('projects', 'readwrite');
  tx.objectStore('projects').put(meta);
  return done(tx);
}

export async function deleteProject(id) {
  const d = await db();
  const tx = d.transaction(['projects', 'cells'], 'readwrite');
  tx.objectStore('projects').delete(id);
  tx.objectStore('cells').delete(range(id));
  return done(tx);
}

// Blobs are stored as ArrayBuffers: Safari has had trouble keeping Blobs in IndexedDB.
export async function putCell(pid, fid, lid, blob) {
  const d = await db();
  const buf = blob ? await blob.arrayBuffer() : null;
  const tx = d.transaction('cells', 'readwrite');
  if (buf) tx.objectStore('cells').put(buf, cellKey(pid, fid, lid));
  else tx.objectStore('cells').delete(cellKey(pid, fid, lid));
  return done(tx);
}

export async function putCells(pid, entries) {
  // entries: [{fid, lid, buf: ArrayBuffer}]
  const d = await db();
  const tx = d.transaction('cells', 'readwrite');
  const st = tx.objectStore('cells');
  for (const e of entries) st.put(e.buf, cellKey(pid, e.fid, e.lid));
  return done(tx);
}

export async function getAllCells(pid) {
  const d = await db();
  const st = d.transaction('cells').objectStore('cells');
  const [keys, vals] = await Promise.all([result(st.getAllKeys(range(pid))), result(st.getAll(range(pid)))]);
  return keys.map((k, i) => {
    const [, fid, lid] = k.split('|');
    return { fid, lid, blob: new Blob([vals[i]], { type: 'image/png' }) };
  });
}

export async function deleteCells(pid, pairs) {
  if (!pairs.length) return;
  const d = await db();
  const tx = d.transaction('cells', 'readwrite');
  const st = tx.objectStore('cells');
  for (const [fid, lid] of pairs) st.delete(cellKey(pid, fid, lid));
  return done(tx);
}

export function askPersistentStorage() {
  try { navigator.storage?.persist?.(); } catch { /* not available */ }
}
