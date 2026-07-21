import {
    db, printersColRef, doc,
    onSnapshot, getDocs, addDoc, updateDoc, deleteDoc, writeBatch
} from './firebaseConfig.js';
import { initialPrinters, initialPrinters2floor } from './data.js';

const LS_KEY = 'mapanto_printers_v2';

let printers = [];
let subscribers = [];
let usingFirebase = false;

function seedList() {
    return [...initialPrinters, ...initialPrinters2floor];
}
function notify() {
    subscribers.forEach(fn => { try { fn(printers); } catch (e) { console.warn(e); } });
}
function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(printers)); } catch (_) {}
}
// remove campos de controle antes de gravar no documento
function stripMeta(data) {
    const clean = { ...data };
    delete clean.id; delete clean._id;
    return clean;
}

/**
 * Inicializa o store lendo a coleção `printers` do Firestore em tempo real.
 * Fallback: cache em localStorage e, por último, o seed embutido em data.js.
 */
export async function initPrinters(onUpdate) {
    if (onUpdate) subscribers.push(onUpdate);

    // mostra algo imediatamente (cache local ou seed) enquanto o Firestore carrega
    try {
        const cached = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
        printers = (Array.isArray(cached) && cached.length) ? cached : seedList();
    } catch (_) {
        printers = seedList();
    }
    notify();

    try {
        // sincronização em tempo real com a coleção de impressoras
        usingFirebase = true;
        onSnapshot(printersColRef, (snap) => {
            usingFirebase = true;
            const list = [];
            snap.forEach(d => list.push({ ...d.data(), id: d.id }));
            printers = list;
            saveLocal();
            notify();
        }, (err) => {
            usingFirebase = false;
            console.warn('Erro ao ler impressoras do Firestore:', err);
        });
    } catch (e) {
        usingFirebase = false;
        console.warn('Firestore indisponível, usando cache local.', e);
    }

    return printers;
}

export function getPrinters() { return printers; }

export async function addPrinter(data) {
    const clean = stripMeta(data);
    if (usingFirebase) {
        const ref = await addDoc(printersColRef, clean);
        return { ...clean, id: ref.id };
    }
    const local = { ...clean, id: 'local_' + Date.now() };
    printers = [...printers, local];
    saveLocal(); notify();
    return local;
}

export async function updatePrinter(id, data) {
    const clean = stripMeta(data);
    if (usingFirebase) {
        await updateDoc(doc(db, 'printers', id), clean);
        return;
    }
    printers = printers.map(p => p.id === id ? { ...p, ...clean, id } : p);
    saveLocal(); notify();
}

export async function deletePrinter(id) {
    if (usingFirebase) {
        await deleteDoc(doc(db, 'printers', id));
        return;
    }
    printers = printers.filter(p => p.id !== id);
    saveLocal(); notify();
}

/**
 * Importa o seed (data.js) para o Firestore, caso a coleção esteja vazia.
 * Usado apenas manualmente para popular um banco novo.
 */
export async function seedFirestore() {
    const existing = await getDocs(printersColRef);
    if (existing.size > 0) return { skipped: true, existing: existing.size };
    const batch = writeBatch(db);
    seedList().forEach(p => batch.set(doc(printersColRef), stripMeta(p)));
    await batch.commit();
    return { seeded: seedList().length };
}

export function isCloudSynced() { return usingFirebase; }
