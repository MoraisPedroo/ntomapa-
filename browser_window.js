import { logPanel } from './helpers.js';

let currentPrinterIp = '';
let currentApiUrl = '';
let currentPath = '/';

const windowEl = document.getElementById('floating-window');
const iframe = document.getElementById('interface-frame');
const titleEl = document.getElementById('floating-title');
const urlInput = document.getElementById('browser-url');
const loader = document.getElementById('browser-loader');

export function openBrowserWindow(ip, apiBaseUrl) {
    currentPrinterIp = ip;
    currentApiUrl = apiBaseUrl;
    currentPath = '/';
    windowEl.classList.remove('hidden');
    titleEl.textContent = `Acesso Remoto: ${ip}`;
    navigateInternal('/');
}

async function navigateInternal(path) {
    loader.classList.remove('hidden');
    currentPath = path;
    urlInput.value = `http://${currentPrinterIp}${path}`;

    try {
        const target = `${currentPrinterIp}${path}`;
        const res = await fetch(`${currentApiUrl}?ip=${encodeURIComponent(target)}`);
        let html = await res.text();

        // Injeção de script para interceptar links e corrigir base
        const interceptor = `
            <script>
                const base = document.createElement('base');
                base.href = 'http://${currentPrinterIp}/';
                document.head.prepend(base);
                document.addEventListener('click', function(e) {
                    const anchor = e.target.closest('a');
                    if (anchor && anchor.href) {
                        e.preventDefault();
                        const url = new URL(anchor.href);
                        window.parent.postMessage({
                            type: 'NAVIGATE_REQUEST',
                            path: url.pathname + url.search
                        }, '*');
                    }
                });
            <\/script>
        `;
        iframe.srcdoc = interceptor + html;
        logPanel(`Navegador: Carregou ${path}`);
    } catch (e) {
        iframe.srcdoc = `<div style="color:red; padding:20px; text-align:center;">Erro ao carregar: ${e.message}</div>`;
        logPanel(`Navegador Erro: ${e.message}`);
    } finally {
        loader.classList.add('hidden');
    }
}

window.addEventListener('message', (event) => {
    if (event.data.type === 'NAVIGATE_REQUEST') {
        navigateInternal(event.data.path);
    }
});

export function closeBrowserWindow() {
    windowEl.classList.add('hidden');
    iframe.srcdoc = '';
}

export function reloadBrowser() {
    navigateInternal(currentPath);
}

export function setupDragLogic() {
    const header = document.getElementById('floating-header');
    let isDragging = false, startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
        if(e.target.closest('button')) return;
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        const rect = windowEl.getBoundingClientRect();
        initialLeft = rect.left; initialTop = rect.top;
        windowEl.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        windowEl.style.left = `${initialLeft + (e.clientX - startX)}px`;
        windowEl.style.top = `${initialTop + (e.clientY - startY)}px`;
    });

    document.addEventListener('mouseup', () => { isDragging = false; windowEl.style.transition = ''; });
}