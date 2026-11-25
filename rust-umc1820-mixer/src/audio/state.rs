use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

pub const NUM_INPUT_STRIPS: usize = 8;
pub const MAX_AUX_PAIRS: usize = 4;
pub const NUM_AUX_STRIPS: usize = MAX_AUX_PAIRS * 2; // 8 bus Aux (4 paires stéréo ou 8 mono séparés)
pub const MAX_INSERTS_PER_STRIP: usize = 5;
pub const TOTAL_STRIPS: usize = NUM_INPUT_STRIPS + NUM_AUX_STRIPS + 1; // 8 IN + 8 AUX + 1 MASTER

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StripKind {
    Input,
    Aux,
    Master,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InputSourceRoute {
    None,
    Mono(usize),
    StereoPair(usize),
}

impl Default for InputSourceRoute {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OutputTargetRoute {
    None,
    MasterBus,
    Mono(usize),
    StereoPair(usize),
}

impl Default for OutputTargetRoute {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PluginFormat {
    AudioUnit, // macOS uniquement (.component)
    Vst3,      // macOS (.vst3) & Linux (.vst3)
    Vst2,      // macOS (.vst) & Linux (.so)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPlugin {
    pub name: String,
    pub vendor: String,
    pub format: PluginFormat,
    pub path: PathBuf,
    /// Identifiant ComponentType/SubType/Manufacturer pour AudioUnit macOS
    pub au_component_code: Option<[u32; 3]>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativePluginHandle {
    AudioUnit { unit_ptr: usize, title: String },
    Vst3 { controller_ptr: usize, title: String },
    Vst2 { effect_ptr: usize, title: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginParamDesc {
    pub id: u32,
    pub name: String,
    pub unit: String,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub value: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsertSlotState {
    pub plugin: Option<DiscoveredPlugin>,
    pub bypassed: bool,
    pub params: Vec<PluginParamDesc>,
}

impl Default for InsertSlotState {
    fn default() -> Self {
        Self {
            plugin: None,
            bypassed: false,
            params: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FiveBandEqParams {
    pub low_db: f32,      // 80 Hz Low Shelf (-15..+15 dB)
    pub low_mid_db: f32,  // 400 Hz Peaking (-15..+15 dB)
    #[serde(default)]
    pub mid_db: f32,      // 1 kHz Peaking (-15..+15 dB) — potentiomètre central
    pub high_mid_db: f32, // 2.5 kHz Peaking (-15..+15 dB)
    pub high_db: f32,     // 10 kHz High Shelf (-15..+15 dB)
    pub bypassed: bool,
}

impl Default for FiveBandEqParams {
    fn default() -> Self {
        Self {
            low_db: 0.0,
            low_mid_db: 0.0,
            mid_db: 0.0,
            high_mid_db: 0.0,
            high_db: 0.0,
            bypassed: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StripState {
    pub index: usize,
    pub kind: StripKind,
    pub name: String,
    /// Sélection d'entrée matérielle (tranches Input)
    #[serde(default)]
    pub input_route: InputSourceRoute,
    /// Sélection de sortie matérielle / bus (tranches Aux et Master)
    #[serde(default)]
    pub output_route: OutputTargetRoute,
    /// Gain rotatif (-12 dB .. +24 dB). Non utilisé / non affiché sur la tranche Master.
    pub gain_db: f32,
    /// 5 emplacements d'insert maximum (VST2 / VST3 / Apple AU).
    pub inserts: [InsertSlotState; MAX_INSERTS_PER_STRIP],
    /// Égaliseur 5 bandes à boutons rotatifs.
    pub eq: FiveBandEqParams,
    /// 8 envois auxiliaires (4 paires stéréo ou 8 mono indépendants).
    #[serde(default)]
    pub aux_sends: Vec<f32>,
    /// Bouton push Solo (On/Off). Absent de la tranche Master.
    pub solo: bool,
    /// Bouton push Mute (On/Off).
    pub mute: bool,
    /// Fader de volume en dB (-60 dB = -inf, jusqu'à +12 dB).
    pub volume_db: f32,
    /// Routage MIDI de la tranche : None = Off, Some(0) = Omni (1..16), Some(1..=16) = canal fixe.
    #[serde(default)]
    pub midi_mode: Option<u8>,
}

impl StripState {
    pub fn new(index: usize, kind: StripKind, name: String) -> Self {
        let input_route = if kind == StripKind::Input {
            InputSourceRoute::Mono(index)
        } else {
            InputSourceRoute::None
        };
        let output_route = match kind {
            StripKind::Input => OutputTargetRoute::None,
            StripKind::Aux => {
                let aux_i = index.saturating_sub(NUM_INPUT_STRIPS);
                if aux_i % 2 == 0 {
                    OutputTargetRoute::StereoPair(aux_i)
                } else {
                    OutputTargetRoute::Mono(aux_i)
                }
            }
            StripKind::Master => OutputTargetRoute::StereoPair(8),
        };
        Self {
            index,
            kind,
            name,
            input_route,
            output_route,
            gain_db: 0.0,
            inserts: std::array::from_fn(|_| InsertSlotState::default()),
            eq: FiveBandEqParams::default(),
            aux_sends: vec![0.0; NUM_AUX_STRIPS],
            solo: false,
            mute: false,
            volume_db: 0.0,
            midi_mode: if kind == StripKind::Input { Some(0) } else { None },
        }
    }

    pub fn normalize(&mut self, expected_index: usize) {
        self.index = expected_index;
        if self.aux_sends.len() < NUM_AUX_STRIPS {
            self.aux_sends.resize(NUM_AUX_STRIPS, 0.0);
        } else if self.aux_sends.len() > NUM_AUX_STRIPS {
            self.aux_sends.truncate(NUM_AUX_STRIPS);
        }
    }
}

fn default_player_gain() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MixerSetFile {
    pub version: u32,
    #[serde(default = "default_aux_pairs")]
    pub aux_pair_stereo: [bool; MAX_AUX_PAIRS],
    pub strips: Vec<StripState>,
    #[serde(default)]
    pub selected_device: Option<String>,
    #[serde(default)]
    pub player_file_path: Option<String>,
    #[serde(default)]
    pub player_loop: bool,
    #[serde(default = "default_player_gain")]
    pub player_gain: f32,
    #[serde(default)]
    pub player_target: Option<usize>,
}

fn default_aux_pairs() -> [bool; MAX_AUX_PAIRS] {
    [true; MAX_AUX_PAIRS]
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MidiMessage {
    pub bytes: [u8; 3],
    pub len: u8,
}

impl MidiMessage {
    #[inline]
    pub fn channel(&self) -> Option<u8> {
        if self.len > 0 && self.bytes[0] >= 0x80 && self.bytes[0] < 0xF0 {
            Some((self.bytes[0] & 0x0F) + 1)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MeterFrame {
    pub peak_l: f32,
    pub peak_r: f32,
    pub rms_l: f32,
    pub rms_r: f32,
    pub clip: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PlayerProgress {
    pub playing: bool,
    pub pos_secs: f32,
    pub duration_secs: f32,
}

pub enum MixerCommand {
    SetGain { strip: usize, gain_db: f32 },
    SetVolume { strip: usize, volume_db: f32 },
    SetMute { strip: usize, mute: bool },
    SetSolo { strip: usize, solo: bool },
    SetEq { strip: usize, eq: FiveBandEqParams },
    SetAuxSend { strip: usize, aux_idx: usize, level: f32 },
    SetAuxPairStereo { pair: usize, stereo: bool },
    SetInputRoute { strip: usize, route: InputSourceRoute },
    SetOutputRoute { strip: usize, route: OutputTargetRoute },
    SetStripMidiMode { strip: usize, mode: Option<u8> },
    InstallInsert {
        strip: usize,
        slot: usize,
        plugin: Option<Box<dyn super::plugin_host::HostedPlugin>>,
    },
    BypassInsert { strip: usize, slot: usize, bypassed: bool },
    SetPluginParam { strip: usize, slot: usize, param_id: u32, value: f32 },
    LoadAudioTrack(Option<Arc<super::player::DecodedAudioTrack>>),
    PlayerPlay,
    PlayerPause,
    PlayerStop,
    PlayerSeek(f32),
    PlayerSetLoop(bool),
    PlayerSetGain(f32),
    PlayerSetTarget(Option<usize>),
}
