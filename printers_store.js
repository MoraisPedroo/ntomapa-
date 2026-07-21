import { printersDocRef, onSnapshot, setDoc, getDoc } from './firebaseConfig.js';
import { initialPrinters, initialPrinters2floor } from './data.js';

const LS_KEY = 'mapanto_printers_v1';

let printers = [];
let subscribers = [];
let usingFirebase = false;

function uid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function seedList() {
    // parte dos dados originais (data.js), garantindo um id estável para cada um
    return [...initialPrinters, ...initialPrinters2floor].map(p => ({ ...p, id: p.id || uid() }));
}

function notify() {
    subscribers.forEach(fn => { try { fn(printers); } catch (e) { console.warn(e); } });
}

function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(printers)); } catch (_) {}
}

async function persist() {
    saveLocal();
    if (!usingFirebase) return;
    try {
        await setDoc(printersDocRef, { printers, updatedAt: new Date().toISOString() });
    } catch (e) {
        console.warn('Falha ao salvar impressoras na nuvem:', e);
    }
}

/**
 * Inicializa o store: tenta Firebase (com sync ao vivo), cai para localStorage,
 * e por fim para o seed embutido em data.js.
 */
export async function initPrinters(onUpdate) {
    if (onUpdate) subscribers.push(onUpdate);

    // fallback imediato: localStorage ou seed, para a UI não ficar vazia
    try {
        const cached = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
        printers = (Array.isArray(cached) && cached.length) ? cached : seedList();
    } catch (_) {
        printers = seedList();
    }
    notify();

    // tenta Firebase
    try {
        const snap = await getDoc(printersDocRef);
        usingFirebase = true;
        if (snap.exists() && Array.isArray(snap.data().printers) && snap.data().printers.length) {
            printers = snap.data().printers;
        } else {
            // primeira vez: semeia a nuvem com os dados atuais
            printers = printers.length ? printers : seedList();
            await setDoc(printersDocRef, { printers, updatedAt: new Date().toISOString() });
        }
        saveLocal();
        notify();

        // sincronização ao vivo entre usuários
        onSnapshot(printersDocRef, (docSnap) => {
            if (docSnap.exists() && Array.isArray(docSnap.data().printers)) {
                printers = docSnap.data().printers;
                saveLocal();
                notify();
            }
        });
    } catch (e) {
        usingFirebase = false;
        console.warn('Firebase indisponível, usando armazenamento local.', e);
    }

    return printers;
}

export function getPrinters() { return printers; }

export async function addPrinter(data) {
    const p = { ...data, id: uid() };
    printers = [...printers, p];
    notify();
    await persist();
    return p;
}

export async function updatePrinter(id, data) {
    printers = printers.map(p => p.id === id ? { ...p, ...data, id } : p);
    notify();
    await persist();
}

export async function deletePrinter(id) {
    printers = printers.filter(p => p.id !== id);
    notify();
    await persist();
}

export function isCloudSynced() { return usingFirebase; }
