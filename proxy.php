<?php
/* =====================================================================
 * proxy.php  —  MapaNto Universal Device Proxy v3
 * ---------------------------------------------------------------------
 * Ponte HTTP/TCP entre o site (via túnel Cloudflare) e os equipamentos
 * da rede interna. Serve para QUALQUER dispositivo web (impressoras
 * Zebra, print servers TP-LINK, páginas A4, etc.) e para o envio de
 * comandos ZPL/EPL na porta 9100.
 *
 * ---- MODOS (GET) ----------------------------------------------------
 *   ?url=URL_COMPLETA            -> busca a página/recurso (segue redirects)
 *   ?ip=IP[&path=/x]             -> idem, montando http://IP/path
 *        &as_json=1              -> { http_status, headers, body_base64, effective_url, content_type }
 *        (sem as_json)           -> conteúdo bruto preservando Content-Type (imgs/css/js/pdf)
 *   ?action=ping&ip=IP           -> portas 80/9100 vivas + latência
 *   ?action=status&ip=IP         -> STATUS normalizado (via ~HS, com fallback web/ping)
 *   ?action=info&ip=IP           -> dados Zebra (SGD + ~HS + parse HTML)
 *
 * ---- MODOS (POST, corpo JSON) --------------------------------------
 *   { ip, cmd, expect_reply? }             -> envia ZPL/EPL para :9100
 *   { url, method, form_data, headers? }   -> submete formulário (com cookies)
 *   { action:'status'|'info', ip }         -> idem GET
 *
 * Cookies persistidos por host (sessão por dispositivo).
 * Basic Auth via header  X-Printer-Auth: user:pass
 * CORS liberado (uso interno via túnel).
 * ===================================================================== */

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Headers: Content-Type, X-Printer-Auth");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("X-Content-Type-Options: nosniff");

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') { http_response_code(204); exit; }

@ini_set('default_socket_timeout', 10);
@set_time_limit(60);

/* ---------------------------------------------------------------- utils */
function send_json($data, $status = 200) {
    header('Content-Type: application/json; charset=UTF-8');
    http_response_code($status);
    // JSON_PARTIAL_OUTPUT_ON_ERROR evita falha total se algum header vier com bytes inválidos
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
    if ($hdr && strpos($hdr, ':') !== false) {
        return 'Authorization: Basic ' . base64_encode($hdr);
    }
    return null;
}

/* monta query preservando chaves repetidas (checkbox/select múltiplos) */
function build_form_query($form) {
    if (!is_array($form)) return (string)$form;
    $pairs = [];
    foreach ($form as $k => $v) {
        if (is_array($v)) { foreach ($v as $vv) $pairs[] = urlencode($k) . '=' . urlencode((string)$vv); }
        else            { $pairs[] = urlencode($k) . '=' . urlencode((string)$v); }
    }
    return implode('&', $pairs);
}

/* ------------------------------------------------------- HTTP via cURL */
function http_request($url, $method = 'GET', $postFields = null, $extraHeaders = []) {
    if (!preg_match('#^https?://#i', $url)) $url = 'http://' . $url;
    $host = host_from_url($url);
    $jar  = cookie_jar_for($host);

    $ch = curl_init();
    $headers = [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) MapaNtoProxy/3.0',
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,*/*;q=0.8',
        'Accept-Language: pt-BR,pt;q=0.9,en;q=0.8',
        'Connection: close',
    ];
    if ($b = basic_auth_header()) $headers[] = $b;
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
        CURLOPT_ENCODING       => '',   // aceita/descompacta gzip/deflate
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

    // usa apenas o ÚLTIMO bloco de cabeçalhos (após redirects)
    $blocks = preg_split("/\r\n\r\n/", trim($headerBlob));
    $lastBlock = is_array($blocks) && count($blocks) ? end($blocks) : $headerBlob;
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
    foreach ((array)$headers as $h) {
        if (stripos($h, $needle) === 0) $found = trim(substr($h, strlen($needle)));
    }
    return $found; // última ocorrência
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
    $flags = [
        'paperOut' => false, 'pause' => false, 'bufferFull' => false,
        'corruptRam' => false, 'tempUnder' => false, 'tempOver' => false,
        'headOpen' => false, 'ribbonOut' => false, 'thermalTransfer' => false,
    ];
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

/* Heurística de status a partir do HTML (Zebras com página web) */
function parse_web_status($html) {
    $h3s = [];
    if (preg_match_all('#<h3[^>]*>([\s\S]*?)</h3>#i', $html, $m)) {
        foreach ($m[1] as $h) { $t = trim(strip_tags($h)); if ($t !== '') $h3s[] = $t; }
    }
    $plain = strtolower(trim(preg_replace('/\s+/', ' ', strip_tags($html))));
    $has = function ($re) use ($plain) { return (bool)preg_match($re, $plain); };

    if ($has('#(cab\w*\.?\s*abert|head\s*open|open\s*head)#')) return 'HEAD_OPEN';
    if ($has('#((sem|falta(?:\s*de)?|out\s*of)\s*(ribbon|fita)|ribbon\s*(out|ausente|fora))#')) return 'RIBBON_OUT';
    if ($has('#(falta\s*(de\s*)?papel|paper\s*out|out\s*of\s*paper|sem\s*(papel|etiqueta|m[ií]dia)|media\s*out)#')) return 'MEDIA_OUT';
    if ($has('#(em\s*pausa|\bpausa\b|paused|\bpause\b)#')) return 'PAUSED';
    if ($has('#(em\s*aguardo|\baguardo\b|\bready\b|waiting|pronta|pronto)#')) return 'READY';
    return null; // não é uma página de status Zebra reconhecível
}

/* --------------------------------------- STATUS normalizado (action=status) */
function device_status($ip) {
    $out = [
        'ip' => $ip, 'reachable' => false, 'source' => 'none', 'state' => 'OFFLINE',
        'flags' => parse_hs('')['flags'], 'detail' => null,
    ];

    // 1) ~HS na porta 9100 (funciona p/ qualquer Zebra, inclusive atrás de print server bidirecional)
    $r = send_raw_tcp($ip, "~HS\r\n", 4, true, 1.6);
    if (($r['ok'] ?? false) && trim($r['reply']) !== '') {
        $hs = parse_hs($r['reply']);
        if ($hs['state'] !== null) {
            $out['reachable'] = true; $out['source'] = 'hs';
            $out['state'] = $hs['state']; $out['flags'] = $hs['flags'];
            $out['hs_raw'] = $r['reply'];
            return $out;
        }
    }

    $p9100 = tcp_open($ip, 9100);

    // 2) página web do dispositivo
    $web = http_request("http://{$ip}/");
    if ($web['error'] === null && $web['status'] >= 200 && $web['status'] < 500) {
        $out['reachable'] = true;
        $webState = parse_web_status($web['body']);
        if ($webState) {
            $out['source'] = 'web'; $out['state'] = $webState;
        } else {
            // dispositivo web acessível, mas sem status Zebra (ex.: print server TP-LINK)
            $out['source'] = 'web'; $out['state'] = 'ONLINE';
            $title = '';
            if (preg_match('#<title>([^<]+)</title>#i', $web['body'], $t)) $title = trim($t[1]);
            $server = find_header($web['headers'], 'Server');
            $out['detail'] = trim(($title ?: 'Dispositivo web') . ($server ? " · $server" : ''));
        }
        return $out;
    }

    // 3) só a porta bruta responde
    if ($p9100) {
        $out['reachable'] = true; $out['source'] = 'ping'; $out['state'] = 'ONLINE';
        $out['detail'] = 'Porta de impressão (9100) ativa; status detalhado indisponível.';
        return $out;
    }
    if (tcp_open($ip, 80)) {
        $out['reachable'] = true; $out['source'] = 'ping'; $out['state'] = 'ONLINE';
        return $out;
    }

    return $out; // OFFLINE
}

/* ------------------------------------------------ Info Zebra (compat) */
function zebra_info($ip) {
    $out = ['ip' => $ip, 'queries' => [], 'reachable' => false, 'web' => null, 'status' => null];
    $sgdQueries = [
        'model'        => '! U1 getvar "device.product_name"',
        'serial'       => '! U1 getvar "device.serial_number"',
        'firmware'     => '! U1 getvar "appl.name"',
        'odometer'     => '! U1 getvar "odometer.total_print_length"',
        'head_temp'    => '! U1 getvar "head.temperature"',
        'media_status' => '! U1 getvar "media.status"',
    ];
    foreach ($sgdQueries as $key => $cmd) {
        $r = send_raw_tcp($ip, $cmd . "\r\n", 3, true, 1.2);
        $out['queries'][$key] = ['sent' => $r['ok'] ?? false, 'reply' => isset($r['reply']) ? trim($r['reply']) : null];
        if ($r['ok'] ?? false) $out['reachable'] = true;
    }
    $out['status'] = device_status($ip);
    if ($out['status']['reachable']) $out['reachable'] = true;
    return $out;
}

/* ----------------------------------------------------------- Ping */
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
    $raw  = file_get_contents('php://input');
    $data = json_decode($raw, true);
    if (!is_array($data)) $data = $_POST;

    $action = $data['action'] ?? null;

    if ($action === 'status' && !empty($data['ip'])) send_json(device_status(trim($data['ip'])), 200);
    if ($action === 'info'   && !empty($data['ip'])) send_json(zebra_info(trim($data['ip'])), 200);

    // submissão de formulário web (login/config das páginas dos dispositivos)
    if (!empty($data['url'])) {
        $url     = trim($data['url']);
        $m       = strtoupper($data['method'] ?? 'POST');
        $form    = $data['form_data'] ?? null;
        $hdrs    = $data['headers'] ?? [];
        if (!preg_match('#^https?://#i', $url)) $url = 'http://' . $url;
        if ($m === 'GET' && is_array($form)) {
            $sep = (strpos($url, '?') === false) ? '?' : '&';
            $url = $url . $sep . build_form_query($form);
            $form = null;
        }
        $res = http_request($url, $m, $form, is_array($hdrs) ? $hdrs : []);
        send_json([
            'effective_url' => $res['effective_url'],
            'http_status'   => $res['status'],
            'headers'       => $res['headers'],
            'content_type'  => $res['content_type'] ?: find_header($res['headers'], 'Content-Type'),
            'body_base64'   => base64_encode($res['body']),
            'error'         => $res['error'],
        ], $res['error'] ? 502 : 200);
    }

    // ZPL/EPL bruto para a porta 9100
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

// monta alvo
if (!empty($_GET['url'])) {
    $target = trim($_GET['url']);
    if (!preg_match('#^https?://#i', $target)) $target = 'http://' . $target;
} elseif (!empty($_GET['ip'])) {
    $ip   = trim($_GET['ip']);
    $path = $_GET['path'] ?? '/';
    if ($path === '' ) $path = '/';
    if ($path[0] !== '/') $path = '/' . $path;
    $target = 'http://' . $ip . $path;
} else {
    send_json(['error' => "Parâmetro 'ip' ou 'url' é obrigatório."], 400);
}

$res = http_request($target, 'GET');

$wantJson = !empty($_GET['as_json']) && ($_GET['as_json'] === '1' || strtolower($_GET['as_json']) === 'true');
if ($wantJson) {
    $payload = [
        'target'        => $target,
        'effective_url' => $res['effective_url'],
        'http_status'   => $res['status'],
        'headers'       => $res['headers'],
        'content_type'  => $res['content_type'] ?: find_header($res['headers'], 'Content-Type'),
        'body_base64'   => $res['body'] !== '' ? base64_encode($res['body']) : null,
        'elapsed'       => $res['time'],
    ];
    if ($res['error']) $payload['error'] = $res['error'];
    send_json($payload, $res['error'] ? 502 : 200);
}

// modo bruto — preserva Content-Type (imgs/css/js/pdf) e status
if ($res['error']) send_json(['error' => "Falha ao acessar {$target}: " . $res['error']], 502);
$ct = $res['content_type'] ?: (find_header($res['headers'], 'Content-Type') ?: 'text/html; charset=UTF-8');
header("Content-Type: {$ct}");
http_response_code($res['status'] ?: 200);
echo $res['body'];
exit;
