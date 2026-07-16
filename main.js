import { configDocRef, onSnapshot, setDoc } from './firebaseConfig.js';
import { initialPrinters, initialPrinters2floor, TESTE_CABECA, CALIBRAGEM } from './data.js';
import { showToast, logPanel, debounce } from './helpers.js';
import { fetchPrinterStatus, sendCommand, STATE_LABELS } from './printer_logic.js';
import { closeBrowserWindow, reloadBrowser, setupDragLogic } from './browser_window.js';
import { openZebraPanel } from './zebra_panel.js';

let API_BASE_URL = "https://replacement-way-milk-auction.trycloudflare.com/proxy.php";
let currentPrinterIp = '';
let printerData = [];
let currentFloor = 1;
let transientLabel = null;
let focusResetTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    // Inicialização
    setupDragLogic();
    printerData = [...initialPrinters, ...initialPrinters2floor];

    // Listeners Janela Flutuante
    document.getElementById('win-close').addEventListener('click', closeBrowserWindow);
    document.getElementById('win-reload').addEventListener('click', reloadBrowser);

    // Elementos
    const mapContainer = document.getElementById('map-container');
    const mapInner = document.getElementById('map-inner');
    const tooltip = document.getElementById('map-tooltip');
    const mapImage = document.getElementById('map-image');
    const floorSelect = document.getElementById('floor-select');

    // Firebase Update
    onSnapshot(configDocRef, (docSnap) => {
        if (docSnap.exists() && docSnap.data().url) {
            API_BASE_URL = docSnap.data().url;
            const displayApiUrl = document.getElementById('display-api-url');
            if(displayApiUrl) {
                displayApiUrl.textContent = API_BASE_URL;
                displayApiUrl.style.backgroundColor = "rgba(52,211,153,.18)";
                setTimeout(() => displayApiUrl.style.backgroundColor = "", 1000);
            }
            logPanel("Sistema: Link da API atualizado via nuvem.");
        }
    });

    const btnSaveApiUrl = document.getElementById('btn-save-api-url');
    if(btnSaveApiUrl) {
        btnSaveApiUrl.addEventListener('click', async () => {
            const newUrl = document.getElementById('new-api-url').value.trim();
            if(!newUrl) return alert("Link inválido");
            try {
                await setDoc(configDocRef, { url: newUrl, updatedAt: new Date() });
                alert("Link atualizado!");
                document.getElementById('new-api-url').value = "";
            } catch (e) { alert("Erro: " + e.message); }
        });
    }

    // --- Mapa ---
    function renderAllPrinters(){
        mapInner.querySelectorAll('.printer-point').forEach(n=>n.remove());
        const fragment = document.createDocumentFragment();
        printerData.filter(p => p.floor === currentFloor).forEach(p => {
            const node = createPrinterPointElement(p);
            fragment.appendChild(node);
        });
        mapInner.appendChild(fragment);
    }

    function createPrinterPointElement(printer){
        const point = document.createElement('button');
        point.className = `printer-point`;
        point.style.top = printer.pos.top;
        point.style.left = printer.pos.left;
        point.dataset.printerSelb = printer.selb;
        point.innerHTML = `<svg class="printer-point-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>`;

        point.addEventListener('click', (e) => {
            e.stopPropagation();
            if (printer.floor !== currentFloor) {
                currentFloor = printer.floor;
                floorSelect.value = currentFloor;
                updateMapImage();
                renderAllPrinters();
            }
            focusPrinter(printer);
            selectPrinter(printer);
        });

        point.addEventListener('mouseenter', (e) => {
            tooltip.innerHTML = `<strong>${printer.name}</strong><br>SELB: ${printer.selb} (Andar ${printer.floor})`;
            const pRect = e.currentTarget.getBoundingClientRect();
            const cRect = mapContainer.getBoundingClientRect();
            tooltip.style.top = `${pRect.top - cRect.top}px`;
            tooltip.style.left = `${pRect.left - cRect.left}px`;
            tooltip.classList.add('show');
        });
        point.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
        return point;
    }

    function updateMapImage() {
        mapImage.src = currentFloor === 1 ? 'plantanto.jpg' : 'plantanto2.jpg';
    }

    function focusPrinter(printer) {
        if (focusResetTimer) clearTimeout(focusResetTimer);
        if (transientLabel) { transientLabel.remove(); transientLabel = null; }
        document.querySelectorAll('.printer-point').forEach(p => p.classList.remove('highlighted'));

        const point = document.querySelector(`.printer-point[data-printer-selb="${printer.selb}"]`);
        if (!point) return;

        point.classList.add('highlighted');
        const pRect = point.getBoundingClientRect();
        const mRect = mapContainer.getBoundingClientRect();

        const scale = 1.4;
        const pCX = (pRect.left - mRect.left) + pRect.width/2;
        const pCY = (pRect.top - mRect.top) + pRect.height/2;
        let dx = mRect.width/2 - pCX * scale;
        let dy = mRect.height/2 - pCY * scale;

        mapInner.style.transform = `scale(${scale}) translate(${dx}px, ${dy}px)`;

        transientLabel = document.createElement('div');
        transientLabel.className = 'focus-label';
        transientLabel.innerHTML = `${printer.name} <span class="font-normal text-xs" style="color:#94a3b8; margin-left:8px;">(${printer.selb})</span>`;
        transientLabel.style.left = '50%'; transientLabel.style.top = '50%';
        transientLabel.style.transform = 'translate(-50%, calc(-100% - 20px))';
        mapContainer.appendChild(transientLabel);

        focusResetTimer = setTimeout(() => {
            mapInner.style.transform = '';
            point.classList.remove('highlighted');
            if(transientLabel) { transientLabel.remove(); transientLabel = null; }
        }, 3500);
    }

    // Abre o gêmeo digital da impressora selecionada
    function selectPrinter(printer){
        currentPrinterIp = printer.ip;
        openZebraPanel(printer, () => API_BASE_URL);

        document.getElementById('ip-input-panel').value = printer.ip;
        document.getElementById('panel-current-ip').textContent = printer.ip;
        logPanel(`Selecionado: ${printer.name} (${printer.ip})`);
    }

    // --- Painel lateral (IP Tools) ---
    document.getElementById('btn-status-panel').addEventListener('click', async () => {
        if (!currentPrinterIp) { showToast('IP inválido!'); return; }
        logPanel(`Status -> consultando ${currentPrinterIp} ...`);
        const res = await fetchPrinterStatus(currentPrinterIp, API_BASE_URL);
        const label = STATE_LABELS[res.state] || res.state;
        showToast(`${currentPrinterIp}: ${label}`);
        logPanel(`Status: ${label}${res.detail ? ' — ' + res.detail : ''}`);
    });
    document.getElementById('btn-load-factory-panel').addEventListener('click', () => {
        if(confirm('Restaurar padrões de fábrica?\n\nATENÇÃO: isso pode apagar configurações de rede e desconectar a impressora do túnel, exigindo reconfiguração física no local.')) {
            sendCommand('^XA^JUF^XZ', 'Factory', currentPrinterIp, API_BASE_URL);
        }
    });
    document.getElementById('btn-restart-panel').addEventListener('click', () => {
        if(confirm('Reiniciar?')) sendCommand('~JR', 'Reiniciar', currentPrinterIp, API_BASE_URL);
    });
    document.getElementById('btn-calibrate-panel').addEventListener('click', () => sendCommand(CALIBRAGEM, 'Calibrar', currentPrinterIp, API_BASE_URL));
    document.getElementById('btn-headtest-panel').addEventListener('click', () => sendCommand(TESTE_CABECA, 'Teste Cabeça', currentPrinterIp, API_BASE_URL));
    document.getElementById('btn-zt421-panel').addEventListener('click', () => {
        if(confirm('Enviar ZT421?')) sendCommand(`\x10CT~~CD,~CC^~CT~^XA~TA000~JSN^LT0^MNW^MTT^PON^PMN^LH0,0^JMA^PR3,3~SD20^JUS^LRN^CI0^XZ`, 'ZT421', currentPrinterIp, API_BASE_URL);
    });
    document.getElementById('btn-send-raw-panel').addEventListener('click', () => {
        const cmd = document.getElementById('panel-rawcmd').value;
        sendCommand(cmd, 'Manual', currentPrinterIp, API_BASE_URL);
    });
    document.getElementById('set-ip-panel').addEventListener('click', () => {
        const val = document.getElementById('ip-input-panel').value.trim();
        if(val) { currentPrinterIp = val; logPanel(`IP Manual: ${val}`); }
    });

    document.getElementById('collapse-panel').addEventListener('click', () => {
        const side = document.getElementById('ip-tools-sidebar');
        side.classList.toggle('collapsed');
        document.getElementById('collapse-panel').textContent = side.classList.contains('collapsed') ? '+' : '—';
    });

    floorSelect.addEventListener('change', (e) => {
        currentFloor = parseInt(e.target.value);
        updateMapImage();
        renderAllPrinters();
    });

    // Busca
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    document.getElementById('search-hitbox').addEventListener('click', () => {
        document.getElementById('search-container').classList.toggle('expanded');
    });

    searchInput.addEventListener('input', debounce(() => {
        const term = searchInput.value.toLowerCase();
        if(!term) { searchResults.style.display = 'none'; return; }

        const matches = printerData.filter(p => p.name.toLowerCase().includes(term) || p.selb.toLowerCase().includes(term));
        searchResults.innerHTML = '';
        if(matches.length === 0) searchResults.innerHTML = '<div class="result-empty">Nada encontrado</div>';

        matches.forEach(r => {
            const d = document.createElement('div');
            d.className = 'result-item';
            d.innerHTML = `<b>${r.name}</b> <small>${r.selb}</small>`;
            d.onclick = () => {
                searchResults.style.display = 'none';
                document.getElementById('search-container').classList.remove('expanded');
                if(r.floor !== currentFloor) { currentFloor = r.floor; floorSelect.value = r.floor; updateMapImage(); renderAllPrinters(); }
                focusPrinter(r); selectPrinter(r);
            };
            searchResults.appendChild(d);
        });
        searchResults.style.display = 'block';
    }, 300));

    // Init
    updateMapImage();
    renderAllPrinters();
});
