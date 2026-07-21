import { logPanel } from './helpers.js';
import { base64ToUtf8 } from './helpers.js';

let currentApiUrl = '';
let currentUrl = '';          // URL absoluta atual (http://ip/...)
let history = [];             // pilha de navegação
let navToken = 0;             // invalida navegações concorrentes

const windowEl   = () => document.getElementById('floating-window');
const iframe     = () => document.getElementById('interface-frame');
const titleEl    = () => document.getElementById('floating-title');
const urlInput   = () => document.getElementById('browser-url');
const loader     = () => document.getElementById('browser-loader');
const loaderText = () => document.getElementById('browser-loader-text');
const transition = () => document.getElementById('browser-transition');

/* ------------------------------------------------------------------
   Utilidades de URL
------------------------------------------------------------------ */
function normalizeTarget(input) {
    let t = (input || '').trim();
    if (!t) return '';
    if (!/^https?:\/\//i.test(t)) t = 'http://' + t;
    return t;
}
function resolveUrl(href, base) {
    try { return new URL(href, base).href; } catch (_) { return null; }
}
function proxyAsset(absUrl) {
    return `${currentApiUrl}?url=${encodeURIComponent(absUrl)}`;
}

/* ------------------------------------------------------------------
   Reescrita do HTML: assets/links/forms passam a apontar para o proxy
------------------------------------------------------------------ */
function rewriteHtml(html, baseUrl) {
    let doc;
    try {
        doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (_) {
        return `<pre style="padding:16px;font-family:monospace">${html.replace(/</g,'&lt;')}</pre>`;
    }

    // remove <base> existente para não confundir a resolução
    doc.querySelectorAll('base').forEach(b => b.remove());

    const abs = (v) => resolveUrl(v, baseUrl);

    // imagens
    doc.querySelectorAll('img[src]').forEach(img => {
        const a = abs(img.getAttribute('src'));
        if (a) img.setAttribute('src', proxyAsset(a));
        img.removeAttribute('srcset');
        img.removeAttribute('loading');
    });
    // css externo
    doc.querySelectorAll('link[rel~="stylesheet"][href], link[href$=".css"]').forEach(l => {
        const a = abs(l.getAttribute('href'));
        if (a) l.setAttribute('href', proxyAsset(a));
    });
    // ícones/favicons deixamos passar sem quebrar
    doc.querySelectorAll('link[rel*="icon"][href]').forEach(l => {
        const a = abs(l.getAttribute('href'));
        if (a) l.setAttribute('href', proxyAsset(a));
    });
    // scripts externos
    doc.querySelectorAll('script[src]').forEach(s => {
        const a = abs(s.getAttribute('src'));
        if (a) s.setAttribute('src', proxyAsset(a));
    });
    // frames / iframes (print servers antigos usam frames)
    doc.querySelectorAll('frame[src], iframe[src]').forEach(fr => {
        const a = abs(fr.getAttribute('src'));
        if (a) fr.setAttribute('src', proxyAsset(a));
    });
    // background/style inline com url(...)
    doc.querySelectorAll('[style*="url("]').forEach(el => {
        el.setAttribute('style', el.getAttribute('style').replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, u) => {
            const a = abs(u);
            return a ? `url(${proxyAsset(a)})` : m;
        }));
    });
    // <style> blocks
    doc.querySelectorAll('style').forEach(st => {
        st.textContent = st.textContent.replace(/url\((['"]?)([^'")]+)\1\)/gi, (m, q, u) => {
            if (/^data:/i.test(u)) return m;
            const a = abs(u);
            return a ? `url(${proxyAsset(a)})` : m;
        });
    });
    // âncoras -> marcamos com href absoluto para interceptar o clique
    doc.querySelectorAll('a[href]').forEach(an => {
        const raw = an.getAttribute('href');
        if (/^(javascript:|mailto:|tel:|#)/i.test(raw)) return;
        const a = abs(raw);
        if (a) { an.setAttribute('data-proxy-href', a); an.setAttribute('href', 'javascript:void(0)'); }
    });
    // formulários
    doc.querySelectorAll('form').forEach(f => {
        const act = f.getAttribute('action');
        const a = abs(act || baseUrl);
        if (a) f.setAttribute('data-proxy-action', a);
        f.setAttribute('data-proxy-method', (f.getAttribute('method') || 'GET').toUpperCase());
    });

    // interceptador injetado no documento
    const interceptor = doc.createElement('script');
    interceptor.textContent = `
        (function(){
          var lastSubmitter = null;
          document.addEventListener('click', function(e){
            var b = e.target.closest && e.target.closest('button, input[type=submit], input[type=image]');
            if (b) lastSubmitter = b;
            var a = e.target.closest && e.target.closest('a[data-proxy-href]');
            if (a){ e.preventDefault();
              parent.postMessage({ type:'PROXY_NAV', url:a.getAttribute('data-proxy-href') }, '*'); }
          }, true);
          document.addEventListener('submit', function(e){
            var f = e.target;
            if (!f || !f.getAttribute('data-proxy-action')) return;
            e.preventDefault();
            var fd = new FormData(f); var data = {};
            fd.forEach(function(v,k){
              if (typeof v !== 'string') return; // ignora arquivos (não suportado pelo túnel)
              if (data[k] === undefined) data[k] = v;
              else { if(!Array.isArray(data[k])) data[k]=[data[k]]; data[k].push(v); }
            });
            // inclui o botão que disparou o envio (name=value) — Zebras exigem isso
            var sub = e.submitter || lastSubmitter;
            if (sub && sub.name && data[sub.name] === undefined) data[sub.name] = sub.value || '';
            parent.postMessage({ type:'PROXY_FORM',
              action: f.getAttribute('data-proxy-action'),
              method: f.getAttribute('data-proxy-method') || 'GET',
              enctype: f.getAttribute('enctype') || 'application/x-www-form-urlencoded',
              data: data }, '*');
          }, true);
        })();
    `;
    doc.body && doc.body.appendChild(interceptor);

    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}

/* ------------------------------------------------------------------
   Núcleo de navegação
------------------------------------------------------------------ */
function showLoader(text) {
    loaderText().textContent = text || 'Conectando pelo túnel…';
    loader().classList.remove('hidden');
}
function hideLoader() { loader().classList.add('hidden'); }

async function renderFromResponse(payload, requestedUrl) {
    const eff = payload.effective_url || requestedUrl;
    const bodyText = payload.body_base64 ? base64ToUtf8(payload.body_base64) : (payload.raw || '');
    const ct = (payload.content_type || findHeader(payload.headers, 'content-type') || '').toLowerCase();

    currentUrl = eff;
    urlInput().value = eff;
    titleEl().textContent = 'Interface: ' + eff.replace(/^https?:\/\//,'').slice(0, 60);

    // Se não for HTML (PDF, imagem, etc.), abre o recurso direto pelo proxy
    if (ct && !ct.includes('text/html') && !ct.includes('application/xhtml')) {
        iframe().removeAttribute('srcdoc');
        iframe().src = proxyAsset(eff);
        return;
    }
    iframe().removeAttribute('src');
    iframe().srcdoc = rewriteHtml(bodyText, eff);
}

async function navigate(url, { push = true } = {}) {
    const token = ++navToken;
    const target = normalizeTarget(url);
    if (!target) return;

    if (push && currentUrl && currentUrl !== target) history.push(currentUrl);
    showLoader('Carregando ' + target.replace(/^https?:\/\//,'').slice(0, 48) + '…');

    try {
        const res = await fetch(`${currentApiUrl}?url=${encodeURIComponent(target)}&as_json=1`, { cache:'no-store' });
        const payload = await res.json();
        if (token !== navToken) return;
        if (payload.error && !payload.body_base64) throw new Error(payload.error);
        await renderFromResponse(payload, target);
        logPanel(`Navegador: abriu ${target}`);
    } catch (e) {
        if (token !== navToken) return;
        iframe().removeAttribute('src');
        iframe().srcdoc = errorPage(target, e.message);
        logPanel(`Navegador erro: ${e.message}`);
    } finally {
        if (token === navToken) hideLoader();
    }
}

async function submitForm(action, method, data) {
    const token = ++navToken;
    showLoader('Enviando formulário…');
    if (currentUrl) history.push(currentUrl);
    try {
        let payload;
        if (method === 'GET') {
            const qs = new URLSearchParams();
            Object.entries(data).forEach(([k,v]) => Array.isArray(v) ? v.forEach(x=>qs.append(k,x)) : qs.append(k,v));
            const sep = action.includes('?') ? '&' : '?';
            const url = action + sep + qs.toString();
            const res = await fetch(`${currentApiUrl}?url=${encodeURIComponent(url)}&as_json=1`, { cache:'no-store' });
            payload = await res.json();
            if (token !== navToken) return;
            await renderFromResponse(payload, url);
        } else {
            const res = await fetch(currentApiUrl, {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ url: action, method:'POST', form_data: data })
            });
            payload = await res.json();
            if (token !== navToken) return;
            await renderFromResponse(payload, action);
        }
        logPanel(`Navegador: formulário enviado (${method}) para ${action}`);
    } catch (e) {
        if (token !== navToken) return;
        iframe().srcdoc = errorPage(action, e.message);
    } finally {
        if (token === navToken) hideLoader();
    }
}

function findHeader(headers, name) {
    if (!Array.isArray(headers)) return null;
    const needle = name.toLowerCase() + ':';
    for (const h of headers) if (h.toLowerCase().startsWith(needle)) return h.slice(needle.length).trim();
    return null;
}

function errorPage(url, msg) {
    return `<!DOCTYPE html><html><body style="margin:0;font-family:system-ui,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh">
      <div style="text-align:center;max-width:420px;padding:24px">
        <div style="font-size:44px;margin-bottom:10px">🔌</div>
        <h2 style="margin:0 0 8px;font-size:18px">Não foi possível abrir a página</h2>
        <p style="color:#94a3b8;font-size:13px;line-height:1.5">${(msg||'').replace(/</g,'&lt;')}</p>
        <code style="display:block;margin-top:12px;font-size:11px;color:#38bdf8;word-break:break-all">${url.replace(/</g,'&lt;')}</code>
        <p style="color:#64748b;font-size:12px;margin-top:16px">Verifique o IP/URL e se o túnel (proxy.php) está ativo.</p>
      </div></body></html>`;
}

/* ------------------------------------------------------------------
   Transição animada impressora -> site
------------------------------------------------------------------ */
function playTransition() {
    const t = transition();
    t.classList.remove('hidden', 'zoom-out');
    // força reflow para reiniciar animação
    void t.offsetWidth;
    setTimeout(() => t.classList.add('zoom-out'), 750);
    setTimeout(() => t.classList.add('hidden'), 1200);
}

/* ------------------------------------------------------------------
   API pública
------------------------------------------------------------------ */
export function openBrowserWindow(ipOrUrl, apiBaseUrl) {
    currentApiUrl = apiBaseUrl;
    currentUrl = '';
    history = [];
    windowEl().classList.remove('hidden');
    windowEl().classList.remove('maximized');
    iframe().srcdoc = '';
    playTransition();
    // inicia navegação por trás da transição
    navigate(ipOrUrl, { push:false });
}

export function closeBrowserWindow() {
    navToken++;
    windowEl().classList.add('hidden');
    iframe().srcdoc = '';
    transition().classList.add('hidden');
}

export function reloadBrowser() {
    if (currentUrl) navigate(currentUrl, { push:false });
}

export function browserBack() {
    if (history.length) {
        const prev = history.pop();
        navigate(prev, { push:false });
    }
}

export function navigateFromBar() {
    const val = urlInput().value.trim();
    if (val) navigate(val);
}

/* ------------------------------------------------------------------
   Mensagens vindas do iframe
------------------------------------------------------------------ */
window.addEventListener('message', (event) => {
    const d = event.data || {};
    if (d.type === 'PROXY_NAV' && d.url) navigate(d.url);
    else if (d.type === 'PROXY_FORM' && d.action) submitForm(d.action, (d.method||'GET').toUpperCase(), d.data || {});
});

/* ------------------------------------------------------------------
   Arrastar / maximizar janela
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
    if (maxBtn) maxBtn.addEventListener('click', () => win.classList.toggle('maximized'));
    if (minBtn) minBtn.addEventListener('click', () => win.classList.add('hidden'));
}
