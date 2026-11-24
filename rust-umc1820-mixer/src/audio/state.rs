use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const NUM_INPUT_STRIPS: usize = 8;
pub const NUM_AUX_STRIPS: usize = 4;
pub const MAX_INSERTS_PER_STRIP: usize = 5;
pub const TOTAL_STRIPS: usize = NUM_INPUT_STRIPS + NUM_AUX_STRIPS + 1; // 8 IN + 4 AUX + 1 MASTER

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StripKind {
    Input,
    Aux,
    Master,
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
pub struct FourBandEqParams {
    pub low_db: f32,      // 80 Hz Low Shelf (-15..+15 dB)
    pub low_mid_db: f32,  // 400 Hz Peaking (-15..+15 dB)
    pub high_mid_db: f32, // 2.5 kHz Peaking (-15..+15 dB)
    pub high_db: f32,     // 10 kHz High Shelf (-15..+15 dB)
    pub bypassed: bool,
}

impl Default for FourBandEqParams {
    fn default() -> Self {
        Self {
            low_db: 0.0,
            low_mid_db: 0.0,
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
    /// Gain rotatif (-12 dB .. +24 dB). Non utilisé / non affiché sur la tranche Master.
    pub gain_db: f32,
    /// 5 emplacements d'insert maximum (VST2 / VST3 / Apple AU).
    pub inserts: [InsertSlotState; MAX_INSERTS_PER_STRIP],
    /// Égaliseur 4 bandes à boutons rotatifs.
    pub eq: FourBandEqParams,
    /// 4 envois auxiliaires vers les sorties stéréo UMC1820 (1/2, 3/4, 5/6, 7/8).
    pub aux_sends: [f32; NUM_AUX_STRIPS],
    /// Bouton push Solo (On/Off). Absent de la tranche Master.
    pub solo: bool,
    /// Bouton push Mute (On/Off).
    pub mute: bool,
    /// Fader de volume en dB (-60 dB = -inf, jusqu'à +12 dB).
    pub volume_db: f32,
}

impl StripState {
    pub fn new(index: usize, kind: StripKind, name: String) -> Self {
        Self {
            index,
            kind,
            name,
            gain_db: 0.0,
            inserts: std::array::from_fn(|_| InsertSlotState::default()),
            eq: FourBandEqParams::default(),
            aux_sends: [0.0; NUM_AUX_STRIPS],
            solo: false,
            mute: false,
            volume_db: 0.0,
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

pub enum MixerCommand {
    SetGain { strip: usize, gain_db: f32 },
    SetVolume { strip: usize, volume_db: f32 },
    SetMute { strip: usize, mute: bool },
    SetSolo { strip: usize, solo: bool },
    SetEq { strip: usize, eq: FourBandEqParams },
    SetAuxSend { strip: usize, aux_idx: usize, level: f32 },
    InstallInsert {
        strip: usize,
        slot: usize,
        plugin: Option<Box<dyn super::plugin_host::HostedPlugin>>,
    },
    BypassInsert { strip: usize, slot: usize, bypassed: bool },
    SetPluginParam { strip: usize, slot: usize, param_id: u32, value: f32 },
}
