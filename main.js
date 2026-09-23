import { configDocRef, onSnapshot, setDoc } from './firebaseConfig.js';
import { TESTE_CABECA, CALIBRAGEM, ZT421_CONFIG } from './data.js';
import { showToast, logPanel, debounce } from './helpers.js';
import { fetchPrinterStatus, sendCommand, STATE_LABELS } from './printer_logic.js';
import { openBrowserWindow, closeBrowserWindow, reloadBrowser, browserBack, navigateFromBar, setupDragLogic } from './browser_window.js';
import { openZebraPanel, closeZebraPanel } from './zebra_panel.js';
import { initIpTools, openIpToolsModal } from './iptools.js';
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
        if (!newUrl) { showToast('Informe um link válido.'); return; }
        try {
            await setDoc(configDocRef, { url: newUrl, updatedAt: new Date() });
            document.getElementById('new-api-url').value = "";
            document.getElementById('tool-modal').classList.add('hidden');
            showToast('Link do túnel atualizado!');
        } catch (e) { showToast('Erro ao salvar: ' + e.message); }
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

    const MAP_VERSION = '4'; // aumente ao trocar a planta para furar o cache
    function updateMapImage() {
        mapImage.src = (currentFloor === 1 ? 'plantanto.jpg' : 'plantanto2.jpg') + '?v=' + MAP_VERSION;
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
        logPanel(`Selecionado: ${printer.name} (${printer.ip})`);
    }

    // Abre o painel virtual para um IP avulso (usa a impressora cadastrada se existir)
    function openPanelForIp(ip) {
        if (!ip) return;
        const known = printerData.find(p => p.ip === ip);
        selectPrinter(known || { id: 'adhoc-' + ip, name: ip, ip, selb: '', department: 'Equipamento avulso', observations: '' });
    }

    // DP IP-Tools (config, etiqueta, broadcast) — usa a impressora escolhida no scan p/ abrir o painel
    initIpTools({ apiGetter, onUsePrinter: (ip) => openPanelForIp(ip) });

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

    /* -------------------- Ferramentas (menu do cabeçalho) -------------------- */
    // O visor (aberto ao clicar numa impressora ou em "IP externo") já traz
    // Status, Interface, Reiniciar, Calibrar, ZT421, contador e comandos ZPL —
    // por isso a antiga barra lateral foi aposentada.
    document.getElementById('zp-iptools').addEventListener('click', () => openIpToolsModal(currentPrinterIp));
    setupToolsMenu();

    // Tela cheia: o mapa ocupa toda a tela (mantém as impressoras no lugar).
    const fsBtn = document.getElementById('fullscreen-btn');
    if (fsBtn) {
        const setFull = (on) => {
            document.body.classList.toggle('map-full', on);
            fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        fsBtn.addEventListener('click', () => {
            const on = !document.body.classList.contains('map-full');
            setFull(on);
            // tenta a tela cheia real do navegador (esconde a barra do navegador no celular)
            try {
                if (on && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
                else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
            } catch (_) {}
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && document.body.classList.contains('map-full')) setFull(false);
        });
        // se sair da tela cheia do navegador (ESC/gesto), tira o modo também
        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement) setFull(false);
        });
    }

    /* -------------------- Check-up da rede -------------------- */
    let checkupRunning = false;
    (function initCheckupModal() {
        const modal = document.getElementById('checkup-modal');
        if (!modal) return;
        const close = () => modal.classList.add('hidden');
        document.getElementById('checkup-close').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
        document.getElementById('ck-rerun').addEventListener('click', runCheckup);
    })();

    function openCheckup() {
        document.getElementById('checkup-modal').classList.remove('hidden');
        runCheckup();
    }

    const CK_SEV = { OFFLINE: 0, ERROR: 1, HEAD_OPEN: 1, RIBBON_OUT: 1, MEDIA_OUT: 1, UNKNOWN: 2, PAUSED: 2, READY: 3, ONLINE: 3, CONNECTING: 2 };

    async function runCheckup() {
        if (checkupRunning) return;
        checkupRunning = true;
        const list = getPrinters().slice();
        const total = list.length;
        const progress = document.getElementById('ck-progress');
        const barFill = document.getElementById('ck-bar-fill');
        const ptext = document.getElementById('ck-progress-text');
        const summary = document.getElementById('ck-summary');
        const listEl = document.getElementById('ck-list');
        const rerun = document.getElementById('ck-rerun');

        progress.hidden = false; summary.hidden = true; rerun.hidden = true;
        listEl.innerHTML = '';
        barFill.style.width = '0%';
        ptext.textContent = total ? `Verificando 0/${total}…` : 'Nenhuma impressora cadastrada.';
        if (!total) { checkupRunning = false; progress.hidden = true; return; }

        const results = [];
        let done = 0, idx = 0;
        const CONCURRENCY = 8;
        const worker = async () => {
            while (idx < list.length) {
                const p = list[idx++];
                let res;
                try { res = await fetchPrinterStatus(p.ip, API_BASE_URL); }
                catch (_) { res = { state: 'OFFLINE', detail: 'Falha' }; }
                results.push({ printer: p, state: res.state, detail: res.detail });
                done++;
                barFill.style.width = Math.round(done / total * 100) + '%';
                ptext.textContent = `Verificando ${done}/${total}…`;
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
        checkupRunning = false;
        renderCheckup(results);
    }

    function renderCheckup(results) {
        const progress = document.getElementById('ck-progress');
        const summary = document.getElementById('ck-summary');
        const listEl = document.getElementById('ck-list');
        const rerun = document.getElementById('ck-rerun');
        progress.hidden = true; rerun.hidden = false;

        const sev = (s) => (CK_SEV[s] ?? 2);
        const bad = results.filter(r => sev(r.state) <= 2).sort((a, b) => sev(a.state) - sev(b.state) || a.printer.name.localeCompare(b.printer.name));
        const off = results.filter(r => r.state === 'OFFLINE').length;
        const prob = results.filter(r => ['ERROR', 'HEAD_OPEN', 'RIBBON_OUT', 'MEDIA_OUT'].includes(r.state)).length;
        const att = results.filter(r => ['PAUSED', 'UNKNOWN', 'CONNECTING'].includes(r.state)).length;
        const ok = results.length - off - prob - att;

        summary.hidden = false;
        summary.innerHTML =
            `<div class="ck-stat ok"><b>${ok}</b><span>OK</span></div>` +
            `<div class="ck-stat att"><b>${att}</b><span>atenção</span></div>` +
            `<div class="ck-stat prob"><b>${prob}</b><span>problema</span></div>` +
            `<div class="ck-stat off"><b>${off}</b><span>offline</span></div>`;

        if (!bad.length) {
            listEl.innerHTML = `<div class="ck-allok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5 5-5.5"/></svg> Todas as impressoras estão OK!</div>`;
            return;
        }
        listEl.innerHTML = '';
        bad.forEach(r => {
            const kind = r.state === 'OFFLINE' ? 'off' : (['PAUSED', 'UNKNOWN', 'CONNECTING'].includes(r.state) ? 'att' : 'prob');
            const row = document.createElement('button');
            row.className = 'ck-row ' + kind;
            row.type = 'button';
            row.innerHTML =
                `<span class="ck-dot"></span>` +
                `<span class="ck-row-main"><b>${r.printer.name}</b>` +
                `<span>${r.printer.ip} · Andar ${r.printer.floor}${r.printer.selb ? ' · ' + r.printer.selb : ''}</span></span>` +
                `<span class="ck-badge">${STATE_LABELS[r.state] || r.state}</span>`;
            row.addEventListener('click', () => {
                document.getElementById('checkup-modal').classList.add('hidden');
                const known = printerData.find(x => x.id === r.printer.id) || r.printer;
                if (known.floor !== currentFloor) { currentFloor = known.floor; floorSelect.value = known.floor; updateMapImage(); renderAllPrinters(); }
                focusPrinter(known);
                selectPrinter(known);
            });
            listEl.appendChild(row);
        });
    }

    function setupToolsMenu() {
        const menu = document.getElementById('tools-menu');   // .tools-fab
        const btn = document.getElementById('tools-btn');     // botão-maleta
        const pop = document.getElementById('tools-pop');     // .fab-items
        if (!menu || !btn || !pop) return;

        // --- speed dial (abre/retrai as opções para baixo) ---
        // joga a dica (tooltip) para o lado que tiver espaço na tela
        const positionTips = () => {
            const r = pop.getBoundingClientRect();
            menu.classList.toggle('tips-right', r.left < window.innerWidth * 0.42);
        };
        const openFab = () => {
            pop.hidden = false;
            positionTips();
            requestAnimationFrame(() => menu.classList.add('open'));
            btn.setAttribute('aria-expanded', 'true');
        };
        const closeFab = () => {
            menu.classList.remove('open');
            btn.setAttribute('aria-expanded', 'false');
            setTimeout(() => { if (!menu.classList.contains('open')) pop.hidden = true; }, 260);
        };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.contains('open') ? closeFab() : openFab();
        });
        pop.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', () => { if (menu.classList.contains('open')) closeFab(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.classList.contains('open')) closeFab(); });
        window.addEventListener('resize', () => { if (menu.classList.contains('open')) positionTips(); });

        // --- mini-modal com formulário (IP externo / Link do túnel) ---
        const toolModal = document.getElementById('tool-modal');
        const openToolModal = (which) => {
            toolModal.dataset.open = which;
            toolModal.classList.remove('hidden');
            setTimeout(() => {
                const f = which === 'extip' ? document.getElementById('tool-extip-input') : document.getElementById('new-api-url');
                if (f) f.focus();
            }, 80);
        };
        const closeToolModal = () => toolModal.classList.add('hidden');
        document.getElementById('tool-modal-close').addEventListener('click', closeToolModal);
        toolModal.addEventListener('click', (e) => { if (e.target === toolModal) closeToolModal(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !toolModal.classList.contains('hidden')) closeToolModal(); });

        pop.querySelectorAll('.fab-item').forEach(item => {
            item.addEventListener('click', () => {
                closeFab();
                switch (item.dataset.tool) {
                    case 'broadcast': openIpToolsModal('', 'scan'); break;
                    case 'labels':    openIpToolsModal('', 'label'); break;
                    case 'fixip':     openIpToolsModal('', 'config'); break;
                    case 'extip':     openToolModal('extip'); break;
                    case 'apilink':   openToolModal('apilink'); break;
                    case 'checkup':   openCheckup(); break;
                }
            });
        });

        const goExtIp = () => {
            const ip = document.getElementById('tool-extip-input').value.trim();
            if (!ip) return;
            closeToolModal();
            logPanel(`IP externo: ${ip}`);
            openPanelForIp(ip);
        };
        document.getElementById('tool-extip-go').addEventListener('click', goExtIp);
        document.getElementById('tool-extip-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') goExtIp(); });
    }

    floorSelect.addEventListener('change', (e) => {
        currentFloor = parseInt(e.target.value);
        updateMapImage();
        renderAllPrinters();
    });

    /* -------------------- Busca -------------------- */
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');
    document.getElementById('search-hitbox').addEventListener('click', () => {
        const expanded = document.getElementById('search-container').classList.toggle('expanded');
        if (expanded) setTimeout(() => searchInput.focus(), 60); // abre o teclado no mobile
    });
    searchInput.addEventListener('input', debounce(() => {
        const term = searchInput.value.toLowerCase().trim();
        if (!term) { searchResults.style.display = 'none'; return; }
        // busca por nome, SELB, IP ou departamento
        const matches = printerData.filter(p =>
            p.name.toLowerCase().includes(term) ||
            (p.selb || '').toLowerCase().includes(term) ||
            (p.ip || '').includes(term) ||
            (p.department || '').toLowerCase().includes(term)
        );
        searchResults.innerHTML = matches.length ? '' : '<div class="result-empty">Nada encontrado</div>';
        matches.slice(0, 40).forEach(r => {
            const d = document.createElement('div');
            d.className = 'result-item';
            d.innerHTML = `
                <div class="result-top">
                    <span class="result-name">${r.name}</span>
                    <span class="result-floor">Andar ${r.floor}</span>
                </div>
                <div class="result-sub">
                    <span class="result-ip mono">${r.ip}</span>
                    ${r.selb ? `<span class="result-selb">SELB ${r.selb}</span>` : ''}
                    <span class="result-dep">${r.department || ''}</span>
                </div>`;
            d.onclick = () => {
                searchResults.style.display = 'none';
                document.getElementById('search-container').classList.remove('expanded');
                searchInput.value = '';
                if (r.floor !== currentFloor) { currentFloor = r.floor; floorSelect.value = r.floor; updateMapImage(); renderAllPrinters(); }
                // apenas destaca no mapa; NÃO abre o painel virtual automaticamente
                focusPrinter(r);
            };
            searchResults.appendChild(d);
        });
        searchResults.style.display = 'block';
        clampResultsToViewport();
    }, 250));

    // Mantém o dropdown dentro da tela (em telas estreitas ele encostaria
    // fora da borda esquerda por causa do alinhamento à direita da busca).
    function clampResultsToViewport() {
        // ancorado à esquerda (a busca fica na barra lateral do mapa)
        searchResults.style.right = 'auto';
        searchResults.style.left = '0';
        const parent = searchResults.offsetParent;
        if (!parent) return;
        const gutter = 12;
        const r = searchResults.getBoundingClientRect();
        const overRight = r.right - (window.innerWidth - gutter);
        if (overRight > 0) searchResults.style.left = (-overRight) + 'px';
        const r2 = searchResults.getBoundingClientRect();
        if (r2.left < gutter) {
            const pr = parent.getBoundingClientRect();
            searchResults.style.left = (gutter - pr.left) + 'px';
        }
    }
    window.addEventListener('resize', () => {
        if (searchResults.style.display === 'block') clampResultsToViewport();
    });

    /* -------------------- Carrega impressoras (store) -------------------- */
    updateMapImage();
    await initPrinters((list) => {
        printerData = list;
        renderAllPrinters();
    });
    printerData = getPrinters();
    renderAllPrinters();
});
