<?php
// proxy.php  -  MapaNto Printer Proxy v2
// =====================================================================
//  Modos de uso:
//   GET  ?ip=IP&path=/    -> busca página HTML da impressora
//   GET  ?url=URL_COMPLETA -> idem, URL livre
//        &as_json=1       -> retorna { http_status, headers, body_base64, effective_url }
//        &asset=1         -> retorna o conteúdo bruto preservando Content-Type (imgs/css)
//   GET  ?action=ping&ip=IP        -> verifica se a porta web/SNMP está viva
//   GET  ?action=info&ip=IP        -> coleta dados Zebra (SGD + parse HTML)
//
//   POST { ip, cmd }                              -> envia ZPL/EPL para socket :9100
//   POST { url, method, form_data, headers }      -> submete formulário HTTP (com cookies)
//   POST { action:'info', ip }                    -> equivalente a GET ?action=info
//
//  Cookies persistidos por host em arquivo temporário (sessão por impressora).
//  Suporte a Basic Auth quando enviado no header `X-Printer-Auth: user:pass`.
//  CORS aberto (uso interno via Cloudflare Tunnel).
// =====================================================================

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Headers: Content-Type, X-Printer-Auth");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

@ini_set('default_socket_timeout', 8);
@set_time_limit(60);
@ini_set('max_execution_time', 60);

function send_json($data, $status = 200) {
    header('Content-Type: application/json; charset=UTF-8');
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function cookie_jar_for($host) {
    $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'mapanto_cookies';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $safe = preg_replace('/[^a-z0-9._-]/i', '_', $host);
    return $dir . DIRECTORY_SEPARATOR . $safe . '.cookies';
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

// ---------------- HTTP via cURL ----------------
function http_request($url, $method = 'GET', $postFields = null, $extraHeaders = []) {
    $host = host_from_url($url);
    $jar  = cookie_jar_for($host);

    $ch = curl_init();
    $headers = [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) MapaNtoProxy/2.0',
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language: pt-BR,pt;q=0.9,en;q=0.8',
        'Connection: close',
    ];
    if ($b = basic_auth_header()) $headers[] = $b;
    foreach ($extraHeaders as $h) $headers[] = $h;

    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 5,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_COOKIEJAR      => $jar,
        CURLOPT_COOKIEFILE     => $jar,
        CURLOPT_SSL_VERIFYPEER => false,
        CURLOPT_SSL_VERIFYHOST => 0,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_ENCODING       => '',
    ]);

    if (strtoupper($method) === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, is_array($postFields) ? http_build_query($postFields) : (string)$postFields);
    } elseif (strtoupper($method) !== 'GET') {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, strtoupper($method));
        if ($postFields !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, is_array($postFields) ? http_build_query($postFields) : (string)$postFields);
    }

    $raw      = curl_exec($ch);
    $errno    = curl_errno($ch);
    $errstr   = curl_error($ch);
    $status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $hsize    = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $effUrl   = curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    $totalT   = curl_getinfo($ch, CURLINFO_TOTAL_TIME);
    curl_close($ch);

    if ($raw === false) {
        return ['error' => "cURL($errno): $errstr", 'status' => 0, 'headers' => [], 'body' => '', 'effective_url' => $url, 'time' => $totalT];
    }

    $headerBlob = substr($raw, 0, $hsize);
    $body       = substr($raw, $hsize);
    $headers    = [];
    foreach (preg_split("/\r?\n/", trim($headerBlob)) as $line) {
        if ($line === '' || stripos($line, 'HTTP/') === 0) continue;
        $headers[] = $line;
    }

    return ['error' => null, 'status' => $status, 'headers' => $headers, 'body' => $body, 'effective_url' => $effUrl, 'time' => $totalT];
}

function find_header($headers, $name) {
    $needle = strtolower($name) . ':';
    foreach ($headers as $h) {
        if (stripos($h, $needle) === 0) return trim(substr($h, strlen($needle)));
    }
    return null;
}

// ---------------- TCP raw (porta 9100) ----------------
function send_raw_tcp($ip, $cmd, $timeout = 5, $wantReply = false, $replyDeadline = 1.5) {
    $host = $ip; $port = 9100;
    if (strpos($ip, ':') !== false) {
        [$host, $maybePort] = explode(':', $ip, 2);
        if (is_numeric($maybePort)) $port = intval($maybePort);
    }
    $errno = 0; $errstr = '';
    $fp = @stream_socket_client("tcp://{$host}:{$port}", $errno, $errstr, $timeout);
    if (!$fp) return ['ok' => false, 'error' => "Falha ao conectar {$host}:{$port} - $errstr", 'errno' => $errno];
    stream_set_timeout($fp, 1, 200000); // 1.2s leitura
    $written = @fwrite($fp, $cmd);
    @fflush($fp);
    $reply = '';
    if ($wantReply) {
        $deadline = microtime(true) + $replyDeadline;
        while (microtime(true) < $deadline) {
            $chunk = @fread($fp, 4096);
            if ($chunk === false) break;
            if ($chunk === '') { usleep(50000); continue; }
            $reply .= $chunk;
            if (strlen($reply) > 4096) break;
            $info = stream_get_meta_data($fp);
            if (!empty($info['timed_out'])) break;
        }
    }
    @fclose($fp);
    return ['ok' => $written !== false && $written > 0, 'bytes' => $written, 'reply' => $reply];
}

// ---------------- Info Zebra (SGD + parse) ----------------
function zebra_info($ip) {
    $out = ['ip' => $ip, 'queries' => [], 'reachable' => false, 'web' => null];

    // Tenta abrir UMA conexão e enviar várias queries seguidas (mais rápido)
    $host = $ip; $port = 9100;
    if (strpos($ip, ':') !== false) {
        [$host, $maybePort] = explode(':', $ip, 2);
        if (is_numeric($maybePort)) $port = intval($maybePort);
    }
    $errno = 0; $errstr = '';
    $fp = @stream_socket_client("tcp://{$host}:{$port}", $errno, $errstr, 3);

    $sgdQueries = [
        'model'        => '! U1 getvar "device.product_name"',
        'serial'       => '! U1 getvar "device.serial_number"',
        'firmware'     => '! U1 getvar "appl.name"',
        'odometer'     => '! U1 getvar "odometer.total_print_length"',
        'head_temp'    => '! U1 getvar "head.temperature"',
        'media_status' => '! U1 getvar "media.status"',
        'host_status'  => '~HS',
    ];

    if ($fp) {
        $out['reachable'] = true;
        stream_set_timeout($fp, 1);
        foreach ($sgdQueries as $key => $cmd) {
            @fwrite($fp, $cmd . "\r\n");
            @fflush($fp);
            $reply = '';
            $deadline = microtime(true) + 0.9;
            while (microtime(true) < $deadline) {
                $chunk = @fread($fp, 2048);
                if ($chunk === false) break;
                if ($chunk === '') { usleep(40000); continue; }
                $reply .= $chunk;
                if (strlen($reply) > 1024) break;
                $info = stream_get_meta_data($fp);
                if (!empty($info['timed_out'])) break;
            }
            $out['queries'][$key] = ['reply' => trim($reply), 'sent' => true];
        }
        @fclose($fp);
    } else {
        foreach ($sgdQueries as $key => $cmd) {
            $out['queries'][$key] = ['sent' => false, 'reply' => '', 'error' => "TCP $errstr"];
        }
    }

    // Tenta página web pra extrair status legível (timeout curto)
    $web = http_request("http://{$ip}/");
    if ($web['error'] === null && $web['status'] >= 200 && $web['status'] < 500) {
        $out['reachable'] = true;
        $h3s = [];
        if (preg_match_all('#<h3[^>]*>([\s\S]*?)</h3>#i', $web['body'], $m)) {
            foreach ($m[1] as $h) $h3s[] = trim(strip_tags($h));
        }
        $title = '';
        if (preg_match('#<title>([^<]+)</title>#i', $web['body'], $t)) $title = trim($t[1]);
        $out['web'] = ['title' => $title, 'h3' => array_slice($h3s, 0, 12), 'http_status' => $web['status']];
    } else {
        $out['web'] = ['error' => $web['error']];
    }

    return $out;
}

// ---------------- Ping rápido ----------------
function ping_printer($ip) {
    $out = ['ip' => $ip];
    $start = microtime(true);
    $fp = @stream_socket_client("tcp://{$ip}:80", $errno, $errstr, 2);
    $out['web_80'] = (bool)$fp;
    if ($fp) @fclose($fp);
    $fp = @stream_socket_client("tcp://{$ip}:9100", $errno, $errstr, 2);
    $out['raw_9100'] = (bool)$fp;
    if ($fp) @fclose($fp);
    $out['elapsed_ms'] = round((microtime(true) - $start) * 1000);
    $out['ok'] = $out['web_80'] || $out['raw_9100'];
    return $out;
}

// =====================================================================
//                            ROTEAMENTO
// =====================================================================

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ---------- POST ----------
if ($method === 'POST') {
    $raw  = file_get_contents('php://input');
    $data = json_decode($raw, true);

    if (!is_array($data)) {
        // tenta form-url-encoded para compatibilidade
        $data = $_POST;
    }

    $action = $data['action'] ?? null;

    // POST de info Zebra
    if ($action === 'info' && !empty($data['ip'])) {
        send_json(zebra_info(trim($data['ip'])), 200);
    }

    // POST de formulário web (login da impressora etc.)
    if (!empty($data['url'])) {
        $url     = trim($data['url']);
        $m       = strtoupper($data['method'] ?? 'POST');
        $form    = $data['form_data'] ?? null;
        $headers = $data['headers'] ?? [];
        if (!preg_match('#^https?://#i', $url)) $url = 'http://' . $url;

        if ($m === 'GET' && is_array($form)) {
            $sep = (strpos($url, '?') === false) ? '?' : '&';
            $url = $url . $sep . http_build_query($form);
            $form = null;
        }

        $res = http_request($url, $m, $form, is_array($headers) ? $headers : []);
        send_json([
            'effective_url' => $res['effective_url'],
            'http_status'   => $res['status'],
            'headers'       => $res['headers'],
            'body_base64'   => base64_encode($res['body']),
            'error'         => $res['error'],
        ], $res['error'] ? 502 : 200);
    }

    // POST raw ZPL para socket
    if (!empty($data['ip']) && isset($data['cmd'])) {
        $r = send_raw_tcp(trim($data['ip']), $data['cmd'], 5, !empty($data['expect_reply']));
        if (!($r['ok'] ?? false)) send_json(['error' => $r['error'] ?? 'falha no envio'], 502);
        send_json(['success' => true, 'sent' => true, 'bytes_written' => $r['bytes'], 'reply' => $r['reply'] ?? ''], 200);
    }

    send_json(['error' => "POST inválido. Use { ip, cmd } OR { url, method, form_data } OR { action:'info', ip }"], 400);
}

// ---------- GET ----------
if ($method !== 'GET') send_json(['error' => 'Método não suportado.'], 405);

$action = $_GET['action'] ?? null;
if ($action === 'ping' && !empty($_GET['ip']))  send_json(ping_printer(trim($_GET['ip'])), 200);
if ($action === 'info' && !empty($_GET['ip']))  send_json(zebra_info(trim($_GET['ip'])), 200);

// monta target
if (!empty($_GET['url'])) {
    $target = trim($_GET['url']);
    if (!preg_match('#^https?://#i', $target)) $target = 'http://' . $target;
} elseif (!empty($_GET['ip'])) {
    $ip   = trim($_GET['ip']);
    $path = $_GET['path'] ?? '/';
    if ($path !== '' && $path[0] !== '/') $path = '/' . $path;
    $target = 'http://' . $ip . $path;
} else {
    send_json(['error' => "Parâmetro 'ip' ou 'url' é obrigatório."], 400);
}

$res = http_request($target, 'GET');

if (!empty($_GET['as_json']) && ($_GET['as_json'] === '1' || strtolower($_GET['as_json']) === 'true')) {
    $payload = [
        'target'        => $target,
        'effective_url' => $res['effective_url'],
        'http_status'   => $res['status'],
        'headers'       => $res['headers'],
        'body_base64'   => $res['body'] !== '' ? base64_encode($res['body']) : null,
        'elapsed'       => $res['time'],
    ];
    if ($res['error']) $payload['error'] = $res['error'];
    send_json($payload, $res['error'] ? 502 : 200);
}

// modo bruto - preserva content-type (útil para imgs/css)
if ($res['error']) send_json(['error' => "Falha ao acessar {$target}: " . $res['error']], 502);
$ct = find_header($res['headers'], 'Content-Type') ?: 'text/html; charset=UTF-8';
header("Content-Type: {$ct}");
http_response_code($res['status'] ?: 200);
echo $res['body'];
exit;
