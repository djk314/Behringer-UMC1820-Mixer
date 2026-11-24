export interface RustProjectFile {
  path: string;
  language: 'toml' | 'rust' | 'markdown';
  description: string;
  content: string;
}

export const RUST_PROJECT_FILES: RustProjectFile[] = [
  {
    path: 'Cargo.toml',
    language: 'toml',
    description: 'Dépendances Rust cross-platform (eframe/egui, cpal CoreAudio/ALSA, ringbuf, libloading, coreaudio-sys)',
    content: `[package]
name = "umc1820-studio-mixer"
version = "0.1.0"
edition = "2021"
description = "Console de mixage 8+4+Master pour Behringer UMC1820 via CoreAudio/ALSA avec inserts VST2/VST3/AU (max 5/tranche)"

[dependencies]
eframe = "0.29"
egui = "0.29"
cpal = "0.15"
ringbuf = "0.4"
libloading = "0.8"
serde = { version = "1.0", features = ["derive"] }

[target.'cfg(target_os = "macos")'.dependencies]
coreaudio-sys = { version = "0.2", features = ["audio_toolbox", "audio_unit", "core_audio"] }

[target.'cfg(target_os = "linux")'.dependencies]
# Sur Linux, cpal utilise ALSA par défaut ; décommenter la feature jack si souhaité :
# cpal = { version = "0.15", features = ["jack"] }
libc = "0.2"

[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
`,
  },
  {
    path: 'src/main.rs',
    language: 'rust',
    description: 'Point d’entrée eframe/egui, initialisation du moteur audio CoreAudio / ALSA',
    content: `mod audio;
mod ui;

use eframe::egui;
use ui::mixer_app::UmcMixerApp;

fn main() -> eframe::Result<()> {
    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("UMC1820 Studio Mixer — CoreAudio / ALSA")
            .with_inner_size([1200.0, 700.0])
            .with_min_inner_size([480.0, 360.0]),
        ..Default::default()
    };

    eframe::run_native(
        "UMC1820 Studio Mixer",
        native_options,
        Box::new(|cc| {
            let mut visuals = egui::Visuals::dark();
            visuals.panel_fill = egui::Color32::from_rgb(11, 14, 20);
            visuals.window_fill = egui::Color32::from_rgb(19, 23, 32);
            cc.egui_ctx.set_visuals(visuals);
            Ok(Box::new(UmcMixerApp::new()))
        }),
    )
}
`,
  },
  {
    path: 'src/audio/mod.rs',
    language: 'rust',
    description: 'Module audio regroupant état, DSP, moteur CoreAudio/ALSA et hôte de plugins',
    content: `pub mod dsp;
pub mod engine;
pub mod plugin_host;
pub mod state;
pub mod vst3_abi;
`,
  },
  {
    path: 'src/audio/state.rs',
    language: 'rust',
    description: 'Modèle de données du mixer : 8 entrées, 4 sorties Aux stéréo, Master sans Gain/Solo, max 5 inserts',
    content: `use serde::{Deserialize, Serialize};
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
`,
  },
  {
    path: 'src/audio/dsp.rs',
    language: 'rust',
    description: 'DSP temps réel sans allocation : EQ Biquad 4 bandes (Audio EQ Cookbook), conversions dB, VU-mètre balistique',
    content: `use super::state::{FourBandEqParams, MeterFrame};
use std::f32::consts::PI;

#[inline]
pub fn db_to_linear(db: f32) -> f32 {
    if db <= -59.5 {
        0.0
    } else {
        10.0_f32.powf(db / 20.0)
    }
}

#[inline]
pub fn linear_to_db(lin: f32) -> f32 {
    if lin <= 1e-5 {
        -60.0
    } else {
        (20.0 * lin.log10()).clamp(-60.0, 12.0)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1_l: f32,
    z2_l: f32,
    z1_r: f32,
    z2_r: f32,
}

impl Default for Biquad {
    fn default() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1_l: 0.0,
            z2_l: 0.0,
            z1_r: 0.0,
            z2_r: 0.0,
        }
    }
}

impl Biquad {
    pub fn set_peaking(&mut self, sample_rate: f32, freq: f32, q: f32, gain_db: f32) {
        let a = 10.0_f32.powf(gain_db / 40.0);
        let omega = 2.0 * PI * (freq / sample_rate).clamp(0.001, 0.45);
        let alpha = omega.sin() / (2.0 * q.max(0.1));
        let cos_w = omega.cos();

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos_w;
        let a2 = 1.0 - alpha / a;

        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    pub fn set_low_shelf(&mut self, sample_rate: f32, freq: f32, gain_db: f32) {
        let a = 10.0_f32.powf(gain_db / 40.0);
        let omega = 2.0 * PI * (freq / sample_rate).clamp(0.001, 0.45);
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let beta = (a.sqrt()) * sin_w * 1.4142135; // S = 1.0

        let a0 = (a + 1.0) + (a - 1.0) * cos_w + beta;
        self.b0 = (a * ((a + 1.0) - (a - 1.0) * cos_w + beta)) / a0;
        self.b1 = (2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w)) / a0;
        self.b2 = (a * ((a + 1.0) - (a - 1.0) * cos_w - beta)) / a0;
        self.a1 = (-2.0 * ((a - 1.0) + (a + 1.0) * cos_w)) / a0;
        self.a2 = ((a + 1.0) + (a - 1.0) * cos_w - beta) / a0;
    }

    pub fn set_high_shelf(&mut self, sample_rate: f32, freq: f32, gain_db: f32) {
        let a = 10.0_f32.powf(gain_db / 40.0);
        let omega = 2.0 * PI * (freq / sample_rate).clamp(0.001, 0.45);
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let beta = (a.sqrt()) * sin_w * 1.4142135;

        let a0 = (a + 1.0) - (a - 1.0) * cos_w + beta;
        self.b0 = (a * ((a + 1.0) + (a - 1.0) * cos_w + beta)) / a0;
        self.b1 = (-2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w)) / a0;
        self.b2 = (a * ((a + 1.0) + (a - 1.0) * cos_w - beta)) / a0;
        self.a1 = (2.0 * ((a - 1.0) - (a + 1.0) * cos_w)) / a0;
        self.a2 = ((a + 1.0) - (a - 1.0) * cos_w - beta) / a0;
    }

    #[inline]
    pub fn process_stereo(&mut self, l: f32, r: f32) -> (f32, f32) {
        let out_l = self.b0 * l + self.z1_l;
        self.z1_l = self.b1 * l - self.a1 * out_l + self.z2_l;
        self.z2_l = self.b2 * l - self.a2 * out_l;

        let out_r = self.b0 * r + self.z1_r;
        self.z1_r = self.b1 * r - self.a1 * out_r + self.z2_r;
        self.z2_r = self.b2 * r - self.a2 * out_r;

        (out_l, out_r)
    }
}

#[derive(Debug, Clone, Default)]
pub struct FourBandEqProcessor {
    low: Biquad,
    low_mid: Biquad,
    high_mid: Biquad,
    high: Biquad,
    bypassed: bool,
}

impl FourBandEqProcessor {
    pub fn update(&mut self, sample_rate: f32, params: FourBandEqParams) {
        self.bypassed = params.bypassed;
        self.low.set_low_shelf(sample_rate, 80.0, params.low_db);
        self.low_mid.set_peaking(sample_rate, 400.0, 1.0, params.low_mid_db);
        self.high_mid.set_peaking(sample_rate, 2500.0, 1.0, params.high_mid_db);
        self.high.set_high_shelf(sample_rate, 10_000.0, params.high_db);
    }

    #[inline]
    pub fn process(&mut self, mut l: f32, mut r: f32) -> (f32, f32) {
        if self.bypassed {
            return (l, r);
        }
        (l, r) = self.low.process_stereo(l, r);
        (l, r) = self.low_mid.process_stereo(l, r);
        (l, r) = self.high_mid.process_stereo(l, r);
        self.high.process_stereo(l, r)
    }
}

#[derive(Debug, Clone, Default)]
pub struct BallisticMeter {
    peak_l: f32,
    peak_r: f32,
    rms_sq_l: f32,
    rms_sq_r: f32,
    clip_hold: u32,
}

impl BallisticMeter {
    pub fn push_block(&mut self, left: &[f32], right: &[f32], sample_rate: f32) -> MeterFrame {
        let decay = (-1.0 / (0.3 * sample_rate)).exp();
        let rms_alpha = 1.0 - (-1.0 / (0.05 * sample_rate)).exp();

        for (&l, &r) in left.iter().zip(right.iter()) {
            let al = l.abs();
            let ar = r.abs();
            self.peak_l = if al > self.peak_l { al } else { self.peak_l * decay };
            self.peak_r = if ar > self.peak_r { ar } else { self.peak_r * decay };
            self.rms_sq_l += rms_alpha * (l * l - self.rms_sq_l);
            self.rms_sq_r += rms_alpha * (r * r - self.rms_sq_r);
            if al >= 0.99 || ar >= 0.99 {
                self.clip_hold = (sample_rate * 1.5) as u32;
            } else if self.clip_hold > 0 {
                self.clip_hold -= 1;
            }
        }

        MeterFrame {
            peak_l: linear_to_db(self.peak_l),
            peak_r: linear_to_db(self.peak_r),
            rms_l: linear_to_db(self.rms_sq_l.sqrt()),
            rms_r: linear_to_db(self.rms_sq_r.sqrt()),
            clip: self.clip_hold > 0,
        }
    }
}
`,
  },
  {
    path: 'src/audio/vst3_abi.rs',
    language: 'rust',
    description: 'Interfaces C-ABI VST3 complètes (FUnknown, IPluginFactory, IComponent, IAudioProcessor, IEditController, IPlugView, IPlugFrame, IRunLoop)',
    content: `#![allow(dead_code)]

use std::ffi::{c_char, c_void};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[inline]
pub const fn tuid(a: u32, b: u32, c: u32, d: u32) -> [u8; 16] {
    let ab = a.to_be_bytes();
    let bb = b.to_be_bytes();
    let cb = c.to_be_bytes();
    let db = d.to_be_bytes();
    [
        ab[0], ab[1], ab[2], ab[3],
        bb[0], bb[1], bb[2], bb[3],
        cb[0], cb[1], cb[2], cb[3],
        db[0], db[1], db[2], db[3],
    ]
}

pub const K_RESULT_OK: i32 = 0;
pub const K_RESULT_FALSE: i32 = 1;
pub const K_NO_INTERFACE: i32 = -1;
pub const K_NOT_IMPLEMENTED: i32 = 3;

pub const K_MEDIA_AUDIO: i32 = 0;
pub const K_DIR_INPUT: i32 = 0;
pub const K_DIR_OUTPUT: i32 = 1;
pub const K_SAMPLE_32: i32 = 0;
pub const K_REALTIME: i32 = 0;
pub const K_SPEAKER_MONO: u64 = 0x1;
pub const K_SPEAKER_STEREO: u64 = 0x3;

pub const IID_FUNKNOWN: [u8; 16] = tuid(0x00000000, 0x00000000, 0xC0000000, 0x00000046);
pub const IID_IPLUGIN_BASE: [u8; 16] = tuid(0x22888DDB, 0x156E45AE, 0x8358B348, 0x08190625);
pub const IID_IPLUGIN_FACTORY: [u8; 16] = tuid(0x7A4D811C, 0x52114A1F, 0xAED9D2EE, 0x0B43BF9F);
pub const IID_ICOMPONENT: [u8; 16] = tuid(0xE831FF31, 0xF2D54301, 0x928EBBEE, 0x25697802);
pub const IID_IAUDIO_PROCESSOR: [u8; 16] = tuid(0x42043F99, 0xB7DA453C, 0xA569E79D, 0x9AAEC33D);
pub const IID_IEDIT_CONTROLLER: [u8; 16] = tuid(0xDCD7BBE3, 0x7742448D, 0xA874AACC, 0x979C759E);
pub const IID_ICOMPONENT_HANDLER: [u8; 16] = tuid(0x93A0BEA3, 0x0BD045DB, 0x8E890B0C, 0xC1E46AC6);
pub const IID_IHOST_APPLICATION: [u8; 16] = tuid(0x58E595CC, 0xDB2D4969, 0x8B6AAF8C, 0x36A664E5);
pub const IID_ICONNECTION_POINT: [u8; 16] = tuid(0x70A4156F, 0x6E6E4026, 0x989148BF, 0xAA60D8D1);
pub const IID_IPLUG_VIEW: [u8; 16] = tuid(0x5BC32507, 0xD06049EA, 0xA6151B52, 0x2B755B29);
pub const IID_IPLUG_FRAME: [u8; 16] = tuid(0x367FAF01, 0xAFA94693, 0x8D4DA2A0, 0xED0882A3);
pub const IID_IRUN_LOOP: [u8; 16] = tuid(0x18C35366, 0x97764F1A, 0x9C5B8385, 0x7A871389);
pub const IID_IBSTREAM: [u8; 16] = tuid(0xC3BF6EA2, 0x30994752, 0x9B6BF990, 0x1EE33E9B);
pub const IID_IPARAMETER_CHANGES: [u8; 16] = tuid(0xA4779663, 0x0BB64A56, 0xB44384A8, 0x466FEB9D);
pub const IID_IPARAM_VALUE_QUEUE: [u8; 16] = tuid(0x01263A18, 0xED074F6F, 0x98C9D356, 0x4686F9BA);

#[inline]
pub unsafe fn uid_eq(a: *const u8, b: &[u8; 16]) -> bool {
    if a.is_null() {
        return false;
    }
    std::slice::from_raw_parts(a, 16) == b
}

pub fn utf16_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().to_string()
}

pub fn write_utf16(dst: &mut [u16], text: &str) {
    dst.fill(0);
    for (i, ch) in text.encode_utf16().take(dst.len().saturating_sub(1)).enumerate() {
        dst[i] = ch;
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PClassInfo {
    pub cid: [u8; 16],
    pub cardinality: i32,
    pub category: [c_char; 32],
    pub name: [c_char; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BusInfo {
    pub media_type: i32,
    pub direction: i32,
    pub channel_count: i32,
    pub name: [u16; 128],
    pub bus_type: i32,
    pub flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ParameterInfo {
    pub id: u32,
    pub title: [u16; 128],
    pub short_title: [u16; 128],
    pub units: [u16; 128],
    pub step_count: i32,
    pub default_normalized_value: f64,
    pub unit_id: i32,
    pub flags: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ProcessSetup {
    pub process_mode: i32,
    pub symbolic_sample_size: i32,
    pub max_samples_per_block: i32,
    pub sample_rate: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct AudioBusBuffers {
    pub num_channels: i32,
    pub silence_flags: u64,
    pub channel_buffers32: *mut *mut f32,
}

#[repr(C)]
pub struct ProcessData {
    pub process_mode: i32,
    pub symbolic_sample_size: i32,
    pub num_samples: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub inputs: *mut AudioBusBuffers,
    pub outputs: *mut AudioBusBuffers,
    pub input_parameter_changes: *mut c_void,
    pub output_parameter_changes: *mut c_void,
    pub input_events: *mut c_void,
    pub output_events: *mut c_void,
    pub process_context: *mut c_void,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct ViewRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl ViewRect {
    pub fn width(&self) -> i32 {
        (self.right - self.left).max(1)
    }
    pub fn height(&self) -> i32 {
        (self.bottom - self.top).max(1)
    }
}

#[repr(C)]
pub struct ComObj<V> {
    pub vtbl: *const V,
}

#[repr(C)]
pub struct FUnknownVtbl {
    pub query_interface: unsafe extern "C" fn(*mut c_void, *const u8, *mut *mut c_void) -> i32,
    pub add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    pub release: unsafe extern "C" fn(*mut c_void) -> u32,
}

#[repr(C)]
pub struct IPluginFactoryVtbl {
    pub base: FUnknownVtbl,
    pub get_factory_info: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub count_classes: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_class_info: unsafe extern "C" fn(*mut c_void, i32, *mut PClassInfo) -> i32,
    pub create_instance: unsafe extern "C" fn(*mut c_void, *const u8, *const u8, *mut *mut c_void) -> i32,
}

#[repr(C)]
pub struct IComponentVtbl {
    pub base: FUnknownVtbl,
    pub initialize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub terminate: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_controller_class_id: unsafe extern "C" fn(*mut c_void, *mut [u8; 16]) -> i32,
    pub set_io_mode: unsafe extern "C" fn(*mut c_void, i32) -> i32,
    pub get_bus_count: unsafe extern "C" fn(*mut c_void, i32, i32) -> i32,
    pub get_bus_info: unsafe extern "C" fn(*mut c_void, i32, i32, i32, *mut BusInfo) -> i32,
    pub get_routing_info: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32,
    pub activate_bus: unsafe extern "C" fn(*mut c_void, i32, i32, i32, u8) -> i32,
    pub set_active: unsafe extern "C" fn(*mut c_void, u8) -> i32,
    pub set_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub get_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
}

#[repr(C)]
pub struct IAudioProcessorVtbl {
    pub base: FUnknownVtbl,
    pub set_bus_arrangements: unsafe extern "C" fn(*mut c_void, *mut u64, i32, *mut u64, i32) -> i32,
    pub get_bus_arrangement: unsafe extern "C" fn(*mut c_void, i32, i32, *mut u64) -> i32,
    pub can_process_sample_size: unsafe extern "C" fn(*mut c_void, i32) -> i32,
    pub get_latency_samples: unsafe extern "C" fn(*mut c_void) -> u32,
    pub setup_processing: unsafe extern "C" fn(*mut c_void, *mut ProcessSetup) -> i32,
    pub set_processing: unsafe extern "C" fn(*mut c_void, u8) -> i32,
    pub process: unsafe extern "C" fn(*mut c_void, *mut ProcessData) -> i32,
    pub get_tail_samples: unsafe extern "C" fn(*mut c_void) -> u32,
}

#[repr(C)]
pub struct IEditControllerVtbl {
    pub base: FUnknownVtbl,
    pub initialize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub terminate: unsafe extern "C" fn(*mut c_void) -> i32,
    pub set_component_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub set_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub get_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub get_parameter_count: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_parameter_info: unsafe extern "C" fn(*mut c_void, i32, *mut ParameterInfo) -> i32,
    pub get_param_string_by_value: unsafe extern "C" fn(*mut c_void, u32, f64, *mut [u16; 128]) -> i32,
    pub get_param_value_by_string: unsafe extern "C" fn(*mut c_void, u32, *const u16, *mut f64) -> i32,
    pub normalized_param_to_plain: unsafe extern "C" fn(*mut c_void, u32, f64) -> f64,
    pub plain_param_to_normalized: unsafe extern "C" fn(*mut c_void, u32, f64) -> f64,
    pub get_param_normalized: unsafe extern "C" fn(*mut c_void, u32) -> f64,
    pub set_param_normalized: unsafe extern "C" fn(*mut c_void, u32, f64) -> i32,
    pub set_component_handler: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub create_view: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut ComObj<IPlugViewVtbl>,
}

#[repr(C)]
pub struct IConnectionPointVtbl {
    pub base: FUnknownVtbl,
    pub connect: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub disconnect: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub notify: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
}

#[repr(C)]
pub struct IPlugViewVtbl {
    pub base: FUnknownVtbl,
    pub is_platform_type_supported: unsafe extern "C" fn(*mut c_void, *const c_char) -> i32,
    pub attached: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> i32,
    pub removed: unsafe extern "C" fn(*mut c_void) -> i32,
    pub on_wheel: unsafe extern "C" fn(*mut c_void, f32) -> i32,
    pub on_key_down: unsafe extern "C" fn(*mut c_void, u16, i16, i16) -> i32,
    pub on_key_up: unsafe extern "C" fn(*mut c_void, u16, i16, i16) -> i32,
    pub get_size: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> i32,
    pub on_size: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> i32,
    pub on_focus: unsafe extern "C" fn(*mut c_void, u8) -> i32,
    pub set_frame: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub can_resize: unsafe extern "C" fn(*mut c_void) -> i32,
    pub check_size_constraint: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> i32,
}

#[repr(C)]
pub struct IPlugFrameVtbl {
    pub base: FUnknownVtbl,
    pub resize_view: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut ViewRect) -> i32,
}

#[repr(C)]
pub struct IRunLoopVtbl {
    pub base: FUnknownVtbl,
    pub register_event_handler: unsafe extern "C" fn(*mut c_void, *mut ComObj<IEventHandlerVtbl>, i32) -> i32,
    pub unregister_event_handler: unsafe extern "C" fn(*mut c_void, *mut ComObj<IEventHandlerVtbl>) -> i32,
    pub register_timer: unsafe extern "C" fn(*mut c_void, *mut ComObj<ITimerHandlerVtbl>, u64) -> i32,
    pub unregister_timer: unsafe extern "C" fn(*mut c_void, *mut ComObj<ITimerHandlerVtbl>) -> i32,
}

#[repr(C)]
pub struct IEventHandlerVtbl {
    pub base: FUnknownVtbl,
    pub on_fd_is_set: unsafe extern "C" fn(*mut c_void, i32),
}

#[repr(C)]
pub struct ITimerHandlerVtbl {
    pub base: FUnknownVtbl,
    pub on_timer: unsafe extern "C" fn(*mut c_void),
}

#[repr(C)]
pub struct IHostApplicationVtbl {
    pub base: FUnknownVtbl,
    pub get_name: unsafe extern "C" fn(*mut c_void, *mut [u16; 128]) -> i32,
    pub create_instance: unsafe extern "C" fn(*mut c_void, *const u8, *const u8, *mut *mut c_void) -> i32,
}

#[repr(C)]
pub struct IComponentHandlerVtbl {
    pub base: FUnknownVtbl,
    pub begin_edit: unsafe extern "C" fn(*mut c_void, u32) -> i32,
    pub perform_edit: unsafe extern "C" fn(*mut c_void, u32, f64) -> i32,
    pub end_edit: unsafe extern "C" fn(*mut c_void, u32) -> i32,
    pub restart_component: unsafe extern "C" fn(*mut c_void, i32) -> i32,
}

#[repr(C)]
pub struct IBStreamVtbl {
    pub base: FUnknownVtbl,
    pub read: unsafe extern "C" fn(*mut c_void, *mut c_void, i32, *mut i32) -> i32,
    pub write: unsafe extern "C" fn(*mut c_void, *const c_void, i32, *mut i32) -> i32,
    pub seek: unsafe extern "C" fn(*mut c_void, i64, i32, *mut i64) -> i32,
    pub tell: unsafe extern "C" fn(*mut c_void, *mut i64) -> i32,
}

#[repr(C)]
pub struct IParameterChangesVtbl {
    pub base: FUnknownVtbl,
    pub get_parameter_count: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_parameter_data: unsafe extern "C" fn(*mut c_void, i32) -> *mut c_void,
    pub add_parameter_data: unsafe extern "C" fn(*mut c_void, *const u32, *mut i32) -> *mut c_void,
}

#[repr(C)]
pub struct IParamValueQueueVtbl {
    pub base: FUnknownVtbl,
    pub get_parameter_id: unsafe extern "C" fn(*mut c_void) -> u32,
    pub get_point_count: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_point: unsafe extern "C" fn(*mut c_void, i32, *mut i32, *mut f64) -> i32,
    pub add_point: unsafe extern "C" fn(*mut c_void, i32, f64, *mut i32) -> i32,
}

// ---------- Implémentations côté hôte ----------

#[repr(C)]
pub struct HostApplication {
    pub vtbl: *const IHostApplicationVtbl,
    ref_count: AtomicU32,
}

static HOST_APP_VTBL: IHostApplicationVtbl = IHostApplicationVtbl {
    base: FUnknownVtbl {
        query_interface: host_app_qi,
        add_ref: host_app_add_ref,
        release: host_app_release,
    },
    get_name: host_app_get_name,
    create_instance: host_app_create_instance,
};

impl HostApplication {
    pub fn new_raw() -> *mut Self {
        Box::into_raw(Box::new(Self {
            vtbl: &HOST_APP_VTBL,
            ref_count: AtomicU32::new(1),
        }))
    }
}

unsafe extern "C" fn host_app_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IHOST_APPLICATION) {
        host_app_add_ref(this);
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn host_app_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostApplication);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "C" fn host_app_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostApplication);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut HostApplication));
        0
    } else {
        prev - 1
    }
}

unsafe extern "C" fn host_app_get_name(_this: *mut c_void, name: *mut [u16; 128]) -> i32 {
    if !name.is_null() {
        write_utf16(&mut *name, "UMC1820 Studio Mixer");
    }
    K_RESULT_OK
}

unsafe extern "C" fn host_app_create_instance(
    _this: *mut c_void,
    _cid: *const u8,
    _iid: *const u8,
    obj: *mut *mut c_void,
) -> i32 {
    if !obj.is_null() {
        *obj = std::ptr::null_mut();
    }
    K_NOT_IMPLEMENTED
}

// ---------- HostComponentHandler ----------

#[repr(C)]
pub struct HostComponentHandler {
    pub vtbl: *const IComponentHandlerVtbl,
    ref_count: AtomicU32,
    pending_edits: Arc<Mutex<Vec<(u32, f64)>>>,
}

static COMP_HANDLER_VTBL: IComponentHandlerVtbl = IComponentHandlerVtbl {
    base: FUnknownVtbl {
        query_interface: ch_qi,
        add_ref: ch_add_ref,
        release: ch_release,
    },
    begin_edit: ch_begin_edit,
    perform_edit: ch_perform_edit,
    end_edit: ch_end_edit,
    restart_component: ch_restart_component,
};

impl HostComponentHandler {
    pub fn new_raw(pending_edits: Arc<Mutex<Vec<(u32, f64)>>>) -> *mut Self {
        Box::into_raw(Box::new(Self {
            vtbl: &COMP_HANDLER_VTBL,
            ref_count: AtomicU32::new(1),
            pending_edits,
        }))
    }
}

unsafe extern "C" fn ch_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_ICOMPONENT_HANDLER) {
        ch_add_ref(this);
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn ch_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostComponentHandler);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "C" fn ch_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostComponentHandler);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut HostComponentHandler));
        0
    } else {
        prev - 1
    }
}

unsafe extern "C" fn ch_begin_edit(_this: *mut c_void, _id: u32) -> i32 {
    K_RESULT_OK
}

unsafe extern "C" fn ch_perform_edit(this: *mut c_void, id: u32, value: f64) -> i32 {
    let me = &*(this as *const HostComponentHandler);
    if let Ok(mut q) = me.pending_edits.lock() {
        q.push((id, value));
    }
    K_RESULT_OK
}

unsafe extern "C" fn ch_end_edit(_this: *mut c_void, _id: u32) -> i32 {
    K_RESULT_OK
}

unsafe extern "C" fn ch_restart_component(_this: *mut c_void, _flags: i32) -> i32 {
    K_RESULT_OK
}

// ---------- HostBStream (pour synchroniser getState -> setComponentState) ----------

#[repr(C)]
pub struct HostBStream {
    pub vtbl: *const IBStreamVtbl,
    ref_count: AtomicU32,
    data: Vec<u8>,
    pos: usize,
}

static BSTREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    base: FUnknownVtbl {
        query_interface: bs_qi,
        add_ref: bs_add_ref,
        release: bs_release,
    },
    read: bs_read,
    write: bs_write,
    seek: bs_seek,
    tell: bs_tell,
};

impl HostBStream {
    pub fn new_raw() -> *mut Self {
        Box::into_raw(Box::new(Self {
            vtbl: &BSTREAM_VTBL,
            ref_count: AtomicU32::new(1),
            data: Vec::new(),
            pos: 0,
        }))
    }
}

unsafe extern "C" fn bs_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IBSTREAM) {
        bs_add_ref(this);
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn bs_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostBStream);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "C" fn bs_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostBStream);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut HostBStream));
        0
    } else {
        prev - 1
    }
}

unsafe extern "C" fn bs_read(
    this: *mut c_void,
    buffer: *mut c_void,
    num_bytes: i32,
    num_bytes_read: *mut i32,
) -> i32 {
    let me = &mut *(this as *mut HostBStream);
    if buffer.is_null() || num_bytes <= 0 || me.pos >= me.data.len() {
        if !num_bytes_read.is_null() {
            *num_bytes_read = 0;
        }
        return K_RESULT_OK;
    }
    let avail = (me.data.len() - me.pos).min(num_bytes as usize);
    std::ptr::copy_nonoverlapping(me.data[me.pos..].as_ptr(), buffer as *mut u8, avail);
    me.pos += avail;
    if !num_bytes_read.is_null() {
        *num_bytes_read = avail as i32;
    }
    K_RESULT_OK
}

unsafe extern "C" fn bs_write(
    this: *mut c_void,
    buffer: *const c_void,
    num_bytes: i32,
    num_bytes_written: *mut i32,
) -> i32 {
    let me = &mut *(this as *mut HostBStream);
    if buffer.is_null() || num_bytes <= 0 {
        if !num_bytes_written.is_null() {
            *num_bytes_written = 0;
        }
        return K_RESULT_OK;
    }
    let count = num_bytes as usize;
    let slice = std::slice::from_raw_parts(buffer as *const u8, count);
    if me.pos + count > me.data.len() {
        me.data.resize(me.pos + count, 0);
    }
    me.data[me.pos..me.pos + count].copy_from_slice(slice);
    me.pos += count;
    if !num_bytes_written.is_null() {
        *num_bytes_written = count as i32;
    }
    K_RESULT_OK
}

unsafe extern "C" fn bs_seek(
    this: *mut c_void,
    pos: i64,
    mode: i32,
    result: *mut i64,
) -> i32 {
    let me = &mut *(this as *mut HostBStream);
    let base: i64 = match mode {
        0 => 0,
        1 => me.pos as i64,
        2 => me.data.len() as i64,
        _ => return K_RESULT_FALSE,
    };
    let next = (base + pos).max(0) as usize;
    me.pos = next.min(me.data.len());
    if !result.is_null() {
        *result = me.pos as i64;
    }
    K_RESULT_OK
}

unsafe extern "C" fn bs_tell(this: *mut c_void, pos: *mut i64) -> i32 {
    let me = &*(this as *const HostBStream);
    if !pos.is_null() {
        *pos = me.pos as i64;
    }
    K_RESULT_OK
}

// ---------- HostParameterChanges (temps réel vers IAudioProcessor::process) ----------

#[repr(C)]
pub struct HostParamValueQueue {
    vtbl: *const IParamValueQueueVtbl,
    param_id: u32,
    value: f64,
}

static PARAM_QUEUE_VTBL: IParamValueQueueVtbl = IParamValueQueueVtbl {
    base: FUnknownVtbl {
        query_interface: pq_qi,
        add_ref: noop_ref,
        release: noop_ref,
    },
    get_parameter_id: pq_get_id,
    get_point_count: pq_get_point_count,
    get_point: pq_get_point,
    add_point: pq_add_point,
};

#[repr(C)]
pub struct HostParameterChanges {
    vtbl: *const IParameterChangesVtbl,
    queues: Vec<Box<HostParamValueQueue>>,
}

static PARAM_CHANGES_VTBL: IParameterChangesVtbl = IParameterChangesVtbl {
    base: FUnknownVtbl {
        query_interface: pc_qi,
        add_ref: noop_ref,
        release: noop_ref,
    },
    get_parameter_count: pc_get_count,
    get_parameter_data: pc_get_data,
    add_parameter_data: pc_add_data,
};

impl HostParameterChanges {
    pub fn new() -> Self {
        Self {
            vtbl: &PARAM_CHANGES_VTBL,
            queues: Vec::with_capacity(32),
        }
    }

    pub fn clear(&mut self) {
        self.queues.clear();
    }

    pub fn push(&mut self, param_id: u32, value: f64) {
        if let Some(existing) = self.queues.iter_mut().find(|q| q.param_id == param_id) {
            existing.value = value;
        } else {
            self.queues.push(Box::new(HostParamValueQueue {
                vtbl: &PARAM_QUEUE_VTBL,
                param_id,
                value,
            }));
        }
    }
}

unsafe extern "C" fn noop_ref(_this: *mut c_void) -> u32 {
    1
}

unsafe extern "C" fn pq_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IPARAM_VALUE_QUEUE) {
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn pq_get_id(this: *mut c_void) -> u32 {
    (*(this as *const HostParamValueQueue)).param_id
}

unsafe extern "C" fn pq_get_point_count(_this: *mut c_void) -> i32 {
    1
}

unsafe extern "C" fn pq_get_point(
    this: *mut c_void,
    index: i32,
    sample_offset: *mut i32,
    value: *mut f64,
) -> i32 {
    if index != 0 {
        return K_RESULT_FALSE;
    }
    let q = &*(this as *const HostParamValueQueue);
    if !sample_offset.is_null() {
        *sample_offset = 0;
    }
    if !value.is_null() {
        *value = q.value;
    }
    K_RESULT_OK
}

unsafe extern "C" fn pq_add_point(
    _this: *mut c_void,
    _sample_offset: i32,
    _value: f64,
    _index: *mut i32,
) -> i32 {
    K_NOT_IMPLEMENTED
}

unsafe extern "C" fn pc_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IPARAMETER_CHANGES) {
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn pc_get_count(this: *mut c_void) -> i32 {
    (*(this as *const HostParameterChanges)).queues.len() as i32
}

unsafe extern "C" fn pc_get_data(this: *mut c_void, index: i32) -> *mut c_void {
    let me = &mut *(this as *mut HostParameterChanges);
    if index < 0 || (index as usize) >= me.queues.len() {
        std::ptr::null_mut()
    } else {
        me.queues[index as usize].as_mut() as *mut HostParamValueQueue as *mut c_void
    }
}

unsafe extern "C" fn pc_add_data(
    _this: *mut c_void,
    _id: *const u32,
    _index: *mut i32,
) -> *mut c_void {
    std::ptr::null_mut()
}

// ---------- HostPlugFrame + IRunLoop (macOS & Linux GUI) ----------

#[derive(Clone)]
pub struct RegisteredEventHandler {
    pub fd: i32,
    pub handler: *mut ComObj<IEventHandlerVtbl>,
}

#[derive(Clone)]
pub struct RegisteredTimer {
    pub handler: *mut ComObj<ITimerHandlerVtbl>,
    pub interval_ms: u64,
    pub last_fired: Instant,
}

#[derive(Default)]
pub struct PlugFrameState {
    pub pending_resize: Option<(i32, i32)>,
    pub event_handlers: Vec<RegisteredEventHandler>,
    pub timers: Vec<RegisteredTimer>,
}

impl PlugFrameState {
    pub unsafe fn clear_run_loop(&mut self) {
        for ev in self.event_handlers.drain(..) {
            if !ev.handler.is_null() {
                ((*(*ev.handler).vtbl).base.release)(ev.handler as *mut c_void);
            }
        }
        for t in self.timers.drain(..) {
            if !t.handler.is_null() {
                ((*(*t.handler).vtbl).base.release)(t.handler as *mut c_void);
            }
        }
    }
}

#[repr(C)]
pub struct HostPlugFrame {
    pub vtbl: *const IPlugFrameVtbl,
    pub run_loop_vtbl: *const IRunLoopVtbl,
    pub ref_count: AtomicU32,
    pub state: Arc<Mutex<PlugFrameState>>,
}

static PLUG_FRAME_VTBL: IPlugFrameVtbl = IPlugFrameVtbl {
    base: FUnknownVtbl {
        query_interface: pf_qi,
        add_ref: pf_add_ref,
        release: pf_release,
    },
    resize_view: pf_resize_view,
};

static RUN_LOOP_VTBL: IRunLoopVtbl = IRunLoopVtbl {
    base: FUnknownVtbl {
        query_interface: rl_qi,
        add_ref: rl_add_ref,
        release: rl_release,
    },
    register_event_handler: rl_register_event_handler,
    unregister_event_handler: rl_unregister_event_handler,
    register_timer: rl_register_timer,
    unregister_timer: rl_unregister_timer,
};

impl HostPlugFrame {
    pub fn new_raw(state: Arc<Mutex<PlugFrameState>>) -> *mut Self {
        Box::into_raw(Box::new(Self {
            vtbl: &PLUG_FRAME_VTBL,
            run_loop_vtbl: &RUN_LOOP_VTBL,
            ref_count: AtomicU32::new(1),
            state,
        }))
    }
}

#[inline]
unsafe fn frame_from_run_loop(ptr: *mut c_void) -> *mut HostPlugFrame {
    (ptr as *mut u8).sub(std::mem::offset_of!(HostPlugFrame, run_loop_vtbl)) as *mut HostPlugFrame
}

unsafe extern "C" fn pf_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    let me = &mut *(this as *mut HostPlugFrame);
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IPLUG_FRAME) {
        pf_add_ref(this);
        *obj = this;
        K_RESULT_OK
    } else if uid_eq(iid, &IID_IRUN_LOOP) {
        pf_add_ref(this);
        *obj = &mut me.run_loop_vtbl as *mut *const IRunLoopVtbl as *mut c_void;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn pf_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostPlugFrame);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "C" fn pf_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostPlugFrame);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut HostPlugFrame));
        0
    } else {
        prev - 1
    }
}

unsafe extern "C" fn pf_resize_view(
    this: *mut c_void,
    view: *mut c_void,
    new_size: *mut ViewRect,
) -> i32 {
    if new_size.is_null() {
        return K_RESULT_FALSE;
    }
    let me = &*(this as *const HostPlugFrame);
    let rect = *new_size;
    if let Ok(mut st) = me.state.lock() {
        st.pending_resize = Some((rect.width(), rect.height()));
    }
    if !view.is_null() {
        let pv = view as *mut ComObj<IPlugViewVtbl>;
        ((*(*pv).vtbl).on_size)(view, new_size);
    }
    K_RESULT_OK
}

unsafe extern "C" fn rl_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    pf_qi(frame_from_run_loop(this) as *mut c_void, iid, obj)
}

unsafe extern "C" fn rl_add_ref(this: *mut c_void) -> u32 {
    pf_add_ref(frame_from_run_loop(this) as *mut c_void)
}

unsafe extern "C" fn rl_release(this: *mut c_void) -> u32 {
    pf_release(frame_from_run_loop(this) as *mut c_void)
}

unsafe extern "C" fn rl_register_event_handler(
    this: *mut c_void,
    handler: *mut ComObj<IEventHandlerVtbl>,
    fd: i32,
) -> i32 {
    if handler.is_null() {
        return K_RESULT_FALSE;
    }
    let me = &*(frame_from_run_loop(this));
    if let Ok(mut st) = me.state.lock() {
        if !st.event_handlers.iter().any(|h| h.handler == handler && h.fd == fd) {
            ((*(*handler).vtbl).base.add_ref)(handler as *mut c_void);
            st.event_handlers.push(RegisteredEventHandler { fd, handler });
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn rl_unregister_event_handler(
    this: *mut c_void,
    handler: *mut ComObj<IEventHandlerVtbl>,
) -> i32 {
    let me = &*(frame_from_run_loop(this));
    if let Ok(mut st) = me.state.lock() {
        let mut idx = 0;
        while idx < st.event_handlers.len() {
            if st.event_handlers[idx].handler == handler {
                let removed = st.event_handlers.remove(idx);
                if !removed.handler.is_null() {
                    ((*(*removed.handler).vtbl).base.release)(removed.handler as *mut c_void);
                }
            } else {
                idx += 1;
            }
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn rl_register_timer(
    this: *mut c_void,
    handler: *mut ComObj<ITimerHandlerVtbl>,
    milliseconds: u64,
) -> i32 {
    if handler.is_null() {
        return K_RESULT_FALSE;
    }
    let me = &*(frame_from_run_loop(this));
    if let Ok(mut st) = me.state.lock() {
        if let Some(existing) = st.timers.iter_mut().find(|t| t.handler == handler) {
            existing.interval_ms = milliseconds.max(10);
        } else {
            ((*(*handler).vtbl).base.add_ref)(handler as *mut c_void);
            st.timers.push(RegisteredTimer {
                handler,
                interval_ms: milliseconds.max(10),
                last_fired: Instant::now(),
            });
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn rl_unregister_timer(
    this: *mut c_void,
    handler: *mut ComObj<ITimerHandlerVtbl>,
) -> i32 {
    let me = &*(frame_from_run_loop(this));
    if let Ok(mut st) = me.state.lock() {
        let mut idx = 0;
        while idx < st.timers.len() {
            if st.timers[idx].handler == handler {
                let removed = st.timers.remove(idx);
                if !removed.handler.is_null() {
                    ((*(*removed.handler).vtbl).base.release)(removed.handler as *mut c_void);
                }
            } else {
                idx += 1;
            }
        }
    }
    K_RESULT_OK
}
`,
  },
  {
    path: 'src/audio/plugin_host.rs',
    language: 'rust',
    description: 'Scanner & hébergeur cross-platform VST2/VST3 (COM + DSP + GUI native) et Apple AudioUnit (CoreAudio Render + Cocoa UI)',
    content: `use super::state::{
    DiscoveredPlugin, NativePluginHandle, PluginFormat, PluginParamDesc, MAX_INSERTS_PER_STRIP,
};
use super::vst3_abi::{
    utf16_to_string, AudioBusBuffers, BusInfo, ComObj, HostApplication, HostBStream,
    HostComponentHandler, HostParameterChanges, IAudioProcessorVtbl, IComponentVtbl,
    IConnectionPointVtbl, IEditControllerVtbl, IPluginFactoryVtbl, PClassInfo, ParameterInfo,
    ProcessData, ProcessSetup, IID_IAUDIO_PROCESSOR, IID_ICOMPONENT, IID_ICONNECTION_POINT,
    IID_IEDIT_CONTROLLER, K_DIR_INPUT, K_DIR_OUTPUT, K_MEDIA_AUDIO, K_REALTIME, K_RESULT_OK,
    K_SAMPLE_32, K_SPEAKER_MONO, K_SPEAKER_STEREO,
};
use libloading::Library;
use std::ffi::{c_void, CStr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// Interface unifiée exécutée dans le thread audio pour chaque insert (VST2, VST3, AudioUnit).
pub trait HostedPlugin: Send {
    fn name(&self) -> &str;
    fn format(&self) -> PluginFormat;
    fn prepare(&mut self, sample_rate: f32, max_block_size: usize);
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]);
    fn set_bypassed(&mut self, bypassed: bool);
    fn parameters(&self) -> Vec<PluginParamDesc>;
    fn set_parameter(&mut self, param_id: u32, value: f32);
    fn native_handle(&self) -> Option<NativePluginHandle> {
        None
    }
}

/// Chaîne de 5 inserts maximum par tranche.
pub struct StripInsertRack {
    pub slots: [Option<Box<dyn HostedPlugin>>; MAX_INSERTS_PER_STRIP],
    pub bypassed: [bool; MAX_INSERTS_PER_STRIP],
}

impl Default for StripInsertRack {
    fn default() -> Self {
        Self {
            slots: std::array::from_fn(|_| None),
            bypassed: [false; MAX_INSERTS_PER_STRIP],
        }
    }
}

impl StripInsertRack {
    pub fn set_bypass(&mut self, slot: usize, bypassed: bool) {
        self.bypassed[slot] = bypassed;
        if let Some(plugin) = self.slots[slot].as_mut() {
            plugin.set_bypassed(bypassed);
        }
    }

    pub fn set_parameter(&mut self, slot: usize, param_id: u32, value: f32) {
        if let Some(plugin) = self.slots[slot].as_mut() {
            plugin.set_parameter(param_id, value);
        }
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for i in 0..MAX_INSERTS_PER_STRIP {
            if self.bypassed[i] {
                continue;
            }
            if let Some(plugin) = self.slots[i].as_mut() {
                plugin.process_stereo(left, right);
            }
        }
    }
}

/// Scanner de plugins compatible macOS (AU + VST3 + VST2) et Linux (VST3 + VST2).
pub fn scan_system_plugins() -> Vec<DiscoveredPlugin> {
    let mut found = Vec::new();

    #[cfg(target_os = "macos")]
    {
        scan_macos_audiounits(&mut found);

        let home = std::env::var("HOME").unwrap_or_default();
        let vst3_dirs = [
            PathBuf::from("/Library/Audio/Plug-Ins/VST3"),
            PathBuf::from(format!("{home}/Library/Audio/Plug-Ins/VST3")),
        ];
        let vst2_dirs = [
            PathBuf::from("/Library/Audio/Plug-Ins/VST"),
            PathBuf::from(format!("{home}/Library/Audio/Plug-Ins/VST")),
        ];

        scan_bundle_dir(&vst3_dirs, "vst3", PluginFormat::Vst3, &mut found);
        scan_bundle_dir(&vst2_dirs, "vst", PluginFormat::Vst2, &mut found);
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let vst3_dirs = [
            PathBuf::from("/usr/lib/vst3"),
            PathBuf::from("/usr/local/lib/vst3"),
            PathBuf::from(format!("{home}/.vst3")),
        ];
        let vst2_dirs = [
            PathBuf::from("/usr/lib/vst"),
            PathBuf::from("/usr/lib/lxvst"),
            PathBuf::from(format!("{home}/.vst")),
        ];

        scan_bundle_dir(&vst3_dirs, "vst3", PluginFormat::Vst3, &mut found);
        scan_bundle_dir(&vst2_dirs, "so", PluginFormat::Vst2, &mut found);
    }

    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

#[cfg(target_os = "macos")]
fn fourcc_string(code: u32) -> String {
    let bytes = code.to_be_bytes();
    bytes
        .iter()
        .map(|&b| if b.is_ascii_graphic() { b as char } else { '?' })
        .collect()
}

#[cfg(target_os = "macos")]
fn scan_macos_audiounits(out: &mut Vec<DiscoveredPlugin>) {
    use coreaudio_sys::*;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    let mut seen_codes: Vec<[u32; 3]> = Vec::new();
    let types = [u32::from_be_bytes(*b"aufx"), u32::from_be_bytes(*b"aumf")];

    unsafe {
        for comp_type in types {
            let search = AudioComponentDescription {
                componentType: comp_type,
                componentSubType: 0,
                componentManufacturer: 0,
                componentFlags: 0,
                componentFlagsMask: 0,
            };
            let mut comp = AudioComponentFindNext(std::ptr::null_mut(), &search);
            while !comp.is_null() {
                let mut desc: AudioComponentDescription = std::mem::zeroed();
                if AudioComponentGetDescription(comp, &mut desc) == 0 {
                    let codes = [
                        desc.componentType,
                        desc.componentSubType,
                        desc.componentManufacturer,
                    ];
                    if !seen_codes.contains(&codes) {
                        seen_codes.push(codes);
                        let mut full_name = String::new();
                        let mut cf_name: CFStringRef = std::ptr::null();
                        if AudioComponentCopyName(comp, &mut cf_name) == 0 && !cf_name.is_null() {
                            let mut buf = [0 as std::ffi::c_char; 256];
                            if CFStringGetCString(
                                cf_name,
                                buf.as_mut_ptr(),
                                buf.len() as CFIndex,
                                K_CF_STRING_ENCODING_UTF8,
                            ) != 0
                            {
                                full_name = CStr::from_ptr(buf.as_ptr())
                                    .to_string_lossy()
                                    .trim()
                                    .to_string();
                            }
                            CFRelease(cf_name as *const c_void);
                        }
                        let (vendor, name) = if let Some((v, n)) = full_name.split_once(": ") {
                            (v.trim().to_string(), n.trim().to_string())
                        } else if !full_name.is_empty() {
                            (fourcc_string(codes[2]), full_name)
                        } else {
                            (
                                fourcc_string(codes[2]),
                                format!("AudioUnit {}", fourcc_string(codes[1])),
                            )
                        };
                        out.push(DiscoveredPlugin {
                            name,
                            vendor,
                            format: PluginFormat::AudioUnit,
                            path: PathBuf::from(format!(
                                "AudioUnit [{}/{}/{}]",
                                fourcc_string(codes[0]),
                                fourcc_string(codes[1]),
                                fourcc_string(codes[2]),
                            )),
                            au_component_code: Some(codes),
                        });
                    }
                }
                comp = AudioComponentFindNext(comp, &search);
            }
        }
    }
}

fn scan_bundle_dir(
    dirs: &[PathBuf],
    ext: &str,
    format: PluginFormat,
    out: &mut Vec<DiscoveredPlugin>,
) {
    for dir in dirs {
        scan_dir_recursive(dir, ext, format, 0, out);
    }
}

fn scan_dir_recursive(
    dir: &Path,
    ext: &str,
    format: PluginFormat,
    depth: usize,
    out: &mut Vec<DiscoveredPlugin>,
) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some(ext) {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown Plugin")
                .to_string();
            out.push(DiscoveredPlugin {
                name,
                vendor: match format {
                    PluginFormat::AudioUnit => "Apple AudioUnit".into(),
                    PluginFormat::Vst3 => "VST3".into(),
                    PluginFormat::Vst2 => "VST2".into(),
                },
                format,
                path,
                au_component_code: None,
            });
        } else if path.is_dir() {
            scan_dir_recursive(&path, ext, format, depth + 1, out);
        }
    }
}

/// Charge dynamiquement un plugin VST3 (.vst3), VST2 (.vst/.so) ou AudioUnit (.component).
pub fn instantiate_plugin(desc: &DiscoveredPlugin) -> Result<Box<dyn HostedPlugin>, String> {
    match desc.format {
        PluginFormat::Vst3 => Vst3PluginInstance::load(&desc.name, &desc.path)
            .map(|p| Box::new(p) as Box<dyn HostedPlugin>),
        PluginFormat::Vst2 => Vst2PluginInstance::load(&desc.name, &desc.path)
            .map(|p| Box::new(p) as Box<dyn HostedPlugin>),
        PluginFormat::AudioUnit => {
            #[cfg(target_os = "macos")]
            {
                AudioUnitInstance::load(desc).map(|p| Box::new(p) as Box<dyn HostedPlugin>)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("Apple AudioUnit est uniquement disponible sur macOS CoreAudio.".into())
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: *const c_void,
        buffer: *const u8,
        buf_len: isize,
        is_directory: u8,
    ) -> *const c_void;
    fn CFBundleCreate(allocator: *const c_void, bundle_url: *const c_void) -> *mut c_void;
    fn CFRelease(cf: *const c_void);
}

enum Vst3ModuleHandle {
    #[cfg(target_os = "macos")]
    MacOs {
        lib: Library,
        cf_bundle: *mut c_void,
    },
    #[cfg(target_os = "linux")]
    Linux {
        raw_handle: *mut c_void,
    },
}

impl Vst3ModuleHandle {
    unsafe fn open(bundle_path: &Path, binary_path: &Path) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        {
            let lib = Library::new(binary_path)
                .map_err(|e| format!("Erreur chargement VST3 {}: {e}", binary_path.display()))?;
            let path_bytes = bundle_path.to_string_lossy().into_owned().into_bytes();
            let cf_url = CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                path_bytes.as_ptr(),
                path_bytes.len() as isize,
                1,
            );
            let cf_bundle = if !cf_url.is_null() {
                let b = CFBundleCreate(std::ptr::null(), cf_url);
                CFRelease(cf_url);
                b
            } else {
                std::ptr::null_mut()
            };
            if let Ok(entry) = lib.get::<unsafe extern "C" fn(*mut c_void) -> bool>(b"bundleEntry") {
                if !entry(cf_bundle) {
                    if !cf_bundle.is_null() {
                        CFRelease(cf_bundle);
                    }
                    return Err("Échec bundleEntry() sur le bundle VST3 macOS".into());
                }
            }
            Ok(Self::MacOs { lib, cf_bundle })
        }

        #[cfg(target_os = "linux")]
        {
            let _ = bundle_path;
            let c_path = std::ffi::CString::new(binary_path.to_string_lossy().as_bytes())
                .map_err(|_| "Chemin binaire VST3 invalide".to_string())?;
            let raw_handle = libc::dlopen(c_path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
            if raw_handle.is_null() {
                return Err(format!("dlopen impossible sur {}", binary_path.display()));
            }
            let sym_entry = libc::dlsym(raw_handle, b"ModuleEntry\\0".as_ptr() as *const std::ffi::c_char);
            if !sym_entry.is_null() {
                let entry: unsafe extern "C" fn(*mut c_void) -> bool = std::mem::transmute(sym_entry);
                if !entry(raw_handle) {
                    libc::dlclose(raw_handle);
                    return Err("Échec ModuleEntry() sur le plugin VST3 Linux".into());
                }
            }
            Ok(Self::Linux { raw_handle })
        }
    }

    unsafe fn get_factory(&self) -> Result<*mut ComObj<IPluginFactoryVtbl>, String> {
        type GetPluginFactoryFn = unsafe extern "C" fn() -> *mut ComObj<IPluginFactoryVtbl>;
        match self {
            #[cfg(target_os = "macos")]
            Self::MacOs { lib, .. } => {
                let sym: libloading::Symbol<GetPluginFactoryFn> = lib
                    .get(b"GetPluginFactory")
                    .map_err(|e| format!("Symbole GetPluginFactory absent: {e}"))?;
                let factory = sym();
                if factory.is_null() {
                    Err("GetPluginFactory() a retourné un pointeur nul".into())
                } else {
                    Ok(factory)
                }
            }
            #[cfg(target_os = "linux")]
            Self::Linux { raw_handle } => {
                let sym = libc::dlsym(*raw_handle, b"GetPluginFactory\\0".as_ptr() as *const std::ffi::c_char);
                if sym.is_null() {
                    return Err("Symbole GetPluginFactory absent".into());
                }
                let f: GetPluginFactoryFn = std::mem::transmute(sym);
                let factory = f();
                if factory.is_null() {
                    Err("GetPluginFactory() a retourné un pointeur nul".into())
                } else {
                    Ok(factory)
                }
            }
        }
    }

    unsafe fn exit_hook(&mut self) {
        match self {
            #[cfg(target_os = "macos")]
            Self::MacOs { lib, cf_bundle } => {
                if let Ok(exit_fn) = lib.get::<unsafe extern "C" fn() -> bool>(b"bundleExit") {
                    let _ = exit_fn();
                }
                if !cf_bundle.is_null() {
                    CFRelease(*cf_bundle);
                    *cf_bundle = std::ptr::null_mut();
                }
            }
            #[cfg(target_os = "linux")]
            Self::Linux { raw_handle } => {
                if !raw_handle.is_null() {
                    let sym_exit = libc::dlsym(*raw_handle, b"ModuleExit\\0".as_ptr() as *const std::ffi::c_char);
                    if !sym_exit.is_null() {
                        let exit_fn: unsafe extern "C" fn() -> bool = std::mem::transmute(sym_exit);
                        let _ = exit_fn();
                    }
                    libc::dlclose(*raw_handle);
                    *raw_handle = std::ptr::null_mut();
                }
            }
        }
    }
}

/// Hôte VST3 COM complet : DSP temps réel + paramètres + contrôleur GUI natif (\`IPlugView\`).
pub struct Vst3PluginInstance {
    name: String,
    module: Vst3ModuleHandle,
    host_app: *mut HostApplication,
    comp_handler: *mut HostComponentHandler,
    factory: *mut ComObj<IPluginFactoryVtbl>,
    comp: *mut ComObj<IComponentVtbl>,
    proc: *mut ComObj<IAudioProcessorVtbl>,
    ctrl: *mut ComObj<IEditControllerVtbl>,
    ctrl_is_separate: bool,
    comp_cp: *mut ComObj<IConnectionPointVtbl>,
    ctrl_cp: *mut ComObj<IConnectionPointVtbl>,
    pending_edits: Arc<Mutex<Vec<(u32, f64)>>>,
    param_changes: HostParameterChanges,
    in_left: Vec<f32>,
    in_right: Vec<f32>,
    out_left: Vec<f32>,
    out_right: Vec<f32>,
    in_channels: usize,
    out_channels: usize,
    has_input_bus: bool,
    bypassed: bool,
    params: Vec<PluginParamDesc>,
}

// SAFETY: La durée de vie COM est possédée par le thread audio ; les vues UI sont fermées avant tout déchargement.
unsafe impl Send for Vst3PluginInstance {}

impl Vst3PluginInstance {
    pub fn load(name: &str, bundle_path: &Path) -> Result<Self, String> {
        let binary_path = resolve_vst3_binary(bundle_path)?;
        unsafe {
            let mut module = Vst3ModuleHandle::open(bundle_path, &binary_path)?;
            let factory = match module.get_factory() {
                Ok(f) => f,
                Err(e) => {
                    module.exit_hook();
                    return Err(e);
                }
            };

            let host_app = HostApplication::new_raw();
            let pending_edits = Arc::new(Mutex::new(Vec::new()));
            let comp_handler = HostComponentHandler::new_raw(Arc::clone(&pending_edits));

            let count = ((*(*factory).vtbl).count_classes)(factory as *mut c_void);
            let mut audio_cid: Option<[u8; 16]> = None;
            for idx in 0..count {
                let mut info: PClassInfo = std::mem::zeroed();
                if ((*(*factory).vtbl).get_class_info)(factory as *mut c_void, idx, &mut info) == K_RESULT_OK {
                    let cat = CStr::from_ptr(info.category.as_ptr()).to_string_lossy();
                    if cat.starts_with("Audio Module Class") {
                        audio_cid = Some(info.cid);
                        break;
                    }
                }
            }
            let Some(cid) = audio_cid else {
                ((*(*factory).vtbl).base.release)(factory as *mut c_void);
                module.exit_hook();
                return Err("Aucune classe 'Audio Module Class' dans le plugin VST3".into());
            };

            let mut comp_void: *mut c_void = std::ptr::null_mut();
            let res = ((*(*factory).vtbl).create_instance)(
                factory as *mut c_void,
                cid.as_ptr(),
                IID_ICOMPONENT.as_ptr(),
                &mut comp_void,
            );
            if res != K_RESULT_OK || comp_void.is_null() {
                ((*(*factory).vtbl).base.release)(factory as *mut c_void);
                module.exit_hook();
                return Err("Échec createInstance(IComponent) sur ce VST3".into());
            }
            let comp = comp_void as *mut ComObj<IComponentVtbl>;
            let init_res = ((*(*comp).vtbl).initialize)(comp as *mut c_void, host_app as *mut c_void);
            if init_res != K_RESULT_OK {
                ((*(*comp).vtbl).base.release)(comp as *mut c_void);
                ((*(*factory).vtbl).base.release)(factory as *mut c_void);
                module.exit_hook();
                return Err(format!("IComponent::initialize a échoué (code {init_res})"));
            }

            let mut proc_void: *mut c_void = std::ptr::null_mut();
            let _ = ((*(*comp).vtbl).base.query_interface)(
                comp as *mut c_void,
                IID_IAUDIO_PROCESSOR.as_ptr(),
                &mut proc_void,
            );
            if proc_void.is_null() {
                ((*(*comp).vtbl).terminate)(comp as *mut c_void);
                ((*(*comp).vtbl).base.release)(comp as *mut c_void);
                ((*(*factory).vtbl).base.release)(factory as *mut c_void);
                module.exit_hook();
                return Err("IAudioProcessor indisponible sur ce VST3".into());
            }
            let proc = proc_void as *mut ComObj<IAudioProcessorVtbl>;

            // Obtention de IEditController (composant unique ou contrôleur séparé)
            let mut ctrl_void: *mut c_void = std::ptr::null_mut();
            let mut ctrl_is_separate = false;
            if ((*(*comp).vtbl).base.query_interface)(
                comp as *mut c_void,
                IID_IEDIT_CONTROLLER.as_ptr(),
                &mut ctrl_void,
            ) != K_RESULT_OK
                || ctrl_void.is_null()
            {
                let mut ctrl_cid = [0_u8; 16];
                if ((*(*comp).vtbl).get_controller_class_id)(comp as *mut c_void, &mut ctrl_cid) == K_RESULT_OK {
                    if ((*(*factory).vtbl).create_instance)(
                        factory as *mut c_void,
                        ctrl_cid.as_ptr(),
                        IID_IEDIT_CONTROLLER.as_ptr(),
                        &mut ctrl_void,
                    ) == K_RESULT_OK
                        && !ctrl_void.is_null()
                    {
                        let ctrl = ctrl_void as *mut ComObj<IEditControllerVtbl>;
                        let _ = ((*(*ctrl).vtbl).initialize)(ctrl as *mut c_void, host_app as *mut c_void);
                        ctrl_is_separate = true;
                    }
                }
            }
            let ctrl = ctrl_void as *mut ComObj<IEditControllerVtbl>;

            let mut comp_cp: *mut ComObj<IConnectionPointVtbl> = std::ptr::null_mut();
            let mut ctrl_cp: *mut ComObj<IConnectionPointVtbl> = std::ptr::null_mut();
            if !ctrl.is_null() {
                let _ = ((*(*ctrl).vtbl).set_component_handler)(
                    ctrl as *mut c_void,
                    comp_handler as *mut c_void,
                );
                if ctrl_is_separate {
                    let mut p1: *mut c_void = std::ptr::null_mut();
                    let mut p2: *mut c_void = std::ptr::null_mut();
                    let _ = ((*(*comp).vtbl).base.query_interface)(
                        comp as *mut c_void,
                        IID_ICONNECTION_POINT.as_ptr(),
                        &mut p1,
                    );
                    let _ = ((*(*ctrl).vtbl).base.query_interface)(
                        ctrl as *mut c_void,
                        IID_ICONNECTION_POINT.as_ptr(),
                        &mut p2,
                    );
                    if !p1.is_null() && !p2.is_null() {
                        comp_cp = p1 as *mut ComObj<IConnectionPointVtbl>;
                        ctrl_cp = p2 as *mut ComObj<IConnectionPointVtbl>;
                        let _ = ((*(*comp_cp).vtbl).connect)(comp_cp as *mut c_void, ctrl_cp as *mut c_void);
                        let _ = ((*(*ctrl_cp).vtbl).connect)(ctrl_cp as *mut c_void, comp_cp as *mut c_void);
                    }
                    let stream = HostBStream::new_raw();
                    if ((*(*comp).vtbl).get_state)(comp as *mut c_void, stream as *mut c_void) == K_RESULT_OK {
                        let _ = ((*(*stream).vtbl).seek)(stream as *mut c_void, 0, 0, std::ptr::null_mut());
                        let _ = ((*(*ctrl).vtbl).set_component_state)(ctrl as *mut c_void, stream as *mut c_void);
                    }
                    ((*(*stream).vtbl).base.release)(stream as *mut c_void);
                }
            }

            // Activation des bus audio principaux
            let in_buses = ((*(*comp).vtbl).get_bus_count)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_INPUT);
            for b in 0..in_buses {
                let mut bi: BusInfo = std::mem::zeroed();
                if ((*(*comp).vtbl).get_bus_info)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_INPUT, b, &mut bi) == K_RESULT_OK {
                    let _ = ((*(*comp).vtbl).activate_bus)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_INPUT, b, u8::from(b == 0));
                }
            }
            let out_buses = ((*(*comp).vtbl).get_bus_count)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_OUTPUT);
            for b in 0..out_buses {
                let mut bi: BusInfo = std::mem::zeroed();
                if ((*(*comp).vtbl).get_bus_info)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_OUTPUT, b, &mut bi) == K_RESULT_OK {
                    let _ = ((*(*comp).vtbl).activate_bus)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_OUTPUT, b, u8::from(b == 0));
                }
            }

            let mut in_arr = K_SPEAKER_STEREO;
            let mut out_arr = K_SPEAKER_STEREO;
            if ((*(*proc).vtbl).set_bus_arrangements)(proc as *mut c_void, &mut in_arr, 1, &mut out_arr, 1)
                != K_RESULT_OK
            {
                in_arr = K_SPEAKER_MONO;
                out_arr = K_SPEAKER_STEREO;
                let _ = ((*(*proc).vtbl).set_bus_arrangements)(
                    proc as *mut c_void,
                    &mut in_arr,
                    1,
                    &mut out_arr,
                    1,
                );
            }

            let mut actual_in_ch = if in_arr == K_SPEAKER_MONO { 1 } else { 2 };
            if in_buses > 0 {
                let mut bi: BusInfo = std::mem::zeroed();
                if ((*(*comp).vtbl).get_bus_info)(
                    comp as *mut c_void,
                    K_MEDIA_AUDIO,
                    K_DIR_INPUT,
                    0,
                    &mut bi,
                ) == K_RESULT_OK
                    && (bi.channel_count == 1 || bi.channel_count == 2)
                {
                    actual_in_ch = bi.channel_count as usize;
                }
            }
            let mut actual_out_ch = if out_arr == K_SPEAKER_MONO { 1 } else { 2 };
            if out_buses > 0 {
                let mut bi: BusInfo = std::mem::zeroed();
                if ((*(*comp).vtbl).get_bus_info)(
                    comp as *mut c_void,
                    K_MEDIA_AUDIO,
                    K_DIR_OUTPUT,
                    0,
                    &mut bi,
                ) == K_RESULT_OK
                    && (bi.channel_count == 1 || bi.channel_count == 2)
                {
                    actual_out_ch = bi.channel_count as usize;
                }
            }

            let mut setup = ProcessSetup {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                max_samples_per_block: 2048,
                sample_rate: 48000.0,
            };
            let _ = ((*(*proc).vtbl).setup_processing)(proc as *mut c_void, &mut setup);
            let _ = ((*(*comp).vtbl).set_active)(comp as *mut c_void, 1);
            let _ = ((*(*proc).vtbl).set_processing)(proc as *mut c_void, 1);

            // Lecture des paramètres réels depuis IEditController
            let mut params = Vec::new();
            if !ctrl.is_null() {
                let p_count = ((*(*ctrl).vtbl).get_parameter_count)(ctrl as *mut c_void).clamp(0, 128);
                for i in 0..p_count {
                    let mut pinfo: ParameterInfo = std::mem::zeroed();
                    if ((*(*ctrl).vtbl).get_parameter_info)(ctrl as *mut c_void, i, &mut pinfo) == K_RESULT_OK {
                        let pname = utf16_to_string(&pinfo.title);
                        let punit = utf16_to_string(&pinfo.units);
                        let min_plain = ((*(*ctrl).vtbl).normalized_param_to_plain)(ctrl as *mut c_void, pinfo.id, 0.0) as f32;
                        let max_plain = ((*(*ctrl).vtbl).normalized_param_to_plain)(ctrl as *mut c_void, pinfo.id, 1.0) as f32;
                        let cur_norm = ((*(*ctrl).vtbl).get_param_normalized)(ctrl as *mut c_void, pinfo.id);
                        let (min, max, def_v, cur_v) = if min_plain.is_finite()
                            && max_plain.is_finite()
                            && (max_plain - min_plain).abs() > 1e-4
                        {
                            let lo = min_plain.min(max_plain);
                            let hi = min_plain.max(max_plain);
                            let d = ((*(*ctrl).vtbl).normalized_param_to_plain)(
                                ctrl as *mut c_void,
                                pinfo.id,
                                pinfo.default_normalized_value,
                            ) as f32;
                            let c = ((*(*ctrl).vtbl).normalized_param_to_plain)(ctrl as *mut c_void, pinfo.id, cur_norm) as f32;
                            (lo, hi, d.clamp(lo, hi), c.clamp(lo, hi))
                        } else {
                            (
                                0.0_f32,
                                1.0_f32,
                                (pinfo.default_normalized_value as f32).clamp(0.0, 1.0),
                                (cur_norm as f32).clamp(0.0, 1.0),
                            )
                        };
                        params.push(PluginParamDesc {
                            id: pinfo.id,
                            name: if pname.is_empty() { format!("Param {}", pinfo.id) } else { pname },
                            unit: punit,
                            min,
                            max,
                            default: def_v,
                            value: cur_v,
                        });
                    }
                }
            }

            Ok(Self {
                name: name.to_string(),
                module,
                host_app,
                comp_handler,
                factory,
                comp,
                proc,
                ctrl,
                ctrl_is_separate,
                comp_cp,
                ctrl_cp,
                pending_edits,
                param_changes: HostParameterChanges::new(),
                in_left: vec![0.0_f32; 2048],
                in_right: vec![0.0_f32; 2048],
                out_left: vec![0.0_f32; 2048],
                out_right: vec![0.0_f32; 2048],
                in_channels: actual_in_ch,
                out_channels: actual_out_ch,
                has_input_bus: in_buses > 0,
                bypassed: false,
                params,
            })
        }
    }
}

impl Drop for Vst3PluginInstance {
    fn drop(&mut self) {
        unsafe {
            if !self.proc.is_null() {
                let _ = ((*(*self.proc).vtbl).set_processing)(self.proc as *mut c_void, 0);
            }
            if !self.comp.is_null() {
                let _ = ((*(*self.comp).vtbl).set_active)(self.comp as *mut c_void, 0);
            }
            if !self.comp_cp.is_null() && !self.ctrl_cp.is_null() {
                let _ = ((*(*self.comp_cp).vtbl).disconnect)(self.comp_cp as *mut c_void, self.ctrl_cp as *mut c_void);
                let _ = ((*(*self.ctrl_cp).vtbl).disconnect)(self.ctrl_cp as *mut c_void, self.comp_cp as *mut c_void);
            }
            if !self.comp_cp.is_null() {
                ((*(*self.comp_cp).vtbl).base.release)(self.comp_cp as *mut c_void);
            }
            if !self.ctrl_cp.is_null() {
                ((*(*self.ctrl_cp).vtbl).base.release)(self.ctrl_cp as *mut c_void);
            }
            if !self.ctrl.is_null() {
                let _ = ((*(*self.ctrl).vtbl).set_component_handler)(self.ctrl as *mut c_void, std::ptr::null_mut());
                if self.ctrl_is_separate {
                    let _ = ((*(*self.ctrl).vtbl).terminate)(self.ctrl as *mut c_void);
                }
                ((*(*self.ctrl).vtbl).base.release)(self.ctrl as *mut c_void);
            }
            if !self.proc.is_null() {
                ((*(*self.proc).vtbl).base.release)(self.proc as *mut c_void);
            }
            if !self.comp.is_null() {
                let _ = ((*(*self.comp).vtbl).terminate)(self.comp as *mut c_void);
                ((*(*self.comp).vtbl).base.release)(self.comp as *mut c_void);
            }
            if !self.factory.is_null() {
                ((*(*self.factory).vtbl).base.release)(self.factory as *mut c_void);
            }
            if !self.comp_handler.is_null() {
                ((*(*self.comp_handler).vtbl).base.release)(self.comp_handler as *mut c_void);
            }
            if !self.host_app.is_null() {
                ((*(*self.host_app).vtbl).base.release)(self.host_app as *mut c_void);
            }
            self.module.exit_hook();
        }
    }
}

impl HostedPlugin for Vst3PluginInstance {
    fn name(&self) -> &str {
        &self.name
    }
    fn format(&self) -> PluginFormat {
        PluginFormat::Vst3
    }
    fn native_handle(&self) -> Option<NativePluginHandle> {
        if self.ctrl.is_null() {
            None
        } else {
            Some(NativePluginHandle::Vst3 {
                controller_ptr: self.ctrl as usize,
                title: self.name.clone(),
            })
        }
    }
    fn prepare(&mut self, sample_rate: f32, max_block_size: usize) {
        let block = max_block_size.clamp(64, 2048);
        unsafe {
            let _ = ((*(*self.proc).vtbl).set_processing)(self.proc as *mut c_void, 0);
            let _ = ((*(*self.comp).vtbl).set_active)(self.comp as *mut c_void, 0);
            let mut setup = ProcessSetup {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                max_samples_per_block: block as i32,
                sample_rate: f64::from(sample_rate),
            };
            let _ = ((*(*self.proc).vtbl).setup_processing)(self.proc as *mut c_void, &mut setup);
            let _ = ((*(*self.comp).vtbl).set_active)(self.comp as *mut c_void, 1);
            let _ = ((*(*self.proc).vtbl).set_processing)(self.proc as *mut c_void, 1);
        }
    }
    fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
    fn parameters(&self) -> Vec<PluginParamDesc> {
        self.params.clone()
    }
    fn set_parameter(&mut self, param_id: u32, value: f32) {
        if let Some(p) = self.params.iter_mut().find(|p| p.id == param_id) {
            p.value = value.clamp(p.min, p.max);
            let span = (p.max - p.min).max(1e-6);
            let norm = f64::from(((p.value - p.min) / span).clamp(0.0, 1.0));
            if let Ok(mut q) = self.pending_edits.lock() {
                q.push((param_id, norm));
            }
        }
    }
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.proc.is_null() {
            return;
        }
        let frames = left.len().min(right.len()).min(2048);
        if frames == 0 {
            return;
        }

        self.param_changes.clear();
        if let Ok(mut q) = self.pending_edits.try_lock() {
            for (id, norm) in q.drain(..) {
                self.param_changes.push(id, norm);
            }
        }

        if self.in_channels == 1 {
            for i in 0..frames {
                self.in_left[i] = 0.5 * (left[i] + right[i]);
            }
        } else {
            self.in_left[..frames].copy_from_slice(&left[..frames]);
            self.in_right[..frames].copy_from_slice(&right[..frames]);
        }
        self.out_left[..frames].fill(0.0);
        self.out_right[..frames].fill(0.0);

        let mut in_ptrs = [self.in_left.as_mut_ptr(), self.in_right.as_mut_ptr()];
        let mut out_ptrs = [self.out_left.as_mut_ptr(), self.out_right.as_mut_ptr()];

        let mut in_bus = AudioBusBuffers {
            num_channels: self.in_channels as i32,
            silence_flags: 0,
            channel_buffers32: in_ptrs.as_mut_ptr(),
        };
        let mut out_bus = AudioBusBuffers {
            num_channels: self.out_channels as i32,
            silence_flags: 0,
            channel_buffers32: out_ptrs.as_mut_ptr(),
        };
        let mut data = ProcessData {
            process_mode: K_REALTIME,
            symbolic_sample_size: K_SAMPLE_32,
            num_samples: frames as i32,
            num_inputs: i32::from(self.has_input_bus),
            num_outputs: 1,
            inputs: if self.has_input_bus { &mut in_bus } else { std::ptr::null_mut() },
            outputs: &mut out_bus,
            input_parameter_changes: &mut self.param_changes as *mut HostParameterChanges as *mut c_void,
            output_parameter_changes: std::ptr::null_mut(),
            input_events: std::ptr::null_mut(),
            output_events: std::ptr::null_mut(),
            process_context: std::ptr::null_mut(),
        };

        let status = unsafe { ((*(*self.proc).vtbl).process)(self.proc as *mut c_void, &mut data) };
        if status == K_RESULT_OK {
            left[..frames].copy_from_slice(&self.out_left[..frames]);
            if self.out_channels == 1 {
                right[..frames].copy_from_slice(&self.out_left[..frames]);
            } else {
                right[..frames].copy_from_slice(&self.out_right[..frames]);
            }
        }
    }
}

const VST2_MAGIC: i32 = 0x5673_7450; // 'VstP'
const VST2_EFF_OPEN: i32 = 0;
const VST2_EFF_CLOSE: i32 = 1;
const VST2_EFF_GET_PARAM_LABEL: i32 = 6;
const VST2_EFF_GET_PARAM_NAME: i32 = 8;
const VST2_EFF_SET_SAMPLE_RATE: i32 = 10;
const VST2_EFF_SET_BLOCK_SIZE: i32 = 11;
const VST2_EFF_MAINS_CHANGED: i32 = 12;
pub const VST2_EFF_EDIT_GET_RECT: i32 = 13;
pub const VST2_EFF_EDIT_OPEN: i32 = 14;
pub const VST2_EFF_EDIT_CLOSE: i32 = 15;
pub const VST2_EFF_EDIT_IDLE: i32 = 19;
const VST2_FLAGS_HAS_EDITOR: i32 = 1 << 0;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Vst2Rect {
    pub top: i16,
    pub left: i16,
    pub bottom: i16,
    pub right: i16,
}

#[repr(C)]
pub struct AEffect {
    pub magic: i32,
    pub dispatcher: unsafe extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize,
    pub process: unsafe extern "C" fn(*mut AEffect, *mut *mut f32, *mut *mut f32, i32),
    pub set_parameter: unsafe extern "C" fn(*mut AEffect, i32, f32),
    pub get_parameter: unsafe extern "C" fn(*mut AEffect, i32) -> f32,
    pub num_programs: i32,
    pub num_params: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub flags: i32,
    pub resvd1: isize,
    pub resvd2: isize,
    pub initial_delay: i32,
    pub real_qualities: i32,
    pub off_qualities: i32,
    pub io_ratio: f32,
    pub object: *mut c_void,
    pub user: *mut c_void,
    pub unique_id: i32,
    pub version: i32,
    pub process_replacing: unsafe extern "C" fn(*mut AEffect, *mut *mut f32, *mut *mut f32, i32),
    pub process_double_replacing: unsafe extern "C" fn(*mut AEffect, *mut *mut f64, *mut *mut f64, i32),
    pub future: [u8; 56],
}

type Vst2AudioMasterCb =
    unsafe extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize;
type Vst2MainFn = unsafe extern "C" fn(Vst2AudioMasterCb) -> *mut AEffect;

struct Vst2HostState {
    sample_rate: f32,
    block_size: i32,
    pending_resize: Option<(i32, i32)>,
}

static VST2_HOST_STATES: OnceLock<Mutex<Vec<(usize, Vst2HostState)>>> = OnceLock::new();

fn vst2_states() -> &'static Mutex<Vec<(usize, Vst2HostState)>> {
    VST2_HOST_STATES.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn vst2_take_pending_resize(effect_ptr: usize) -> Option<(i32, i32)> {
    let mut guard = vst2_states().lock().ok()?;
    guard
        .iter_mut()
        .find(|(k, _)| *k == effect_ptr)
        .and_then(|(_, st)| st.pending_resize.take())
}

pub unsafe fn vst2_dispatcher(
    effect_ptr: usize,
    opcode: i32,
    index: i32,
    value: isize,
    ptr: *mut c_void,
    opt: f32,
) -> isize {
    let effect = effect_ptr as *mut AEffect;
    if effect.is_null() {
        return 0;
    }
    ((*effect).dispatcher)(effect, opcode, index, value, ptr, opt)
}

unsafe fn copy_vst2_cstr(dst: *mut c_void, text: &[u8]) {
    if dst.is_null() || text.is_empty() {
        return;
    }
    std::ptr::copy_nonoverlapping(text.as_ptr(), dst as *mut u8, text.len());
}

unsafe extern "C" fn vst2_host_callback(
    effect: *mut AEffect,
    opcode: i32,
    index: i32,
    value: isize,
    ptr: *mut c_void,
    _opt: f32,
) -> isize {
    let key = effect as usize;
    match opcode {
        1 => 2400, // audioMasterVersion
        2 => 0,    // audioMasterCurrentId
        15 => {
            // audioMasterSizeWindow
            if key != 0 {
                if let Ok(mut guard) = vst2_states().lock() {
                    if let Some((_, st)) = guard.iter_mut().find(|(k, _)| *k == key) {
                        st.pending_resize = Some((index, value as i32));
                    }
                }
            }
            1
        }
        16 => {
            // audioMasterGetSampleRate
            if let Ok(guard) = vst2_states().lock() {
                if let Some((_, st)) = guard.iter().find(|(k, _)| *k == key) {
                    return st.sample_rate as isize;
                }
            }
            48000
        }
        17 => {
            // audioMasterGetBlockSize
            if let Ok(guard) = vst2_states().lock() {
                if let Some((_, st)) = guard.iter().find(|(k, _)| *k == key) {
                    return st.block_size as isize;
                }
            }
            2048
        }
        23 => 1, // audioMasterGetCurrentProcessLevel
        24 => 1, // audioMasterGetAutomationState
        32 => {
            copy_vst2_cstr(ptr, c"UMC1820".to_bytes_with_nul());
            1
        }
        33 => {
            copy_vst2_cstr(ptr, c"UMC1820 Studio Mixer".to_bytes_with_nul());
            1
        }
        34 => 1000, // audioMasterGetVendorVersion
        37 => {
            // audioMasterCanDo
            if ptr.is_null() {
                return 0;
            }
            let req = CStr::from_ptr(ptr as *const std::ffi::c_char).to_string_lossy();
            match req.as_ref() {
                "sizeWindow" | "supplyIdle" | "sendVstTimeInfo" | "acceptIOChanges" => 1,
                _ => 0,
            }
        }
        38 => 1, // audioMasterGetLanguage (kVstLangEnglish)
        _ => 0,
    }
}

/// Hôte VST2 C-ABI complet (AEffect + processReplacing + éditeur natif effEditOpen).
pub struct Vst2PluginInstance {
    name: String,
    _lib: Library,
    effect: *mut AEffect,
    num_inputs: usize,
    num_outputs: usize,
    in_left: Vec<f32>,
    in_right: Vec<f32>,
    in_scratch: Vec<f32>,
    out_left: Vec<f32>,
    out_right: Vec<f32>,
    out_scratch: Vec<f32>,
    bypassed: bool,
    params: Vec<PluginParamDesc>,
}

unsafe impl Send for Vst2PluginInstance {}

impl Vst2PluginInstance {
    pub fn load(name: &str, path: &Path) -> Result<Self, String> {
        let binary_path = resolve_vst2_binary(path)?;
        unsafe {
            let lib = Library::new(&binary_path)
                .map_err(|e| format!("Erreur chargement VST2 {}: {e}", binary_path.display()))?;
            let entry: Vst2MainFn = if let Ok(sym) = lib.get::<Vst2MainFn>(b"VSTPluginMain") {
                *sym
            } else if let Ok(sym) = lib.get::<Vst2MainFn>(b"main_macho") {
                *sym
            } else if let Ok(sym) = lib.get::<Vst2MainFn>(b"main") {
                *sym
            } else {
                return Err("Point d'entrée VSTPluginMain introuvable".into());
            };

            let effect = entry(vst2_host_callback);
            if effect.is_null() || (*effect).magic != VST2_MAGIC {
                return Err("AEffect VST2 invalide ou magic incorrect".into());
            }

            if let Ok(mut guard) = vst2_states().lock() {
                guard.push((
                    effect as usize,
                    Vst2HostState {
                        sample_rate: 48000.0,
                        block_size: 2048,
                        pending_resize: None,
                    },
                ));
            }

            ((*effect).dispatcher)(effect, VST2_EFF_OPEN, 0, 0, std::ptr::null_mut(), 0.0);
            ((*effect).dispatcher)(effect, VST2_EFF_SET_SAMPLE_RATE, 0, 0, std::ptr::null_mut(), 48000.0);
            ((*effect).dispatcher)(effect, VST2_EFF_SET_BLOCK_SIZE, 0, 2048, std::ptr::null_mut(), 0.0);
            ((*effect).dispatcher)(effect, VST2_EFF_MAINS_CHANGED, 0, 1, std::ptr::null_mut(), 0.0);

            let mut params = Vec::new();
            let p_count = (*effect).num_params.clamp(0, 128);
            for i in 0..p_count {
                let mut name_buf = [0_u8; 64];
                let mut unit_buf = [0_u8; 64];
                ((*effect).dispatcher)(
                    effect,
                    VST2_EFF_GET_PARAM_NAME,
                    i,
                    0,
                    name_buf.as_mut_ptr() as *mut c_void,
                    0.0,
                );
                ((*effect).dispatcher)(
                    effect,
                    VST2_EFF_GET_PARAM_LABEL,
                    i,
                    0,
                    unit_buf.as_mut_ptr() as *mut c_void,
                    0.0,
                );
                let pname = CStr::from_ptr(name_buf.as_ptr() as *const std::ffi::c_char)
                    .to_string_lossy()
                    .trim()
                    .to_string();
                let punit = CStr::from_ptr(unit_buf.as_ptr() as *const std::ffi::c_char)
                    .to_string_lossy()
                    .trim()
                    .to_string();
                let cur = ((*effect).get_parameter)(effect, i).clamp(0.0, 1.0);
                params.push(PluginParamDesc {
                    id: i as u32,
                    name: if pname.is_empty() { format!("Param {i}") } else { pname },
                    unit: punit,
                    min: 0.0,
                    max: 1.0,
                    default: cur,
                    value: cur,
                });
            }

            Ok(Self {
                name: name.to_string(),
                _lib: lib,
                effect,
                num_inputs: (*effect).num_inputs.max(0) as usize,
                num_outputs: (*effect).num_outputs.max(0) as usize,
                in_left: vec![0.0_f32; 2048],
                in_right: vec![0.0_f32; 2048],
                in_scratch: vec![0.0_f32; 2048],
                out_left: vec![0.0_f32; 2048],
                out_right: vec![0.0_f32; 2048],
                out_scratch: vec![0.0_f32; 2048],
                bypassed: false,
                params,
            })
        }
    }
}

impl Drop for Vst2PluginInstance {
    fn drop(&mut self) {
        unsafe {
            if !self.effect.is_null() {
                ((*self.effect).dispatcher)(
                    self.effect,
                    VST2_EFF_MAINS_CHANGED,
                    0,
                    0,
                    std::ptr::null_mut(),
                    0.0,
                );
                ((*self.effect).dispatcher)(
                    self.effect,
                    VST2_EFF_CLOSE,
                    0,
                    0,
                    std::ptr::null_mut(),
                    0.0,
                );
                if let Ok(mut guard) = vst2_states().lock() {
                    guard.retain(|(k, _)| *k != self.effect as usize);
                }
            }
        }
    }
}

impl HostedPlugin for Vst2PluginInstance {
    fn name(&self) -> &str {
        &self.name
    }
    fn format(&self) -> PluginFormat {
        PluginFormat::Vst2
    }
    fn native_handle(&self) -> Option<NativePluginHandle> {
        if self.effect.is_null() {
            return None;
        }
        let flags = unsafe { (*self.effect).flags };
        if (flags & VST2_FLAGS_HAS_EDITOR) != 0 {
            Some(NativePluginHandle::Vst2 {
                effect_ptr: self.effect as usize,
                title: self.name.clone(),
            })
        } else {
            None
        }
    }
    fn prepare(&mut self, sample_rate: f32, max_block_size: usize) {
        let block = max_block_size.clamp(64, 2048) as i32;
        if let Ok(mut guard) = vst2_states().lock() {
            if let Some((_, st)) = guard.iter_mut().find(|(k, _)| *k == self.effect as usize) {
                st.sample_rate = sample_rate;
                st.block_size = block;
            }
        }
        unsafe {
            ((*self.effect).dispatcher)(
                self.effect,
                VST2_EFF_MAINS_CHANGED,
                0,
                0,
                std::ptr::null_mut(),
                0.0,
            );
            ((*self.effect).dispatcher)(
                self.effect,
                VST2_EFF_SET_SAMPLE_RATE,
                0,
                0,
                std::ptr::null_mut(),
                sample_rate,
            );
            ((*self.effect).dispatcher)(
                self.effect,
                VST2_EFF_SET_BLOCK_SIZE,
                0,
                block as isize,
                std::ptr::null_mut(),
                0.0,
            );
            ((*self.effect).dispatcher)(
                self.effect,
                VST2_EFF_MAINS_CHANGED,
                0,
                1,
                std::ptr::null_mut(),
                0.0,
            );
        }
    }
    fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
    fn parameters(&self) -> Vec<PluginParamDesc> {
        self.params.clone()
    }
    fn set_parameter(&mut self, param_id: u32, value: f32) {
        let clamped = value.clamp(0.0, 1.0);
        if let Some(p) = self.params.iter_mut().find(|p| p.id == param_id) {
            p.value = clamped;
        }
        unsafe {
            if !self.effect.is_null() {
                ((*self.effect).set_parameter)(self.effect, param_id as i32, clamped);
            }
        }
    }
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.effect.is_null() {
            return;
        }
        let frames = left.len().min(right.len()).min(2048);
        if frames == 0 {
            return;
        }

        if self.num_inputs == 1 {
            for i in 0..frames {
                self.in_left[i] = 0.5 * (left[i] + right[i]);
            }
        } else {
            self.in_left[..frames].copy_from_slice(&left[..frames]);
            self.in_right[..frames].copy_from_slice(&right[..frames]);
        }
        self.in_scratch[..frames].fill(0.0);
        self.out_left[..frames].fill(0.0);
        self.out_right[..frames].fill(0.0);

        let in_count = self.num_inputs.min(8);
        let out_count = self.num_outputs.min(8);
        let mut in_ptrs = [self.in_scratch.as_mut_ptr(); 8];
        if in_count >= 1 {
            in_ptrs[0] = self.in_left.as_mut_ptr();
        }
        if in_count >= 2 {
            in_ptrs[1] = self.in_right.as_mut_ptr();
        }
        let mut out_ptrs = [self.out_scratch.as_mut_ptr(); 8];
        if out_count >= 1 {
            out_ptrs[0] = self.out_left.as_mut_ptr();
        }
        if out_count >= 2 {
            out_ptrs[1] = self.out_right.as_mut_ptr();
        }

        unsafe {
            ((*self.effect).process_replacing)(
                self.effect,
                in_ptrs.as_mut_ptr(),
                out_ptrs.as_mut_ptr(),
                frames as i32,
            );
        }

        if out_count >= 2 {
            left[..frames].copy_from_slice(&self.out_left[..frames]);
            right[..frames].copy_from_slice(&self.out_right[..frames]);
        } else if out_count == 1 {
            left[..frames].copy_from_slice(&self.out_left[..frames]);
            right[..frames].copy_from_slice(&self.out_left[..frames]);
        }
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct AuInputScratch {
    left: [f32; 2048],
    right: [f32; 2048],
    available_frames: usize,
}

#[cfg(target_os = "macos")]
impl Default for AuInputScratch {
    fn default() -> Self {
        Self {
            left: [0.0_f32; 2048],
            right: [0.0_f32; 2048],
            available_frames: 0,
        }
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct StereoAudioBufferList {
    m_number_buffers: u32,
    m_buffers: [coreaudio_sys::AudioBuffer; 2],
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn au_input_render_callback(
    in_ref_con: *mut c_void,
    _io_action_flags: *mut coreaudio_sys::AudioUnitRenderActionFlags,
    _in_time_stamp: *const coreaudio_sys::AudioTimeStamp,
    _in_bus_number: coreaudio_sys::UInt32,
    in_number_frames: coreaudio_sys::UInt32,
    io_data: *mut coreaudio_sys::AudioBufferList,
) -> coreaudio_sys::OSStatus {
    if in_ref_con.is_null() || io_data.is_null() {
        return -50;
    }
    let scratch = &*(in_ref_con as *const AuInputScratch);
    let abl = &mut *io_data;
    let count = (in_number_frames as usize).min(scratch.available_frames).min(2048);
    let num_bufs = abl.mNumberBuffers as usize;
    let bufs = std::slice::from_raw_parts_mut(abl.mBuffers.as_mut_ptr(), num_bufs);
    if num_bufs >= 1 && !bufs[0].mData.is_null() {
        let dst = std::slice::from_raw_parts_mut(bufs[0].mData as *mut f32, count);
        dst.copy_from_slice(&scratch.left[..count]);
        bufs[0].mDataByteSize = (count * std::mem::size_of::<f32>()) as u32;
    }
    if num_bufs >= 2 && !bufs[1].mData.is_null() {
        let dst = std::slice::from_raw_parts_mut(bufs[1].mData as *mut f32, count);
        dst.copy_from_slice(&scratch.right[..count]);
        bufs[1].mDataByteSize = (count * std::mem::size_of::<f32>()) as u32;
    }
    0
}

#[cfg(target_os = "macos")]
pub struct AudioUnitInstance {
    name: String,
    unit: coreaudio_sys::AudioComponentInstance,
    input_scratch: *mut AuInputScratch,
    in_channels: usize,
    out_channels: usize,
    out_left: Vec<f32>,
    out_right: Vec<f32>,
    sample_pos: f64,
    bypassed: bool,
    params: Vec<PluginParamDesc>,
}

#[cfg(target_os = "macos")]
unsafe impl Send for AudioUnitInstance {}

#[cfg(target_os = "macos")]
impl AudioUnitInstance {
    unsafe fn configure_stream_format(
        unit: coreaudio_sys::AudioComponentInstance,
        sample_rate: f64,
    ) -> (usize, usize) {
        use coreaudio_sys::*;
        let make_asbd = |channels: u32| AudioStreamBasicDescription {
            mSampleRate: sample_rate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 32,
            mReserved: 0,
        };
        let asbd_sz = std::mem::size_of::<AudioStreamBasicDescription>() as UInt32;
        let stereo = make_asbd(2);
        let mono = make_asbd(1);

        let mut in_ch = 2_usize;
        if AudioUnitSetProperty(
            unit,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input,
            0,
            &stereo as *const _ as *const c_void,
            asbd_sz,
        ) != 0
        {
            if AudioUnitSetProperty(
                unit,
                kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Input,
                0,
                &mono as *const _ as *const c_void,
                asbd_sz,
            ) == 0
            {
                in_ch = 1;
            }
        }

        let mut out_ch = 2_usize;
        if AudioUnitSetProperty(
            unit,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output,
            0,
            &stereo as *const _ as *const c_void,
            asbd_sz,
        ) != 0
        {
            if AudioUnitSetProperty(
                unit,
                kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Output,
                0,
                &mono as *const _ as *const c_void,
                asbd_sz,
            ) == 0
            {
                out_ch = 1;
            }
        }
        (in_ch, out_ch)
    }

    pub fn load(desc: &DiscoveredPlugin) -> Result<Self, String> {
        use coreaudio_sys::*;
        unsafe {
            let codes = desc.au_component_code.ok_or_else(|| {
                format!("Code ComponentType/SubType manquant pour AudioUnit {}", desc.name)
            })?;
            let comp_desc = AudioComponentDescription {
                componentType: codes[0],
                componentSubType: codes[1],
                componentManufacturer: codes[2],
                componentFlags: 0,
                componentFlagsMask: 0,
            };
            let comp = AudioComponentFindNext(std::ptr::null_mut(), &comp_desc);
            if comp.is_null() {
                return Err(format!("AudioUnit {} introuvable via AudioComponentFindNext", desc.name));
            }
            let mut unit: AudioComponentInstance = std::ptr::null_mut();
            let status = AudioComponentInstanceNew(comp, &mut unit);
            if status != 0 || unit.is_null() {
                return Err(format!("Échec AudioComponentInstanceNew (OSStatus={status})"));
            }

            let input_scratch = Box::into_raw(Box::new(AuInputScratch::default()));
            let max_frames: UInt32 = 2048;
            let _ = AudioUnitSetProperty(
                unit,
                kAudioUnitProperty_MaximumFramesPerSlice,
                kAudioUnitScope_Global,
                0,
                &max_frames as *const UInt32 as *const c_void,
                std::mem::size_of::<UInt32>() as UInt32,
            );
            let (in_channels, out_channels) = Self::configure_stream_format(unit, 48000.0);

            let cb = AURenderCallbackStruct {
                inputProc: Some(au_input_render_callback),
                inputProcRefCon: input_scratch as *mut c_void,
            };
            let _ = AudioUnitSetProperty(
                unit,
                kAudioUnitProperty_SetRenderCallback,
                kAudioUnitScope_Input,
                0,
                &cb as *const _ as *const c_void,
                std::mem::size_of::<AURenderCallbackStruct>() as UInt32,
            );

            AudioUnitInitialize(unit);

            // Lecture des paramètres réels exposés par l'AudioUnit CoreAudio
            let mut params = Vec::new();
            let mut list_size: UInt32 = 0;
            let mut writable: Boolean = 0;
            if AudioUnitGetPropertyInfo(
                unit,
                kAudioUnitProperty_ParameterList,
                kAudioUnitScope_Global,
                0,
                &mut list_size,
                &mut writable,
            ) == 0 && list_size > 0
            {
                let count = list_size as usize / std::mem::size_of::<AudioUnitParameterID>();
                let mut ids = vec![0_u32; count];
                if AudioUnitGetProperty(
                    unit,
                    kAudioUnitProperty_ParameterList,
                    kAudioUnitScope_Global,
                    0,
                    ids.as_mut_ptr() as *mut c_void,
                    &mut list_size,
                ) == 0
                {
                    for param_id in ids {
                        let mut info: AudioUnitParameterInfo = std::mem::zeroed();
                        let mut info_size = std::mem::size_of::<AudioUnitParameterInfo>() as UInt32;
                        if AudioUnitGetProperty(
                            unit,
                            kAudioUnitProperty_ParameterInfo,
                            kAudioUnitScope_Global,
                            param_id,
                            &mut info as *mut _ as *mut c_void,
                            &mut info_size,
                        ) == 0
                        {
                            let mut cur_val: f32 = info.defaultValue;
                            let _ = AudioUnitGetParameter(
                                unit,
                                param_id,
                                kAudioUnitScope_Global,
                                0,
                                &mut cur_val,
                            );
                            info.name[info.name.len() - 1] = 0;
                            let name = CStr::from_ptr(info.name.as_ptr())
                                .to_string_lossy()
                                .trim()
                                .to_string();
                            params.push(PluginParamDesc {
                                id: param_id,
                                name: if name.is_empty() { format!("Param {param_id}") } else { name },
                                unit: String::new(),
                                min: info.minValue,
                                max: info.maxValue.max(info.minValue + 0.001),
                                default: info.defaultValue,
                                value: cur_val,
                            });
                        }
                    }
                }
            }

            Ok(Self {
                name: desc.name.clone(),
                unit,
                input_scratch,
                in_channels,
                out_channels,
                out_left: vec![0.0_f32; 2048],
                out_right: vec![0.0_f32; 2048],
                sample_pos: 0.0,
                bypassed: false,
                params,
            })
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for AudioUnitInstance {
    fn drop(&mut self) {
        unsafe {
            coreaudio_sys::AudioUnitUninitialize(self.unit);
            coreaudio_sys::AudioComponentInstanceDispose(self.unit);
            if !self.input_scratch.is_null() {
                drop(Box::from_raw(self.input_scratch));
                self.input_scratch = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(target_os = "macos")]
impl HostedPlugin for AudioUnitInstance {
    fn name(&self) -> &str {
        &self.name
    }
    fn format(&self) -> PluginFormat {
        PluginFormat::AudioUnit
    }
    fn native_handle(&self) -> Option<NativePluginHandle> {
        Some(NativePluginHandle::AudioUnit {
            unit_ptr: self.unit as usize,
            title: self.name.clone(),
        })
    }
    fn prepare(&mut self, sample_rate: f32, _max_block_size: usize) {
        unsafe {
            coreaudio_sys::AudioUnitUninitialize(self.unit);
            let (in_ch, out_ch) = Self::configure_stream_format(self.unit, f64::from(sample_rate));
            self.in_channels = in_ch;
            self.out_channels = out_ch;
            coreaudio_sys::AudioUnitInitialize(self.unit);
        }
    }
    fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
    fn parameters(&self) -> Vec<PluginParamDesc> {
        self.params.clone()
    }
    fn set_parameter(&mut self, param_id: u32, value: f32) {
        if let Some(p) = self.params.iter_mut().find(|p| p.id == param_id) {
            p.value = value.clamp(p.min, p.max);
        }
        unsafe {
            let _ = coreaudio_sys::AudioUnitSetParameter(
                self.unit,
                param_id,
                coreaudio_sys::kAudioUnitScope_Global,
                0,
                value,
                0,
            );
        }
    }
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.input_scratch.is_null() {
            return;
        }
        let frames = left.len().min(right.len()).min(2048);
        if frames == 0 {
            return;
        }
        unsafe {
            let scratch = &mut *self.input_scratch;
            if self.in_channels == 1 {
                for i in 0..frames {
                    scratch.left[i] = 0.5 * (left[i] + right[i]);
                }
            } else {
                scratch.left[..frames].copy_from_slice(&left[..frames]);
                scratch.right[..frames].copy_from_slice(&right[..frames]);
            }
            scratch.available_frames = frames;

            let byte_sz = (frames * std::mem::size_of::<f32>()) as u32;
            let mut abl = StereoAudioBufferList {
                m_number_buffers: self.out_channels as u32,
                m_buffers: [
                    coreaudio_sys::AudioBuffer {
                        mNumberChannels: 1,
                        mDataByteSize: byte_sz,
                        mData: self.out_left.as_mut_ptr() as *mut c_void,
                    },
                    coreaudio_sys::AudioBuffer {
                        mNumberChannels: 1,
                        mDataByteSize: byte_sz,
                        mData: self.out_right.as_mut_ptr() as *mut c_void,
                    },
                ],
            };
            let mut flags: coreaudio_sys::AudioUnitRenderActionFlags = 0;
            let mut ts: coreaudio_sys::AudioTimeStamp = std::mem::zeroed();
            ts.mSampleTime = self.sample_pos;
            ts.mFlags = 1; // kAudioTimeStampSampleTimeValid
            self.sample_pos += frames as f64;

            let status = coreaudio_sys::AudioUnitRender(
                self.unit,
                &mut flags,
                &ts,
                0,
                frames as u32,
                &mut abl as *mut StereoAudioBufferList as *mut coreaudio_sys::AudioBufferList,
            );
            if status == 0 {
                left[..frames].copy_from_slice(&self.out_left[..frames]);
                if self.out_channels == 1 {
                    right[..frames].copy_from_slice(&self.out_left[..frames]);
                } else {
                    right[..frames].copy_from_slice(&self.out_right[..frames]);
                }
            }
        }
    }
}

fn first_file_in_dir(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_file())
}

fn resolve_vst3_binary(bundle: &Path) -> Result<PathBuf, String> {
    if bundle.is_file() {
        return Ok(bundle.to_path_buf());
    }
    let stem = bundle.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    #[cfg(target_os = "macos")]
    let dir = bundle.join("Contents/MacOS");
    #[cfg(target_os = "macos")]
    let candidate = dir.join(stem);

    #[cfg(target_os = "linux")]
    let dir = {
        let x64 = bundle.join("Contents/x86_64-linux");
        if x64.exists() { x64 } else { bundle.join("Contents/aarch64-linux") }
    };
    #[cfg(target_os = "linux")]
    let candidate = dir.join(format!("{stem}.so"));

    if candidate.exists() {
        Ok(candidate)
    } else if let Some(found) = first_file_in_dir(&dir) {
        Ok(found)
    } else {
        Err(format!("Binaire VST3 introuvable dans {}", bundle.display()))
    }
}

fn resolve_vst2_binary(bundle: &Path) -> Result<PathBuf, String> {
    if bundle.is_file() {
        return Ok(bundle.to_path_buf());
    }
    let stem = bundle.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let dir = bundle.join("Contents/MacOS");
    let candidate = dir.join(stem);
    if candidate.exists() {
        Ok(candidate)
    } else if let Some(found) = first_file_in_dir(&dir) {
        Ok(found)
    } else {
        Err(format!("Binaire VST2 introuvable dans {}", bundle.display()))
    }
}
`,
  },
  {
    path: 'src/audio/engine.rs',
    language: 'rust',
    description: 'Moteur audio cpal (CoreAudio sur macOS / ALSA-JACK sur Linux) gérant les 8 entrées, 4 sorties stéréo Aux et Master',
    content: `use super::dsp::{db_to_linear, BallisticMeter, FourBandEqProcessor};
use super::plugin_host::{HostedPlugin, StripInsertRack};
use super::state::{
    MeterFrame, MixerCommand, StripKind, StripState, MAX_INSERTS_PER_STRIP, NUM_AUX_STRIPS,
    NUM_INPUT_STRIPS, TOTAL_STRIPS,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleRate, Stream, StreamConfig};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;

pub struct AudioEngineHandle {
    pub command_tx: ringbuf::HeapProd<MixerCommand>,
    pub meter_rx: ringbuf::HeapCons<[MeterFrame; TOTAL_STRIPS]>,
    pub retired_plugin_rx: ringbuf::HeapCons<Box<dyn HostedPlugin>>,
    pub device_name: String,
    pub sample_rate: u32,
    pub buffer_frames: u32,
    _input_stream: Option<Stream>,
    _output_stream: Option<Stream>,
}

struct StripDspRuntime {
    kind: StripKind,
    gain_db: f32,
    volume_db: f32,
    mute: bool,
    solo: bool,
    aux_sends: [f32; NUM_AUX_STRIPS],
    eq: FourBandEqProcessor,
    inserts: StripInsertRack,
    meter: BallisticMeter,
}

impl StripDspRuntime {
    fn new(kind: StripKind) -> Self {
        Self {
            kind,
            gain_db: 0.0,
            volume_db: 0.0,
            mute: false,
            solo: false,
            aux_sends: [0.0; NUM_AUX_STRIPS],
            eq: FourBandEqProcessor::default(),
            inserts: StripInsertRack::default(),
            meter: BallisticMeter::default(),
        }
    }
}

pub fn list_audio_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices()
        .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

pub fn start_audio_engine(preferred_device: Option<&str>) -> Result<AudioEngineHandle, String> {
    let host = cpal::default_host();

    let output_device = host
        .output_devices()
        .ok()
        .and_then(|mut devs| {
            devs.find(|d| {
                let name = d.name().unwrap_or_default();
                if let Some(pref) = preferred_device {
                    name.contains(pref)
                } else {
                    name.contains("UMC1820")
                }
            })
        })
        .or_else(|| host.default_output_device())
        .ok_or_else(|| "Aucun périphérique de sortie CoreAudio/ALSA détecté".to_string())?;

    let input_device = host
        .input_devices()
        .ok()
        .and_then(|mut devs| {
            devs.find(|d| {
                let name = d.name().unwrap_or_default();
                if let Some(pref) = preferred_device {
                    name.contains(pref)
                } else {
                    name.contains("UMC1820")
                }
            })
        })
        .or_else(|| host.default_input_device());

    let device_name = output_device.name().unwrap_or_else(|_| "Audio Device".into());
    let supported_out = output_device
        .default_output_config()
        .map_err(|e| format!("Config sortie impossible: {e}"))?;

    let sample_rate = supported_out.sample_rate().0;
    let out_channels = supported_out.channels() as usize;
    let buffer_frames = 128_u32;

    let (cmd_tx, mut cmd_rx) = HeapRb::<MixerCommand>::new(256).split();
    let (mut meter_tx, meter_rx) = HeapRb::<[MeterFrame; TOTAL_STRIPS]>::new(16).split();
    let (mut retired_tx, retired_plugin_rx) =
        HeapRb::<Box<dyn HostedPlugin>>::new(32).split();
    let (mut audio_in_tx, mut audio_in_rx) = HeapRb::<f32>::new(sample_rate as usize * 8).split();

    let mut input_stream = None;
    let mut in_channels = 2_usize;

    if let Some(in_dev) = input_device {
        if let Ok(in_cfg) = in_dev.default_input_config() {
            in_channels = in_cfg.channels() as usize;
            let fixed_cfg = StreamConfig {
                channels: in_cfg.channels(),
                sample_rate: SampleRate(sample_rate),
                buffer_size: BufferSize::Fixed(buffer_frames),
            };
            let default_cfg = StreamConfig {
                channels: in_cfg.channels(),
                sample_rate: SampleRate(sample_rate),
                buffer_size: BufferSize::Default,
            };
            let in_stream_res = in_dev
                .build_input_stream(
                    &fixed_cfg,
                    move |data: &[f32], _| {
                        let _ = audio_in_tx.push_slice(data);
                    },
                    |err| eprintln!("Erreur flux entrée CoreAudio/ALSA: {err}"),
                    None,
                )
                .or_else(|_| {
                    let (mut tx2, rx2) = HeapRb::<f32>::new(sample_rate as usize * in_channels.max(18)).split();
                    audio_in_rx = rx2;
                    in_dev.build_input_stream(
                        &default_cfg,
                        move |data: &[f32], _| {
                            let _ = tx2.push_slice(data);
                        },
                        |err| eprintln!("Erreur flux entrée CoreAudio/ALSA: {err}"),
                        None,
                    )
                });
            if let Ok(stream) = in_stream_res {
                let _ = stream.play();
                input_stream = Some(stream);
            }
        }
    }

    let mut runtimes: Vec<StripDspRuntime> = (0..TOTAL_STRIPS)
        .map(|i| {
            if i < NUM_INPUT_STRIPS {
                StripDspRuntime::new(StripKind::Input)
            } else if i < NUM_INPUT_STRIPS + NUM_AUX_STRIPS {
                StripDspRuntime::new(StripKind::Aux)
            } else {
                StripDspRuntime::new(StripKind::Master)
            }
        })
        .collect();

    let out_cfg = StreamConfig {
        channels: out_channels as u16,
        sample_rate: SampleRate(sample_rate),
        buffer_size: BufferSize::Default,
    };

    let sr_f32 = sample_rate as f32;
    let mut scratch_in = vec![0.0_f32; 2048 * in_channels.max(18)];
    let mut block_l = vec![0.0_f32; 2048];
    let mut block_r = vec![0.0_f32; 2048];
    let mut aux_bus_l = [vec![0.0_f32; 2048], vec![0.0_f32; 2048], vec![0.0_f32; 2048], vec![0.0_f32; 2048]];
    let mut aux_bus_r = [vec![0.0_f32; 2048], vec![0.0_f32; 2048], vec![0.0_f32; 2048], vec![0.0_f32; 2048]];
    let mut master_l = vec![0.0_f32; 2048];
    let mut master_r = vec![0.0_f32; 2048];

    let output_stream = output_device
        .build_output_stream(
            &out_cfg,
            move |out: &mut [f32], _| {
                // 1. Appliquer toutes les commandes UI sans bloquer
                while let Some(cmd) = cmd_rx.try_pop() {
                    match cmd {
                        MixerCommand::SetGain { strip, gain_db } => {
                            if strip < TOTAL_STRIPS && runtimes[strip].kind == StripKind::Input {
                                runtimes[strip].gain_db = gain_db;
                            }
                        }
                        MixerCommand::SetVolume { strip, volume_db } => {
                            if strip < TOTAL_STRIPS {
                                runtimes[strip].volume_db = volume_db;
                            }
                        }
                        MixerCommand::SetMute { strip, mute } => {
                            if strip < TOTAL_STRIPS {
                                runtimes[strip].mute = mute;
                            }
                        }
                        MixerCommand::SetSolo { strip, solo } => {
                            if strip < TOTAL_STRIPS && runtimes[strip].kind != StripKind::Master {
                                runtimes[strip].solo = solo;
                            }
                        }
                        MixerCommand::SetEq { strip, eq } => {
                            if strip < TOTAL_STRIPS {
                                runtimes[strip].eq.update(sr_f32, eq);
                            }
                        }
                        MixerCommand::SetAuxSend { strip, aux_idx, level } => {
                            if strip < TOTAL_STRIPS
                                && runtimes[strip].kind != StripKind::Master
                                && aux_idx < NUM_AUX_STRIPS
                            {
                                runtimes[strip].aux_sends[aux_idx] = level;
                            }
                        }
                        MixerCommand::InstallInsert { strip, slot, plugin } => {
                            if strip < TOTAL_STRIPS && slot < MAX_INSERTS_PER_STRIP {
                                let prev = std::mem::replace(
                                    &mut runtimes[strip].inserts.slots[slot],
                                    plugin,
                                );
                                if let Some(old_plugin) = prev {
                                    let _ = retired_tx.try_push(old_plugin);
                                }
                            }
                        }
                        MixerCommand::BypassInsert { strip, slot, bypassed } => {
                            if strip < TOTAL_STRIPS && slot < MAX_INSERTS_PER_STRIP {
                                runtimes[strip].inserts.set_bypass(slot, bypassed);
                            }
                        }
                        MixerCommand::SetPluginParam { strip, slot, param_id, value } => {
                            if strip < TOTAL_STRIPS && slot < MAX_INSERTS_PER_STRIP {
                                runtimes[strip].inserts.set_parameter(slot, param_id, value);
                            }
                        }
                    }
                }

                let frames = (out.len() / out_channels).min(2048);
                let needed_in = frames * in_channels;
                scratch_in[..needed_in].fill(0.0);
                let _ = audio_in_rx.pop_slice(&mut scratch_in[..needed_in]);

                for b in 0..NUM_AUX_STRIPS {
                    aux_bus_l[b][..frames].fill(0.0);
                    aux_bus_r[b][..frames].fill(0.0);
                }
                master_l[..frames].fill(0.0);
                master_r[..frames].fill(0.0);

                let any_solo = runtimes[..NUM_INPUT_STRIPS + NUM_AUX_STRIPS]
                    .iter()
                    .any(|r| r.solo);
                let mut meters = [MeterFrame::default(); TOTAL_STRIPS];

                // 2. Traitement des 8 tranches d'entrée UMC1820 (1..8)
                for ch in 0..NUM_INPUT_STRIPS {
                    let rt = &mut runtimes[ch];
                    let trim = db_to_linear(rt.gain_db);
                    for f in 0..frames {
                        let sample = if ch < in_channels {
                            scratch_in[f * in_channels + ch] * trim
                        } else {
                            0.0
                        };
                        block_l[f] = sample;
                        block_r[f] = sample;
                    }

                    rt.inserts.process(&mut block_l[..frames], &mut block_r[..frames]);

                    let audible = if any_solo { rt.solo && !rt.mute } else { !rt.mute };
                    let fader = if audible { db_to_linear(rt.volume_db) } else { 0.0 };

                    for f in 0..frames {
                        let (el, er) = rt.eq.process(block_l[f], block_r[f]);
                        let sl = el * fader;
                        let sr = er * fader;
                        block_l[f] = sl;
                        block_r[f] = sr;
                        master_l[f] += sl;
                        master_r[f] += sr;
                        for aux_i in 0..NUM_AUX_STRIPS {
                            let send = rt.aux_sends[aux_i];
                            aux_bus_l[aux_i][f] += sl * send;
                            aux_bus_r[aux_i][f] += sr * send;
                        }
                    }

                    meters[ch] = rt.meter.push_block(&block_l[..frames], &block_r[..frames], sr_f32);
                }

                // 3. Traitement des 4 sorties stéréo Aux (1/2, 3/4, 5/6, 7/8) — sans gain d'entrée
                for aux_i in 0..NUM_AUX_STRIPS {
                    let idx = NUM_INPUT_STRIPS + aux_i;
                    let rt = &mut runtimes[idx];
                    for f in 0..frames {
                        block_l[f] = aux_bus_l[aux_i][f];
                        block_r[f] = aux_bus_r[aux_i][f];
                    }

                    rt.inserts.process(&mut block_l[..frames], &mut block_r[..frames]);

                    let audible = if any_solo { rt.solo && !rt.mute } else { !rt.mute };
                    let fader = if audible { db_to_linear(rt.volume_db) } else { 0.0 };

                    for f in 0..frames {
                        let (el, er) = rt.eq.process(block_l[f], block_r[f]);
                        aux_bus_l[aux_i][f] = el * fader;
                        aux_bus_r[aux_i][f] = er * fader;
                    }

                    meters[idx] = rt.meter.push_block(
                        &aux_bus_l[aux_i][..frames],
                        &aux_bus_r[aux_i][..frames],
                        sr_f32,
                    );
                }

                // 4. Traitement de la tranche Master (SANS Gain et SANS Solo)
                let master_idx = NUM_INPUT_STRIPS + NUM_AUX_STRIPS;
                {
                    let rt = &mut runtimes[master_idx];
                    rt.inserts.process(&mut master_l[..frames], &mut master_r[..frames]);
                    let fader = if !rt.mute { db_to_linear(rt.volume_db) } else { 0.0 };

                    for f in 0..frames {
                        let (el, er) = rt.eq.process(master_l[f], master_r[f]);
                        master_l[f] = (el * fader).tanh();
                        master_r[f] = (er * fader).tanh();
                    }
                    meters[master_idx] = rt.meter.push_block(
                        &master_l[..frames],
                        &master_r[..frames],
                        sr_f32,
                    );
                }

                // 5. Routage vers les sorties physiques UMC1820 (1/2, 3/4, 5/6, 7/8 + Main 9/10)
                for f in 0..frames {
                    let base = f * out_channels;
                    if out_channels >= 10 {
                        // Sorties 1-8 = 4 paires stéréo Aux, Sorties 9-10 = Main Out
                        for aux_i in 0..4 {
                            out[base + aux_i * 2] = aux_bus_l[aux_i][f];
                            out[base + aux_i * 2 + 1] = aux_bus_r[aux_i][f];
                        }
                        out[base + 8] = master_l[f];
                        out[base + 9] = master_r[f];
                    } else if out_channels >= 2 {
                        out[base] = master_l[f];
                        out[base + 1] = master_r[f];
                    }
                }

                let _ = meter_tx.try_push(meters);
            },
            |err| eprintln!("Erreur flux sortie CoreAudio/ALSA: {err}"),
            None,
        )
        .map_err(|e| format!("Échec ouverture flux sortie: {e}"))?;

    output_stream
        .play()
        .map_err(|e| format!("Échec démarrage flux sortie: {e}"))?;

    Ok(AudioEngineHandle {
        command_tx: cmd_tx,
        meter_rx,
        retired_plugin_rx,
        device_name,
        sample_rate,
        buffer_frames,
        _input_stream: input_stream,
        _output_stream: Some(output_stream),
    })
}

pub fn default_mixer_strips() -> Vec<StripState> {
    let mut strips = Vec::with_capacity(TOTAL_STRIPS);
    for i in 0..NUM_INPUT_STRIPS {
        strips.push(StripState::new(i, StripKind::Input, format!("IN {}", i + 1)));
    }
    let aux_names = ["AUX 1/2", "AUX 3/4", "AUX 5/6", "AUX 7/8"];
    for (idx, label) in aux_names.iter().enumerate() {
        strips.push(StripState::new(
            NUM_INPUT_STRIPS + idx,
            StripKind::Aux,
            (*label).to_string(),
        ));
    }
    strips.push(StripState::new(
        NUM_INPUT_STRIPS + NUM_AUX_STRIPS,
        StripKind::Master,
        "MASTER".to_string(),
    ));
    strips
}
`,
  },
  {
    path: 'src/ui/mod.rs',
    language: 'rust',
    description: 'Module interface graphique egui + fenêtres natives AU/VST3',
    content: `pub mod mixer_app;
pub mod native_editor;
pub mod widgets;
`,
  },
  {
    path: 'src/ui/native_editor.rs',
    language: 'rust',
    description: 'Fenêtres natives des plugins : Apple AudioUnit (Cocoa UI / AUGenericView) et VST3 (IPlugView NSView / X11 + IRunLoop)',
    content: `#[derive(Clone, Copy, PartialEq, Eq)]
struct SlotKey {
    strip: usize,
    slot: usize,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::SlotKey;
    use crate::audio::plugin_host::{
        vst2_dispatcher, vst2_take_pending_resize, Vst2Rect, VST2_EFF_EDIT_CLOSE,
        VST2_EFF_EDIT_GET_RECT, VST2_EFF_EDIT_IDLE, VST2_EFF_EDIT_OPEN,
    };
    use crate::audio::state::NativePluginHandle;
    use crate::audio::vst3_abi::{
        ComObj, HostPlugFrame, IEditControllerVtbl, IPlugViewVtbl, PlugFrameState, ViewRect,
        K_RESULT_OK,
    };
    use std::ffi::{c_char, c_void, CString};
    use std::sync::{Arc, Mutex};

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
        #[cfg(target_arch = "x86_64")]
        fn objc_msgSend_stret();
    }

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn NSClassFromString(a_class_name: *const c_void) -> *mut c_void;
    }

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "CoreAudioKit", kind = "framework")]
    extern "C" {}

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    #[allow(dead_code)]
    struct NSPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct NSSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    #[allow(dead_code)]
    struct NSRect {
        origin: NSPoint,
        size: NSSize,
    }

    #[inline]
    unsafe fn sel(name: &std::ffi::CStr) -> *mut c_void {
        sel_registerName(name.as_ptr())
    }

    #[inline]
    unsafe fn msg0(obj: *mut c_void, s: *mut c_void) -> *mut c_void {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s)
    }

    #[inline]
    unsafe fn msg0_void(obj: *mut c_void, s: *mut c_void) {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s);
    }

    #[inline]
    unsafe fn msg0_u8(obj: *mut c_void, s: *mut c_void) -> u8 {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> u8 =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s)
    }

    #[inline]
    unsafe fn msg1_ptr(obj: *mut c_void, s: *mut c_void, arg: *mut c_void) -> *mut c_void {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s, arg)
    }

    #[inline]
    unsafe fn msg1_u8_void(obj: *mut c_void, s: *mut c_void, arg: u8) {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, u8) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s, arg);
    }

    #[inline]
    unsafe fn msg1_size_void(obj: *mut c_void, s: *mut c_void, arg: NSSize) {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, NSSize) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s, arg);
    }

    unsafe fn nsview_frame(view: *mut c_void) -> NSRect {
        let s = sel(c"frame");
        #[cfg(target_arch = "aarch64")]
        {
            let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> NSRect =
                std::mem::transmute(objc_msgSend as *const ());
            f(view, s)
        }
        #[cfg(target_arch = "x86_64")]
        {
            let mut rect = NSRect::default();
            let f: unsafe extern "C" fn(*mut NSRect, *mut c_void, *mut c_void) =
                std::mem::transmute(objc_msgSend_stret as *const ());
            f(&mut rect, view, s);
            rect
        }
    }

    unsafe fn make_nsstring(text: &str) -> *mut c_void {
        let c_text = CString::new(text).unwrap_or_else(|_| CString::new("Plugin").unwrap());
        let cls = objc_getClass(c"NSString".as_ptr());
        let alloc = msg0(cls, sel(c"alloc"));
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(alloc, sel(c"initWithUTF8String:"), c_text.as_ptr())
    }

    unsafe fn create_nswindow(width: f64, height: f64, title: &str, resizable: bool) -> *mut c_void {
        let cls = objc_getClass(c"NSWindow".as_ptr());
        let alloc = msg0(cls, sel(c"alloc"));
        let rect = NSRect {
            origin: NSPoint { x: 160.0, y: 160.0 },
            size: NSSize {
                width: width.max(240.0),
                height: height.max(160.0),
            },
        };
        let style_mask: usize = if resizable { 1 | 2 | 4 | 8 } else { 1 | 2 | 4 };
        let init_fn: unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            NSRect,
            usize,
            usize,
            u8,
        ) -> *mut c_void = std::mem::transmute(objc_msgSend as *const ());
        let window = init_fn(
            alloc,
            sel(c"initWithContentRect:styleMask:backing:defer:"),
            rect,
            style_mask,
            2, // NSBackingStoreBuffered
            0, // NO
        );
        if !window.is_null() {
            msg1_u8_void(window, sel(c"setReleasedWhenClosed:"), 0);
            let ns_title = make_nsstring(title);
            if !ns_title.is_null() {
                let _ = msg1_ptr(window, sel(c"setTitle:"), ns_title);
                msg0_void(ns_title, sel(c"release"));
            }
            msg0_void(window, sel(c"center"));
        }
        window
    }

    enum NativeBackend {
        AudioUnit {
            au_factory: *mut c_void,
        },
        Vst3 {
            view: *mut ComObj<IPlugViewVtbl>,
            frame: *mut HostPlugFrame,
            frame_state: Arc<Mutex<PlugFrameState>>,
        },
        Vst2 {
            effect_ptr: usize,
        },
    }

    struct OpenEditor {
        key: SlotKey,
        window: *mut c_void,
        backend: NativeBackend,
    }

    pub struct NativeEditorManager {
        open: Vec<OpenEditor>,
    }

    impl NativeEditorManager {
        pub fn new() -> Self {
            Self { open: Vec::new() }
        }

        pub fn is_open(&self, strip: usize, slot: usize) -> bool {
            self.open.iter().any(|e| e.key == SlotKey { strip, slot })
        }

        pub fn open_editor(
            &mut self,
            strip: usize,
            slot: usize,
            handle: &NativePluginHandle,
        ) -> Result<(), String> {
            self.close_slot(strip, slot);
            let key = SlotKey { strip, slot };
            match handle {
                NativePluginHandle::AudioUnit { unit_ptr, title } => {
                    let editor = unsafe { open_au_editor(key, *unit_ptr, title)? };
                    self.open.push(editor);
                    Ok(())
                }
                NativePluginHandle::Vst3 {
                    controller_ptr,
                    title,
                } => {
                    let editor = unsafe { open_vst3_editor(key, *controller_ptr, title)? };
                    self.open.push(editor);
                    Ok(())
                }
                NativePluginHandle::Vst2 { effect_ptr, title } => {
                    let editor = unsafe { open_vst2_editor(key, *effect_ptr, title)? };
                    self.open.push(editor);
                    Ok(())
                }
            }
        }

        pub fn close_slot(&mut self, strip: usize, slot: usize) {
            let key = SlotKey { strip, slot };
            if let Some(idx) = self.open.iter().position(|e| e.key == key) {
                let ed = self.open.remove(idx);
                unsafe { destroy_editor(ed) };
            }
        }

        pub fn close_all(&mut self) {
            for ed in self.open.drain(..) {
                unsafe { destroy_editor(ed) };
            }
        }

        pub fn pump_events(&mut self) {
            let mut to_close = Vec::new();
            for ed in &self.open {
                unsafe {
                    if ed.window.is_null() || msg0_u8(ed.window, sel(c"isVisible")) == 0 {
                        to_close.push(ed.key);
                        continue;
                    }
                    match &ed.backend {
                        NativeBackend::Vst3 { frame_state, .. } => {
                            let resize = frame_state
                                .lock()
                                .ok()
                                .and_then(|mut st| st.pending_resize.take());
                            if let Some((w, h)) = resize {
                                msg1_size_void(
                                    ed.window,
                                    sel(c"setContentSize:"),
                                    NSSize {
                                        width: f64::from(w.max(100)),
                                        height: f64::from(h.max(100)),
                                    },
                                );
                            }
                        }
                        NativeBackend::Vst2 { effect_ptr } => {
                            vst2_dispatcher(
                                *effect_ptr,
                                VST2_EFF_EDIT_IDLE,
                                0,
                                0,
                                std::ptr::null_mut(),
                                0.0,
                            );
                            if let Some((w, h)) = vst2_take_pending_resize(*effect_ptr) {
                                msg1_size_void(
                                    ed.window,
                                    sel(c"setContentSize:"),
                                    NSSize {
                                        width: f64::from(w.max(100)),
                                        height: f64::from(h.max(100)),
                                    },
                                );
                            }
                        }
                        NativeBackend::AudioUnit { .. } => {}
                    }
                }
            }
            for key in to_close {
                self.close_slot(key.strip, key.slot);
            }
        }

        pub fn sync_vst3_param_normalized(
            &self,
            controller_ptr: usize,
            param_id: u32,
            norm_value: f64,
        ) {
            let ctrl = controller_ptr as *mut ComObj<IEditControllerVtbl>;
            if !ctrl.is_null() {
                unsafe {
                    let _ = ((*(*ctrl).vtbl).set_param_normalized)(
                        ctrl as *mut c_void,
                        param_id,
                        norm_value.clamp(0.0, 1.0),
                    );
                }
            }
        }
    }

    impl Drop for NativeEditorManager {
        fn drop(&mut self) {
            self.close_all();
        }
    }

    unsafe fn destroy_editor(ed: OpenEditor) {
        match ed.backend {
            NativeBackend::Vst3 {
                view,
                frame,
                frame_state,
            } => {
                if let Ok(mut st) = frame_state.lock() {
                    st.clear_run_loop();
                }
                if !view.is_null() {
                    let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
                    let _ = ((*(*view).vtbl).removed)(view as *mut c_void);
                    let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                }
                if !frame.is_null() {
                    let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
                }
            }
            NativeBackend::Vst2 { effect_ptr } => {
                vst2_dispatcher(
                    effect_ptr,
                    VST2_EFF_EDIT_CLOSE,
                    0,
                    0,
                    std::ptr::null_mut(),
                    0.0,
                );
            }
            NativeBackend::AudioUnit { au_factory } => {
                if !au_factory.is_null() {
                    msg0_void(au_factory, sel(c"release"));
                }
            }
        }
        if !ed.window.is_null() {
            let _ = msg1_ptr(ed.window, sel(c"orderOut:"), std::ptr::null_mut());
            let _ = msg1_ptr(ed.window, sel(c"setContentView:"), std::ptr::null_mut());
            msg0_void(ed.window, sel(c"close"));
            msg0_void(ed.window, sel(c"release"));
        }
    }

    unsafe fn open_au_editor(
        key: SlotKey,
        unit_ptr: usize,
        title: &str,
    ) -> Result<OpenEditor, String> {
        use coreaudio_sys::*;
        const K_AUDIO_UNIT_PROPERTY_COCOA_UI: UInt32 = 14;
        let unit = unit_ptr as AudioComponentInstance;
        if unit.is_null() {
            return Err("AudioUnit invalide.".into());
        }

        let mut view: *mut c_void = std::ptr::null_mut();
        let mut owned_view = false;
        let mut au_factory: *mut c_void = std::ptr::null_mut();

        let mut prop_size: UInt32 = 0;
        let mut writable: Boolean = 0;
        if AudioUnitGetPropertyInfo(
            unit,
            K_AUDIO_UNIT_PROPERTY_COCOA_UI,
            kAudioUnitScope_Global,
            0,
            &mut prop_size,
            &mut writable,
        ) == 0
            && prop_size as usize >= std::mem::size_of::<AudioUnitCocoaViewInfo>()
        {
            let mut buf = vec![0_u8; prop_size as usize];
            if AudioUnitGetProperty(
                unit,
                K_AUDIO_UNIT_PROPERTY_COCOA_UI,
                kAudioUnitScope_Global,
                0,
                buf.as_mut_ptr() as *mut c_void,
                &mut prop_size,
            ) == 0
            {
                let info = &*(buf.as_ptr() as *const AudioUnitCocoaViewInfo);
                let bundle_url = info.mCocoaAUViewBundleLocation as *const c_void;
                let class_name = info.mCocoaAUViewClass[0] as *const c_void;

                if !bundle_url.is_null() && !class_name.is_null() {
                    let ns_bundle_cls = objc_getClass(c"NSBundle".as_ptr());
                    let alloc_b = msg0(ns_bundle_cls, sel(c"alloc"));
                    let bundle = msg1_ptr(alloc_b, sel(c"initWithURL:"), bundle_url as *mut c_void);
                    if !bundle.is_null() {
                        let _ = msg0_u8(bundle, sel(c"load"));
                        let mut view_cls = msg1_ptr(bundle, sel(c"classNamed:"), class_name as *mut c_void);
                        if view_cls.is_null() {
                            view_cls = NSClassFromString(class_name);
                        }
                        if !view_cls.is_null() {
                            let factory_alloc = msg0(view_cls, sel(c"alloc"));
                            let factory = msg0(factory_alloc, sel(c"init"));
                            if !factory.is_null() {
                                let ui_fn: unsafe extern "C" fn(
                                    *mut c_void,
                                    *mut c_void,
                                    *mut c_void,
                                    NSSize,
                                ) -> *mut c_void = std::mem::transmute(objc_msgSend as *const ());
                                view = ui_fn(
                                    factory,
                                    sel(c"uiViewForAudioUnit:withSize:"),
                                    unit as *mut c_void,
                                    NSSize {
                                        width: 800.0,
                                        height: 560.0,
                                    },
                                );
                                au_factory = factory;
                            }
                        }
                        msg0_void(bundle, sel(c"release"));
                    }
                }

                // Libération CF selon la règle Create/Copy de kAudioUnitProperty_CocoaUI
                if !bundle_url.is_null() {
                    CFRelease(bundle_url);
                }
                let ptr_sz = std::mem::size_of::<*const c_void>();
                let num_classes = (prop_size as usize).saturating_sub(ptr_sz) / ptr_sz;
                let class_ptrs = std::slice::from_raw_parts(
                    buf.as_ptr().add(ptr_sz) as *const *const c_void,
                    num_classes,
                );
                for &cf_str in class_ptrs {
                    if !cf_str.is_null() {
                        CFRelease(cf_str);
                    }
                }
            }
        }

        // Repli CoreAudioKit::AUGenericView (ex: AudioUnits intégrés Apple)
        if view.is_null() {
            let generic_cls = objc_getClass(c"AUGenericView".as_ptr());
            if !generic_cls.is_null() {
                let alloc = msg0(generic_cls, sel(c"alloc"));
                let v = msg1_ptr(alloc, sel(c"initWithAudioUnit:"), unit as *mut c_void);
                if !v.is_null() {
                    view = v;
                    owned_view = true;
                }
            }
        }

        if view.is_null() {
            if !au_factory.is_null() {
                msg0_void(au_factory, sel(c"release"));
            }
            return Err("Impossible de créer la vue Cocoa ou AUGenericView pour cet AudioUnit.".into());
        }

        let frame = nsview_frame(view);
        let width = if frame.size.width > 10.0 { frame.size.width } else { 720.0 };
        let height = if frame.size.height > 10.0 { frame.size.height } else { 460.0 };
        let window = create_nswindow(
            width,
            height,
            &format!("{title} — AU (Tranche {} Insert {})", key.strip + 1, key.slot + 1),
            true,
        );
        if window.is_null() {
            if owned_view {
                msg0_void(view, sel(c"release"));
            }
            if !au_factory.is_null() {
                msg0_void(au_factory, sel(c"release"));
            }
            return Err("Échec création NSWindow pour l'AudioUnit.".into());
        }

        let _ = msg1_ptr(window, sel(c"setContentView:"), view);
        if owned_view {
            msg0_void(view, sel(c"release"));
        }
        let _ = msg1_ptr(window, sel(c"makeKeyAndOrderFront:"), std::ptr::null_mut());

        Ok(OpenEditor {
            key,
            window,
            backend: NativeBackend::AudioUnit { au_factory },
        })
    }

    unsafe fn open_vst3_editor(
        key: SlotKey,
        controller_ptr: usize,
        title: &str,
    ) -> Result<OpenEditor, String> {
        let ctrl = controller_ptr as *mut ComObj<IEditControllerVtbl>;
        if ctrl.is_null() {
            return Err("Ce plugin VST3 n'expose pas de contrôleur GUI (IEditController).".into());
        }
        let view = ((*(*ctrl).vtbl).create_view)(ctrl as *mut c_void, c"editor".as_ptr());
        if view.is_null() {
            return Err("Ce plugin VST3 ne fournit pas de vue graphique native ('editor').".into());
        }
        let platform_type = c"NSView".as_ptr();
        if ((*(*view).vtbl).is_platform_type_supported)(view as *mut c_void, platform_type)
            != K_RESULT_OK
        {
            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
            return Err("Ce plugin VST3 ne supporte pas le type de vue macOS 'NSView'.".into());
        }

        let frame_state = Arc::new(Mutex::new(PlugFrameState::default()));
        let frame = HostPlugFrame::new_raw(Arc::clone(&frame_state));
        let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, frame as *mut c_void);

        let mut rect = ViewRect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 540,
        };
        let _ = ((*(*view).vtbl).get_size)(view as *mut c_void, &mut rect);
        let resizable = ((*(*view).vtbl).can_resize)(view as *mut c_void) == K_RESULT_OK;
        let window = create_nswindow(
            f64::from(rect.width()),
            f64::from(rect.height()),
            &format!("{title} — VST3 (Tranche {} Insert {})", key.strip + 1, key.slot + 1),
            resizable,
        );
        if window.is_null() {
            let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
            return Err("Échec création NSWindow pour le VST3.".into());
        }

        let content_view = msg0(window, sel(c"contentView"));
        if ((*(*view).vtbl).attached)(view as *mut c_void, content_view, platform_type)
            != K_RESULT_OK
        {
            let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
            msg0_void(window, sel(c"close"));
            msg0_void(window, sel(c"release"));
            return Err("IPlugView::attached(NSView) a échoué sur ce VST3.".into());
        }

        if let Ok(mut st) = frame_state.lock() {
            if let Some((w, h)) = st.pending_resize.take() {
                rect.right = rect.left + w.max(100);
                rect.bottom = rect.top + h.max(100);
                msg1_size_void(
                    window,
                    sel(c"setContentSize:"),
                    NSSize {
                        width: f64::from(w.max(100)),
                        height: f64::from(h.max(100)),
                    },
                );
            }
        }

        let _ = ((*(*view).vtbl).on_size)(view as *mut c_void, &mut rect);
        let _ = ((*(*view).vtbl).on_focus)(view as *mut c_void, 1);
        let _ = msg1_ptr(window, sel(c"makeKeyAndOrderFront:"), std::ptr::null_mut());

        Ok(OpenEditor {
            key,
            window,
            backend: NativeBackend::Vst3 {
                view,
                frame,
                frame_state,
            },
        })
    }

    unsafe fn open_vst2_editor(
        key: SlotKey,
        effect_ptr: usize,
        title: &str,
    ) -> Result<OpenEditor, String> {
        let mut rect_ptr: *mut Vst2Rect = std::ptr::null_mut();
        vst2_dispatcher(
            effect_ptr,
            VST2_EFF_EDIT_GET_RECT,
            0,
            0,
            &mut rect_ptr as *mut *mut Vst2Rect as *mut c_void,
            0.0,
        );
        let (init_w, init_h) = if !rect_ptr.is_null() {
            let r = *rect_ptr;
            let w = (i32::from(r.right) - i32::from(r.left)).max(240);
            let h = (i32::from(r.bottom) - i32::from(r.top)).max(160);
            (f64::from(w), f64::from(h))
        } else {
            (800.0, 540.0)
        };

        let window = create_nswindow(
            init_w,
            init_h,
            &format!("{title} — VST2 (Tranche {} Insert {})", key.strip + 1, key.slot + 1),
            true,
        );
        if window.is_null() {
            return Err("Échec création NSWindow pour le VST2.".into());
        }

        let content_view = msg0(window, sel(c"contentView"));
        vst2_dispatcher(effect_ptr, VST2_EFF_EDIT_OPEN, 0, 0, content_view, 0.0);

        let mut final_w = init_w;
        let mut final_h = init_h;
        if let Some((rw, rh)) = vst2_take_pending_resize(effect_ptr) {
            final_w = f64::from(rw.max(120));
            final_h = f64::from(rh.max(120));
        } else {
            let mut post_rect: *mut Vst2Rect = std::ptr::null_mut();
            vst2_dispatcher(
                effect_ptr,
                VST2_EFF_EDIT_GET_RECT,
                0,
                0,
                &mut post_rect as *mut *mut Vst2Rect as *mut c_void,
                0.0,
            );
            if !post_rect.is_null() {
                let r = *post_rect;
                let rw = i32::from(r.right) - i32::from(r.left);
                let rh = i32::from(r.bottom) - i32::from(r.top);
                if rw > 40 && rh > 40 {
                    final_w = f64::from(rw);
                    final_h = f64::from(rh);
                }
            }
        }

        msg1_size_void(
            window,
            sel(c"setContentSize:"),
            NSSize {
                width: final_w.max(200.0),
                height: final_h.max(150.0),
            },
        );
        let _ = msg1_ptr(window, sel(c"makeKeyAndOrderFront:"), std::ptr::null_mut());
        vst2_dispatcher(
            effect_ptr,
            VST2_EFF_EDIT_IDLE,
            0,
            0,
            std::ptr::null_mut(),
            0.0,
        );

        Ok(OpenEditor {
            key,
            window,
            backend: NativeBackend::Vst2 { effect_ptr },
        })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::SlotKey;
    use crate::audio::plugin_host::{
        vst2_dispatcher, vst2_take_pending_resize, Vst2Rect, VST2_EFF_EDIT_CLOSE,
        VST2_EFF_EDIT_GET_RECT, VST2_EFF_EDIT_IDLE, VST2_EFF_EDIT_OPEN,
    };
    use crate::audio::state::NativePluginHandle;
    use crate::audio::vst3_abi::{
        ComObj, HostPlugFrame, IEditControllerVtbl, IPlugViewVtbl, PlugFrameState, ViewRect,
        K_RESULT_OK,
    };
    use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void, CString};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const EXPOSURE_MASK: c_long = 1 << 15;
    const STRUCTURE_NOTIFY_MASK: c_long = 1 << 17;
    const CONFIGURE_NOTIFY: c_int = 22;
    const CLIENT_MESSAGE: c_int = 33;

    #[repr(C)]
    #[derive(Clone, Copy)]
    #[allow(dead_code)]
    struct XConfigureEvent {
        type_: c_int,
        serial: c_ulong,
        send_event: c_int,
        display: *mut c_void,
        event: c_ulong,
        window: c_ulong,
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        border_width: c_int,
        above: c_ulong,
        override_redirect: c_int,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    #[allow(dead_code)]
    struct XClientMessageEvent {
        type_: c_int,
        serial: c_ulong,
        send_event: c_int,
        display: *mut c_void,
        window: c_ulong,
        message_type: c_ulong,
        format: c_int,
        data: [c_long; 5],
    }

    #[repr(C)]
    #[allow(dead_code)]
    union XEvent {
        type_: c_int,
        configure: XConfigureEvent,
        client: XClientMessageEvent,
        pad: [c_long; 24],
    }

    struct X11Api {
        _lib: *mut c_void,
        open_display: unsafe extern "C" fn(*const c_char) -> *mut c_void,
        close_display: unsafe extern "C" fn(*mut c_void) -> c_int,
        default_screen: unsafe extern "C" fn(*mut c_void) -> c_int,
        root_window: unsafe extern "C" fn(*mut c_void, c_int) -> c_ulong,
        black_pixel: unsafe extern "C" fn(*mut c_void, c_int) -> c_ulong,
        create_simple_window: unsafe extern "C" fn(
            *mut c_void,
            c_ulong,
            c_int,
            c_int,
            c_uint,
            c_uint,
            c_uint,
            c_ulong,
            c_ulong,
        ) -> c_ulong,
        store_name: unsafe extern "C" fn(*mut c_void, c_ulong, *const c_char) -> c_int,
        intern_atom: unsafe extern "C" fn(*mut c_void, *const c_char, c_int) -> c_ulong,
        set_wm_protocols: unsafe extern "C" fn(*mut c_void, c_ulong, *mut c_ulong, c_int) -> c_int,
        select_input: unsafe extern "C" fn(*mut c_void, c_ulong, c_long) -> c_int,
        map_window: unsafe extern "C" fn(*mut c_void, c_ulong) -> c_int,
        resize_window: unsafe extern "C" fn(*mut c_void, c_ulong, c_uint, c_uint) -> c_int,
        pending: unsafe extern "C" fn(*mut c_void) -> c_int,
        next_event: unsafe extern "C" fn(*mut c_void, *mut XEvent) -> c_int,
        destroy_window: unsafe extern "C" fn(*mut c_void, c_ulong) -> c_int,
        flush: unsafe extern "C" fn(*mut c_void) -> c_int,
    }

    impl X11Api {
        unsafe fn load() -> Result<Self, String> {
            let mut handle = libc::dlopen(c"libX11.so.6".as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
            if handle.is_null() {
                handle = libc::dlopen(c"libX11.so".as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
            }
            if handle.is_null() {
                return Err("libX11.so.6 introuvable (X11/XWayland requis pour les GUI VST3 Linux).".into());
            }
            macro_rules! sym {
                ($name:expr) => {{
                    let ptr = libc::dlsym(handle, $name.as_ptr());
                    if ptr.is_null() {
                        libc::dlclose(handle);
                        return Err("Symbole X11 manquant".into());
                    }
                    std::mem::transmute(ptr)
                }};
            }
            Ok(Self {
                _lib: handle,
                open_display: sym!(c"XOpenDisplay"),
                close_display: sym!(c"XCloseDisplay"),
                default_screen: sym!(c"XDefaultScreen"),
                root_window: sym!(c"XRootWindow"),
                black_pixel: sym!(c"XBlackPixel"),
                create_simple_window: sym!(c"XCreateSimpleWindow"),
                store_name: sym!(c"XStoreName"),
                intern_atom: sym!(c"XInternAtom"),
                set_wm_protocols: sym!(c"XSetWMProtocols"),
                select_input: sym!(c"XSelectInput"),
                map_window: sym!(c"XMapWindow"),
                resize_window: sym!(c"XResizeWindow"),
                pending: sym!(c"XPending"),
                next_event: sym!(c"XNextEvent"),
                destroy_window: sym!(c"XDestroyWindow"),
                flush: sym!(c"XFlush"),
            })
        }
    }

    impl Drop for X11Api {
        fn drop(&mut self) {
            unsafe {
                if !self._lib.is_null() {
                    libc::dlclose(self._lib);
                }
            }
        }
    }

    enum X11Backend {
        Vst3 {
            view: *mut ComObj<IPlugViewVtbl>,
            frame: *mut HostPlugFrame,
            frame_state: Arc<Mutex<PlugFrameState>>,
        },
        Vst2 {
            effect_ptr: usize,
        },
    }

    struct OpenX11Editor {
        key: SlotKey,
        window: c_ulong,
        backend: X11Backend,
    }

    pub struct NativeEditorManager {
        x11: Option<X11Api>,
        display: *mut c_void,
        wm_delete_window: c_ulong,
        open: Vec<OpenX11Editor>,
    }

    impl NativeEditorManager {
        pub fn new() -> Self {
            Self {
                x11: None,
                display: std::ptr::null_mut(),
                wm_delete_window: 0,
                open: Vec::new(),
            }
        }

        fn ensure_display(&mut self) -> Result<(), String> {
            if self.x11.is_some() && !self.display.is_null() {
                return Ok(());
            }
            unsafe {
                let api = X11Api::load()?;
                let display = (api.open_display)(std::ptr::null());
                if display.is_null() {
                    return Err(
                        "XOpenDisplay() a échoué (session Wayland pure sans XWayland ?).".into(),
                    );
                }
                let wm_del = (api.intern_atom)(display, c"WM_DELETE_WINDOW".as_ptr(), 0);
                self.display = display;
                self.wm_delete_window = wm_del;
                self.x11 = Some(api);
                Ok(())
            }
        }

        pub fn is_open(&self, strip: usize, slot: usize) -> bool {
            self.open.iter().any(|e| e.key == SlotKey { strip, slot })
        }

        pub fn open_editor(
            &mut self,
            strip: usize,
            slot: usize,
            handle: &NativePluginHandle,
        ) -> Result<(), String> {
            self.close_slot(strip, slot);
            match handle {
                NativePluginHandle::AudioUnit { .. } => {
                    Err("Apple AudioUnit n'est pas disponible sur Linux.".into())
                }
                NativePluginHandle::Vst3 {
                    controller_ptr,
                    title,
                } => {
                    self.ensure_display()?;
                    let x11 = self.x11.as_ref().unwrap();
                    let ctrl = *controller_ptr as *mut ComObj<IEditControllerVtbl>;
                    if ctrl.is_null() {
                        return Err("Contrôleur VST3 nul.".into());
                    }
                    unsafe {
                        let view = ((*(*ctrl).vtbl).create_view)(
                            ctrl as *mut c_void,
                            c"editor".as_ptr(),
                        );
                        if view.is_null() {
                            return Err("Ce plugin VST3 n'expose pas de vue graphique ('editor').".into());
                        }
                        let platform_type = c"X11EmbedWindowID".as_ptr();
                        if ((*(*view).vtbl).is_platform_type_supported)(
                            view as *mut c_void,
                            platform_type,
                        ) != K_RESULT_OK
                        {
                            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                            return Err("Ce plugin VST3 ne supporte pas 'X11EmbedWindowID'.".into());
                        }

                        let frame_state = Arc::new(Mutex::new(PlugFrameState::default()));
                        let frame = HostPlugFrame::new_raw(Arc::clone(&frame_state));
                        let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, frame as *mut c_void);

                        let mut rect = ViewRect {
                            left: 0,
                            top: 0,
                            right: 800,
                            bottom: 540,
                        };
                        let _ = ((*(*view).vtbl).get_size)(view as *mut c_void, &mut rect);
                        let w = rect.width().max(200) as c_uint;
                        let h = rect.height().max(150) as c_uint;

                        let screen = (x11.default_screen)(self.display);
                        let root = (x11.root_window)(self.display, screen);
                        let black = (x11.black_pixel)(self.display, screen);
                        let window = (x11.create_simple_window)(
                            self.display,
                            root,
                            120,
                            120,
                            w,
                            h,
                            0,
                            black,
                            black,
                        );
                        if window == 0 {
                            let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
                            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
                            return Err("XCreateSimpleWindow() a échoué.".into());
                        }

                        let win_title = CString::new(format!(
                            "{title} — VST3 (Tranche {} Insert {})",
                            strip + 1,
                            slot + 1
                        ))
                        .unwrap_or_else(|_| CString::new("VST3 Plugin").unwrap());
                        (x11.store_name)(self.display, window, win_title.as_ptr());
                        let mut proto = self.wm_delete_window;
                        (x11.set_wm_protocols)(self.display, window, &mut proto, 1);
                        (x11.select_input)(self.display, window, EXPOSURE_MASK | STRUCTURE_NOTIFY_MASK);
                        (x11.map_window)(self.display, window);
                        (x11.flush)(self.display);

                        if ((*(*view).vtbl).attached)(
                            view as *mut c_void,
                            window as usize as *mut c_void,
                            platform_type,
                        ) != K_RESULT_OK
                        {
                            let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
                            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
                            (x11.destroy_window)(self.display, window);
                            (x11.flush)(self.display);
                            return Err("IPlugView::attached(X11EmbedWindowID) a échoué.".into());
                        }

                        let _ = ((*(*view).vtbl).on_size)(view as *mut c_void, &mut rect);
                        let _ = ((*(*view).vtbl).on_focus)(view as *mut c_void, 1);
                        (x11.flush)(self.display);

                        self.open.push(OpenX11Editor {
                            key: SlotKey { strip, slot },
                            window,
                            backend: X11Backend::Vst3 {
                                view,
                                frame,
                                frame_state,
                            },
                        });
                        Ok(())
                    }
                }
                NativePluginHandle::Vst2 { effect_ptr, title } => {
                    self.ensure_display()?;
                    let x11 = self.x11.as_ref().unwrap();
                    unsafe {
                        let mut rect_ptr: *mut Vst2Rect = std::ptr::null_mut();
                        vst2_dispatcher(
                            *effect_ptr,
                            VST2_EFF_EDIT_GET_RECT,
                            0,
                            0,
                            &mut rect_ptr as *mut *mut Vst2Rect as *mut c_void,
                            0.0,
                        );
                        let (w, h) = if !rect_ptr.is_null() {
                            let r = *rect_ptr;
                            (
                                (i32::from(r.right) - i32::from(r.left)).max(240) as c_uint,
                                (i32::from(r.bottom) - i32::from(r.top)).max(160) as c_uint,
                            )
                        } else {
                            (800, 540)
                        };

                        let screen = (x11.default_screen)(self.display);
                        let root = (x11.root_window)(self.display, screen);
                        let black = (x11.black_pixel)(self.display, screen);
                        let window = (x11.create_simple_window)(
                            self.display,
                            root,
                            120,
                            120,
                            w,
                            h,
                            0,
                            black,
                            black,
                        );
                        if window == 0 {
                            return Err("XCreateSimpleWindow() a échoué pour VST2.".into());
                        }
                        let win_title = CString::new(format!(
                            "{title} — VST2 (Tranche {} Insert {})",
                            strip + 1,
                            slot + 1
                        ))
                        .unwrap_or_else(|_| CString::new("VST2 Plugin").unwrap());
                        (x11.store_name)(self.display, window, win_title.as_ptr());
                        let mut proto = self.wm_delete_window;
                        (x11.set_wm_protocols)(self.display, window, &mut proto, 1);
                        (x11.select_input)(self.display, window, EXPOSURE_MASK | STRUCTURE_NOTIFY_MASK);
                        (x11.map_window)(self.display, window);
                        (x11.flush)(self.display);

                        vst2_dispatcher(
                            *effect_ptr,
                            VST2_EFF_EDIT_OPEN,
                            0,
                            0,
                            window as usize as *mut c_void,
                            0.0,
                        );
                        if let Some((rw, rh)) = vst2_take_pending_resize(*effect_ptr) {
                            (x11.resize_window)(
                                self.display,
                                window,
                                rw.max(120) as c_uint,
                                rh.max(120) as c_uint,
                            );
                        } else {
                            let mut post_rect: *mut Vst2Rect = std::ptr::null_mut();
                            vst2_dispatcher(
                                *effect_ptr,
                                VST2_EFF_EDIT_GET_RECT,
                                0,
                                0,
                                &mut post_rect as *mut *mut Vst2Rect as *mut c_void,
                                0.0,
                            );
                            if !post_rect.is_null() {
                                let r = *post_rect;
                                let rw = i32::from(r.right) - i32::from(r.left);
                                let rh = i32::from(r.bottom) - i32::from(r.top);
                                if rw > 40 && rh > 40 {
                                    (x11.resize_window)(
                                        self.display,
                                        window,
                                        rw as c_uint,
                                        rh as c_uint,
                                    );
                                }
                            }
                        }
                        (x11.flush)(self.display);

                        self.open.push(OpenX11Editor {
                            key: SlotKey { strip, slot },
                            window,
                            backend: X11Backend::Vst2 {
                                effect_ptr: *effect_ptr,
                            },
                        });
                        Ok(())
                    }
                }
            }
        }

        pub fn close_slot(&mut self, strip: usize, slot: usize) {
            let key = SlotKey { strip, slot };
            if let Some(idx) = self.open.iter().position(|e| e.key == key) {
                let ed = self.open.remove(idx);
                self.destroy_x11_editor(ed);
            }
        }

        pub fn close_all(&mut self) {
            let drained: Vec<_> = self.open.drain(..).collect();
            for ed in drained {
                self.destroy_x11_editor(ed);
            }
            if let Some(x11) = self.x11.take() {
                if !self.display.is_null() {
                    unsafe {
                        (x11.close_display)(self.display);
                    }
                    self.display = std::ptr::null_mut();
                }
            }
        }

        fn destroy_x11_editor(&self, ed: OpenX11Editor) {
            unsafe {
                match ed.backend {
                    X11Backend::Vst3 {
                        view,
                        frame,
                        frame_state,
                    } => {
                        if let Ok(mut st) = frame_state.lock() {
                            st.clear_run_loop();
                        }
                        if !view.is_null() {
                            let _ = ((*(*view).vtbl).set_frame)(
                                view as *mut c_void,
                                std::ptr::null_mut(),
                            );
                            let _ = ((*(*view).vtbl).removed)(view as *mut c_void);
                            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                        }
                        if !frame.is_null() {
                            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
                        }
                    }
                    X11Backend::Vst2 { effect_ptr } => {
                        vst2_dispatcher(
                            effect_ptr,
                            VST2_EFF_EDIT_CLOSE,
                            0,
                            0,
                            std::ptr::null_mut(),
                            0.0,
                        );
                    }
                }
                if let Some(x11) = &self.x11 {
                    if !self.display.is_null() && ed.window != 0 {
                        (x11.destroy_window)(self.display, ed.window);
                        (x11.flush)(self.display);
                    }
                }
            }
        }

        pub fn pump_events(&mut self) {
            let Some(x11) = self.x11.as_ref() else {
                return;
            };
            if self.display.is_null() || self.open.is_empty() {
                return;
            }

            let mut to_close = Vec::new();
            unsafe {
                while (x11.pending)(self.display) > 0 {
                    let mut ev: XEvent = std::mem::zeroed();
                    (x11.next_event)(self.display, &mut ev);
                    let ev_type = ev.type_;
                    if ev_type == CLIENT_MESSAGE {
                        let cm = ev.client;
                        if cm.data[0] as c_ulong == self.wm_delete_window {
                            if let Some(ed) = self.open.iter().find(|e| e.window == cm.window) {
                                to_close.push(ed.key);
                            }
                        }
                    } else if ev_type == CONFIGURE_NOTIFY {
                        let cfg = ev.configure;
                        if let Some(ed) = self.open.iter().find(|e| e.window == cfg.window) {
                            if let X11Backend::Vst3 { view, .. } = &ed.backend {
                                let mut vr = ViewRect {
                                    left: 0,
                                    top: 0,
                                    right: cfg.width.max(100),
                                    bottom: cfg.height.max(100),
                                };
                                let _ = ((*(*view).vtbl).on_size)(*view as *mut c_void, &mut vr);
                            }
                        }
                    }
                }

                let now = Instant::now();
                for ed in &self.open {
                    match &ed.backend {
                        X11Backend::Vst3 { frame_state, .. } => {
                            let (resize, ev_handlers, due_timers) = {
                                let Ok(mut st) = frame_state.lock() else {
                                    continue;
                                };
                                let resize = st.pending_resize.take();
                                let ev_handlers = st.event_handlers.clone();
                                let mut due_timers = Vec::new();
                                for t in &mut st.timers {
                                    if now.duration_since(t.last_fired)
                                        >= Duration::from_millis(t.interval_ms)
                                    {
                                        t.last_fired = now;
                                        due_timers.push(t.handler);
                                    }
                                }
                                (resize, ev_handlers, due_timers)
                            };

                            if let Some((w, h)) = resize {
                                (x11.resize_window)(
                                    self.display,
                                    ed.window,
                                    w.max(100) as c_uint,
                                    h.max(100) as c_uint,
                                );
                                (x11.flush)(self.display);
                            }

                            if !ev_handlers.is_empty() {
                                let mut pfds: Vec<libc::pollfd> = ev_handlers
                                    .iter()
                                    .map(|h| libc::pollfd {
                                        fd: h.fd,
                                        events: libc::POLLIN,
                                        revents: 0,
                                    })
                                    .collect();
                                if libc::poll(pfds.as_mut_ptr(), pfds.len() as libc::nfds_t, 0) > 0
                                {
                                    for (pfd, ev) in pfds.iter().zip(ev_handlers.iter()) {
                                        if (pfd.revents & libc::POLLIN) != 0 && !ev.handler.is_null()
                                        {
                                            ((*(*ev.handler).vtbl).on_fd_is_set)(
                                                ev.handler as *mut c_void,
                                                ev.fd,
                                            );
                                        }
                                    }
                                }
                            }

                            for timer_handler in due_timers {
                                if !timer_handler.is_null() {
                                    ((*(*timer_handler).vtbl).on_timer)(
                                        timer_handler as *mut c_void,
                                    );
                                }
                            }
                        }
                        X11Backend::Vst2 { effect_ptr } => {
                            vst2_dispatcher(
                                *effect_ptr,
                                VST2_EFF_EDIT_IDLE,
                                0,
                                0,
                                std::ptr::null_mut(),
                                0.0,
                            );
                            if let Some((w, h)) = vst2_take_pending_resize(*effect_ptr) {
                                (x11.resize_window)(
                                    self.display,
                                    ed.window,
                                    w.max(100) as c_uint,
                                    h.max(100) as c_uint,
                                );
                                (x11.flush)(self.display);
                            }
                        }
                    }
                }
            }

            for key in to_close {
                self.close_slot(key.strip, key.slot);
            }
        }

        pub fn sync_vst3_param_normalized(
            &self,
            controller_ptr: usize,
            param_id: u32,
            norm_value: f64,
        ) {
            let ctrl = controller_ptr as *mut ComObj<IEditControllerVtbl>;
            if !ctrl.is_null() {
                unsafe {
                    let _ = ((*(*ctrl).vtbl).set_param_normalized)(
                        ctrl as *mut c_void,
                        param_id,
                        norm_value.clamp(0.0, 1.0),
                    );
                }
            }
        }
    }

    impl Drop for NativeEditorManager {
        fn drop(&mut self) {
            self.close_all();
        }
    }
}

pub use platform::NativeEditorManager;
`,
  },
  {
    path: 'src/ui/widgets.rs',
    language: 'rust',
    description: 'Widgets audio egui sur mesure : potentiomètre rotatif, fader dB, VU-mètre LED et boutons Solo/Mute',
    content: `use egui::{Color32, Pos2, Rect, Response, Sense, Stroke, Ui, Vec2};
use std::f32::consts::PI;

pub fn rotary_knob(
    ui: &mut Ui,
    value: &mut f32,
    range: std::ops::RangeInclusive<f32>,
    default_val: f32,
    label: &str,
    unit: &str,
    accent: Color32,
    size: f32,
) -> Response {
    let label_h = (size * 0.48).clamp(11.0, 16.0);
    let pad_w = (size * 0.36).clamp(8.0, 14.0);
    let (rect, mut response) = ui.allocate_exact_size(
        Vec2::new(size + pad_w, size + label_h + 6.0),
        Sense::click_and_drag(),
    );

    if response.double_clicked() {
        *value = default_val;
        response.mark_changed();
    }
    if response.dragged() {
        let span = *range.end() - *range.start();
        let sensitivity = if ui.input(|i| i.modifiers.shift) { 0.0015 } else { 0.005 };
        *value = (*value - response.drag_delta().y * span * sensitivity).clamp(*range.start(), *range.end());
        response.mark_changed();
    }

    if ui.is_rect_visible(rect) {
        let painter = ui.painter();
        let center = Pos2::new(rect.center().x, rect.top() + size * 0.5 + 2.0);
        let radius = size * 0.42;
        let norm = ((*value - *range.start()) / (*range.end() - *range.start())).clamp(0.0, 1.0);

        // Arc de fond (-135 deg à +135 deg)
        let start_angle = 0.75 * PI;
        let sweep = 1.5 * PI;
        draw_arc(painter, center, radius + 3.0, start_angle, start_angle + sweep, Stroke::new(2.0_f32, Color32::from_rgb(38, 45, 58)));
        draw_arc(painter, center, radius + 3.0, start_angle, start_angle + sweep * norm, Stroke::new(2.5_f32, accent));

        // Corps du bouton rotatif
        painter.circle_filled(center, radius, Color32::from_rgb(24, 29, 40));
        painter.circle_stroke(center, radius, Stroke::new(1.0_f32, Color32::from_rgb(56, 65, 82)));

        // Curseur rotatif
        let angle = start_angle + sweep * norm;
        let tip = Pos2::new(center.x + angle.cos() * (radius - 2.0), center.y + angle.sin() * (radius - 2.0));
        let inner = Pos2::new(center.x + angle.cos() * (radius * 0.35), center.y + angle.sin() * (radius * 0.35));
        painter.line_segment([inner, tip], Stroke::new(2.0_f32, Color32::WHITE));

        let font_sz = (size * 0.34).clamp(8.0, 10.0);
        painter.text(
            Pos2::new(rect.center().x, rect.bottom() - 5.0),
            egui::Align2::CENTER_CENTER,
            format!("{label} {value:.0}{unit}"),
            egui::FontId::monospace(font_sz),
            Color32::from_rgb(165, 175, 195),
        );
    }

    response
}

fn draw_arc(painter: &egui::Painter, center: Pos2, radius: f32, start: f32, end: f32, stroke: Stroke) {
    let steps = 24;
    let mut pts = Vec::with_capacity(steps + 1);
    for i in 0..=steps {
        let t = i as f32 / steps as f32;
        let a = start + (end - start) * t;
        pts.push(Pos2::new(center.x + a.cos() * radius, center.y + a.sin() * radius));
    }
    painter.add(egui::Shape::line(pts, stroke));
}

pub fn vertical_fader(ui: &mut Ui, value_db: &mut f32, height: f32) -> Response {
    let width = (height * 0.25).clamp(24.0, 34.0);
    let (rect, mut response) = ui.allocate_exact_size(Vec2::new(width, height), Sense::click_and_drag());
    let min_db = -60.0_f32;
    let max_db = 12.0_f32;

    if response.double_clicked() {
        *value_db = 0.0;
        response.mark_changed();
    }
    if response.dragged() {
        let norm = 1.0 - ((ui.input(|i| i.pointer.interact_pos()).unwrap_or(rect.center()).y - rect.top()) / rect.height()).clamp(0.0, 1.0);
        *value_db = min_db + norm * (max_db - min_db);
        response.mark_changed();
    }

    if ui.is_rect_visible(rect) {
        let painter = ui.painter();
        let track_x = rect.center().x;
        painter.line_segment(
            [Pos2::new(track_x, rect.top() + 8.0), Pos2::new(track_x, rect.bottom() - 8.0)],
            Stroke::new(3.0_f32, Color32::from_rgb(15, 18, 25)),
        );

        let norm = ((*value_db - min_db) / (max_db - min_db)).clamp(0.0, 1.0);
        let y = rect.bottom() - 10.0 - norm * (rect.height() - 20.0);
        let cap_w = (width - 6.0).max(18.0);
        let cap = Rect::from_center_size(Pos2::new(track_x, y), Vec2::new(cap_w, 14.0));
        painter.rect_filled(cap, 2.0, Color32::from_rgb(203, 213, 225));
        painter.line_segment([Pos2::new(cap.left() + 2.0, y), Pos2::new(cap.right() - 2.0, y)], Stroke::new(1.5_f32, Color32::from_rgb(15, 23, 42)));
    }

    response
}

pub fn vu_meter(ui: &mut Ui, peak_l: f32, peak_r: f32, rms_l: f32, rms_r: f32, clip: bool, height: f32) {
    let width = (height * 0.14).clamp(14.0, 18.0);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, height), Sense::hover());
    if !ui.is_rect_visible(rect) {
        return;
    }
    let painter = ui.painter();
    painter.rect_filled(rect, 2.0, Color32::from_rgb(8, 10, 15));

    let segments = 16;
    let seg_h = (rect.height() - 8.0) / segments as f32;
    let ch_w = ((width - 6.0) * 0.5).max(4.0);
    for (ch_idx, (&peak_db, &rms_db)) in [peak_l, peak_r].iter().zip([rms_l, rms_r].iter()).enumerate() {
        let peak_norm = ((peak_db + 60.0) / 60.0).clamp(0.0, 1.0);
        let rms_norm = ((rms_db + 60.0) / 60.0).clamp(0.0, 1.0);
        let peak_count = (peak_norm * segments as f32).round() as usize;
        let rms_count = (rms_norm * segments as f32).round() as usize;
        let x = rect.left() + 2.0 + ch_idx as f32 * (ch_w + 2.0);
        for s in 0..segments {
            let y = rect.bottom() - 4.0 - (s as f32 + 1.0) * seg_h;
            let seg_rect = Rect::from_min_size(Pos2::new(x, y), Vec2::new(ch_w, (seg_h - 1.5).max(2.0)));
            let color = if s < rms_count {
                if s >= 14 {
                    Color32::from_rgb(239, 68, 68)
                } else if s >= 11 {
                    Color32::from_rgb(245, 158, 11)
                } else {
                    Color32::from_rgb(16, 185, 129)
                }
            } else if s < peak_count {
                Color32::from_rgb(56, 189, 248)
            } else {
                Color32::from_rgb(24, 29, 38)
            };
            painter.rect_filled(seg_rect, 1.0, color);
        }
    }
    if clip {
        let clip_rect = Rect::from_min_size(rect.min, Vec2::new(rect.width(), 4.0));
        painter.rect_filled(clip_rect, 1.0, Color32::from_rgb(239, 68, 68));
    }
}

pub fn push_button(ui: &mut Ui, label: &str, active: &mut bool, active_color: Color32, scale: f32) -> bool {
    let fill = if *active { active_color } else { Color32::from_rgb(27, 33, 45) };
    let text_color = if *active { Color32::BLACK } else { Color32::from_rgb(180, 190, 205) };
    let font_sz = (10.5 * scale).clamp(8.5, 11.5);
    let min_w = (32.0 * scale).clamp(24.0, 42.0);
    let min_h = (21.0 * scale).clamp(17.0, 24.0);
    let btn = egui::Button::new(egui::RichText::new(label).size(font_sz).strong().color(text_color))
        .fill(fill)
        .min_size(Vec2::new(min_w, min_h));
    if ui.add(btn).clicked() {
        *active = !*active;
        true
    } else {
        false
    }
}
`,
  },
  {
    path: 'src/ui/mixer_app.rs',
    language: 'rust',
    description: 'Interface complète de la console : 8 tranches d’entrée, 4 bus Aux stéréo, Master sans Gain/Solo, Rack 5 Inserts et GUI natives',
    content: `use crate::audio::engine::{
    default_mixer_strips, list_audio_devices, start_audio_engine, AudioEngineHandle,
};
use crate::audio::plugin_host::{instantiate_plugin, scan_system_plugins, HostedPlugin};
use crate::audio::state::{
    DiscoveredPlugin, MeterFrame, MixerCommand, NativePluginHandle, PluginFormat, StripKind,
    StripState, MAX_INSERTS_PER_STRIP, NUM_AUX_STRIPS, NUM_INPUT_STRIPS, TOTAL_STRIPS,
};
use crate::ui::native_editor::NativeEditorManager;
use crate::ui::widgets::{push_button, rotary_knob, vertical_fader, vu_meter};
use eframe::egui;
use egui::Color32;
use ringbuf::traits::{Consumer, Producer};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiScaleMode {
    Auto,
    Scale75,
    Scale85,
    Scale100,
    Scale115,
}

impl UiScaleMode {
    fn label(self) -> &'static str {
        match self {
            Self::Auto => "Auto",
            Self::Scale75 => "75%",
            Self::Scale85 => "85%",
            Self::Scale100 => "100%",
            Self::Scale115 => "115%",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StripViewFilter {
    All,
    InputsOnly,
    BusesOnly,
}

impl StripViewFilter {
    fn label(self) -> &'static str {
        match self {
            Self::All => "Toutes (13)",
            Self::InputsOnly => "Entrées (1–8)",
            Self::BusesOnly => "Aux & Master",
        }
    }
}

pub struct UmcMixerApp {
    strips: Vec<StripState>,
    meters: [MeterFrame; TOTAL_STRIPS],
    // IMPORTANT : déclaré avant \`offline_plugins\` et \`engine\` pour fermer toutes les fenêtres natives avant le déchargement des plugins.
    native_editors: NativeEditorManager,
    native_handles: [[Option<NativePluginHandle>; MAX_INSERTS_PER_STRIP]; TOTAL_STRIPS],
    offline_plugins: [[Option<Box<dyn HostedPlugin>>; MAX_INSERTS_PER_STRIP]; TOTAL_STRIPS],
    engine: Option<AudioEngineHandle>,
    devices: Vec<String>,
    selected_device: String,
    discovered_plugins: Vec<DiscoveredPlugin>,
    active_insert_target: Option<(usize, usize)>,
    modal_show_catalog: bool,
    plugin_search: String,
    plugin_format_filter: Option<PluginFormat>,
    last_plugin_error: Option<(usize, usize, String)>,
    last_native_ui_error: Option<(usize, usize, String)>,
    scale_mode: UiScaleMode,
    view_filter: StripViewFilter,
    status_error: Option<String>,
}

impl Drop for UmcMixerApp {
    fn drop(&mut self) {
        self.native_editors.close_all();
    }
}

impl UmcMixerApp {
    pub fn new() -> Self {
        let strips = default_mixer_strips();
        let devices = list_audio_devices();
        let discovered_plugins = scan_system_plugins();
        let (engine, status_error) = match start_audio_engine(None) {
            Ok(h) => (Some(h), None),
            Err(e) => (None, Some(e)),
        };
        let selected_device = engine
            .as_ref()
            .map(|e| e.device_name.clone())
            .unwrap_or_else(|| "Aucun périphérique".into());

        Self {
            strips,
            meters: [MeterFrame::default(); TOTAL_STRIPS],
            native_editors: NativeEditorManager::new(),
            native_handles: std::array::from_fn(|_| std::array::from_fn(|_| None)),
            offline_plugins: std::array::from_fn(|_| std::array::from_fn(|_| None)),
            engine,
            devices,
            selected_device,
            discovered_plugins,
            active_insert_target: None,
            modal_show_catalog: false,
            plugin_search: String::new(),
            plugin_format_filter: None,
            last_plugin_error: None,
            last_native_ui_error: None,
            scale_mode: UiScaleMode::Auto,
            view_filter: StripViewFilter::All,
            status_error,
        }
    }

    fn send(&mut self, cmd: MixerCommand) {
        if let Some(eng) = self.engine.as_mut() {
            let _ = eng.command_tx.try_push(cmd);
        }
    }

    fn install_insert_on_main_thread(
        &mut self,
        strip_idx: usize,
        slot_idx: usize,
        plugin: Option<DiscoveredPlugin>,
        auto_open_gui: bool,
    ) {
        self.native_editors.close_slot(strip_idx, slot_idx);
        self.native_handles[strip_idx][slot_idx] = None;
        self.offline_plugins[strip_idx][slot_idx] = None;
        self.last_native_ui_error = None;

        match plugin {
            None => {
                self.strips[strip_idx].inserts[slot_idx].plugin = None;
                self.strips[strip_idx].inserts[slot_idx].params.clear();
                self.strips[strip_idx].inserts[slot_idx].bypassed = false;
                if matches!(&self.last_plugin_error, Some((s, sl, _)) if *s == strip_idx && *sl == slot_idx) {
                    self.last_plugin_error = None;
                }
                self.send(MixerCommand::InstallInsert {
                    strip: strip_idx,
                    slot: slot_idx,
                    plugin: None,
                });
            }
            Some(desc) => {
                let sr = self
                    .engine
                    .as_ref()
                    .map(|e| e.sample_rate as f32)
                    .unwrap_or(48000.0);
                self.strips[strip_idx].inserts[slot_idx].plugin = Some(desc.clone());
                self.strips[strip_idx].inserts[slot_idx].bypassed = false;
                self.strips[strip_idx].inserts[slot_idx].params.clear();

                match instantiate_plugin(&desc) {
                    Ok(mut hosted) => {
                        hosted.prepare(sr, 2048);
                        eprintln!(
                            "Insert chargé [{} / {:?}] sur tranche {} slot {}",
                            hosted.name(),
                            hosted.format(),
                            strip_idx + 1,
                            slot_idx + 1
                        );
                        let params = hosted.parameters();
                        let native_handle = hosted.native_handle();
                        self.strips[strip_idx].inserts[slot_idx].params = params;
                        self.native_handles[strip_idx][slot_idx] = native_handle.clone();
                        if matches!(&self.last_plugin_error, Some((s, sl, _)) if *s == strip_idx && *sl == slot_idx) {
                            self.last_plugin_error = None;
                        }

                        if let Some(eng) = self.engine.as_mut() {
                            if let Err(MixerCommand::InstallInsert { plugin: Some(p), .. }) =
                                eng.command_tx.try_push(MixerCommand::InstallInsert {
                                    strip: strip_idx,
                                    slot: slot_idx,
                                    plugin: Some(hosted),
                                })
                            {
                                self.offline_plugins[strip_idx][slot_idx] = Some(p);
                            }
                        } else {
                            self.offline_plugins[strip_idx][slot_idx] = Some(hosted);
                        }

                        if auto_open_gui {
                            if let Some(handle) = native_handle.as_ref() {
                                if let Err(err) =
                                    self.native_editors.open_editor(strip_idx, slot_idx, handle)
                                {
                                    self.last_native_ui_error = Some((strip_idx, slot_idx, err));
                                }
                            }
                        }
                    }
                    Err(err) => {
                        self.last_plugin_error = Some((strip_idx, slot_idx, err));
                        self.send(MixerCommand::InstallInsert {
                            strip: strip_idx,
                            slot: slot_idx,
                            plugin: None,
                        });
                    }
                }
            }
        }
    }

    fn compute_scale(&self, ctx: &egui::Context) -> f32 {
        match self.scale_mode {
            UiScaleMode::Auto => {
                let rect = ctx.screen_rect();
                let h_scale = ((rect.height() - 56.0) / 560.0).clamp(0.70, 1.10);
                let w_scale = (rect.width() / 1380.0).clamp(0.78, 1.10);
                (h_scale * 0.8 + w_scale * 0.2).clamp(0.72, 1.10)
            }
            UiScaleMode::Scale75 => 0.75,
            UiScaleMode::Scale85 => 0.85,
            UiScaleMode::Scale100 => 1.00,
            UiScaleMode::Scale115 => 1.15,
        }
    }
}

impl eframe::App for UmcMixerApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.native_editors.pump_events();

        if let Some(eng) = self.engine.as_mut() {
            while let Some(frame) = eng.meter_rx.try_pop() {
                self.meters = frame;
            }
            while let Some(_retired) = eng.retired_plugin_rx.try_pop() {
                // Libéré proprement sur le thread UI principal
            }
        }
        ctx.request_repaint_after(std::time::Duration::from_millis(16));

        let scale = self.compute_scale(ctx);

        egui::TopBottomPanel::top("top_bar").show(ctx, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.heading("UMC1820 Studio Mixer");
                ui.separator();
                egui::ComboBox::from_label("Pilote")
                    .selected_text(&self.selected_device)
                    .show_ui(ui, |ui| {
                        for dev in self.devices.clone() {
                            if ui.selectable_label(self.selected_device == dev, &dev).clicked() {
                                self.native_editors.close_all();
                                self.native_handles =
                                    std::array::from_fn(|_| std::array::from_fn(|_| None));
                                self.offline_plugins =
                                    std::array::from_fn(|_| std::array::from_fn(|_| None));
                                self.engine = None;
                                self.selected_device = dev.clone();
                                match start_audio_engine(Some(&dev)) {
                                    Ok(h) => {
                                        self.engine = Some(h);
                                        self.status_error = None;
                                    }
                                    Err(e) => self.status_error = Some(e),
                                }
                                for s_idx in 0..self.strips.len() {
                                    for sl_idx in 0..MAX_INSERTS_PER_STRIP {
                                        if let Some(plugin) =
                                            self.strips[s_idx].inserts[sl_idx].plugin.clone()
                                        {
                                            let byp = self.strips[s_idx].inserts[sl_idx].bypassed;
                                            self.install_insert_on_main_thread(
                                                s_idx,
                                                sl_idx,
                                                Some(plugin),
                                                false,
                                            );
                                            self.strips[s_idx].inserts[sl_idx].bypassed = byp;
                                            self.send(MixerCommand::BypassInsert {
                                                strip: s_idx,
                                                slot: sl_idx,
                                                bypassed: byp,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    });

                egui::ComboBox::from_label("Taille")
                    .selected_text(self.scale_mode.label())
                    .width(68.0)
                    .show_ui(ui, |ui| {
                        for mode in [
                            UiScaleMode::Auto,
                            UiScaleMode::Scale75,
                            UiScaleMode::Scale85,
                            UiScaleMode::Scale100,
                            UiScaleMode::Scale115,
                        ] {
                            ui.selectable_value(&mut self.scale_mode, mode, mode.label());
                        }
                    });

                egui::ComboBox::from_label("Vue")
                    .selected_text(self.view_filter.label())
                    .width(105.0)
                    .show_ui(ui, |ui| {
                        for filter in [
                            StripViewFilter::All,
                            StripViewFilter::InputsOnly,
                            StripViewFilter::BusesOnly,
                        ] {
                            ui.selectable_value(&mut self.view_filter, filter, filter.label());
                        }
                    });

                if let Some(eng) = &self.engine {
                    ui.label(
                        egui::RichText::new(format!("{} Hz · {} fr", eng.sample_rate, eng.buffer_frames))
                            .size(11.0)
                            .color(Color32::GRAY),
                    );
                }
                if ui.button("Rescanner VST2/VST3/AU").clicked() {
                    self.discovered_plugins = scan_system_plugins();
                }
                if let Some(err) = &self.status_error {
                    ui.colored_label(Color32::from_rgb(239, 68, 68), err);
                }
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::both()
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    ui.horizontal_top(|ui| {
                        for i in 0..self.strips.len() {
                            let visible = match self.view_filter {
                                StripViewFilter::All => true,
                                StripViewFilter::InputsOnly => i < NUM_INPUT_STRIPS,
                                StripViewFilter::BusesOnly => i >= NUM_INPUT_STRIPS,
                            };
                            if visible {
                                self.draw_strip(ui, i, scale);
                                ui.add_space(4.0 * scale);
                            }
                        }
                    });
                });
        });

        self.draw_plugin_picker_modal(ctx);
    }
}

impl UmcMixerApp {
    fn draw_strip(&mut self, ui: &mut egui::Ui, idx: usize, scale: f32) {
        let kind = self.strips[idx].kind;
        let is_master = kind == StripKind::Master;
        let bg = match kind {
            StripKind::Input => Color32::from_rgb(19, 23, 32),
            StripKind::Aux => Color32::from_rgb(17, 25, 36),
            StripKind::Master => Color32::from_rgb(26, 22, 24),
        };

        let strip_w = (112.0 * scale).clamp(84.0, 134.0);
        let text_sm = (9.5 * scale).clamp(8.0, 11.0);
        let gain_knob_sz = (30.0 * scale).clamp(22.0, 36.0);
        let eq_knob_sz = (23.0 * scale).clamp(17.0, 28.0);
        let aux_knob_sz = (22.0 * scale).clamp(16.0, 27.0);
        let fader_h = (118.0 * scale).clamp(78.0, 150.0);

        egui::Frame::none()
            .fill(bg)
            .stroke(egui::Stroke::new(1.0_f32, Color32::from_rgb(35, 41, 54)))
            .inner_margin((6.0 * scale).clamp(4.0, 8.0))
            .rounding(4.0)
            .show(ui, |ui| {
                ui.set_width(strip_w);
                ui.spacing_mut().item_spacing.y = (3.0 * scale).clamp(2.0, 5.0);
                ui.vertical_centered(|ui| {
                    ui.label(
                        egui::RichText::new(&self.strips[idx].name)
                            .strong()
                            .size((12.0 * scale).clamp(9.5, 14.0)),
                    );

                    // 1. Gain rotatif (UNIQUEMENT sur les 8 tranches d'entrée, absent sur Aux et Master)
                    if kind == StripKind::Input {
                        let mut gain = self.strips[idx].gain_db;
                        if rotary_knob(
                            ui,
                            &mut gain,
                            -12.0..=24.0,
                            0.0,
                            "GAIN",
                            "dB",
                            Color32::from_rgb(245, 158, 11),
                            gain_knob_sz,
                        )
                        .changed()
                        {
                            self.strips[idx].gain_db = gain;
                            self.send(MixerCommand::SetGain { strip: idx, gain_db: gain });
                        }
                    } else {
                        let bus_tag = if is_master { "BUS MASTER" } else { "BUS AUX STÉRÉO" };
                        let spacer_h = gain_knob_sz + (gain_knob_sz * 0.48).clamp(11.0, 16.0) + 6.0;
                        ui.allocate_ui(egui::vec2(strip_w, spacer_h), |ui| {
                            ui.centered_and_justified(|ui| {
                                ui.label(egui::RichText::new(bus_tag).size(text_sm).color(Color32::GRAY));
                            });
                        });
                    }

                    ui.separator();

                    // 2. 5 emplacements d'inserts VST2/VST3/AU maximum
                    ui.label(egui::RichText::new("INSERTS (5 MAX)").size(text_sm * 0.92).color(Color32::GRAY));
                    let slot_btn_h = (17.0 * scale).clamp(14.0, 20.0);
                    for slot in 0..MAX_INSERTS_PER_STRIP {
                        let slot_state = self.strips[idx].inserts[slot].clone();
                        let has_plugin = slot_state.plugin.is_some();
                        let native_open = self.native_editors.is_open(idx, slot);
                        let label = slot_state
                            .plugin
                            .as_ref()
                            .map(|p| {
                                if native_open {
                                    format!("● {}", p.name)
                                } else {
                                    format!("⚙ {}", p.name)
                                }
                            })
                            .unwrap_or_else(|| format!("+ Slot {}", slot + 1));
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 2.0;
                            let btn_w = if has_plugin { strip_w - 22.0 } else { strip_w };
                            let btn = egui::Button::new(
                                egui::RichText::new(label)
                                    .size(text_sm)
                                    .color(if !has_plugin {
                                        Color32::from_rgb(130, 142, 165)
                                    } else if slot_state.bypassed {
                                        Color32::from_rgb(120, 128, 145)
                                    } else if native_open {
                                        Color32::from_rgb(125, 211, 252)
                                    } else {
                                        Color32::from_rgb(226, 232, 240)
                                    }),
                            )
                            .fill(if has_plugin && !slot_state.bypassed {
                                Color32::from_rgb(26, 36, 54)
                            } else {
                                Color32::from_rgb(15, 19, 28)
                            });
                            let resp = ui
                                .add_sized([btn_w.max(54.0), slot_btn_h], btn)
                                .on_hover_text(if has_plugin {
                                    "Cliquer pour ouvrir l'interface native ou régler le plugin"
                                } else {
                                    "Cliquer pour insérer un plugin AU / VST3 / VST2"
                                });
                            if resp.clicked() {
                                self.active_insert_target = Some((idx, slot));
                                self.modal_show_catalog = !has_plugin;
                                if has_plugin && !self.native_editors.is_open(idx, slot) {
                                    if let Some(handle) = self.native_handles[idx][slot].clone() {
                                        if let Err(err) =
                                            self.native_editors.open_editor(idx, slot, &handle)
                                        {
                                            self.last_native_ui_error = Some((idx, slot, err));
                                        }
                                    }
                                }
                            }
                            if has_plugin {
                                let mut byp = slot_state.bypassed;
                                if ui
                                    .checkbox(&mut byp, "")
                                    .on_hover_text("Bypass / Activer l'insert")
                                    .changed()
                                {
                                    self.strips[idx].inserts[slot].bypassed = byp;
                                    self.send(MixerCommand::BypassInsert { strip: idx, slot, bypassed: byp });
                                }
                            }
                        });
                    }

                    ui.separator();

                    // 3. EQ 4 bandes à boutons rotatifs (grille 2×2 compacte)
                    ui.label(egui::RichText::new("EQ 4 BANDES").size(text_sm * 0.92).color(Color32::GRAY));
                    let mut eq = self.strips[idx].eq;
                    let mut eq_changed = false;
                    egui::Grid::new(format!("eq_grid_{idx}"))
                        .spacing([2.0, 2.0])
                        .show(ui, |ui| {
                            eq_changed |= rotary_knob(ui, &mut eq.high_db, -15.0..=15.0, 0.0, "HI", "dB", Color32::from_rgb(56, 189, 248), eq_knob_sz).changed();
                            eq_changed |= rotary_knob(ui, &mut eq.high_mid_db, -15.0..=15.0, 0.0, "HM", "dB", Color32::from_rgb(56, 189, 248), eq_knob_sz).changed();
                            ui.end_row();
                            eq_changed |= rotary_knob(ui, &mut eq.low_mid_db, -15.0..=15.0, 0.0, "LM", "dB", Color32::from_rgb(56, 189, 248), eq_knob_sz).changed();
                            eq_changed |= rotary_knob(ui, &mut eq.low_db, -15.0..=15.0, 0.0, "LO", "dB", Color32::from_rgb(56, 189, 248), eq_knob_sz).changed();
                            ui.end_row();
                        });
                    if eq_changed {
                        self.strips[idx].eq = eq;
                        self.send(MixerCommand::SetEq { strip: idx, eq });
                    }

                    ui.separator();

                    // 4. 4 boutons rotatifs Auxiliaires en grille 2×2 (absents sur Master)
                    if !is_master {
                        ui.label(egui::RichText::new("ENVOIS AUX").size(text_sm * 0.92).color(Color32::GRAY));
                        let aux_labels = ["A1/2", "A3/4", "A5/6", "A7/8"];
                        egui::Grid::new(format!("aux_grid_{idx}"))
                            .spacing([2.0, 2.0])
                            .show(ui, |ui| {
                                for aux_i in 0..NUM_AUX_STRIPS {
                                    let mut val = self.strips[idx].aux_sends[aux_i] * 100.0;
                                    if rotary_knob(ui, &mut val, 0.0..=100.0, 0.0, aux_labels[aux_i], "%", Color32::from_rgb(16, 185, 129), aux_knob_sz).changed() {
                                        let norm = val / 100.0;
                                        self.strips[idx].aux_sends[aux_i] = norm;
                                        self.send(MixerCommand::SetAuxSend { strip: idx, aux_idx: aux_i, level: norm });
                                    }
                                    if aux_i % 2 == 1 {
                                        ui.end_row();
                                    }
                                }
                            });
                        ui.separator();
                    } else {
                        let aux_knob_h = aux_knob_sz + (aux_knob_sz * 0.48).clamp(11.0, 16.0) + 6.0;
                        let master_aux_spacer_h = (text_sm * 1.3) + 2.0 * aux_knob_h + 8.0;
                        ui.allocate_ui(egui::vec2(strip_w, master_aux_spacer_h), |ui| {
                            ui.centered_and_justified(|ui| {
                                ui.label(egui::RichText::new("SOMMATION\nMAIN OUT").size(text_sm).color(Color32::from_rgb(110, 120, 140)));
                            });
                        });
                        ui.separator();
                    }

                    // 5. Boutons Push Solo (absent sur Master) & Mute
                    ui.horizontal(|ui| {
                        if !is_master {
                            let mut solo = self.strips[idx].solo;
                            if push_button(ui, "SOLO", &mut solo, Color32::from_rgb(245, 158, 11), scale) {
                                self.strips[idx].solo = solo;
                                self.send(MixerCommand::SetSolo { strip: idx, solo });
                            }
                        }
                        let mut mute = self.strips[idx].mute;
                        if push_button(ui, "MUTE", &mut mute, Color32::from_rgb(239, 68, 68), scale) {
                            self.strips[idx].mute = mute;
                            self.send(MixerCommand::SetMute { strip: idx, mute });
                        }
                    });

                    ui.add_space((4.0 * scale).clamp(2.0, 6.0));

                    // 6. Slider de volume & VU-mètre
                    ui.horizontal(|ui| {
                        let mut vol = self.strips[idx].volume_db;
                        if vertical_fader(ui, &mut vol, fader_h).changed() {
                            self.strips[idx].volume_db = vol;
                            self.send(MixerCommand::SetVolume { strip: idx, volume_db: vol });
                        }
                        let m = self.meters[idx];
                        vu_meter(ui, m.peak_l, m.peak_r, m.rms_l, m.rms_r, m.clip, fader_h);
                    });

                    let vol = self.strips[idx].volume_db;
                    ui.label(
                        egui::RichText::new(if vol <= -59.5 { "-∞ dB".into() } else { format!("{vol:+.1} dB") })
                            .monospace()
                            .size((10.5 * scale).clamp(8.5, 11.5)),
                    );
                });
            });
    }

    fn draw_plugin_picker_modal(&mut self, ctx: &egui::Context) {
        let Some((strip_idx, slot_idx)) = self.active_insert_target else {
            return;
        };
        let mut open = true;
        let strip_name = self.strips[strip_idx].name.clone();
        let max_w = (ctx.screen_rect().width() - 32.0).clamp(300.0, 480.0);
        let max_h = (ctx.screen_rect().height() - 48.0).clamp(260.0, 520.0);

        egui::Window::new(format!("Insert #{} — {}", slot_idx + 1, strip_name))
            .open(&mut open)
            .resizable(true)
            .default_width(max_w)
            .max_height(max_h)
            .show(ctx, |ui| {
                let current_plugin = self.strips[strip_idx].inserts[slot_idx].plugin.clone();
                let native_handle = self.native_handles[strip_idx][slot_idx].clone();

                if let Some(plugin) = current_plugin.as_ref() {
                    ui.horizontal_wrapped(|ui| {
                        ui.strong(&plugin.name);
                        ui.label(
                            egui::RichText::new(format!("[{:?}]", plugin.format))
                                .monospace()
                                .color(Color32::from_rgb(56, 189, 248)),
                        );
                    });
                    ui.label(
                        egui::RichText::new(plugin.path.display().to_string())
                            .size(10.0)
                            .color(Color32::GRAY),
                    );

                    ui.add_space(4.0);
                    ui.horizontal_wrapped(|ui| {
                        if let Some(handle) = native_handle.as_ref() {
                            let is_open = self.native_editors.is_open(strip_idx, slot_idx);
                            let gui_label = if is_open {
                                "Fermer la fenêtre native"
                            } else {
                                "Ouvrir l'interface native (GUI)"
                            };
                            let gui_btn = egui::Button::new(
                                egui::RichText::new(gui_label).strong().color(Color32::WHITE),
                            )
                            .fill(if is_open {
                                Color32::from_rgb(185, 28, 28)
                            } else {
                                Color32::from_rgb(2, 132, 199)
                            });
                            if ui.add(gui_btn).clicked() {
                                if is_open {
                                    self.native_editors.close_slot(strip_idx, slot_idx);
                                } else if let Err(err) =
                                    self.native_editors.open_editor(strip_idx, slot_idx, handle)
                                {
                                    self.last_native_ui_error = Some((strip_idx, slot_idx, err));
                                } else {
                                    self.last_native_ui_error = None;
                                }
                            }
                        }

                        let mut byp = self.strips[strip_idx].inserts[slot_idx].bypassed;
                        if ui.checkbox(&mut byp, "Bypass").changed() {
                            self.strips[strip_idx].inserts[slot_idx].bypassed = byp;
                            self.send(MixerCommand::BypassInsert {
                                strip: strip_idx,
                                slot: slot_idx,
                                bypassed: byp,
                            });
                        }

                        let toggle_label = if self.modal_show_catalog {
                            "Voir réglages"
                        } else {
                            "Changer de plugin"
                        };
                        if ui.button(toggle_label).clicked() {
                            self.modal_show_catalog = !self.modal_show_catalog;
                        }

                        if ui.button("Vider l'emplacement").clicked() {
                            self.install_insert_on_main_thread(strip_idx, slot_idx, None, false);
                            self.modal_show_catalog = true;
                        }
                    });
                    ui.separator();
                }

                if let Some((es, esl, msg)) = &self.last_plugin_error {
                    if *es == strip_idx && *esl == slot_idx {
                        ui.colored_label(Color32::from_rgb(245, 158, 11), format!("Info chargement: {msg}"));
                        ui.separator();
                    }
                }
                if let Some((es, esl, msg)) = &self.last_native_ui_error {
                    if *es == strip_idx && *esl == slot_idx {
                        ui.colored_label(Color32::from_rgb(248, 113, 113), format!("Interface native: {msg}"));
                        ui.separator();
                    }
                }

                if current_plugin.is_some() && !self.modal_show_catalog {
                    // Vue Réglages des paramètres du plugin inséré (repli / synchro directe)
                    ui.horizontal(|ui| {
                        ui.strong("Paramètres du plugin");
                        if !self.strips[strip_idx].inserts[slot_idx].params.is_empty()
                            && ui.small_button("Réinitialiser").clicked()
                        {
                            let param_count = self.strips[strip_idx].inserts[slot_idx].params.len();
                            for p_i in 0..param_count {
                                let def = self.strips[strip_idx].inserts[slot_idx].params[p_i].default;
                                let p_min = self.strips[strip_idx].inserts[slot_idx].params[p_i].min;
                                let p_max = self.strips[strip_idx].inserts[slot_idx].params[p_i].max;
                                let id = self.strips[strip_idx].inserts[slot_idx].params[p_i].id;
                                self.strips[strip_idx].inserts[slot_idx].params[p_i].value = def;
                                if let Some(NativePluginHandle::Vst3 { controller_ptr, .. }) =
                                    native_handle.as_ref()
                                {
                                    let norm = f64::from(
                                        ((def - p_min) / (p_max - p_min).max(1e-6)).clamp(0.0, 1.0),
                                    );
                                    self.native_editors.sync_vst3_param_normalized(
                                        *controller_ptr,
                                        id,
                                        norm,
                                    );
                                }
                                self.send(MixerCommand::SetPluginParam {
                                    strip: strip_idx,
                                    slot: slot_idx,
                                    param_id: id,
                                    value: def,
                                });
                            }
                        }
                    });

                    ui.add_space(4.0);
                    let param_count = self.strips[strip_idx].inserts[slot_idx].params.len();
                    if param_count == 0 {
                        ui.label(
                            egui::RichText::new(
                                "Aucun paramètre exposé dans la liste (utilisez l'interface native si disponible).",
                            )
                            .size(11.0)
                            .color(Color32::GRAY),
                        );
                    } else {
                        egui::ScrollArea::vertical()
                            .max_height((max_h - 165.0).max(140.0))
                            .show(ui, |ui| {
                                for p_i in 0..param_count {
                                    let p = self.strips[strip_idx].inserts[slot_idx].params[p_i].clone();
                                    let mut val = p.value;
                                    ui.horizontal(|ui| {
                                        ui.label(egui::RichText::new(&p.name).size(11.5));
                                    });
                                    let mut slider = egui::Slider::new(&mut val, p.min..=p.max);
                                    if !p.unit.is_empty() {
                                        slider = slider.suffix(format!(" {}", p.unit));
                                    }
                                    if ui.add(slider).changed() {
                                        self.strips[strip_idx].inserts[slot_idx].params[p_i].value = val;
                                        if let Some(NativePluginHandle::Vst3 { controller_ptr, .. }) =
                                            native_handle.as_ref()
                                        {
                                            let norm = f64::from(
                                                ((val - p.min) / (p.max - p.min).max(1e-6))
                                                    .clamp(0.0, 1.0),
                                            );
                                            self.native_editors.sync_vst3_param_normalized(
                                                *controller_ptr,
                                                p.id,
                                                norm,
                                            );
                                        }
                                        self.send(MixerCommand::SetPluginParam {
                                            strip: strip_idx,
                                            slot: slot_idx,
                                            param_id: p.id,
                                            value: val,
                                        });
                                    }
                                    ui.add_space(4.0);
                                }
                            });
                    }
                } else {
                    // Vue Catalogue & Recherche de plugins
                    ui.horizontal_wrapped(|ui| {
                        ui.label("Rechercher :");
                        ui.add(
                            egui::TextEdit::singleline(&mut self.plugin_search)
                                .desired_width(140.0)
                                .hint_text("Nom du plugin..."),
                        );
                        ui.selectable_value(&mut self.plugin_format_filter, None, "Tous");
                        ui.selectable_value(&mut self.plugin_format_filter, Some(PluginFormat::AudioUnit), "AU");
                        ui.selectable_value(&mut self.plugin_format_filter, Some(PluginFormat::Vst3), "VST3");
                        ui.selectable_value(&mut self.plugin_format_filter, Some(PluginFormat::Vst2), "VST2");
                    });
                    ui.add_space(4.0);

                    let query = self.plugin_search.to_lowercase();
                    let filtered: Vec<DiscoveredPlugin> = self
                        .discovered_plugins
                        .iter()
                        .filter(|p| {
                            self.plugin_format_filter.map_or(true, |f| p.format == f)
                                && (query.is_empty() || p.name.to_lowercase().contains(&query))
                        })
                        .cloned()
                        .collect();

                    egui::ScrollArea::vertical()
                        .max_height((max_h - 165.0).max(140.0))
                        .show(ui, |ui| {
                            if filtered.is_empty() {
                                ui.label(
                                    egui::RichText::new("Aucun plugin détecté dans les dossiers système.")
                                        .size(11.0)
                                        .color(Color32::GRAY),
                                );
                            }
                            for plugin in filtered {
                                let tag = format!("[{:?}] {}", plugin.format, plugin.name);
                                if ui.button(tag).clicked() {
                                    self.install_insert_on_main_thread(
                                        strip_idx,
                                        slot_idx,
                                        Some(plugin),
                                        true,
                                    );
                                    self.modal_show_catalog = false;
                                }
                            }
                        });
                }
            });
        if !open {
            self.active_insert_target = None;
        }
    }
}
`,
  },
  {
    path: 'README.md',
    language: 'markdown',
    description: 'Guide de compilation, interfaces graphiques natives AU/VST3 et routage CoreAudio/ALSA pour la Behringer UMC1820',
    content: `# UMC1820 Studio Mixer (Rust + egui + CoreAudio / ALSA)

Console de mixage logicielle multi-plateforme (macOS & Linux) conçue pour la **Behringer UMC1820** via le pilote **CoreAudio** (macOS) ou **ALSA / JACK / PipeWire** (Linux).

## Architecture du Mixer
- **8 Tranches d'entrée (IN 1 à IN 8)** : Gain rotatif (-12 à +24 dB), 5 slots d'inserts maximum (Apple AU / VST3 / VST2), EQ 4 bandes rotatif (80 Hz, 400 Hz, 2.5 kHz, 10 kHz), 4 envois auxiliaires rotatifs (1/2, 3/4, 5/6, 7/8), boutons Push Solo & Mute, Fader volume et VU-mètre Peak/RMS.
- **4 Tranches Auxiliaires Stéréo (Out 1/2, 3/4, 5/6, 7/8)** : routées directement vers les paires de sorties ligne de l'UMC1820 (sans gain d'entrée).
- **1 Tranche Master** : mêmes réglages (5 inserts, EQ 4 bandes, Mute, Fader, VU-mètre stéréo) **sans Gain, sans Solo et sans envois Aux**.

## Interfaces natives des plugins (GUI)
- **Apple AudioUnit (macOS)** : détection système via \`AudioComponentFindNext\` (\`aufx\` & \`aumf\`) et ouverture automatique de l'interface Cocoa native (\`kAudioUnitProperty_CocoaUI\`) dans une fenêtre \`NSWindow\`, avec repli sur \`CoreAudioKit::AUGenericView\`.
- **VST3 (macOS & Linux)** : hébergement COM complet (\`IComponent\`, \`IAudioProcessor\` stéréo & mono->stéréo, \`IEditController\`, \`IPlugView\`, \`IPlugFrame\`) attaché dans une \`NSWindow\` (\`NSView\`) sur macOS ou une fenêtre X11 (\`X11EmbedWindowID\` + \`IRunLoop\`) sur Linux (sous Wayland pur, activer XWayland).
- **VST2 (macOS & Linux)** : hébergement C-ABI (\`AEffect\`, \`effEditOpen\` / \`effEditIdle\`) avec ouverture automatique de la fenêtre graphique native (\`NSWindow\` / X11) en plus des curseurs de paramètres.

## Compilation sur macOS (CoreAudio + AU/VST3/VST2)
1. Installer ou mettre à jour Rust (**rustc >= 1.88 requis**) :
   \`\`\`bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup update stable
   \`\`\`
2. Vérifier que les outils Xcode sont installés : \`xcode-select --install\`
3. Compiler et lancer :
   \`\`\`bash
   cargo run --release
   \`\`\`

## Compilation sur Linux (ALSA / PipeWire-JACK + VST3/VST2)
1. Installer les bibliothèques système requises (\`alsa.pc\` et \`pkg-config\` pour \`alsa-sys\`) :
   - **Ubuntu / Debian / Mint / Pop!_OS** :
     \`\`\`bash
     sudo apt update && sudo apt install -y build-essential pkg-config libasound2-dev libgtk-3-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev
     \`\`\`
   - **Fedora / RHEL** :
     \`\`\`bash
     sudo dnf install -y gcc pkgconf-pkg-config alsa-lib-devel gtk3-devel
     \`\`\`
   - **Arch / Manjaro** :
     \`\`\`bash
     sudo pacman -S --needed base-devel pkgconf alsa-lib gtk3
     \`\`\`
2. Compiler et lancer :
   \`\`\`bash
   cargo run --release
   \`\`\`

## Utilisation en parallèle de Bitwig Studio sur macOS
CoreAudio autorise plusieurs clients audio simultanés sur l'UMC1820, ou vous pouvez créer un périphérique virtuel **BlackHole 16ch** / **Périphérique agrégé** dans *Configuration audio et MIDI* pour chaîner les sorties du Mixer vers Bitwig Studio.
`,
  },
];
