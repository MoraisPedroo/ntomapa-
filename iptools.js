import { sendCommand } from './printer_logic.js';
import { showToast, logPanel } from './helpers.js';

/*
 * DP IP-Tools — configuração de rede, etiqueta de identificação e
 * broadcast (varredura da rede) integrados ao proxy do MapaNto.
 *   - Configurar IP / Etiqueta: geram ZPL e enviam via { ip, cmd } (proxy).
 *   - Buscar rede: POST { action:'scan_network', base_ip } (proxy v5+).
 */

let getApi = () => '';
let onUse = null;          // callback(ip) — abre o painel virtual
let scanResults = [];

const $ = (id) => document.getElementById(id);

/* ---------------- ZPL ---------------- */
function escapeZpl(v) { return String(v || '').replaceAll('^', '^^').replaceAll('~', '~}'); }

function generateConfigZpl(ip, netmask, gateway) {
    return `^XA\n^ND2,P,${ip},${netmask},${gateway}\n^NBC\n^NC1\n^NPP\n^XZ\n^XA\n^JUS\n^XZ`;
}

// template da etiqueta (com gráficos) extraído do DP IP-Tools, em base64
const LABEL_TPL_B64 = "XlhBCl5QVzQwMApeTEwyNDAKXkxTMApeRk8zMjAsMF5HRkEsMDA3NjgsMDA3NjgsMDAwMDgsOlo2NDplSnpka2JFTkFqRU1SWk5ENktSSWxGRldRRGNGaUFWb2pDaEF3QVlVQjI2UUNGY3l4WWtxOGhTTVFFRktkc0gybldBQ0d0eDhQZjM4eEhhTStmdGF3MTJWcUJVWklKNUVIUkdKZWdBUXJaZ2pLM0p0OWJnR2JJYThmaGhUM01nMWllTzdPdGlhT1NZWG1ZZVQ1ekF1K0xvNGRwRXZESk02VEpHNXJWekQ3RmVIL0FKNTdxb1BCTnpnR1NOelN3MnpoemxZOVZ0bjFOOEhpMS8yZWVWdEZrNnVVQitQcUhsS3BIa3A1VVlHWXIrY2FUNFYwczhJdUQvbzhzSWwxdUVpL1ZQWHZ3WHcwK1YzM3MvOFZjOGVNc1IrWDZJbCsvMCtreXJBM0hRTC9lVXYvcWplMnM1bitRPT06OTI5MQpeRk8zMjAsNjReR0ZBLDAxMjgwLDAxMjgwLDAwMDA4LDpaNjQ6ZUp6TmtyOU93bEFVeGcrNTFHc2dhUjFnb2lITWhvUzFFUU00dUhlNDNYMEM0OGhnWXAxNERXWUc1NFlteElUQjEyQjBLb3dkQ0xVOTN5bFlFaGNYUGN1dlgrODlmL3FkRXYzenVGNHNkTFluYWdlR09ZeVhGVDNPRGt4cTFja3VFcndHV09xK1hkV25jK1NOdW1BYjlhZ1RnWmJCQVBvVHJFMFlYdjZHK3d0SEc5RUdiTWFodHQzOGV1QXoxVGFCdmpQUTRSSjYwb0plSHpRVit0NHdWUnd4clFEOUJnbmF0MzNVSDRaZ1MvcjNoRVVVOWM0NTJDWTBjdGt2T3Jqc244cWV4YjgwOTNmMXBqOVMrREhic1Q4WHRRMzhJdkdQdzBDcnFNSDlMTk1TLzFmNC9udER0WnczellpY1lqN0xwNWU4WGs5dGRDWk83b1FiNFVHY3pVSThqRk9lanhUMlM3VG4rU3Y3OWk3Ui80cnFzZy9NZDlMSGMyYWZ1dUlYNXUyUXg3NjNKOWlIazZWTXE5eFhQR2RTUUZwOFBKS3E1QmdsQ1lYdlBGL3RkUWQvMXlubW5hV1lYK08rNDRCMlNhbHJkMjlSMTUyQyt5bm5xL1NKODlYdUFYNFV2aFgreUVLRXBZcysySnpMRHlQSGozSXMxMVVFV2hQeFhMeG52Ny9WTDNYeC8vd216dk4vcXYvSDhRWEFqcXpnOjZFQjEKXkZPMzE5LDExXkdCMCwyMTAsOF5GUwpeRk8xODIsOF5HQjE5NSwxMiw2XkZTCl5GVDMwNCw1M15BMEksNTEsNTBeRkheRkR7e0lQfX1eRlMKXkZUMjc0LDE1MF5BMEksNTEsNTBeRkheRkR7e0NPREV9fV5GUwpeTFJZXkZPOSwxMzleR0IzMDgsMCw3MF5GU15MUk4KXkZUNDAsMjA1XkEwTiwyMiwyMl5GSF5GRHt7SVB9fV5GUwpeUFExLDAsMSxZCl5YWg==";

function generateLabelZpl(code, ip) {
    let tpl;
    try { tpl = atob(LABEL_TPL_B64); } catch (_) { tpl = ''; }
    return tpl
        .replaceAll('{{CODE}}', escapeZpl(String(code || '').toUpperCase()))
        .replaceAll('{{IP}}', escapeZpl(ip || '?.?.?.?'));
}

function isValidIp(v) {
    const p = String(v || '').trim().split('.');
    return p.length === 4 && p.every(x => /^\d{1,3}$/.test(x) && Number(x) >= 0 && Number(x) <= 255);
}

/* ---------------- Broadcast (scan) ---------------- */
export async function scanNetwork(baseIp) {
    const res = await fetch(getApi(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan_network', base_ip: baseIp })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.message || json.error || `HTTP ${res.status}`);
    const raw = Array.isArray(json.data) ? json.data : (json.data?.printers || json.printers || []);
    return raw.map(p => ({
        ip: String(p.ip || ''),
        serial: String(p.serial || 'N/I'),
        model: String(p.model || p.modelo || 'Zebra'),
    })).filter(p => isValidIp(p.ip));
}

/* ---------------- UI ---------------- */
function setStatus(msg, type = '') {
    const el = $('ipt-status');
    if (el) { el.textContent = msg; el.className = 'ipt-status ' + type; }
}

function activateTab(name) {
    document.querySelectorAll('.ipt-tab').forEach(t => t.classList.toggle('active', t.dataset.t === name));
    document.querySelectorAll('.ipt-panel').forEach(p => { const on = p.dataset.p === name; p.classList.toggle('active', on); p.hidden = !on; });
}

function renderScanResults() {
    const box = $('ipt-scan-results');
    const filter = ($('ipt-scan-filter').value || '').toLowerCase().trim();
    const items = scanResults.filter(p => [p.ip, p.serial, p.model].some(v => v.toLowerCase().includes(filter)));
    $('ipt-scan-summary').textContent = filter
        ? `${items.length} de ${scanResults.length} resultado(s)`
        : `${scanResults.length} impressora(s) encontrada(s)`;
    box.replaceChildren();
    if (!items.length) {
        const e = document.createElement('div');
        e.className = 'ipt-empty';
        e.textContent = scanResults.length ? 'Nenhum resultado para o filtro.' : 'Nenhuma Zebra encontrada nessa faixa.';
        box.append(e);
        return;
    }
    items.forEach(p => {
        const row = document.createElement('div');
        row.className = 'ipt-row';
        row.innerHTML = `<div class="ipt-row-main"><b>${p.ip}</b><span>${p.model} · S/N ${p.serial}</span></div>`;
        const btn = document.createElement('button');
        btn.className = 'side-btn sky';
        btn.textContent = 'Usar';
        btn.addEventListener('click', () => usePrinter(p));
        row.append(btn);
        box.append(row);
    });
}

function usePrinter(p) {
    $('ipt-cfg-target').value = p.ip;
    $('ipt-cfg-newip').value = p.ip.split('.').slice(0, 3).join('.') + '.';
    $('ipt-lbl-target').value = p.ip;
    $('ipt-lbl-ip').value = p.ip;
    setStatus(`Selecionada: ${p.ip} · S/N ${p.serial}`, 'ok');
    if (onUse) onUse(p.ip);           // abre o painel virtual
}

async function doScan() {
    const base = $('ipt-scan-base').value.trim();
    if (!isValidIp(base)) { setStatus('IP da faixa inválido.', 'warn'); return; }
    const btn = $('ipt-scan-btn');
    btn.disabled = true; btn.textContent = 'Buscando…';
    setStatus(`Varredura em ${base.split('.').slice(0, 3).join('.')}.1–254 …`, 'warn');
    try {
        scanResults = await scanNetwork(base);
        renderScanResults();
        setStatus(`Busca concluída: ${scanResults.length} Zebra(s).`, scanResults.length ? 'ok' : 'warn');
        logPanel(`Broadcast: ${scanResults.length} impressora(s) na faixa de ${base}`);
    } catch (e) {
        scanResults = []; renderScanResults();
        setStatus('Falha na busca: ' + e.message, 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Buscar';
    }
}

async function doConfig() {
    const target = $('ipt-cfg-target').value.trim();
    const newIp = $('ipt-cfg-newip').value.trim();
    const mask = $('ipt-cfg-mask').value.trim();
    const gw = $('ipt-cfg-gw').value.trim();
    for (const [v, l] of [[target, 'IP atual'], [newIp, 'Novo IP'], [mask, 'Máscara'], [gw, 'Gateway']]) {
        if (!isValidIp(v)) { setStatus(`${l} inválido.`, 'warn'); return; }
    }
    if (!confirm(`Aplicar configuração PERMANENTE?\n\nDestino: ${target}\nNovo IP: ${newIp}\nMáscara: ${mask}\nGateway: ${gw}\n\nA impressora vai reiniciar e mudar de IP.`)) return;
    setStatus(`Enviando configuração para ${target}…`, 'warn');
    const ok = await sendCommand(generateConfigZpl(newIp, mask, gw), 'Config rede', target, getApi());
    if (ok) {
        await sendCommand('~JR\n', 'Reiniciar (config)', target, getApi());
        setStatus(`Configuração enviada. A impressora vai reiniciar no IP ${newIp}.`, 'ok');
        showToast('Configuração de rede enviada.');
    } else {
        setStatus('Falha ao enviar a configuração (veja o log/link da API).', 'err');
    }
}

async function doLabel() {
    const code = $('ipt-lbl-code').value.trim();
    const ip = $('ipt-lbl-ip').value.trim();
    const target = $('ipt-lbl-target').value.trim();
    if (!code) { setStatus('Digite o código/nome.', 'warn'); return; }
    if (!isValidIp(ip)) { setStatus('IP mostrado na etiqueta inválido.', 'warn'); return; }
    if (!isValidIp(target)) { setStatus('IP de envio inválido.', 'warn'); return; }
    setStatus(`Enviando etiqueta para ${target}…`, 'warn');
    const ok = await sendCommand(generateLabelZpl(code, ip), 'Etiqueta ID', target, getApi());
    if (ok) { setStatus(`Etiqueta enviada para ${target}.`, 'ok'); showToast('Etiqueta enviada para impressão.'); }
    else setStatus('Falha ao enviar a etiqueta.', 'err');
}

export function openIpToolsModal(prefillIp) {
    const ip = (prefillIp || '').trim();
    if (ip) {
        $('ipt-cfg-target').value = ip;
        $('ipt-lbl-target').value = ip;
        $('ipt-lbl-ip').value = ip;
        $('ipt-scan-base').value = ip;
    }
    $('ipt-target-ip').textContent = ip || 'nenhum';
    setStatus('Pronto.');
    $('iptools-modal').classList.remove('hidden');
}
export function closeIpToolsModal() { $('iptools-modal').classList.add('hidden'); }

export function initIpTools({ apiGetter, onUsePrinter }) {
    getApi = apiGetter || getApi;
    onUse = onUsePrinter || null;
    const modal = $('iptools-modal');
    if (!modal) return;

    $('ipt-close').addEventListener('click', closeIpToolsModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeIpToolsModal(); });
    document.querySelectorAll('.ipt-tab').forEach(t => t.addEventListener('click', () => activateTab(t.dataset.t)));
    $('ipt-scan-btn').addEventListener('click', doScan);
    $('ipt-scan-filter').addEventListener('input', renderScanResults);
    $('ipt-cfg-btn').addEventListener('click', doConfig);
    $('ipt-lbl-btn').addEventListener('click', doLabel);
}
