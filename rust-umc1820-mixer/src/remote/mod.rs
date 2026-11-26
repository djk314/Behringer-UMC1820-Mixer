use crate::audio::state::{NUM_AUX_STRIPS, NUM_INPUT_STRIPS, TOTAL_STRIPS};
use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

const REMOTE_UI_HTML: &str = include_str!("remote_ui.html");
const WS_MAGIC_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RemoteCommand {
    RequestState,
    SetVolume { strip: usize, volume_db: f32 },
    SetGain { strip: usize, gain_db: f32 },
    SetMute { strip: usize, mute: bool },
    SetSolo { strip: usize, solo: bool },
    ClearAllSolo,
    SetEqBand { strip: usize, band: String, value_db: f32 },
    SetEqBypass { strip: usize, bypassed: bool },
    SetAuxSend { strip: usize, aux_idx: usize, level: f32 },
    SetInputPairStereo { pair: usize, stereo: bool },
    SetAuxPairStereo { pair: usize, stereo: bool },
    SetInputRoute { strip: usize, kind: String, channel: usize },
    SetOutputRoute { strip: usize, kind: String, channel: usize },
    SetStripMidiMode { strip: usize, mode: Option<u8> },
    SetStripMidiDevice { strip: usize, device: String },
    BypassInsert { strip: usize, slot: usize, bypassed: bool },
    SetPluginParam { strip: usize, slot: usize, param_id: u32, value: f32 },
    PlayerPlay,
    PlayerPause,
    PlayerStop,
    PlayerSeek { pos_secs: f32 },
    PlayerSetLoop { loop_enabled: bool },
    PlayerSetGain { gain: f32 },
    PlayerSetTarget { target: Option<usize> },
}

#[derive(Serialize)]
pub struct RemoteMeterEntry {
    pub pl: f32,
    pub pr: f32,
    pub rl: f32,
    pub rr: f32,
    pub clip: bool,
}

#[derive(Serialize)]
pub struct RemoteMetersPacket<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub meters: &'a [RemoteMeterEntry],
    pub player: RemotePlayerProgressView,
}

#[derive(Serialize)]
pub struct RemotePlayerProgressView {
    pub playing: bool,
    pub pos_secs: f32,
    pub duration_secs: f32,
}

struct RemoteShared {
    latest_state_json: String,
    clients: Vec<mpsc::Sender<String>>,
}

pub struct RemoteServer {
    pub http_port: u16,
    pub osc_port: Option<u16>,
    pub local_ip: String,
    running: Arc<AtomicBool>,
    cmd_rx: mpsc::Receiver<RemoteCommand>,
    shared: Arc<Mutex<RemoteShared>>,
    client_count: Arc<AtomicUsize>,
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.stop();
    }
}

impl RemoteServer {
    pub fn start() -> Result<Self, String> {
        let mut bound_listener = None;
        let mut bound_port = 8080;
        for port in 8080..=8090 {
            if let Ok(listener) = TcpListener::bind(("0.0.0.0", port)) {
                bound_port = port;
                bound_listener = Some(listener);
                break;
            }
        }
        let listener = bound_listener
            .ok_or_else(|| "Impossible d'ouvrir le serveur HTTP/WebSocket (ports 8080–8090)".to_string())?;
        let _ = listener.set_nonblocking(true);

        let mut osc_sock = None;
        let mut osc_port = None;
        for port in 9000..=9010 {
            if let Ok(sock) = UdpSocket::bind(("0.0.0.0", port)) {
                let _ = sock.set_read_timeout(Some(Duration::from_millis(80)));
                osc_sock = Some(sock);
                osc_port = Some(port);
                break;
            }
        }

        let local_ip = detect_local_ipv4();
        let running = Arc::new(AtomicBool::new(true));
        let (cmd_tx, cmd_rx) = mpsc::channel::<RemoteCommand>();
        let shared = Arc::new(Mutex::new(RemoteShared {
            latest_state_json: "{}".to_string(),
            clients: Vec::new(),
        }));
        let client_count = Arc::new(AtomicUsize::new(0));

        // HTTP + WebSocket thread
        {
            let running = Arc::clone(&running);
            let cmd_tx = cmd_tx.clone();
            let shared = Arc::clone(&shared);
            let client_count = Arc::clone(&client_count);
            thread::spawn(move || {
                while running.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _addr)) => {
                            let running_c = Arc::clone(&running);
                            let cmd_tx_c = cmd_tx.clone();
                            let shared_c = Arc::clone(&shared);
                            let count_c = Arc::clone(&client_count);
                            thread::spawn(move || {
                                handle_tcp_connection(stream, running_c, cmd_tx_c, shared_c, count_c);
                            });
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(25));
                        }
                        Err(_) => {
                            thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            });
        }

        // Optional OSC UDP listener thread (TouchOSC / Lemur / controllers)
        if let Some(sock) = osc_sock {
            let running = Arc::clone(&running);
            thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while running.load(Ordering::Relaxed) {
                    match sock.recv_from(&mut buf) {
                        Ok((n, _addr)) => {
                            parse_osc_packet(&buf[..n], &cmd_tx);
                        }
                        Err(e)
                            if e.kind() == ErrorKind::WouldBlock
                                || e.kind() == ErrorKind::TimedOut => {}
                        Err(_) => {
                            thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            });
        }

        Ok(Self {
            http_port: bound_port,
            osc_port,
            local_ip,
            running,
            cmd_rx,
            shared,
            client_count,
        })
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::Relaxed);
        if let Ok(mut guard) = self.shared.lock() {
            guard.clients.clear();
        }
        self.client_count.store(0, Ordering::Relaxed);
    }

    pub fn url(&self) -> String {
        format!("http://{}:{}", self.local_ip, self.http_port)
    }

    pub fn client_count(&self) -> usize {
        self.client_count.load(Ordering::Relaxed)
    }

    pub fn poll_commands(&self) -> Vec<RemoteCommand> {
        let mut cmds = Vec::new();
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            cmds.push(cmd);
        }
        cmds
    }

    pub fn broadcast_state(&self, state_json: String) {
        if let Ok(mut guard) = self.shared.lock() {
            guard.latest_state_json = state_json.clone();
            guard.clients.retain(|tx| tx.send(state_json.clone()).is_ok());
            self.client_count.store(guard.clients.len(), Ordering::Relaxed);
        }
    }

    pub fn broadcast_meters(&self, meters_json: &str) {
        if self.client_count() == 0 {
            return;
        }
        if let Ok(mut guard) = self.shared.lock() {
            guard
                .clients
                .retain(|tx| tx.send(meters_json.to_string()).is_ok());
            self.client_count.store(guard.clients.len(), Ordering::Relaxed);
        }
    }
}

fn detect_local_ipv4() -> String {
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                let ip = addr.ip().to_string();
                if !ip.starts_with("127.") {
                    return ip;
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

fn handle_tcp_connection(
    mut stream: TcpStream,
    running: Arc<AtomicBool>,
    cmd_tx: mpsc::Sender<RemoteCommand>,
    shared: Arc<Mutex<RemoteShared>>,
    client_count: Arc<AtomicUsize>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_nodelay(true);

    let Some(req) = read_http_request(&mut stream) else {
        return;
    };

    if req.is_websocket_upgrade() {
        if let Some(ws_key) = req.header("sec-websocket-key") {
            let accept = compute_ws_accept(ws_key);
            let handshake = format!(
                "HTTP/1.1 101 Switching Protocols\r\n\
                 Upgrade: websocket\r\n\
                 Connection: Upgrade\r\n\
                 Sec-WebSocket-Accept: {accept}\r\n\r\n"
            );
            if stream.write_all(handshake.as_bytes()).is_err() {
                return;
            }
            let _ = stream.flush();
            run_websocket_session(stream, running, cmd_tx, shared, client_count);
            return;
        }
    }

    if req.path == "/api/state" {
        let json = shared
            .lock()
            .map(|g| g.latest_state_json.clone())
            .unwrap_or_else(|_| "{}".to_string());
        write_http_response(&mut stream, "200 OK", "application/json; charset=utf-8", json.as_bytes());
    } else if req.path == "/favicon.ico" {
        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    } else {
        write_http_response(
            &mut stream,
            "200 OK",
            "text/html; charset=utf-8",
            REMOTE_UI_HTML.as_bytes(),
        );
    }
}

struct HttpRequest {
    path: String,
    headers: Vec<(String, String)>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        let lower = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| k == &lower)
            .map(|(_, v)| v.as_str())
    }

    fn is_websocket_upgrade(&self) -> bool {
        self.header("upgrade")
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false)
    }
}

fn read_http_request(stream: &mut TcpStream) -> Option<HttpRequest> {
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 1024];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => return None,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 16384 {
                    return None;
                }
            }
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let _method = parts.next()?;
    let raw_path = parts.next().unwrap_or("/");
    let path = raw_path.split('?').next().unwrap_or("/").to_string();

    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    Some(HttpRequest { path, headers })
}

fn write_http_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn run_websocket_session(
    mut stream: TcpStream,
    running: Arc<AtomicBool>,
    cmd_tx: mpsc::Sender<RemoteCommand>,
    shared: Arc<Mutex<RemoteShared>>,
    client_count: Arc<AtomicUsize>,
) {
    let (out_tx, out_rx) = mpsc::channel::<String>();
    let initial_state = if let Ok(mut guard) = shared.lock() {
        guard.clients.push(out_tx);
        client_count.store(guard.clients.len(), Ordering::Relaxed);
        guard.latest_state_json.clone()
    } else {
        return;
    };

    if send_ws_frame(&mut stream, 0x1, initial_state.as_bytes()).is_err() {
        return;
    }

    let mut frag_buf: Vec<u8> = Vec::new();
    while running.load(Ordering::Relaxed) {
        while let Ok(msg) = out_rx.try_recv() {
            if send_ws_frame(&mut stream, 0x1, msg.as_bytes()).is_err() {
                return;
            }
        }

        let _ = stream.set_read_timeout(Some(Duration::from_millis(20)));
        let mut first_byte = [0u8; 1];
        match stream.read(&mut first_byte) {
            Ok(0) => break,
            Ok(_) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                match read_ws_frame_rest(&mut stream, first_byte[0]) {
                    Ok((fin, opcode, payload)) => match opcode {
                        0x8 => {
                            let _ = send_ws_frame(&mut stream, 0x8, &[]);
                            break;
                        }
                        0x9 => {
                            if send_ws_frame(&mut stream, 0xA, &payload).is_err() {
                                break;
                            }
                        }
                        0xA => {}
                        0x1 | 0x0 => {
                            frag_buf.extend_from_slice(&payload);
                            if fin {
                                if let Ok(txt) = std::str::from_utf8(&frag_buf) {
                                    if let Ok(cmd) = serde_json::from_str::<RemoteCommand>(txt) {
                                        let _ = cmd_tx.send(cmd);
                                    }
                                }
                                frag_buf.clear();
                            }
                        }
                        _ => {}
                    },
                    Err(_) => break,
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
}

fn read_exact_blocking(stream: &mut TcpStream, buf: &mut [u8]) -> std::io::Result<()> {
    let mut offset = 0;
    while offset < buf.len() {
        match stream.read(&mut buf[offset..]) {
            Ok(0) => return Err(std::io::Error::new(ErrorKind::UnexpectedEof, "eof")),
            Ok(n) => offset += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn read_ws_frame_rest(stream: &mut TcpStream, b0: u8) -> std::io::Result<(bool, u8, Vec<u8>)> {
    let fin = (b0 & 0x80) != 0;
    let opcode = b0 & 0x0F;
    let mut b1_arr = [0u8; 1];
    read_exact_blocking(stream, &mut b1_arr)?;
    let b1 = b1_arr[0];
    let masked = (b1 & 0x80) != 0;
    let len7 = (b1 & 0x7F) as u64;

    let payload_len: usize = if len7 == 126 {
        let mut ext = [0u8; 2];
        read_exact_blocking(stream, &mut ext)?;
        u16::from_be_bytes(ext) as usize
    } else if len7 == 127 {
        let mut ext = [0u8; 8];
        read_exact_blocking(stream, &mut ext)?;
        let len64 = u64::from_be_bytes(ext);
        if len64 > 2 * 1024 * 1024 {
            return Err(std::io::Error::new(ErrorKind::InvalidData, "frame too big"));
        }
        len64 as usize
    } else {
        len7 as usize
    };

    let mask_key = if masked {
        let mut k = [0u8; 4];
        read_exact_blocking(stream, &mut k)?;
        Some(k)
    } else {
        None
    };

    let mut payload = vec![0u8; payload_len];
    if payload_len > 0 {
        read_exact_blocking(stream, &mut payload)?;
    }
    if let Some(k) = mask_key {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= k[i & 3];
        }
    }
    Ok((fin, opcode, payload))
}

fn send_ws_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut header = Vec::with_capacity(10);
    header.push(0x80 | (opcode & 0x0F));
    let len = payload.len();
    if len <= 125 {
        header.push(len as u8);
    } else if len <= 65535 {
        header.push(126);
        header.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(len as u64).to_be_bytes());
    }
    stream.write_all(&header)?;
    if !payload.is_empty() {
        stream.write_all(payload)?;
    }
    stream.flush()
}

fn compute_ws_accept(client_key: &str) -> String {
    let mut input = Vec::with_capacity(client_key.len() + WS_MAGIC_GUID.len());
    input.extend_from_slice(client_key.trim().as_bytes());
    input.extend_from_slice(WS_MAGIC_GUID.as_bytes());
    let digest = sha1_digest(&input);
    base64_encode(&digest)
}

fn sha1_digest(data: &[u8]) -> [u8; 20] {
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    let mut h0: u32 = 0x67452301;
    let mut h1: u32 = 0xEFCDAB89;
    let mut h2: u32 = 0x98BADCFE;
    let mut h3: u32 = 0x10325476;
    let mut h4: u32 = 0xC3D2E1F0;

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;

        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDCu32),
                _ => (b ^ c ^ d, 0xCA62C1D6u32),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }

        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut out = [0u8; 20];
    out[0..4].copy_from_slice(&h0.to_be_bytes());
    out[4..8].copy_from_slice(&h1.to_be_bytes());
    out[8..12].copy_from_slice(&h2.to_be_bytes());
    out[12..16].copy_from_slice(&h3.to_be_bytes());
    out[16..20].copy_from_slice(&h4.to_be_bytes());
    out
}

fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((input.len() + 2) / 3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

// --- Lightweight OSC over UDP parser ---

fn read_osc_str(data: &[u8], pos: &mut usize) -> Option<String> {
    if *pos >= data.len() {
        return None;
    }
    let nul = data[*pos..].iter().position(|&b| b == 0)?;
    let s = std::str::from_utf8(&data[*pos..*pos + nul]).ok()?.to_string();
    *pos = (*pos + nul + 4) & !3;
    Some(s)
}

fn parse_osc_packet(data: &[u8], cmd_tx: &mpsc::Sender<RemoteCommand>) {
    if data.starts_with(b"#bundle\0") {
        let mut pos = 16;
        while pos + 4 <= data.len() {
            let sz = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
            pos += 4;
            if pos + sz > data.len() {
                break;
            }
            parse_osc_packet(&data[pos..pos + sz], cmd_tx);
            pos += sz;
        }
        return;
    }

    let mut pos = 0;
    let Some(addr) = read_osc_str(data, &mut pos) else {
        return;
    };
    let Some(tags) = read_osc_str(data, &mut pos) else {
        return;
    };

    let mut args_f32: Vec<f32> = Vec::new();
    for tag in tags.chars().skip(1) {
        if pos + 4 > data.len() {
            break;
        }
        match tag {
            'f' => {
                args_f32.push(f32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]));
                pos += 4;
            }
            'i' => {
                args_f32.push(i32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as f32);
                pos += 4;
            }
            _ => break,
        }
    }

    let val = args_f32.first().copied().unwrap_or(0.0);
    let parts: Vec<&str> = addr.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 && parts[0] == "player" {
        match parts[1] {
            "play" => {
                let _ = cmd_tx.send(RemoteCommand::PlayerPlay);
            }
            "pause" => {
                let _ = cmd_tx.send(RemoteCommand::PlayerPause);
            }
            "stop" => {
                let _ = cmd_tx.send(RemoteCommand::PlayerStop);
            }
            _ => {}
        }
        return;
    }

    if parts.len() < 3 || parts[0] != "strip" {
        return;
    }
    let strip_idx = if parts[1] == "master" {
        NUM_INPUT_STRIPS + NUM_AUX_STRIPS
    } else if let Ok(n) = parts[1].parse::<usize>() {
        if n == 0 || n > TOTAL_STRIPS {
            return;
        }
        n - 1
    } else {
        return;
    };

    match parts[2] {
        "volume" => {
            let db = (-60.0 + val.clamp(0.0, 1.0) * 72.0).clamp(-60.0, 12.0);
            let _ = cmd_tx.send(RemoteCommand::SetVolume { strip: strip_idx, volume_db: db });
        }
        "volume_db" => {
            let _ = cmd_tx.send(RemoteCommand::SetVolume {
                strip: strip_idx,
                volume_db: val.clamp(-60.0, 12.0),
            });
        }
        "gain" => {
            let _ = cmd_tx.send(RemoteCommand::SetGain {
                strip: strip_idx,
                gain_db: val.clamp(-12.0, 24.0),
            });
        }
        "mute" => {
            let _ = cmd_tx.send(RemoteCommand::SetMute {
                strip: strip_idx,
                mute: val > 0.5,
            });
        }
        "solo" => {
            let _ = cmd_tx.send(RemoteCommand::SetSolo {
                strip: strip_idx,
                solo: val > 0.5,
            });
        }
        "aux" if parts.len() >= 4 => {
            if let Ok(a) = parts[3].parse::<usize>() {
                if (1..=8).contains(&a) {
                    let _ = cmd_tx.send(RemoteCommand::SetAuxSend {
                        strip: strip_idx,
                        aux_idx: a - 1,
                        level: val.clamp(0.0, 1.0),
                    });
                }
            }
        }
        "eq" if parts.len() >= 4 => {
            let band = match parts[3] {
                "low" | "low_mid" | "mid" | "high_mid" | "high" => Some(parts[3].to_string()),
                _ => None,
            };
            if let Some(band) = band {
                let _ = cmd_tx.send(RemoteCommand::SetEqBand {
                    strip: strip_idx,
                    band,
                    value_db: val.clamp(-15.0, 15.0),
                });
            }
        }
        _ => {}
    }
}
