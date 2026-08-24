import { sendCommand, fetchPrinterStatus, sendCommandWithReply, fetchCounter, STATE_LABELS } from './printer_logic.js';
import { showToast, logPanel } from './helpers.js';
import { openBrowserWindow } from './browser_window.js';
import { TESTE_CABECA, CALIBRAGEM } from './data.js';

const POLL_MS = 8000;      // intervalo de telemetria com o painel aberto
const COUNTER_MS = 5000;   // intervalo do contador de impressão
const HOLD_MS = 1400;      // tempo segurando o botão de reiniciar
const BOOT_MS = 9500;      // duração do POST simulado (acompanha a barra de boot)

let current = null;        // impressora aberta
let getApi = () => '';     // getter do link da API
let handlers = {};         // { onEdit, onDelete }
let pollTimer = null;
let counterTimer = null;
let counterPath = '';      // caminho da página de contador que funcionou
let counterFetching = false;
let lastJobs = null;
let busy = false;
let fetching = false;
let lastState = 'CONNECTING';
let session = 0;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------
   Ícones
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

/* SVG animado da cabeça abrindo/fechando (para o próprio LCD) */
const LCD_HEADOPEN = `
<svg class="lcd-anim" viewBox="0 0 90 62" fill="none">
  <rect x="10" y="34" width="70" height="20" rx="3" fill="#7f1d1d" stroke="#fecaca" stroke-width="2"/>
  <rect x="18" y="40" width="54" height="8" rx="1.5" fill="#450a0a"/>
  <g class="ho-lid">
    <rect x="10" y="16" width="62" height="14" rx="3" fill="#991b1b" stroke="#fecaca" stroke-width="2"/>
    <line x1="20" y1="30" x2="64" y2="30" stroke="#fca5a5" stroke-width="2"/>
  </g>
  <g class="ho-arrow" stroke="#fef08a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <line x1="80" y1="14" x2="80" y2="26"/><path d="M76 22l4 4 4-4"/>
  </g>
</svg>`;

/* ------------------------------------------------------------------
   Guias de resolução (animação + passos)
------------------------------------------------------------------ */
const GUIDES = {
    HEAD_OPEN: {
        title: 'Como fechar o cabeçote',
        anim: `<svg class="guide-svg" viewBox="0 0 240 120" fill="none">
            <rect x="30" y="66" width="150" height="34" rx="5" fill="#e2e8f0" stroke="#94a3b8" stroke-width="2"/>
            <rect x="44" y="76" width="122" height="14" rx="2" fill="#cbd5e1"/>
            <g class="ho-lid">
              <rect x="30" y="30" width="132" height="24" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2"/>
              <rect x="44" y="48" width="104" height="6" rx="2" fill="#38bdf8"/>
              <text x="96" y="45" font-size="10" fill="#475569" text-anchor="middle" font-family="sans-serif">cabeçote</text>
            </g>
            <g class="ho-arrow" stroke="#f59e0b" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="200" y1="34" x2="200" y2="62"/><path d="M192 54l8 8 8-8"/>
            </g>
        </svg>`,
        steps: [
            'Abra a tampa lateral e verifique se não há etiqueta ou fita presa no rolo.',
            'Baixe o conjunto do cabeçote de impressão até encaixar.',
            'Gire a trava/alavanca para a posição fechada (você ouve um clique).',
            'Depois de travado, use FEED para avançar uma etiqueta e confirmar.',
        ],
    },
    RIBBON_OUT: {
        title: 'Como trocar o ribbon (fita)',
        anim: `<svg class="guide-svg" viewBox="0 0 240 120" fill="none">
            <circle class="rb-spool" cx="66" cy="60" r="30" fill="#fde68a" stroke="#d97706" stroke-width="2"/>
            <circle cx="66" cy="60" r="8" fill="#92400e"/>
            <circle class="rb-spool" cx="178" cy="60" r="16" fill="#fca5a5" stroke="#b91c1c" stroke-width="2"/>
            <circle cx="178" cy="60" r="5" fill="#7f1d1d"/>
            <path class="rb-feed" d="M92 52 H162" stroke="#d97706" stroke-width="3"/>
            <path class="rb-feed" d="M92 68 H162" stroke="#d97706" stroke-width="3"/>
        </svg>`,
        steps: [
            'Abra a tampa e retire o rolo de ribbon usado (o refletor prateado indica o fim).',
            'Encaixe a nova fita no eixo de suprimento respeitando o lado revestido.',
            'Passe a fita pelo caminho e fixe no eixo de recolhimento; gire para tensionar.',
            'Feche a tampa e toque em “Calibrar” aqui no painel (envia ~JC).',
        ],
    },
    MEDIA_OUT: {
        title: 'Como repor as etiquetas',
        anim: `<svg class="guide-svg" viewBox="0 0 240 120" fill="none">
            <circle class="md-roll" cx="60" cy="60" r="34" fill="#e0f2fe" stroke="#0284c7" stroke-width="2"/>
            <circle cx="60" cy="60" r="9" fill="#0369a1"/>
            <g class="md-strip">
              <rect x="94" y="50" width="18" height="20" rx="2" fill="#fff" stroke="#0284c7" stroke-width="1.6"/>
              <rect x="116" y="50" width="18" height="20" rx="2" fill="#fff" stroke="#0284c7" stroke-width="1.6"/>
              <rect x="138" y="50" width="18" height="20" rx="2" fill="#fff" stroke="#0284c7" stroke-width="1.6"/>
              <rect x="160" y="50" width="18" height="20" rx="2" fill="#fff" stroke="#0284c7" stroke-width="1.6"/>
            </g>
            <path d="M188 60 h26" stroke="#0284c7" stroke-width="2.5" stroke-dasharray="4 4"/>
        </svg>`,
        steps: [
            'Abra o compartimento e remova o miolo/etiquetas que sobraram.',
            'Coloque o novo rolo respeitando o sentido de saída das etiquetas.',
            'Passe a mídia pelas guias e sob o sensor até a saída do cabeçote.',
            'Feche, toque em “Calibrar” (~JC) e depois FEED para testar.',
        ],
    },
};

/* ------------------------------------------------------------------
   Metadados de estado
------------------------------------------------------------------ */
const STATE_META = {
    READY:      { cls:'lcd-ready',      icon:'check', title:'PRONTA',               sub:'Pronta para imprimir.', chip:'PRONTA', conn:'ok' },
    PAUSED:     { cls:'lcd-paused',     icon:'pause', title:'EM PAUSA',             sub:'Pressione PAUSE para retomar a impressão.', chip:'PAUSA', conn:'ok' },
    RIBBON_OUT: { cls:'lcd-error',      icon:'alert', title:'ALERTA: SEM RIBBON',   sub:'Substitua o ribbon e calibre os sensores.', chip:'RIBBON OUT', conn:'ok' },
    MEDIA_OUT:  { cls:'lcd-error',      icon:'alert', title:'ALERTA: SEM ETIQUETA', sub:'Reponha as etiquetas e calibre os sensores.', chip:'MEDIA OUT', conn:'ok' },
    HEAD_OPEN:  { cls:'lcd-error',      icon:'alert', title:'CABEÇA ABERTA',        sub:'Feche e trave o cabeçote de impressão.', chip:'HEAD OPEN', conn:'ok' },
    ERROR:      { cls:'lcd-error',      icon:'alert', title:'EM ERRO',              sub:'Condição de erro detectada no equipamento.', chip:'ERRO', conn:'ok' },
    ONLINE:     { cls:'lcd-online',     icon:'net',   title:'ONLINE',               sub:'Dispositivo acessível na rede (status detalhado indisponível).', chip:'ONLINE', conn:'ok' },
    UNKNOWN:    { cls:'lcd-unknown',    icon:'help',  title:'STATUS INDEFINIDO',    sub:'Não foi possível interpretar o status.', chip:'INDEFINIDO', conn:'ok' },
    OFFLINE:    { cls:'lcd-off',        icon:'wifiOff', title:'SEM CONEXÃO',        sub:'A impressora não respondeu pelo túnel.', chip:'OFFLINE', conn:'down' },
    CONNECTING: { cls:'lcd-connecting', icon:null,    title:'CONSULTANDO…',         sub:'Lendo status pelo túnel corporativo.', chip:'SYNC', conn:'wait' },
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
    return `<div class="lcd-footer"><span class="lcd-chip">${chip}</span><span>${current ? current.ip : ''} · ${time}</span></div>`;
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
    const off = [null, false];
    const map = {
        READY:      { status:['green',false], pause:off, data:off, supplies:off, network:['green',false] },
        PAUSED:     { status:['green',false], pause:['amber',false], data:off, supplies:off, network:['green',false] },
        RIBBON_OUT: { status:['red',true], pause:['amber',false], data:off, supplies:['red',false], network:['green',false] },
        MEDIA_OUT:  { status:['red',true], pause:['amber',false], data:off, supplies:['red',false], network:['green',false] },
        HEAD_OPEN:  { status:['red',true], pause:['amber',false], data:off, supplies:off, network:['green',false] },
        ERROR:      { status:['red',true], pause:off, data:off, supplies:off, network:['green',false] },
        ONLINE:     { status:['green',false], pause:off, data:off, supplies:off, network:['green',false] },
        UNKNOWN:    { status:['amber',true], pause:off, data:off, supplies:off, network:['green',false] },
        OFFLINE:    { status:off, pause:off, data:off, supplies:off, network:['red',true] },
        CONNECTING: { status:off, pause:off, data:['green',true], supplies:off, network:['amber',true] },
        BOOT:       { status:['amber',true], pause:off, data:['green',true], supplies:off, network:off },
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

function renderGuide(state) {
    const guide = $('zp-guide');
    const g = GUIDES[state];
    if (!g) { guide.classList.add('hidden'); return; }
    $('guide-title').textContent = g.title;
    $('guide-anim').innerHTML = g.anim;
    $('guide-steps').innerHTML = g.steps.map(s => `<li>${s}</li>`).join('');
    guide.classList.remove('hidden');
    guide.classList.add('is-error', 'open');   // já aparece aberto no erro
    $('guide-toggle').textContent = 'ocultar ▴';
}

function renderState(state, detail) {
    lastState = state;
    const meta = STATE_META[state] || STATE_META.UNKNOWN;
    const lcd = $('zt-lcd');
    if (!lcd) return;

    const useDetail = detail && ['UNKNOWN','OFFLINE','ERROR','ONLINE'].includes(state);
    const sub = useDetail ? detail : meta.sub;
    const flags = { net: state !== 'OFFLINE', ribbon: state !== 'RIBBON_OUT', label: state !== 'MEDIA_OUT' };

    lcd.className = 'zt-lcd ' + meta.cls;
    const bodyIcon = state === 'CONNECTING' ? '<div class="lcd-spinner"></div>'
                   : state === 'HEAD_OPEN'  ? LCD_HEADOPEN
                   : (ICON[meta.icon] || '');
    lcd.innerHTML = lcdStatusbar(flags) + lcdBody(bodyIcon, meta.title, sub) + lcdFooter(meta.chip);

    applyLeds(state);
    applyConn(meta.conn, { ok:'Online via túnel corporativo', down: detail || 'Sem resposta da impressora', wait:'Consultando status…' }[meta.conn]);
    renderGuide(state);

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
    $('zp-guide').classList.add('hidden');
}

function renderReconnecting(attempt, maxAttempts) {
    const lcd = $('zt-lcd');
    if (!lcd) return;
    lcd.className = 'zt-lcd lcd-connecting';
    lcd.innerHTML = lcdStatusbar({}) + lcdBody('<div class="lcd-spinner"></div>', 'RECONECTANDO…',
        `Restabelecendo comunicação (tentativa ${attempt}/${maxAttempts})`) + lcdFooter('SYNC');
    applyLeds('CONNECTING');
    applyConn('wait', `Reconectando… (${attempt}/${maxAttempts})`);
}

/* ------------------------------------------------------------------
   Telemetria
------------------------------------------------------------------ */
async function refreshStatus() {
    if (!current || busy || fetching) return;
    fetching = true;
    setLed('led-data', 'green', true);
    const mySession = session;
    const res = await fetchPrinterStatus(current.ip, getApi());
    fetching = false;
    if (mySession !== session || busy || !current) return;
    renderState(res.state, res.detail);
}
function startPolling() { stopPolling(); pollTimer = setInterval(refreshStatus, POLL_MS); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

/* ------------------------------------------------------------------
   Contador de impressão
------------------------------------------------------------------ */
function formatUptime(s) {
    if (!s) return null;
    return String(s)
        .replace(/\s*days?\s*/i, 'd ')
        .replace(/\s*hours?\s*/i, 'h ')
        .replace(/\s*mins?\s*/i, 'min ')
        .replace(/\s*secs?\s*/i, 's')
        .replace(/\s+/g, ' ')
        .trim();
}

function renderCounter(res) {
    const valEl = $('counter-value');
    const upEl = $('counter-uptime');
    const updEl = $('counter-updated');
    const card = $('zp-counter');
    if (!valEl) return;

    const liveEl = $('counter-live');
    if (res && res.jobs !== null && res.jobs !== undefined) {
        const num = Number(res.jobs).toLocaleString('pt-BR');
        if (valEl.textContent !== num) {
            valEl.textContent = num;
            card.classList.remove('bump'); void card.offsetWidth; card.classList.add('bump'); // anima a troca
        }
        upEl.textContent = formatUptime(res.uptime) || '—';
        updEl.textContent = new Date().toLocaleTimeString('pt-BR');
        card.classList.remove('counter-off');
        if (liveEl) liveEl.textContent = '● ao vivo';
        lastJobs = res.jobs;
    } else {
        valEl.textContent = '—';
        upEl.textContent = '—';
        updEl.textContent = res && res.error ? 'sem conexão' : 'indisponível';
        card.classList.add('counter-off');
        if (liveEl) liveEl.textContent = res && res.error ? '○ sem conexão' : '○ indisponível';
    }
}

async function refreshCounter() {
    if (!current || counterFetching) return;
    counterFetching = true;
    const mySession = session;
    const res = await fetchCounter(current.ip, getApi(), counterPath);
    counterFetching = false;
    if (mySession !== session || !current) return;
    if (res.foundPath) counterPath = res.foundPath; // memoriza o caminho certo p/ os próximos
    renderCounter(res);
    // dispositivo sem contador (não é erro de rede): para de sondar para não pesar
    // (ainda atualiza ao enviar um comando, que chama refreshCounter direto)
    if ((res.jobs === null || res.jobs === undefined) && !res.error) stopCounterPoll();
}
function startCounterPoll() { stopCounterPoll(); counterTimer = setInterval(refreshCounter, COUNTER_MS); }
function stopCounterPoll() { if (counterTimer) { clearInterval(counterTimer); counterTimer = null; } }

/* ------------------------------------------------------------------
   Ações
------------------------------------------------------------------ */
async function keyAction(cmd, label, refreshDelay = 1500) {
    if (!current || busy) return;
    const mySession = session;
    const ok = await sendCommand(cmd, label, current.ip, getApi());
    if (ok && mySession === session && current) {
        setTimeout(() => { if (mySession === session) { refreshStatus(); refreshCounter(); } }, refreshDelay);
    }
}

async function restartSequence() {
    if (!current || busy) return;
    busy = true; stopPolling();
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

    await sleep(BOOT_MS);
    if (mySession !== session) return;

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
    renderState('OFFLINE', 'A impressora não voltou após o reinício — aguarde e atualize o status.');
    startPolling();
}

function setupRestartHold() {
    const btn = $('key-restart');
    if (!btn) return;
    let timer = 0, holdStart = 0, firing = false;
    const reset = () => { if (timer) clearInterval(timer); timer = 0; holdStart = 0; btn.classList.remove('holding'); btn.style.setProperty('--hold', 0); };
    const step = () => {
        const p = Math.min((performance.now() - holdStart) / HOLD_MS, 1);
        btn.style.setProperty('--hold', p);
        if (p >= 1) { reset(); if (!firing) { firing = true; restartSequence().finally(() => { firing = false; }); } }
    };
    btn.addEventListener('pointerdown', (e) => {
        if (busy || !current) return;
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        btn.classList.add('holding'); holdStart = performance.now(); step(); timer = setInterval(step, 16);
    });
    btn.addEventListener('pointerup', reset);
    btn.addEventListener('pointercancel', reset);
    btn.addEventListener('lostpointercapture', reset);
}

/* ------------------------------------------------------------------
   Ações avançadas (enviar comando ZPL com resposta)
------------------------------------------------------------------ */
async function sendAdvancedCommand() {
    if (!current) return;
    const ta = $('adv-cmd');
    const cmd = ta.value.trim();
    if (!cmd) { showToast('Digite um comando.'); return; }
    const reply = $('adv-reply');
    reply.classList.remove('hidden');
    reply.textContent = '> enviando…';
    const res = await sendCommandWithReply(cmd, 'Comando', current.ip, getApi());
    if (res.ok) {
        reply.textContent = res.reply && res.reply.trim()
            ? '↩ ' + res.reply.trim()
            : '✓ Enviado (sem resposta do equipamento).';
        setTimeout(() => { refreshStatus(); refreshCounter(); }, 1200);
    } else {
        reply.textContent = '✗ ' + (res.error || 'Falha no envio.');
    }
}

/* ------------------------------------------------------------------
   Abertura / fechamento
------------------------------------------------------------------ */
export function openZebraPanel(printer, apiGetter, opts = {}) {
    current = printer;
    getApi = apiGetter;
    handlers = opts;
    session++; busy = false; fetching = false;

    $('zp-name').textContent = printer.name;
    $('zp-department').textContent = printer.department || '—';
    $('zp-selb').textContent = printer.selb || '—';
    $('zp-ip').textContent = printer.ip || '—';
    $('zp-observations').textContent = printer.observations || 'Nenhuma.';
    $('adv-reply').classList.add('hidden');
    $('adv-reply').textContent = '';
    $('adv-cmd').value = '';
    $('zebra-modal').classList.remove('hidden');

    // reseta o contador
    counterPath = '';
    lastJobs = null;
    renderCounter(null);
    $('counter-updated').textContent = 'consultando…';

    renderState('CONNECTING');
    refreshStatus();
    startPolling();
    refreshCounter();
    startCounterPoll();
}

export function closeZebraPanel() {
    session++; stopPolling(); stopCounterPoll();
    current = null; busy = false; fetching = false;
    const modal = $('zebra-modal');
    if (modal) modal.classList.add('hidden');
}

export function getCurrentPrinter() { return current; }

/* ------------------------------------------------------------------
   Init
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
    $('zp-open-web').addEventListener('click', () => {
        if (!current) return;
        const wp = current.webPath ? (current.webPath[0] === '/' ? current.webPath : '/' + current.webPath) : '';
        openBrowserWindow(current.ip + wp, getApi());
    });

    // editar / excluir
    $('zp-edit').addEventListener('click', () => { if (current && handlers.onEdit) handlers.onEdit(current); });
    $('zp-delete').addEventListener('click', () => { if (current && handlers.onDelete) handlers.onDelete(current); });

    // guia colapsável
    document.getElementById('guide-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        const g = $('zp-guide');
        g.classList.toggle('open');
        $('guide-toggle').textContent = g.classList.contains('open') ? 'ocultar ▴' : 'ver ▾';
    });

    // ações avançadas
    $('adv-toggle').addEventListener('click', () => $('adv-toggle').parentElement.classList.toggle('open'));
    $('adv-zt421').addEventListener('click', () => {
        if (confirm('Enviar configuração ZT421 para a impressora?'))
            keyAction(`\x10CT~~CD,~CC^~CT~^XA~TA000~JSN^LT0^MNW^MTT^PON^PMN^LH0,0^JMA^PR3,3~SD20^JUS^LRN^CI0^XZ`, 'Config ZT421');
    });
    $('adv-factory').addEventListener('click', () => {
        if (confirm('Restaurar padrões de fábrica?\n\nATENÇÃO: pode apagar a configuração de rede e desconectar a impressora do túnel, exigindo intervenção física no local.'))
            keyAction('^XA^JUF^XZ', 'Restaurar Fábrica', 3000);
    });
    $('adv-send').addEventListener('click', sendAdvancedCommand);
    document.querySelectorAll('.chip-cmd').forEach(chip => {
        chip.addEventListener('click', () => { $('adv-cmd').value = chip.dataset.cmd; });
    });

    setupRestartHold();

    window.zebraDemo = (state, detail) => {
        if (modal.classList.contains('hidden')) { console.warn('Abra uma impressora primeiro.'); return; }
        stopPolling();
        if (state === 'BOOT') { renderBootScreen(); return; }
        renderState(state, detail || '');
    };
}

init();
