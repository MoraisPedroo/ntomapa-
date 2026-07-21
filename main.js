import { configDocRef, onSnapshot, setDoc } from './firebaseConfig.js';
import { TESTE_CABECA, CALIBRAGEM } from './data.js';
import { showToast, logPanel, debounce } from './helpers.js';
import { fetchPrinterStatus, sendCommand, STATE_LABELS } from './printer_logic.js';
import { openBrowserWindow, closeBrowserWindow, reloadBrowser, browserBack, navigateFromBar, setupDragLogic } from './browser_window.js';
import { openZebraPanel, closeZebraPanel } from './zebra_panel.js';
import { initPrinters, getPrinters, addPrinter, updatePrinter, deletePrinter, isCloudSynced } from './printers_store.js';

let API_BASE_URL = "https://replacement-way-milk-auction.trycloudflare.com/proxy.php";
let currentPrinterIp = '';
let currentPrinter = null;
let printerData = [];
let currentFloor = 1;
let transientLabel = null;
let focusResetTimer = null;

// modo de posicionamento no mapa
let placing = false;
let placingCallback = null;
// estado do formulário de impressora
let formMode = 'add';      // 'add' | 'edit'
let editingId = null;
let pendingPos = null;

const apiGetter = () => API_BASE_URL;

/* ============================================================
   TEMA
   ============================================================ */
function initTheme() {
    const saved = localStorage.getItem('mapanto_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    const btn = document.getElementById('theme-toggle');
    btn.addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('mapanto_theme', next);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    initTheme();
    setupDragLogic();

    // Janela do navegador remoto
    document.getElementById('win-close').addEventListener('click', closeBrowserWindow);
    document.getElementById('win-reload').addEventListener('click', reloadBrowser);
    document.getElementById('win-back').addEventListener('click', browserBack);
    document.getElementById('win-go').addEventListener('click', navigateFromBar);
    document.getElementById('browser-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateFromBar(); });

    // Elementos do mapa
    const mapContainer = document.getElementById('map-container');
    const mapInner = document.getElementById('map-inner');
    const tooltip = document.getElementById('map-tooltip');
    const mapImage = document.getElementById('map-image');
    const floorSelect = document.getElementById('floor-select');

    /* -------------------- API URL (Firebase) -------------------- */
    onSnapshot(configDocRef, (docSnap) => {
        if (docSnap.exists() && docSnap.data().url) {
            API_BASE_URL = docSnap.data().url;
            const el = document.getElementById('display-api-url');
            if (el) {
                el.textContent = API_BASE_URL;
                el.style.backgroundColor = "rgba(52,211,153,.18)";
                setTimeout(() => el.style.backgroundColor = "", 1000);
            }
            logPanel("Sistema: Link da API atualizado via nuvem.");
        }
    });
    document.getElementById('display-api-url').textContent = API_BASE_URL;

    document.getElementById('btn-save-api-url').addEventListener('click', async () => {
        const newUrl = document.getElementById('new-api-url').value.trim();
        if (!newUrl) return alert("Link inválido");
        try {
            await setDoc(configDocRef, { url: newUrl, updatedAt: new Date() });
            alert("Link atualizado!");
            document.getElementById('new-api-url').value = "";
        } catch (e) { alert("Erro: " + e.message); }
    });

    /* -------------------- Mapa -------------------- */
    function renderAllPrinters() {
        mapInner.querySelectorAll('.printer-point').forEach(n => n.remove());
        const fragment = document.createDocumentFragment();
        printerData.filter(p => p.floor === currentFloor).forEach(p => fragment.appendChild(createPrinterPointElement(p)));
        mapInner.appendChild(fragment);
    }

    function createPrinterPointElement(printer) {
        const point = document.createElement('button');
        point.className = 'printer-point';
        point.style.top = printer.pos.top;
        point.style.left = printer.pos.left;
        point.dataset.printerId = printer.id;
        point.innerHTML = `<svg class="printer-point-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>`;

        point.addEventListener('click', (e) => {
            e.stopPropagation();
            if (placing) return;
            focusPrinter(printer);
            selectPrinter(printer);
        });
        point.addEventListener('mouseenter', (e) => {
            if (placing) return;
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
        const point = document.querySelector(`.printer-point[data-printer-id="${printer.id}"]`);
        if (!point) return;
        point.classList.add('highlighted');

        const pRect = point.getBoundingClientRect();
        const mRect = mapContainer.getBoundingClientRect();
        const scale = 1.4;
        const pCX = (pRect.left - mRect.left) + pRect.width / 2;
        const pCY = (pRect.top - mRect.top) + pRect.height / 2;
        const dx = mRect.width / 2 - pCX * scale;
        const dy = mRect.height / 2 - pCY * scale;
        mapInner.style.transform = `scale(${scale}) translate(${dx}px, ${dy}px)`;

        transientLabel = document.createElement('div');
        transientLabel.className = 'focus-label';
        transientLabel.innerHTML = `${printer.name} <span style="color:var(--muted); font-weight:400; margin-left:8px; font-size:.8rem">(${printer.selb})</span>`;
        transientLabel.style.left = '50%'; transientLabel.style.top = '50%';
        transientLabel.style.transform = 'translate(-50%, calc(-100% - 20px))';
        mapContainer.appendChild(transientLabel);

        focusResetTimer = setTimeout(() => {
            mapInner.style.transform = '';
            point.classList.remove('highlighted');
            if (transientLabel) { transientLabel.remove(); transientLabel = null; }
        }, 3500);
    }

    function selectPrinter(printer) {
        currentPrinterIp = printer.ip;
        currentPrinter = printer;
        openZebraPanel(printer, apiGetter, { onEdit: openEditForm, onDelete: confirmDelete });
        document.getElementById('ip-input-panel').value = printer.ip;
        document.getElementById('panel-current-ip').textContent = printer.ip;
        logPanel(`Selecionado: ${printer.name} (${printer.ip})`);
    }

    /* -------------------- Posicionamento no mapa -------------------- */
    function enterPlacingMode(cb) {
        placing = true;
        placingCallback = cb;
        mapContainer.classList.add('placing');
        document.getElementById('add-mode-banner').classList.remove('hidden');
        mapInner.style.transform = '';
    }
    function exitPlacingMode() {
        placing = false;
        placingCallback = null;
        mapContainer.classList.remove('placing');
        document.getElementById('add-mode-banner').classList.add('hidden');
    }
    mapInner.addEventListener('click', (e) => {
        if (!placing) return;
        const rect = mapInner.getBoundingClientRect();
        const left = ((e.clientX - rect.left) / rect.width) * 100;
        const top = ((e.clientY - rect.top) / rect.height) * 100;
        const pos = { top: top.toFixed(3) + '%', left: left.toFixed(3) + '%' };
        const cb = placingCallback;
        exitPlacingMode();
        if (cb) cb(pos);
    });
    document.getElementById('add-mode-cancel').addEventListener('click', exitPlacingMode);
    document.getElementById('add-printer-btn').addEventListener('click', () => {
        enterPlacingMode((pos) => openAddForm(pos));
    });

    /* -------------------- Formulário de impressora -------------------- */
    const pfModal = document.getElementById('printer-form-modal');
    function fillPos(pos) {
        pendingPos = pos;
        document.getElementById('pf-pos').textContent = pos ? `${pos.top} , ${pos.left}` : '—';
    }
    function openAddForm(pos) {
        formMode = 'add'; editingId = null;
        document.getElementById('pf-title').textContent = 'Adicionar impressora';
        document.getElementById('pf-name').value = '';
        document.getElementById('pf-department').value = '';
        document.getElementById('pf-selb').value = '';
        document.getElementById('pf-ip').value = '';
        document.getElementById('pf-observations').value = '';
        document.getElementById('pf-webpath').value = '';
        document.getElementById('pf-floor').value = currentFloor;
        fillPos(pos || null);
        pfModal.classList.remove('hidden');
    }
    function openEditForm(printer) {
        formMode = 'edit'; editingId = printer.id;
        document.getElementById('pf-title').textContent = 'Editar impressora';
        document.getElementById('pf-name').value = printer.name || '';
        document.getElementById('pf-department').value = printer.department || '';
        document.getElementById('pf-selb').value = printer.selb || '';
        document.getElementById('pf-ip').value = printer.ip || '';
        document.getElementById('pf-observations').value = printer.observations || '';
        document.getElementById('pf-webpath').value = printer.webPath || '';
        document.getElementById('pf-floor').value = printer.floor || 1;
        fillPos(printer.pos);
        closeZebraPanel();
        pfModal.classList.remove('hidden');
    }
    function closeForm() { pfModal.classList.add('hidden'); }

    document.getElementById('pf-close').addEventListener('click', closeForm);
    document.getElementById('pf-cancel').addEventListener('click', closeForm);
    pfModal.addEventListener('click', (e) => { if (e.target === pfModal) closeForm(); });

    document.getElementById('pf-pick').addEventListener('click', () => {
        pfModal.classList.add('hidden');
        // mostra o andar escolhido no form antes de posicionar
        const f = parseInt(document.getElementById('pf-floor').value);
        if (f !== currentFloor) { currentFloor = f; floorSelect.value = f; updateMapImage(); renderAllPrinters(); }
        enterPlacingMode((pos) => { fillPos(pos); pfModal.classList.remove('hidden'); });
    });

    document.getElementById('pf-save').addEventListener('click', async () => {
        const name = document.getElementById('pf-name').value.trim();
        const ip = document.getElementById('pf-ip').value.trim();
        if (!name) { showToast('Informe o nome da impressora.'); return; }
        if (!ip) { showToast('Informe o endereço IP.'); return; }
        if (!pendingPos) { showToast('Defina a posição no mapa.'); return; }

        let webPath = document.getElementById('pf-webpath').value.trim();
        if (webPath && webPath[0] !== '/') webPath = '/' + webPath;
        const data = {
            name,
            department: document.getElementById('pf-department').value.trim(),
            selb: document.getElementById('pf-selb').value.trim() || name,
            ip,
            observations: document.getElementById('pf-observations').value.trim(),
            webPath,
            floor: parseInt(document.getElementById('pf-floor').value),
            pos: pendingPos,
        };
        try {
            if (formMode === 'add') {
                await addPrinter(data);
                showToast('Impressora adicionada!');
            } else {
                await updatePrinter(editingId, data);
                showToast('Impressora atualizada!');
            }
            logPanel(`${formMode === 'add' ? 'Adicionada' : 'Editada'}: ${name} (${ip})${isCloudSynced() ? ' — sincronizada na nuvem' : ' — salva localmente'}`);
            closeForm();
            if (data.floor !== currentFloor) { currentFloor = data.floor; floorSelect.value = data.floor; updateMapImage(); }
        } catch (e) { showToast('Erro ao salvar: ' + e.message); }
    });

    async function confirmDelete(printer) {
        if (!confirm(`Excluir a impressora "${printer.name}" do mapa?`)) return;
        await deletePrinter(printer.id);
        closeZebraPanel();
        showToast('Impressora excluída.');
        logPanel(`Excluída: ${printer.name} (${printer.ip})`);
    }

    /* -------------------- Painel lateral (IP Tools) -------------------- */
    document.getElementById('btn-status-panel').addEventListener('click', async () => {
        if (!currentPrinterIp) { showToast('IP inválido!'); return; }
        logPanel(`Status -> consultando ${currentPrinterIp} ...`);
        const res = await fetchPrinterStatus(currentPrinterIp, API_BASE_URL);
        const label = STATE_LABELS[res.state] || res.state;
        showToast(`${currentPrinterIp}: ${label}`);
        logPanel(`Status: ${label}${res.detail ? ' — ' + res.detail : ''}`);
    });
    document.getElementById('btn-open-web-panel').addEventListener('click', () => {
        if (!currentPrinterIp) { showToast('Defina um IP primeiro.'); return; }
        const wp = currentPrinter && currentPrinter.ip === currentPrinterIp ? (currentPrinter.webPath || '') : '';
        openBrowserWindow(currentPrinterIp + wp, API_BASE_URL);
    });
    document.getElementById('btn-restart-panel').addEventListener('click', () => {
        if (confirm('Reiniciar?')) sendCommand('~JR', 'Reiniciar', currentPrinterIp, API_BASE_URL);
    });
    document.getElementById('btn-calibrate-panel').addEventListener('click', () => sendCommand(CALIBRAGEM, 'Calibrar', currentPrinterIp, API_BASE_URL));
    document.getElementById('btn-headtest-panel').addEventListener('click', () => sendCommand(TESTE_CABECA, 'Teste Cabeça', currentPrinterIp, API_BASE_URL));
    document.getElementById('btn-zt421-panel').addEventListener('click', () => {
        if (confirm('Enviar ZT421?')) sendCommand(`\x10CT~~CD,~CC^~CT~^XA~TA000~JSN^LT0^MNW^MTT^PON^PMN^LH0,0^JMA^PR3,3~SD20^JUS^LRN^CI0^XZ`, 'ZT421', currentPrinterIp, API_BASE_URL);
    });
    document.getElementById('btn-send-raw-panel').addEventListener('click', () => {
        sendCommand(document.getElementById('panel-rawcmd').value, 'Manual', currentPrinterIp, API_BASE_URL);
    });
    document.getElementById('set-ip-panel').addEventListener('click', () => {
        const val = document.getElementById('ip-input-panel').value.trim();
        if (val) { currentPrinterIp = val; document.getElementById('panel-current-ip').textContent = val; logPanel(`IP Manual: ${val}`); }
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

    /* -------------------- Busca -------------------- */
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    document.getElementById('search-hitbox').addEventListener('click', () => {
        document.getElementById('search-container').classList.toggle('expanded');
    });
    searchInput.addEventListener('input', debounce(() => {
        const term = searchInput.value.toLowerCase();
        if (!term) { searchResults.style.display = 'none'; return; }
        const matches = printerData.filter(p => p.name.toLowerCase().includes(term) || (p.selb || '').toLowerCase().includes(term));
        searchResults.innerHTML = matches.length ? '' : '<div class="result-empty">Nada encontrado</div>';
        matches.slice(0, 30).forEach(r => {
            const d = document.createElement('div');
            d.className = 'result-item';
            d.innerHTML = `<b>${r.name}</b> <small>${r.selb}</small>`;
            d.onclick = () => {
                searchResults.style.display = 'none';
                document.getElementById('search-container').classList.remove('expanded');
                if (r.floor !== currentFloor) { currentFloor = r.floor; floorSelect.value = r.floor; updateMapImage(); renderAllPrinters(); }
                focusPrinter(r); selectPrinter(r);
            };
            searchResults.appendChild(d);
        });
        searchResults.style.display = 'block';
    }, 300));

    /* -------------------- Carrega impressoras (store) -------------------- */
    updateMapImage();
    await initPrinters((list) => {
        printerData = list;
        renderAllPrinters();
    });
    printerData = getPrinters();
    renderAllPrinters();
});
