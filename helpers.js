export function debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(()=> fn(...args), delay); };
}

export function base64ToUtf8(b64) {
    if (!b64) return '';
    try {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (typeof TextDecoder !== 'undefined') {
            try { return new TextDecoder('utf-8').decode(bytes); } catch (e) {}
        }
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    } catch (e) { return b64; }
}

export function showToast(msg) {
    const toastEl = document.getElementById('toast-notification');
    if(!toastEl) return;
    toastEl.textContent = msg; 
    toastEl.classList.add('show'); 
    setTimeout(()=>toastEl.classList.remove('show'), 3000); 
}

export function logPanel(msg) {
    const panelLog = document.getElementById('panel-log');
    if (!panelLog) return;
    try {
        const ts = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.textContent = `[${ts}] ${msg}`;
        panelLog.prepend(entry);
        const children = panelLog.children;
        if (children.length > 50) {
            panelLog.removeChild(children[children.length - 1]);
        }
    } catch(e){ console.warn('logPanel erro', e); }
}