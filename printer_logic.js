import { showToast, logPanel, base64ToUtf8 } from './helpers.js';

// Rótulos amigáveis para cada estado detectado
export const STATE_LABELS = {
    READY:      'Pronta para imprimir',
    PAUSED:     'Em pausa',
    RIBBON_OUT: 'Alerta: sem ribbon',
    MEDIA_OUT:  'Alerta: sem etiqueta',
    HEAD_OPEN:  'Cabeça de impressão aberta',
    ERROR:      'Em erro',
    UNKNOWN:    'Status não identificado',
    OFFLINE:    'Sem conexão',
    CONNECTING: 'Consultando…',
};

/**
 * Interpreta o HTML/texto de status retornado pela impressora Zebra
 * e devolve um estado estruturado { state, detail }.
 */
export function parseZebraStatus(raw) {
    const text = String(raw || '');
    const plain = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .toLowerCase();

    // Extrai os <h3> (as páginas das Zebra ZT230/ZT4xx mostram o status neles)
    const h3s = [];
    text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (m, g1) => {
        const cleaned = g1.replace(/<[^>]+>/g, '').trim();
        if (cleaned) h3s.push(cleaned);
        return m;
    });
    const condition = h3s.slice(0, 4).join(' · ');

    const headOpen  = /(cab\w*\.?\s*abert|head\s*open|open\s*head)/i.test(plain);
    const ribbonOut = /((sem|falta(?:\s*de)?|out\s*of)\s*(ribbon|fita)|ribbon\s*(out|ausente|fora))/i.test(plain);
    const mediaOut  = /(falta\s*(de\s*)?papel|paper\s*out|out\s*of\s*paper|sem\s*(papel|etiqueta|m[ií]dia)|media\s*out|falta\s*etiqueta)/i.test(plain);
    const paused    = /(em\s*pausa|\bpausa\b|paused|\bpause\b)/i.test(plain);
    const ready     = /(em\s*aguardo|\baguardo\b|ready|waiting|pronta|pronto)/i.test(plain);
    const genericErr= /(erro|error|falha|fault)/i.test(plain);

    if (headOpen)  return { state: 'HEAD_OPEN',  detail: condition };
    if (ribbonOut) return { state: 'RIBBON_OUT', detail: condition };
    if (mediaOut)  return { state: 'MEDIA_OUT',  detail: condition };
    if (paused)    return { state: 'PAUSED',     detail: condition };
    if (ready)     return { state: 'READY',      detail: condition };
    if (genericErr)return { state: 'ERROR',      detail: condition || 'Condição de erro detectada.' };
    return { state: 'UNKNOWN', detail: condition || 'Não foi possível interpretar o status.' };
}

/**
 * Consulta o status da impressora através do túnel (proxy.php)
 * e devolve { state, detail, raw }.
 */
export async function fetchPrinterStatus(ip, apiBaseUrl) {
    if (!ip) return { state: 'OFFLINE', detail: 'IP inválido.' };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);

    try {
        let res = await fetch(`${apiBaseUrl}?ip=${encodeURIComponent(ip)}&as_json=1`, { cache: 'no-store', signal: controller.signal });
        if (!res.ok) {
            res = await fetch(`${apiBaseUrl}?ip=${encodeURIComponent(ip)}`, { cache: 'no-store', signal: controller.signal });
            if (!res.ok) throw new Error('Erro HTTP ' + res.status);
        }
        clearTimeout(timeoutId);

        const ct = (res.headers.get('content-type') || '').toLowerCase();
        let body;
        if (ct.includes('application/json')) {
            const payload = await res.json();
            body = payload.body_base64 ? base64ToUtf8(payload.body_base64)
                 : (payload.raw_html || payload.raw_response || JSON.stringify(payload));
        } else {
            body = await res.text();
        }

        const parsed = parseZebraStatus(body);
        return { ...parsed, raw: body };

    } catch (err) {
        clearTimeout(timeoutId);
        const isAbort = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
        if (isAbort) {
            return { state: 'OFFLINE', detail: 'A impressora não respondeu — verifique o cabo de rede.' };
        }
        return { state: 'OFFLINE', detail: 'Falha no túnel/API — confira o link do Cloudflare no painel lateral.', proxyError: true };
    }
}

/**
 * Envia um comando ZPL e solicita a resposta do equipamento (expect_reply).
 * Retorna { ok, reply, error }.
 */
export async function sendCommandWithReply(cmd, actionName, ip, apiBaseUrl) {
    if (!ip) return { ok: false, error: 'IP inválido.' };
    if (!cmd || !cmd.trim()) return { ok: false, error: 'Comando vazio.' };
    logPanel(`${actionName} (c/ resposta) -> ${ip}`);
    try {
        const res = await fetch(apiBaseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ip, cmd, expect_reply: true })
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.success) {
            logPanel(`${actionName}: ok${json.reply ? ' (resposta recebida)' : ''}.`);
            return { ok: true, reply: json.reply || '' };
        }
        return { ok: false, error: json.error || `HTTP ${res.status}` };
    } catch (err) {
        return { ok: false, error: 'Erro de conexão com a API.' };
    }
}

/**
 * Envia um comando ZPL bruto para a impressora via túnel.
 * Retorna true em caso de sucesso.
 */
export async function sendCommand(cmd, actionName, currentPrinterIp, apiBaseUrl) {
    if (!currentPrinterIp) { showToast('IP inválido!'); logPanel(`${actionName}: IP inválido`); return false; }
    if (!cmd || cmd.trim() === '') { showToast('Comando vazio!'); logPanel(`${actionName}: comando vazio`); return false; }

    logPanel(`${actionName} -> enviando para ${currentPrinterIp} ...`);
    try {
        const payload = { ip: currentPrinterIp, cmd: cmd };
        const res = await fetch(apiBaseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json().catch(() => ({}));
        if (res.ok && json.success) {
            showToast(`${actionName} enviado com sucesso!`);
            logPanel(`${actionName}: enviado com sucesso.`);
            return true;
        }
        const err = json.error || JSON.stringify(json);
        showToast(`Erro: ${err}`);
        logPanel(`${actionName}: erro -> ${err}`);
        return false;
    } catch (err) {
        showToast(`Erro de conexão com API`);
        logPanel(`${actionName}: erro de conexão (verifique o link).`);
        return false;
    }
}
