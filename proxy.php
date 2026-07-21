<?php
/* =====================================================================
 * proxy.php  —  MapaNto Universal Device Proxy v4
 * ---------------------------------------------------------------------
 * Ponte HTTP/TCP entre o site (via túnel Cloudflare) e os equipamentos
 * da rede interna. Serve QUALQUER dispositivo web (impressoras Zebra,
 * print servers TP-LINK, páginas A4, etc.) e envia comandos ZPL/EPL
 * na porta 9100.
 *
 * ---- NAVEGAÇÃO DE INTERFACE (modo render) --------------------------
 *   ?url=URL&render=1            -> devolve a página com TODOS os links,
 *                                   imagens, css, frames e formulários
 *                                   reescritos p/ passar pelo proxy.
 *                                   A página fica IDÊNTICA à original e a
 *                                   navegação interna funciona sozinha.
 *   (POST no mesmo endereço)     -> repassa o envio de formulário.
 *
 * ---- MODOS SIMPLES (GET) -------------------------------------------
 *   ?url=URL / ?ip=IP[&path=/x]  -> busca a página/recurso
 *        &as_json=1              -> { http_status, headers, body_base64, ... }
 *        (sem as_json)           -> conteúdo bruto (Content-Type preservado)
 *   ?action=ping&ip=IP           -> portas 80/9100 + latência
 *   ?action=status&ip=IP         -> STATUS normalizado (~HS + fallback web/ping)
 *   ?action=info&ip=IP           -> dados Zebra (SGD + ~HS + HTML)
 *
 * ---- MODOS (POST, corpo JSON) --------------------------------------
 *   { ip, cmd, expect_reply? }             -> ZPL/EPL para :9100
 *   { url, method, form_data, headers? }   -> formulário (com cookies)
 *   { action:'status'|'info', ip }         -> idem GET
 *
 * Cookies por host, Basic Auth via X-Printer-Auth, CORS liberado.
 * Compatível com PHP 7.1+.
 * ===================================================================== */

// nunca deixa avisos/erros do PHP vazarem para dentro das páginas/JSON
error_reporting(0);
@ini_set('display_errors', '0');

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Headers: Content-Type, X-Printer-Auth");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
// NÃO enviar X-Content-Type-Options: nosniff — quebra CSS/imagens de
// dispositivos antigos que mandam Content-Type errado.

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }

@ini_set('default_socket_timeout', 10);
@set_time_limit(60);

/* nome do próprio script, p/ montar links relativos (host/proto-agnóstico) */
function self_ref() {
    $s = $_SERVER['SCRIPT_NAME'] ?? '/proxy.php';
    $b = basename($s);
    return $b !== '' ? $b : 'proxy.php';
}

/* ---------------------------------------------------------------- utils */
function send_json($data, $status = 200) {
    header('Content-Type: application/json; charset=UTF-8');
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

function cookie_jar_for($host) {
    $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'mapanto_cookies';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $safe = preg_replace('/[^a-z0-9._-]/i', '_', (string)$host);
    return $dir . DIRECTORY_SEPARATOR . ($safe ?: 'default') . '.cookies';
}

function host_from_url($url) {
    $p = @parse_url($url);
    return $p['host'] ?? '';
}

function basic_auth_header() {
    $hdr = $_SERVER['HTTP_X_PRINTER_AUTH'] ?? '';
    if ($hdr && strpos($hdr, ':') !== false) return 'Authorization: Basic ' . base64_encode($hdr);
    return null;
}

/* Credenciais Basic Auth guardadas por host (o usuário digita uma vez no
   formulário de login e o proxy reutiliza nas próximas requisições) */
function auth_store_for($host) {
    $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'mapanto_auth';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $safe = preg_replace('/[^a-z0-9._-]/i', '_', (string)$host);
    return $dir . DIRECTORY_SEPARATOR . ($safe ?: 'default') . '.auth';
}
function get_stored_auth($host) {
    $f = auth_store_for($host);
    if (is_file($f)) { $c = @file_get_contents($f); if ($c !== false && strpos($c, ':') !== false) return $c; }
    return null;
}
function set_stored_auth($host, $userpass) { @file_put_contents(auth_store_for($host), $userpass); }
function clear_stored_auth($host) { $f = auth_store_for($host); if (is_file($f)) @unlink($f); }

/* query preservando chaves repetidas (checkbox/select múltiplos) */
function build_form_query($form) {
    if (!is_array($form)) return (string)$form;
    $pairs = [];
    foreach ($form as $k => $v) {
        if (is_array($v)) { foreach ($v as $vv) $pairs[] = urlencode($k) . '=' . urlencode((string)$vv); }
        else            { $pairs[] = urlencode($k) . '=' . urlencode((string)$v); }
    }
    return implode('&', $pairs);
}

/* Resolve uma URL relativa contra uma base (RFC 3986 simplificado) */
function resolve_url($rel, $base) {
    $rel = trim((string)$rel);
    if ($rel === '') return $base;
    if (preg_match('#^[a-z][a-z0-9+.\-]*://#i', $rel)) return $rel;      // absoluta c/ esquema
    if (substr($rel, 0, 2) === '//') {                                   // proto-relativa
        $s = parse_url($base, PHP_URL_SCHEME); if (!$s) $s = 'http';
        return $s . ':' . $rel;
    }
    if (!preg_match('~^(https?)://([^/]+)(/[^?#]*)?~i', $base, $bm)) return $rel;
    $scheme = $bm[1]; $host = $bm[2]; $bpath = isset($bm[3]) && $bm[3] !== '' ? $bm[3] : '/';

    if ($rel[0] === '#') return preg_replace('/#.*$/', '', $base) . $rel;
    if ($rel[0] === '?') return preg_replace('/[?#].*$/', '', $base) . $rel;

    $relPath = $rel; $suffix = '';
    if (preg_match('/[?#]/', $rel, $mm, PREG_OFFSET_CAPTURE)) {
        $qi = $mm[0][1]; $suffix = substr($rel, $qi); $relPath = substr($rel, 0, $qi);
    }
    if ($relPath === '') $path = preg_replace('/[?#].*$/', '', $bpath);
    elseif ($relPath[0] === '/') $path = $relPath;
    else { $dir = preg_replace('#/[^/]*$#', '/', $bpath); if ($dir === '') $dir = '/'; $path = $dir . $relPath; }

    $segs = explode('/', ltrim($path, '/'));
    $out = [];
    foreach ($segs as $s) {
        if ($s === '.' || $s === '') continue;
        if ($s === '..') { array_pop($out); continue; }
        $out[] = $s;
    }
    $norm = '/' . implode('/', $out);
    if (substr($path, -1) === '/' && $norm !== '/' && substr($norm, -1) !== '/') $norm .= '/';
    return $scheme . '://' . $host . $norm . $suffix;
}

/* ------------------------------------------------------- HTTP via cURL */
function http_request($url, $method = 'GET', $postFields = null, $extraHeaders = []) {
    if (!preg_match('#^https?://#i', $url)) $url = 'http://' . $url;
    $host = host_from_url($url);
    $jar  = cookie_jar_for($host);

    $ch = curl_init();
    $headers = [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) MapaNtoProxy/4.0',
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,*/*;q=0.8',
        'Accept-Language: pt-BR,pt;q=0.9,en;q=0.8',
        'Connection: close',
    ];
    if ($b = basic_auth_header()) $headers[] = $b;
    else { $sa = get_stored_auth($host); if ($sa) $headers[] = 'Authorization: Basic ' . base64_encode($sa); }
    foreach ((array)$extraHeaders as $h) if (is_string($h) && $h !== '') $headers[] = $h;

    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 8,
        CURLOPT_TIMEOUT        => 18,
        CURLOPT_CONNECTTIMEOUT => 7,
        CURLOPT_COOKIEJAR      => $jar,
        CURLOPT_COOKIEFILE     => $jar,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_ENCODING       => '',
    ]);

    $m = strtoupper($method);
    if ($m === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, is_array($postFields) ? build_form_query($postFields) : (string)$postFields);
    } elseif ($m !== 'GET') {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $m);
        if ($postFields !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, is_array($postFields) ? build_form_query($postFields) : (string)$postFields);
    }

    $raw    = curl_exec($ch);
    $errno  = curl_errno($ch);
    $errstr = curl_error($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hsize  = (int)curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $effUrl = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    $ctype  = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $totalT = curl_getinfo($ch, CURLINFO_TOTAL_TIME);
    curl_close($ch);

    if ($raw === false) {
        return ['error' => "cURL($errno): $errstr", 'status' => 0, 'headers' => [], 'body' => '', 'effective_url' => $url, 'content_type' => '', 'time' => $totalT];
    }

    $headerBlob = substr($raw, 0, $hsize);
    $body       = substr($raw, $hsize);
    $blocks     = preg_split("/\r\n\r\n/", trim($headerBlob));
    $lastBlock  = (is_array($blocks) && count($blocks)) ? end($blocks) : $headerBlob;
    $headers = [];
    foreach (preg_split("/\r?\n/", trim($lastBlock)) as $line) {
        if ($line === '' || stripos($line, 'HTTP/') === 0) continue;
        $headers[] = $line;
    }

    return ['error' => null, 'status' => $status, 'headers' => $headers, 'body' => $body,
            'effective_url' => $effUrl ?: $url, 'content_type' => $ctype ?: '', 'time' => $totalT];
}

function find_header($headers, $name) {
    $needle = strtolower($name) . ':';
    $found = null;
    foreach ((array)$headers as $h) if (stripos($h, $needle) === 0) $found = trim(substr($h, strlen($needle)));
    return $found;
}

/* Deduz o Content-Type pela extensão da URL — dispositivos antigos costumam
   mandar o tipo errado, o que faz o navegador ignorar CSS/imagens. */
function guess_content_type($url, $deviceCt) {
    $path = parse_url($url, PHP_URL_PATH);
    $ext = strtolower(pathinfo($path ? $path : '', PATHINFO_EXTENSION));
    $map = [
        'css' => 'text/css', 'js' => 'application/javascript', 'json' => 'application/json',
        'gif' => 'image/gif', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
        'bmp' => 'image/bmp', 'ico' => 'image/x-icon', 'svg' => 'image/svg+xml', 'webp' => 'image/webp',
        'html' => 'text/html', 'htm' => 'text/html', 'txt' => 'text/plain', 'pdf' => 'application/pdf',
        'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf', 'eot' => 'application/vnd.ms-fontobject',
    ];
    if (isset($map[$ext])) return $map[$ext];
    return $deviceCt ?: 'application/octet-stream';
}

/* ================================================================
 *  REESCRITA HTML/CSS (modo render) — deixa a página idêntica
 * ================================================================ */
function proxy_doc_url($abs)   { return self_ref() . '?url=' . rawurlencode($abs) . '&amp;render=1'; }
function proxy_asset_url($abs) { return self_ref() . '?url=' . rawurlencode($abs); }

function rewrite_css_urls($css, $base) {
    $css = preg_replace_callback('#url\(\s*(["\']?)([^"\')]+)\1\s*\)#i', function ($m) use ($base) {
        $u = trim($m[2]);
        if ($u === '' || preg_match('#^(data:|about:)#i', $u)) return $m[0];
        return 'url(' . proxy_asset_url(resolve_url($u, $base)) . ')';
    }, $css);
    $css = preg_replace_callback('#@import\s+(["\'])([^"\']+)\1#i', function ($m) use ($base) {
        return '@import "' . proxy_asset_url(resolve_url($m[2], $base)) . '"';
    }, $css);
    return $css;
}

function _rewrite_attr($attrs, $name, $mode, $base) {
    $re = '#(\s' . $name . '\s*=\s*)("([^"]*)"|\'([^\']*)\'|([^\s>]+))#i';
    return preg_replace_callback($re, function ($a) use ($mode, $base) {
        $val = (($a[3] ?? '') !== '') ? $a[3] : ((($a[4] ?? '') !== '') ? $a[4] : ($a[5] ?? ''));
        $v = trim($val);
        if ($v === '' || preg_match('~^(javascript:|mailto:|tel:|data:|about:|#)~i', $v)) return $a[0];
        $abs = resolve_url($v, $base);
        $new = ($mode === 'doc') ? proxy_doc_url($abs) : proxy_asset_url($abs);
        return $a[1] . '"' . $new . '"';
    }, $attrs);
}

function rewrite_html($html, $base) {
    $store = [];
    $stash = function ($s) use (&$store) { $k = "\x01P" . count($store) . "\x01"; $store[$k] = $s; return $k; };

    // protege comentários
    $html = preg_replace_callback('#<!--.*?-->#s', function ($m) use ($stash) { return $stash($m[0]); }, $html);
    // <script>: reescreve só o src externo; protege o conteúdo interno
    $html = preg_replace_callback('#<script\b([^>]*)>(.*?)</script>#is', function ($m) use ($stash, $base) {
        $attrs = _rewrite_attr($m[1], 'src', 'asset', $base);
        return $stash('<script' . $attrs . '>' . $m[2] . '</script>');
    }, $html);
    // <style>: reescreve url()/@import
    $html = preg_replace_callback('#(<style\b[^>]*>)(.*?)(</style>)#is', function ($m) use ($stash, $base) {
        return $stash($m[1] . rewrite_css_urls($m[2], $base) . $m[3]);
    }, $html);
    // remove <base>
    $html = preg_replace('#<base\b[^>]*>#i', '', $html);

    // reescreve as tags de abertura restantes
    $html = preg_replace_callback('#<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*)>#s', function ($m) use ($base) {
        $tag = strtolower($m[1]); $attrs = $m[2];

        // Formulários: enviamos o destino como campos escondidos porque forms
        // GET descartam a query string do action (senão o proxy recebia a
        // requisição sem 'url' e reclamava de parâmetro obrigatório).
        if ($tag === 'form') {
            $action = '';
            if (preg_match('~\saction\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s>]+))~i', $attrs, $am)) {
                $action = (($am[2] ?? '') !== '') ? $am[2] : ((($am[3] ?? '') !== '') ? $am[3] : ($am[4] ?? ''));
            }
            $abs = resolve_url($action !== '' ? $action : $base, $base);
            $abs = preg_replace('/[?#].*$/', '', $abs);
            $method = preg_match('~\smethod\s*=\s*["\']?\s*post~i', $attrs) ? 'post' : 'get';
            $attrs = preg_replace('~\s(action|method)\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)~i', '', $attrs);
            $hidden = '<input type="hidden" name="__mp_url" value="' . htmlspecialchars($abs) . '">'
                    . '<input type="hidden" name="__mp_render" value="1">';
            return '<form' . $attrs . ' action="' . self_ref() . '" method="' . $method . '">' . $hidden;
        }

        $doc   = ['a' => 'href', 'area' => 'href', 'frame' => 'src', 'iframe' => 'src'];
        $asset = ['img' => 'src', 'link' => 'href', 'embed' => 'src', 'source' => 'src', 'audio' => 'src', 'video' => 'src', 'track' => 'src'];
        if (isset($doc[$tag]))   $attrs = _rewrite_attr($attrs, $doc[$tag], 'doc', $base);
        if (isset($asset[$tag])) $attrs = _rewrite_attr($attrs, $asset[$tag], 'asset', $base);
        if ($tag === 'input' && preg_match('#type\s*=\s*["\']?\s*image#i', $attrs)) $attrs = _rewrite_attr($attrs, 'src', 'asset', $base);
        if (preg_match('#\sbackground\s*=#i', $attrs)) $attrs = _rewrite_attr($attrs, 'background', 'asset', $base);
        $attrs = preg_replace('#\ssrcset\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)#i', '', $attrs);
        if (stripos($attrs, 'url(') !== false) {
            $attrs = preg_replace_callback('#(style\s*=\s*)"([^"]*)"#i', function ($s) use ($base) {
                return $s[1] . '"' . str_replace('"', '&quot;', rewrite_css_urls($s[2], $base)) . '"';
            }, $attrs);
        }
        return '<' . $m[1] . $attrs . '>';
    }, $html);

    // restaura blocos protegidos
    if (!empty($store)) $html = strtr($html, $store);

    // injeta reporter de URL p/ a barra de endereço do app
    $inject = '<script>(function(){try{parent.postMessage({type:"PROXY_URL",url:' . json_encode($base) . '},"*");}catch(e){}})();</script>';
    if (stripos($html, '</body>') !== false) $html = preg_replace('#</body>#i', $inject . '</body>', $html, 1);
    else $html .= $inject;

    return $html;
}

function render_error_page($url, $msg) {
    $u = htmlspecialchars($url); $m = htmlspecialchars((string)$msg);
    return "<!DOCTYPE html><html><body style='margin:0;font-family:system-ui,sans-serif;background:#0b1220;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh'>"
         . "<div style='text-align:center;max-width:420px;padding:24px'><div style='font-size:44px'>🔌</div>"
         . "<h2 style='margin:8px 0'>Não foi possível abrir a página</h2>"
         . "<p style='color:#94a3b8;font-size:13px'>$m</p>"
         . "<code style='display:block;margin-top:10px;font-size:11px;color:#38bdf8;word-break:break-all'>$u</code></div></body></html>";
}

function render_login_page($url, $wwwAuth) {
    $host = host_from_url($url);
    $self = self_ref();
    $action = htmlspecialchars($self . '?authfor=' . rawurlencode($host) . '&next=' . rawurlencode($url));
    $realm = '';
    if ($wwwAuth && preg_match('~realm="?([^"]+)"?~i', $wwwAuth, $m)) $realm = ' — ' . htmlspecialchars(trim($m[1], '" '));
    $h = htmlspecialchars($host);
    return "<!DOCTYPE html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
      . "<style>body{margin:0;font-family:system-ui,'Segoe UI',sans-serif;background:#eef2f7;display:flex;align-items:center;justify-content:center;min-height:100vh}"
      . ".c{background:#fff;border:1px solid #d7dee8;border-radius:14px;padding:26px 24px;width:min(360px,92vw);box-shadow:0 20px 50px -25px rgba(15,23,42,.4)}"
      . "h2{margin:6px 0 4px;font-size:18px;color:#1e293b}p{margin:0 0 14px;font-size:12.5px;color:#64748b}"
      . "label{display:block;font-size:12px;color:#475569;margin:10px 0 4px;font-weight:600}"
      . "input{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px}"
      . "button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:#0284c7;color:#fff;font-weight:600;font-size:14px;cursor:pointer}"
      . ".lock{font-size:30px;text-align:center}</style></head>"
      . "<body><form class='c' method='post' action='$action'>"
      . "<div class='lock'>🔒</div><h2>Autenticação necessária</h2>"
      . "<p>O dispositivo <b>$h</b>$realm exige usuário e senha.</p>"
      . "<label>Usuário</label><input name='u' autofocus autocomplete='username'>"
      . "<label>Senha</label><input name='p' type='password' autocomplete='current-password'>"
      . "<button type='submit'>Entrar</button></form></body></html>";
}

/* Emite a resposta no modo render (rewrite se HTML/CSS; cru caso contrário) */
function output_render($res) {
    if (!$res['error'] && (int)$res['status'] === 401) {
        header('Content-Type: text/html; charset=UTF-8');
        echo render_login_page($res['effective_url'], find_header($res['headers'], 'WWW-Authenticate'));
        exit;
    }
    if ($res['error']) {
        http_response_code(502);
        header('Content-Type: text/html; charset=UTF-8');
        echo render_error_page($res['effective_url'], $res['error']);
        exit;
    }
    $ct = $res['content_type'] ?: (find_header($res['headers'], 'Content-Type') ?: '');
    $guess = guess_content_type($res['effective_url'], $ct);
    http_response_code($res['status'] ?: 200);

    // HTML? (pelo tipo do dispositivo, vazio, ou deduzido pela extensão .htm/.html)
    if ($ct === '' || stripos($ct, 'text/html') !== false || stripos($ct, 'application/xhtml') !== false || stripos($guess, 'text/html') !== false) {
        header('Content-Type: ' . ($ct && stripos($ct, 'text/html') !== false ? $ct : 'text/html; charset=UTF-8'));
        echo rewrite_html($res['body'], $res['effective_url']);
        exit;
    }
    // CSS? (força text/css mesmo se o dispositivo mandou o tipo errado)
    if (stripos($guess, 'text/css') !== false) {
        header('Content-Type: text/css');
        echo rewrite_css_urls($res['body'], $res['effective_url']);
        exit;
    }
    // demais (imagens/js/fontes): usa o tipo deduzido pela extensão
    header('Content-Type: ' . $guess);
    echo $res['body'];
    exit;
}

/* ------------------------------------------------------- TCP raw (9100) */
function tcp_open($ip, $port, $timeout = 3) {
    $fp = @stream_socket_client("tcp://{$ip}:{$port}", $errno, $errstr, $timeout);
    if ($fp) { @fclose($fp); return true; }
    return false;
}

function send_raw_tcp($ip, $cmd, $timeout = 5, $wantReply = false, $replyWindow = 1.6) {
    $host = $ip; $port = 9100;
    if (strpos($ip, ':') !== false) {
        [$host, $maybePort] = explode(':', $ip, 2);
        if (is_numeric($maybePort)) $port = (int)$maybePort;
    }
    $errno = 0; $errstr = '';
    $fp = @stream_socket_client("tcp://{$host}:{$port}", $errno, $errstr, $timeout);
    if (!$fp) return ['ok' => false, 'error' => "Falha ao conectar {$host}:{$port} - $errstr", 'errno' => $errno, 'reply' => ''];
    stream_set_timeout($fp, $timeout);
    $written = @fwrite($fp, $cmd);
    @fflush($fp);
    $reply = '';
    if ($wantReply) {
        $deadline = microtime(true) + $replyWindow;
        stream_set_blocking($fp, false);
        while (microtime(true) < $deadline) {
            $chunk = @fread($fp, 4096);
            if ($chunk === false) break;
            if ($chunk === '') { usleep(60000); continue; }
            $reply .= $chunk;
            if (strlen($reply) > 16384) break;
        }
    }
    @fclose($fp);
    return ['ok' => ($written !== false && $written > 0), 'bytes' => $written, 'reply' => $reply];
}

/* ------------------------------------------------- Parsing do ~HS Zebra */
function parse_hs($raw) {
    $flags = ['paperOut' => false, 'pause' => false, 'bufferFull' => false, 'corruptRam' => false,
              'tempUnder' => false, 'tempOver' => false, 'headOpen' => false, 'ribbonOut' => false, 'thermalTransfer' => false];
    $clean = str_replace(["\x02", "\x03"], '', (string)$raw);
    $lines = array_values(array_filter(array_map('trim', preg_split("/\r\n|\r|\n/", $clean)), function ($l) { return $l !== ''; }));
    if (count($lines) < 2) return ['state' => null, 'flags' => $flags, 'lines' => count($lines)];

    $s1 = explode(',', $lines[0]);
    $s2 = explode(',', $lines[1]);
    $g  = function ($a, $i) { return isset($a[$i]) ? trim($a[$i]) : ''; };

    $flags['paperOut']        = $g($s1, 1) === '1';
    $flags['pause']           = $g($s1, 2) === '1';
    $flags['bufferFull']      = $g($s1, 5) === '1';
    $flags['corruptRam']      = $g($s1, 9) === '1';
    $flags['tempUnder']       = $g($s1, 10) === '1';
    $flags['tempOver']        = $g($s1, 11) === '1';
    $flags['headOpen']        = $g($s2, 2) === '1';
    $flags['ribbonOut']       = $g($s2, 3) === '1';
    $flags['thermalTransfer'] = $g($s2, 4) === '1';

    if     ($flags['headOpen'])                                 $state = 'HEAD_OPEN';
    elseif ($flags['ribbonOut'] && $flags['thermalTransfer'])   $state = 'RIBBON_OUT';
    elseif ($flags['paperOut'])                                 $state = 'MEDIA_OUT';
    elseif ($flags['pause'])                                    $state = 'PAUSED';
    elseif ($flags['tempOver'] || $flags['tempUnder'] || $flags['corruptRam']) $state = 'ERROR';
    else                                                        $state = 'READY';

    return ['state' => $state, 'flags' => $flags, 'lines' => count($lines)];
}

function parse_web_status($html) {
    $plain = strtolower(trim(preg_replace('/\s+/', ' ', strip_tags($html))));
    $has = function ($re) use ($plain) { return (bool)preg_match($re, $plain); };
    if ($has('#(cab\w*\.?\s*abert|head\s*open|open\s*head)#')) return 'HEAD_OPEN';
    if ($has('#((sem|falta(?:\s*de)?|out\s*of)\s*(ribbon|fita)|ribbon\s*(out|ausente|fora))#')) return 'RIBBON_OUT';
    if ($has('#(falta\s*(de\s*)?papel|paper\s*out|out\s*of\s*paper|sem\s*(papel|etiqueta|m[ií]dia)|media\s*out)#')) return 'MEDIA_OUT';
    if ($has('#(em\s*pausa|\bpausa\b|paused|\bpause\b)#')) return 'PAUSED';
    if ($has('#(em\s*aguardo|\baguardo\b|\bready\b|waiting|pronta|pronto)#')) return 'READY';
    return null;
}

function device_status($ip) {
    $out = ['ip' => $ip, 'reachable' => false, 'source' => 'none', 'state' => 'OFFLINE', 'flags' => parse_hs('')['flags'], 'detail' => null];

    $r = send_raw_tcp($ip, "~HS\r\n", 4, true, 1.6);
    if (($r['ok'] ?? false) && trim($r['reply']) !== '') {
        $hs = parse_hs($r['reply']);
        if ($hs['state'] !== null) {
            $out['reachable'] = true; $out['source'] = 'hs';
            $out['state'] = $hs['state']; $out['flags'] = $hs['flags']; $out['hs_raw'] = $r['reply'];
            return $out;
        }
    }

    $p9100 = tcp_open($ip, 9100);
    $web = http_request("http://{$ip}/");
    if ($web['error'] === null && $web['status'] >= 200 && $web['status'] < 500) {
        $out['reachable'] = true;
        $webState = parse_web_status($web['body']);
        if ($webState) { $out['source'] = 'web'; $out['state'] = $webState; }
        else {
            $out['source'] = 'web'; $out['state'] = 'ONLINE';
            $title = ''; if (preg_match('#<title>([^<]+)</title>#i', $web['body'], $t)) $title = trim($t[1]);
            $server = find_header($web['headers'], 'Server');
            $out['detail'] = trim(($title ?: 'Dispositivo web') . ($server ? " · $server" : ''));
        }
        return $out;
    }

    if ($p9100) { $out['reachable'] = true; $out['source'] = 'ping'; $out['state'] = 'ONLINE'; $out['detail'] = 'Porta 9100 ativa; status detalhado indisponível.'; return $out; }
    if (tcp_open($ip, 80)) { $out['reachable'] = true; $out['source'] = 'ping'; $out['state'] = 'ONLINE'; return $out; }
    return $out;
}

function zebra_info($ip) {
    $out = ['ip' => $ip, 'queries' => [], 'reachable' => false, 'status' => null];
    $sgd = ['model' => '! U1 getvar "device.product_name"', 'serial' => '! U1 getvar "device.serial_number"',
            'firmware' => '! U1 getvar "appl.name"', 'head_temp' => '! U1 getvar "head.temperature"',
            'media_status' => '! U1 getvar "media.status"'];
    foreach ($sgd as $key => $cmd) {
        $r = send_raw_tcp($ip, $cmd . "\r\n", 3, true, 1.2);
        $out['queries'][$key] = ['sent' => $r['ok'] ?? false, 'reply' => isset($r['reply']) ? trim($r['reply']) : null];
        if ($r['ok'] ?? false) $out['reachable'] = true;
    }
    $out['status'] = device_status($ip);
    if ($out['status']['reachable']) $out['reachable'] = true;
    return $out;
}

function ping_printer($ip) {
    $out = ['ip' => $ip];
    $start = microtime(true);
    $out['web_80']   = tcp_open($ip, 80, 2);
    $out['raw_9100'] = tcp_open($ip, 9100, 2);
    $out['elapsed_ms'] = round((microtime(true) - $start) * 1000);
    $out['ok'] = $out['web_80'] || $out['raw_9100'];
    return $out;
}

/* =====================================================================
 *                              ROTEAMENTO
 * ===================================================================== */
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/* ---------------------------- POST ---------------------------- */
if ($method === 'POST') {

    // Login Basic Auth: guarda as credenciais do host e recarrega a página
    if (!empty($_GET['authfor'])) {
        $host = trim($_GET['authfor']);
        $u = $_POST['u'] ?? ''; $p = $_POST['p'] ?? '';
        if ($u === '' && $p === '') { parse_str(file_get_contents('php://input'), $pp); $u = $pp['u'] ?? ''; $p = $pp['p'] ?? ''; }
        if ($u !== '') set_stored_auth($host, $u . ':' . $p);
        $next = !empty($_GET['next']) ? trim($_GET['next']) : ('http://' . $host . '/');
        if (!preg_match('~^https?://~i', $next)) $next = 'http://' . $next;
        output_render(http_request($next, 'GET'));
    }

    // POST de formulário do dispositivo (destino nos campos escondidos __mp_url)
    if (!empty($_POST['__mp_url'])) {
        $device = trim($_POST['__mp_url']);
        if (!preg_match('~^https?://~i', $device)) $device = 'http://' . $device;
        $fields = $_POST; unset($fields['__mp_url'], $fields['__mp_render']);
        output_render(http_request($device, 'POST', build_form_query($fields), ['Content-Type: application/x-www-form-urlencoded']));
    }

    // POST de formulário no modo render (?url=...&render=1) — vindo do próprio iframe
    if (!empty($_GET['url']) && isset($_GET['render'])) {
        $target = trim($_GET['url']);
        if (!preg_match('#^https?://#i', $target)) $target = 'http://' . $target;
        $ctype  = $_SERVER['CONTENT_TYPE'] ?? 'application/x-www-form-urlencoded';
        $rawBody = file_get_contents('php://input');
        if ($rawBody === '' && !empty($_POST)) $rawBody = build_form_query($_POST);
        $res = http_request($target, 'POST', $rawBody, ['Content-Type: ' . $ctype]);
        output_render($res);
    }

    $raw  = file_get_contents('php://input');
    $data = json_decode($raw, true);
    if (!is_array($data)) $data = $_POST;

    $action = $data['action'] ?? null;
    if ($action === 'status' && !empty($data['ip'])) send_json(device_status(trim($data['ip'])), 200);
    if ($action === 'info'   && !empty($data['ip'])) send_json(zebra_info(trim($data['ip'])), 200);

    if (!empty($data['url'])) {
        $url = trim($data['url']); $m = strtoupper($data['method'] ?? 'POST');
        $form = $data['form_data'] ?? null; $hdrs = $data['headers'] ?? [];
        if (!preg_match('#^https?://#i', $url)) $url = 'http://' . $url;
        if ($m === 'GET' && is_array($form)) {
            $sep = (strpos($url, '?') === false) ? '?' : '&';
            $url = $url . $sep . build_form_query($form); $form = null;
        }
        $res = http_request($url, $m, $form, is_array($hdrs) ? $hdrs : []);
        send_json([
            'effective_url' => $res['effective_url'], 'http_status' => $res['status'],
            'headers' => $res['headers'], 'content_type' => $res['content_type'] ?: find_header($res['headers'], 'Content-Type'),
            'body_base64' => base64_encode($res['body']), 'error' => $res['error'],
        ], $res['error'] ? 502 : 200);
    }

    if (!empty($data['ip']) && isset($data['cmd'])) {
        $r = send_raw_tcp(trim($data['ip']), $data['cmd'], 5, !empty($data['expect_reply']));
        if (!($r['ok'] ?? false)) send_json(['error' => $r['error'] ?? 'falha no envio'], 502);
        send_json(['success' => true, 'sent' => true, 'bytes_written' => $r['bytes'], 'reply' => $r['reply'] ?? ''], 200);
    }

    send_json(['error' => "POST inválido. Use { ip, cmd } | { url, method, form_data } | { action:'status'|'info', ip }"], 400);
}

/* ---------------------------- GET ----------------------------- */
if ($method !== 'GET') send_json(['error' => 'Método não suportado.'], 405);

$action = $_GET['action'] ?? null;
if ($action === 'ping'   && !empty($_GET['ip'])) send_json(ping_printer(trim($_GET['ip'])), 200);
if ($action === 'status' && !empty($_GET['ip'])) send_json(device_status(trim($_GET['ip'])), 200);
if ($action === 'info'   && !empty($_GET['ip'])) send_json(zebra_info(trim($_GET['ip'])), 200);

// GET de formulário do dispositivo (destino nos campos escondidos __mp_url)
if (!empty($_GET['__mp_url'])) {
    $device = trim($_GET['__mp_url']);
    if (!preg_match('~^https?://~i', $device)) $device = 'http://' . $device;
    $fields = $_GET; unset($fields['__mp_url'], $fields['__mp_render']);
    if (!empty($fields)) {
        $sep = (strpos($device, '?') === false) ? '?' : '&';
        $device .= $sep . build_form_query($fields);
    }
    output_render(http_request($device, 'GET'));
}

// alvo
if (!empty($_GET['url'])) {
    $target = trim($_GET['url']);
    if (!preg_match('#^https?://#i', $target)) $target = 'http://' . $target;
} elseif (!empty($_GET['ip'])) {
    $ip = trim($_GET['ip']); $path = $_GET['path'] ?? '/';
    if ($path === '') $path = '/';
    if ($path[0] !== '/') $path = '/' . $path;
    $target = 'http://' . $ip . $path;
} else {
    send_json(['error' => "Parâmetro 'ip' ou 'url' é obrigatório."], 400);
}

$res = http_request($target, 'GET');

// modo render: página completa reescrita p/ passar pelo proxy
if (!empty($_GET['render'])) output_render($res);

// modo JSON
$wantJson = !empty($_GET['as_json']) && ($_GET['as_json'] === '1' || strtolower($_GET['as_json']) === 'true');
if ($wantJson) {
    $payload = [
        'target' => $target, 'effective_url' => $res['effective_url'], 'http_status' => $res['status'],
        'headers' => $res['headers'], 'content_type' => $res['content_type'] ?: find_header($res['headers'], 'Content-Type'),
        'body_base64' => $res['body'] !== '' ? base64_encode($res['body']) : null, 'elapsed' => $res['time'],
    ];
    if ($res['error']) $payload['error'] = $res['error'];
    send_json($payload, $res['error'] ? 502 : 200);
}

// modo bruto — Content-Type deduzido pela extensão; CSS ganha url() reescrito
if ($res['error']) send_json(['error' => "Falha ao acessar {$target}: " . $res['error']], 502);
$devCt = $res['content_type'] ?: (find_header($res['headers'], 'Content-Type') ?: '');
$ct = guess_content_type($res['effective_url'], $devCt ?: 'text/html; charset=UTF-8');
header("Content-Type: {$ct}");
http_response_code($res['status'] ?: 200);
if (stripos($ct, 'text/css') !== false) echo rewrite_css_urls($res['body'], $res['effective_url']);
else echo $res['body'];
exit;
