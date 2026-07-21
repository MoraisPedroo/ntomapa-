import { logPanel } from './helpers.js';

/*
 * Navegador de interface — modo "render".
 * O iframe carrega a página DIRETO do proxy (?url=...&render=1). O proxy
 * reescreve todos os links/imagens/css/frames/formulários para passarem por
 * ele, então a página fica idêntica à original e a navegação interna
 * (cliques, frames, formulários) funciona nativamente dentro do iframe.
 * A barra de endereço é atualizada via postMessage injetado pelo proxy.
 */

let currentApiUrl = '';
let currentDeviceUrl = '';   // URL real do dispositivo em exibição
let expectingUrl = null;     // URL que nós mesmos pedimos (evita duplo push no histórico)
let history = [];

const windowEl   = () => document.getElementById('floating-window');
const iframe     = () => document.getElementById('interface-frame');
const titleEl    = () => document.getElementById('floating-title');
const urlInput   = () => document.getElementById('browser-url');
const loader     = () => document.getElementById('browser-loader');
const loaderText = () => document.getElementById('browser-loader-text');
const transition = () => document.getElementById('browser-transition');

function normalizeTarget(input) {
    let t = (input || '').trim();
    if (!t) return '';
    if (!/^https?:\/\//i.test(t)) t = 'http://' + t;
    return t;
}
function renderUrl(deviceUrl) {
    return `${currentApiUrl}?url=${encodeURIComponent(deviceUrl)}&render=1`;
}
function showLoader(text) { loaderText().textContent = text || 'Carregando…'; loader().classList.remove('hidden'); }
function hideLoader() { loader().classList.add('hidden'); }

function setBar(url) {
    currentDeviceUrl = url;
    urlInput().value = url;
    titleEl().textContent = 'Interface: ' + url.replace(/^https?:\/\//, '').slice(0, 60);
}

function loadDevice(deviceUrl, { push = true } = {}) {
    const t = normalizeTarget(deviceUrl);
    if (!t) return;
    if (push && currentDeviceUrl && currentDeviceUrl !== t) history.push(currentDeviceUrl);
    expectingUrl = t;
    setBar(t);
    showLoader('Carregando ' + t.replace(/^https?:\/\//, '').slice(0, 48) + '…');
    iframe().src = renderUrl(t);
    logPanel(`Navegador: abrindo ${t}`);
}

/* ------------------------------------------------------------------
   Transição animada impressora -> site
------------------------------------------------------------------ */
function playTransition() {
    const t = transition();
    t.classList.remove('hidden', 'zoom-out');
    void t.offsetWidth;
    setTimeout(() => t.classList.add('zoom-out'), 750);
    setTimeout(() => t.classList.add('hidden'), 1200);
}

/* ------------------------------------------------------------------
   API pública
------------------------------------------------------------------ */
export function openBrowserWindow(ipOrUrl, apiBaseUrl) {
    currentApiUrl = apiBaseUrl;
    currentDeviceUrl = '';
    history = [];
    windowEl().classList.remove('hidden');
    windowEl().classList.remove('maximized');
    iframe().removeAttribute('srcdoc');
    playTransition();
    loadDevice(ipOrUrl, { push: false });
}

export function closeBrowserWindow() {
    windowEl().classList.add('hidden');
    iframe().removeAttribute('src');
    iframe().srcdoc = '';
    transition().classList.add('hidden');
}

export function reloadBrowser() {
    if (currentDeviceUrl) loadDevice(currentDeviceUrl, { push: false });
}

export function browserBack() {
    if (history.length) loadDevice(history.pop(), { push: false });
}

export function navigateFromBar() {
    const val = urlInput().value.trim();
    if (val) loadDevice(val);
}

/* Baixa o código-fonte ORIGINAL (sem reescrita) da página atual — diagnóstico */
export async function downloadSource() {
    const target = currentDeviceUrl || normalizeTarget(urlInput().value);
    if (!target) { logPanel('Download: nenhuma página aberta.'); return; }
    try {
        logPanel(`Baixando código-fonte de ${target} ...`);
        const res = await fetch(`${currentApiUrl}?url=${encodeURIComponent(target)}`, { cache: 'no-store' });
        const blob = await res.blob();
        const name = (target.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_').replace(/_+$/, '') || 'pagina')
            .replace(/(\.html?|\.htm)$/i, '') + '.html';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        logPanel(`Download: ${name} salvo.`);
    } catch (e) {
        logPanel(`Download falhou: ${e.message}`);
    }
}

/* ------------------------------------------------------------------
   Sinais vindos do iframe (script injetado pelo proxy no modo render)
------------------------------------------------------------------ */
window.addEventListener('message', (event) => {
    const d = event.data || {};
    if (d.type !== 'PROXY_URL' || !d.url) return;
    hideLoader();
    if (d.url === expectingUrl) { setBar(d.url); expectingUrl = null; return; }
    // navegação interna (clique em link / frame / redirect) — registra no histórico
    if (currentDeviceUrl && currentDeviceUrl !== d.url) history.push(currentDeviceUrl);
    setBar(d.url);
    expectingUrl = null;
});

/* ------------------------------------------------------------------
   Arrastar / maximizar / minimizar janela + esconder loader ao carregar
------------------------------------------------------------------ */
export function setupDragLogic() {
    const header = document.getElementById('floating-header');
    const win = windowEl();
    let isDragging = false, startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        if (win.classList.contains('maximized')) return;
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        const rect = win.getBoundingClientRect();
        initialLeft = rect.left; initialTop = rect.top;
        win.style.transition = 'none';
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        win.style.left = `${initialLeft + (e.clientX - startX)}px`;
        win.style.top  = `${initialTop + (e.clientY - startY)}px`;
    });
    document.addEventListener('mouseup', () => { isDragging = false; win.style.transition = ''; });

    const maxBtn = document.getElementById('win-max');
    const minBtn = document.getElementById('win-min');
    const dlBtn  = document.getElementById('win-download');
    if (maxBtn) maxBtn.addEventListener('click', () => win.classList.toggle('maximized'));
    if (minBtn) minBtn.addEventListener('click', () => win.classList.add('hidden'));
    if (dlBtn)  dlBtn.addEventListener('click', downloadSource);

    // esconde o loader quando o iframe termina de carregar (inclusive PDFs/imagens sem script)
    const fr = iframe();
    if (fr) fr.addEventListener('load', () => hideLoader());
}
