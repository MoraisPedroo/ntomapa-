import { sendCommand, fetchPrinterStatus, STATE_LABELS } from './printer_logic.js';
import { showToast, logPanel } from './helpers.js';
import { openBrowserWindow } from './browser_window.js';
import { TESTE_CABECA, CALIBRAGEM } from './data.js';

const POLL_MS = 8000;      // intervalo de telemetria com o painel aberto
const HOLD_MS = 1400;      // tempo segurando o botão de reiniciar
const BOOT_MS = 9500;      // duração do POST simulado (acompanha a barra de boot no CSS)

let current = null;        // impressora aberta no painel
let getApi = () => '';     // getter do link da API (atualiza via Firebase)
let pollTimer = null;
let busy = false;          // true durante reinício/envio de comando
let fetching = false;
let lastState = 'CONNECTING';
let session = 0;           // invalida sequências assíncronas ao fechar/trocar de impressora

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------
   Ícones (SVG inline)
------------------------------------------------------------------ */
const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.5" opacity=".4"/><path d="M7.8 12.6l2.7 2.7 5.7-6"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5L22 20.5H2L12 3.5z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.4" r=".6" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 5.5v13M15 5.5v13"/></svg>',
    help:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5" opacity=".4"/><path d="M9.6 9.3a2.6 2.6 0 115.1.9c-.5 1.4-2.1 1.7-2.6 3"/><circle cx="12" cy="16.8" r=".6" fill="currentColor"/></svg>',
    wifiOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8.5 16.5a5 5 0 017 0M5 13a10 10 0 0114 0" opacity=".35"/><path d="M12 20h.01"/><path d="M4 4l16 16"/></svg>',
    net:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h.01M8.5 16.5a5 5 0 017 0M5 13a10 10 0 0114 0"/></svg>',
    ribbon:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="11" r="4"/><circle cx="17.5" cy="11" r="2.5"/><path d="M8 17h9.5"/></svg>',
    label: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4.5" y="4" width="15" height="6.5" rx="1.2"/><rect x="4.5" y="13.5" width="15" height="6.5" rx="1.2"/></svg>',
};

/* ------------------------------------------------------------------
   Metadados de cada estado (tela, LEDs, conexão)
------------------------------------------------------------------ */
const STATE_META = {
    READY:      { cls: 'lcd-ready',      icon: 'check', title: 'PRONTA',              sub: 'Pronta para imprimir.', chip: 'PRONTA',      conn: 'ok' },
    PAUSED:     { cls: 'lcd-paused',     icon: 'pause', title: 'EM PAUSA',            sub: 'Pressione PAUSE para retomar a impressão.', chip: 'PAUSA', conn: 'ok' },
    RIBBON_OUT: { cls: 'lcd-error',      icon: 'alert', title: 'ALERTA: SEM RIBBON',  sub: 'Substitua o ribbon e calibre os sensores.', chip: 'RIBBON OUT', conn: 'ok' },
    MEDIA_OUT:  { cls: 'lcd-error',      icon: 'alert', title: 'ALERTA: SEM ETIQUETA',sub: 'Reponha as etiquetas e calibre os sensores.', chip: 'MEDIA OUT', conn: 'ok' },
    HEAD_OPEN:  { cls: 'lcd-error',      icon: 'alert', title: 'CABEÇA ABERTA',       sub: 'Feche e trave o cabeçote de impressão.', chip: 'HEAD OPEN', conn: 'ok' },
    ERROR:      { cls: 'lcd-error',      icon: 'alert', title: 'EM ERRO',             sub: 'Condição de erro detectada no equipamento.', chip: 'ERRO', conn: 'ok' },
    UNKNOWN:    { cls: 'lcd-unknown',    icon: 'help',  title: 'STATUS INDEFINIDO',   sub: 'Não foi possível interpretar o status.', chip: 'INDEFINIDO', conn: 'ok' },
    OFFLINE:    { cls: 'lcd-off',        icon: 'wifiOff', title: 'SEM CONEXÃO',       sub: 'A impressora não respondeu pelo túnel.', chip: 'OFFLINE', conn: 'down' },
    CONNECTING: { cls: 'lcd-connecting', icon: null,    title: 'CONSULTANDO…',        sub: 'Lendo status pelo túnel corporativo.', chip: 'SYNC', conn: 'wait' },
};

/* ------------------------------------------------------------------
   Renderização do LCD e LEDs
------------------------------------------------------------------ */
function lcdStatusbar(flags = {}) {
    const netCls = flags.net === false ? 'bad' : (flags.net ? 'ok' : '');
    const ribCls = flags.ribbon === false ? 'bad' : '';
    const labCls = flags.label === false ? 'bad' : '';
    return `<div class="lcd-statusbar">
        <span>${current ? current.name : 'ZEBRA'}</span>
        <span class="lcd-icons">
            <span class="lcd-ic ${ribCls}" title="Ribbon">${ICON.ribbon}</span>
            <span class="lcd-ic ${labCls}" title="Etiquetas">${ICON.label}</span>
            <span class="lcd-ic ${netCls}" title="Rede">${ICON.net}</span>
        </span>
    </div>`;
}

function lcdFooter(chip) {
    const time = new Date().toLocaleTimeString('pt-BR');
    return `<div class="lcd-footer">
        <span class="lcd-chip">${chip}</span>
        <span>${current ? current.ip : ''} · ${time}</span>
    </div>`;
}

function lcdBody(iconHTML, title, sub) {
    return `<div class="lcd-body">
        ${iconHTML ? `<div class="lcd-icon">${iconHTML}</div>` : ''}
        <div class="lcd-title">${title}</div>
        ${sub ? `<div class="lcd-sub">${sub}</div>` : ''}
    </div>`;
}

function setLed(id, color, blink = false) {
    const el = $(id);
    if (!el) return;
    el.className = 'zt-led' + (color ? ` on-${color}` : '') + (blink ? ' blink' : '');
}

function applyLeds(state) {
    // [status, pause, data, supplies, network] -> [cor, pisca]
    const off = [null, false];
    const map = {
        READY:      { status: ['green', false], pause: off, data: off, supplies: off, network: ['green', false] },
        PAUSED:     { status: ['green', false], pause: ['amber', false], data: off, supplies: off, network: ['green', false] },
        RIBBON_OUT: { status: ['red', true],  pause: ['amber', false], data: off, supplies: ['red', false], network: ['green', false] },
        MEDIA_OUT:  { status: ['red', true],  pause: ['amber', false], data: off, supplies: ['red', false], network: ['green', false] },
        HEAD_OPEN:  { status: ['red', true],  pause: ['amber', false], data: off, supplies: off, network: ['green', false] },
        ERROR:      { status: ['red', true],  pause: off, data: off, supplies: off, network: ['green', false] },
        UNKNOWN:    { status: ['amber', true], pause: off, data: off, supplies: off, network: ['green', false] },
        OFFLINE:    { status: off, pause: off, data: off, supplies: off, network: ['red', true] },
        CONNECTING: { status: off, pause: off, data: ['green', true], supplies: off, network: ['amber', true] },
        BOOT:       { status: ['amber', true], pause: off, data: ['green', true], supplies: off, network: off },
    };
    const leds = map[state] || map.UNKNOWN;
    setLed('led-status',   ...leds.status);
    setLed('led-pause',    ...leds.pause);
    setLed('led-data',     ...leds.data);
    setLed('led-supplies', ...leds.supplies);
    setLed('led-network',  ...leds.network);
}

function applyConn(kind, text) {
    const dot = $('zp-conn-dot');
    const label = $('zp-conn-text');
    if (dot) dot.className = 'conn-dot ' + kind;
    if (label) label.textContent = text;
}

function renderState(state, detail) {
    lastState = state;
    const meta = STATE_META[state] || STATE_META.UNKNOWN;
    const lcd = $('zt-lcd');
    if (!lcd) return;

    const useDetail = detail && ['UNKNOWN', 'OFFLINE', 'ERROR'].includes(state);
    const sub = useDetail ? detail : meta.sub;
    const flags = {
        net: state !== 'OFFLINE',
        ribbon: state !== 'RIBBON_OUT',
        label: state !== 'MEDIA_OUT',
    };

    lcd.className = 'zt-lcd ' + meta.cls;
    const bodyIcon = state === 'CONNECTING' ? '<div class="lcd-spinner"></div>' : (ICON[meta.icon] || '');
    lcd.innerHTML = lcdStatusbar(flags) + lcdBody(bodyIcon, meta.title, sub) + lcdFooter(meta.chip);

    applyLeds(state);
    const connText = {
        ok:   'Online via túnel corporativo',
        down: detail || 'Sem resposta da impressora',
        wait: 'Consultando status…',
    }[meta.conn];
    applyConn(meta.conn, connText);

    // Rótulo do PAUSE acompanha o estado
    const pauseKey = $('key-pause');
    if (pauseKey) pauseKey.textContent = state === 'PAUSED' ? 'RESUME' : 'PAUSE';
}

function renderBootScreen() {
    const lcd = $('zt-lcd');
    if (!lcd) return;
    lcd.className = 'zt-lcd lcd-boot';
    lcd.innerHTML = lcdStatusbar({}) + `
        <div class="lcd-body">
            <div class="boot-logo">ZEBRA</div>
            <div class="boot-bar"><i></i></div>
            <div class="lcd-sub">Reinicializando… executando autoteste (POST)</div>
        </div>` + lcdFooter('BOOT');
    applyLeds('BOOT');
    applyConn('wait', 'Reinicializando equipamento…');
}

function renderReconnecting(attempt, maxAttempts) {
    const lcd = $('zt-lcd');
    if (!lcd) return;
    lcd.className = 'zt-lcd lcd-connecting';
    lcd.innerHTML = lcdStatusbar({}) + lcdBody(
        '<div class="lcd-spinner"></div>',
        'RECONECTANDO…',
        `Restabelecendo comunicação (tentativa ${attempt}/${maxAttempts})`
    ) + lcdFooter('SYNC');
    applyLeds('CONNECTING');
    applyConn('wait', `Reconectando… (${attempt}/${maxAttempts})`);
}

/* ------------------------------------------------------------------
   Telemetria (polling)
------------------------------------------------------------------ */
async function refreshStatus() {
    if (!current || busy || fetching) return;
    fetching = true;
    setLed('led-data', 'green', true); // atividade de dados
    const mySession = session;
    const res = await fetchPrinterStatus(current.ip, getApi());
    fetching = false;
    if (mySession !== session || busy || !current) return;
    renderState(res.state, res.detail);
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(refreshStatus, POLL_MS);
}
function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* ------------------------------------------------------------------
   Ações (teclas físicas virtuais)
------------------------------------------------------------------ */
async function keyAction(cmd, label, refreshDelay = 1500) {
    if (!current || busy) return;
    const mySession = session;
    const ok = await sendCommand(cmd, label, current.ip, getApi());
    if (ok && mySession === session && current) {
        setTimeout(() => { if (mySession === session) refreshStatus(); }, refreshDelay);
    }
}

async function restartSequence() {
    if (!current || busy) return;
    busy = true;
    stopPolling();
    const mySession = session;
    const ip = current.ip;

    renderBootScreen();
    const ok = await sendCommand('~JR', 'Reiniciar', ip, getApi());
    if (mySession !== session) return;

    if (!ok) {
        busy = false;
        renderState('OFFLINE', 'Falha ao enviar ~JR — verifique o link da API no painel lateral.');
        startPolling();
        return;
    }

    // Aguarda o POST (a barra de boot anima nesse tempo)
    await sleep(BOOT_MS);
    if (mySession !== session) return;

    // Tenta reencontrar a impressora na rede
    const MAX_TRIES = 10;
    for (let i = 1; i <= MAX_TRIES; i++) {
        renderReconnecting(i, MAX_TRIES);
        const res = await fetchPrinterStatus(ip, getApi());
        if (mySession !== session) return;
        if (res.state !== 'OFFLINE') {
            busy = false;
            renderState(res.state, res.detail);
            startPolling();
            showToast('Impressora reiniciada com sucesso!');
            logPanel(`Reiniciar: ${ip} voltou online (${STATE_LABELS[res.state]}).`);
            return;
        }
        await sleep(3000);
        if (mySession !== session) return;
    }

    busy = false;
    renderState('OFFLINE', 'A impressora não voltou após o reinício — aguarde um pouco e atualize o status.');
    startPolling();
}

/* ------------------------------------------------------------------
   Botão de reiniciar: segurar para confirmar
------------------------------------------------------------------ */
function setupRestartHold() {
    const btn = $('key-restart');
    if (!btn) return;
    let timer = 0;
    let holdStart = 0;
    let firing = false;

    const reset = () => {
        if (timer) clearInterval(timer);
        timer = 0; holdStart = 0;
        btn.classList.remove('holding');
        btn.style.setProperty('--hold', 0);
    };

    const step = () => {
        const p = Math.min((performance.now() - holdStart) / HOLD_MS, 1);
        btn.style.setProperty('--hold', p);
        if (p >= 1) {
            reset();
            if (!firing) {
                firing = true;
                restartSequence().finally(() => { firing = false; });
            }
        }
    };

    btn.addEventListener('pointerdown', (e) => {
        if (busy || !current) return;
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        btn.classList.add('holding');
        holdStart = performance.now();
        step();
        timer = setInterval(step, 16);
    });
    btn.addEventListener('pointerup', reset);
    btn.addEventListener('pointercancel', reset);
    btn.addEventListener('lostpointercapture', reset);
}

/* ------------------------------------------------------------------
   Abertura / fechamento do painel
------------------------------------------------------------------ */
export function openZebraPanel(printer, apiGetter) {
    current = printer;
    getApi = apiGetter;
    session++;
    busy = false;
    fetching = false;

    $('zp-name').textContent = printer.name;
    $('zp-department').textContent = printer.department || '—';
    $('zp-selb').textContent = printer.selb || '—';
    $('zp-ip').textContent = printer.ip || '—';
    $('zp-observations').textContent = printer.observations || 'Nenhuma.';

    $('zebra-modal').classList.remove('hidden');
    renderState('CONNECTING');
    refreshStatus();
    startPolling();
}

export function closeZebraPanel() {
    session++;
    stopPolling();
    current = null;
    busy = false;
    fetching = false;
    const modal = $('zebra-modal');
    if (modal) modal.classList.add('hidden');
}

/* ------------------------------------------------------------------
   Listeners (executa uma vez no carregamento do módulo)
------------------------------------------------------------------ */
function init() {
    const modal = $('zebra-modal');
    if (!modal) return;

    $('zebra-close').addEventListener('click', closeZebraPanel);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeZebraPanel(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeZebraPanel();
    });

    $('key-pause').addEventListener('click', () => {
        const paused = lastState === 'PAUSED';
        keyAction(paused ? '~PS' : '~PP', paused ? 'Retomar' : 'Pausar');
    });
    $('key-feed').addEventListener('click', () => keyAction('~PH', 'Feed', 2000));
    $('key-cancel').addEventListener('click', () => keyAction('~JA', 'Cancelar trabalhos'));

    $('zp-refresh').addEventListener('click', () => { if (!busy) { renderState('CONNECTING'); refreshStatus(); } });
    $('zp-calibrate').addEventListener('click', () => keyAction(CALIBRAGEM, 'Calibrar', 4000));
    $('zp-headtest').addEventListener('click', () => keyAction(TESTE_CABECA, 'Teste Cabeça'));
    $('zp-open-web').addEventListener('click', () => { if (current) openBrowserWindow(current.ip, getApi()); });

    setupRestartHold();

    // Demonstração visual dos estados no console: zebraDemo('RIBBON_OUT')
    window.zebraDemo = (state, detail) => {
        if (modal.classList.contains('hidden')) { console.warn('Abra uma impressora primeiro.'); return; }
        stopPolling();
        if (state === 'BOOT') { renderBootScreen(); return; }
        renderState(state, detail || '');
    };
}

init();
