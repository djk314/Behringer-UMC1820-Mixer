use super::state::{MidiMessage, MidiPortFilter, StripMidiDevice};
use midir::{Ignore, MidiInput, MidiInputConnection};
use ringbuf::traits::Producer;
use std::sync::{Arc, Mutex};

pub fn list_midi_inputs() -> Vec<String> {
    let Ok(midi_in) = MidiInput::new("umc1820-midi-scan") else {
        return Vec::new();
    };
    midi_in
        .ports()
        .iter()
        .filter_map(|p| midi_in.port_name(p).ok())
        .collect()
}

pub struct MidiInputManager {
    sender: Arc<Mutex<Option<ringbuf::HeapProd<MidiMessage>>>>,
    connections: Vec<MidiInputConnection<()>>,
    ports: Vec<String>,
    enabled: bool,
    last_error: Option<String>,
}

impl MidiInputManager {
    pub fn new() -> Self {
        let mut mgr = Self {
            sender: Arc::new(Mutex::new(None)),
            connections: Vec::new(),
            ports: Vec::new(),
            enabled: true,
            last_error: None,
        };
        mgr.refresh_ports();
        mgr
    }

    pub fn attach_sender(&mut self, tx: Option<ringbuf::HeapProd<MidiMessage>>) {
        if let Ok(mut guard) = self.sender.lock() {
            *guard = tx;
        }
    }

    pub fn ports(&self) -> &[String] {
        &self.ports
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        if self.enabled != enabled {
            self.enabled = enabled;
            self.reconnect();
        }
    }

    pub fn connected_count(&self) -> usize {
        self.connections.len()
    }

    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    pub fn resolve_filter(&self, device: &StripMidiDevice) -> MidiPortFilter {
        if !self.enabled {
            return MidiPortFilter::None;
        }
        match device {
            StripMidiDevice::All => MidiPortFilter::All,
            StripMidiDevice::None => MidiPortFilter::None,
            StripMidiDevice::Port(name) => self
                .ports
                .iter()
                .position(|p| p == name)
                .and_then(|idx| u8::try_from(idx).ok())
                .map(MidiPortFilter::PortIndex)
                .unwrap_or(MidiPortFilter::None),
        }
    }

    pub fn refresh_ports(&mut self) {
        self.ports = list_midi_inputs();
        self.reconnect();
    }

    fn reconnect(&mut self) {
        self.connections.clear();
        self.last_error = None;

        if !self.enabled {
            return;
        }

        for (idx, port_name) in self.ports.iter().enumerate() {
            let Ok(port_id) = u8::try_from(idx) else {
                break;
            };
            let mut midi_in = match MidiInput::new("umc1820-studio-mixer") {
                Ok(m) => m,
                Err(e) => {
                    self.last_error = Some(format!("Init MIDI impossible: {e}"));
                    continue;
                }
            };
            midi_in.ignore(Ignore::None);

            let matching_port = midi_in
                .ports()
                .into_iter()
                .find(|p| midi_in.port_name(p).ok().as_deref() == Some(port_name.as_str()));

            let Some(port) = matching_port else {
                continue;
            };

            let sender = Arc::clone(&self.sender);
            let conn_label = format!("umc1820-in-{idx}");
            match midi_in.connect(
                &port,
                &conn_label,
                move |_stamp, bytes, _| {
                    if !bytes.is_empty() && bytes[0] >= 0x80 && bytes[0] < 0xF0 {
                        let len = bytes.len().min(3);
                        let mut msg = MidiMessage {
                            port_id,
                            bytes: [0; 3],
                            len: len as u8,
                        };
                        msg.bytes[..len].copy_from_slice(&bytes[..len]);
                        if let Ok(mut guard) = sender.lock() {
                            if let Some(prod) = guard.as_mut() {
                                let _ = prod.try_push(msg);
                            }
                        }
                    }
                },
                (),
            ) {
                Ok(conn) => self.connections.push(conn),
                Err(e) => {
                    self.last_error = Some(format!("Port MIDI {port_name}: {e}"));
                }
            }
        }
    }
}
