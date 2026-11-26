use crate::audio::engine::{
    default_mixer_strips, list_audio_devices, start_audio_engine, AudioEngineHandle,
};
use crate::audio::midi::MidiInputManager;
use crate::audio::player::decode_audio_file;
use crate::audio::plugin_host::{instantiate_plugin, scan_system_plugins, HostedPlugin};
use crate::audio::state::{
    default_input_order, normalize_input_order, DiscoveredPlugin, InputSourceRoute, MeterFrame,
    MixerCommand, MixerSetFile, NativePluginHandle, OutputTargetRoute, PlayerProgress,
    PluginFormat, StripKind, StripMidiDevice, StripState, MAX_AUX_PAIRS, MAX_INPUT_PAIRS,
    MAX_INSERTS_PER_STRIP, NUM_AUX_STRIPS, NUM_INPUT_STRIPS, TOTAL_STRIPS,
};
use crate::remote::{
    RemoteCommand, RemoteMeterEntry, RemoteMetersPacket, RemotePlayerProgressView, RemoteServer,
};
use crate::ui::file_dialog::{pick_open_file, pick_save_file};
use crate::ui::native_editor::NativeEditorManager;
use crate::ui::widgets::{push_button, rotary_knob, vertical_fader, vu_meter};
use eframe::egui;
use egui::Color32;
use ringbuf::traits::{Consumer, Producer};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiScaleMode {
    Auto,
    Scale50,
    Scale75,
    Scale85,
    Scale100,
    Scale115,
}

impl UiScaleMode {
    fn label(self) -> &'static str {
        match self {
            Self::Auto => "Auto (Fenêtre)",
            Self::Scale50 => "50%",
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
            Self::All => "Toutes",
            Self::InputsOnly => "Entrées",
            Self::BusesOnly => "Aux & Master",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputBankFilter {
    All,
    Bank1,
    Bank2,
}

impl InputBankFilter {
    fn label(self) -> &'static str {
        match self {
            Self::All => "IN: 1–16 (Tout)",
            Self::Bank1 => "IN: 1–8",
            Self::Bank2 => "IN: 9–16",
        }
    }

    fn next(self) -> Self {
        match self {
            Self::All => Self::Bank1,
            Self::Bank1 => Self::Bank2,
            Self::Bank2 => Self::All,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiTheme {
    NoirStudio,
    NuitConsole,
    Ardoise,
    Titane,
    LumiereJour,
}

impl UiTheme {
    const ALL: [Self; 5] = [
        Self::NoirStudio,
        Self::NuitConsole,
        Self::Ardoise,
        Self::Titane,
        Self::LumiereJour,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::NoirStudio => "1. Noir Studio (Très sombre)",
            Self::NuitConsole => "2. Nuit Console (Sombre)",
            Self::Ardoise => "3. Ardoise (Moyen)",
            Self::Titane => "4. Titane (Clair)",
            Self::LumiereJour => "5. Lumière Jour (Très clair)",
        }
    }

    fn is_light(self) -> bool {
        matches!(self, Self::Titane | Self::LumiereJour)
    }

    fn panel_fill(self) -> Color32 {
        match self {
            Self::NoirStudio => Color32::from_rgb(5, 7, 11),
            Self::NuitConsole => Color32::from_rgb(11, 14, 20),
            Self::Ardoise => Color32::from_rgb(30, 36, 48),
            Self::Titane => Color32::from_rgb(214, 220, 230),
            Self::LumiereJour => Color32::from_rgb(244, 246, 250),
        }
    }

    fn window_fill(self) -> Color32 {
        match self {
            Self::NoirStudio => Color32::from_rgb(12, 15, 22),
            Self::NuitConsole => Color32::from_rgb(19, 23, 32),
            Self::Ardoise => Color32::from_rgb(40, 48, 62),
            Self::Titane => Color32::from_rgb(228, 233, 240),
            Self::LumiereJour => Color32::from_rgb(252, 253, 255),
        }
    }

    fn strip_bg(self, kind: StripKind) -> Color32 {
        match (self, kind) {
            (Self::NoirStudio, StripKind::Input) => Color32::from_rgb(11, 13, 19),
            (Self::NoirStudio, StripKind::Aux) => Color32::from_rgb(10, 16, 24),
            (Self::NoirStudio, StripKind::Master) => Color32::from_rgb(18, 14, 17),
            (Self::NuitConsole, StripKind::Input) => Color32::from_rgb(19, 23, 32),
            (Self::NuitConsole, StripKind::Aux) => Color32::from_rgb(17, 25, 36),
            (Self::NuitConsole, StripKind::Master) => Color32::from_rgb(26, 22, 24),
            (Self::Ardoise, StripKind::Input) => Color32::from_rgb(38, 46, 60),
            (Self::Ardoise, StripKind::Aux) => Color32::from_rgb(33, 48, 66),
            (Self::Ardoise, StripKind::Master) => Color32::from_rgb(52, 42, 48),
            (Self::Titane, StripKind::Input) => Color32::from_rgb(226, 231, 239),
            (Self::Titane, StripKind::Aux) => Color32::from_rgb(212, 224, 238),
            (Self::Titane, StripKind::Master) => Color32::from_rgb(236, 224, 226),
            (Self::LumiereJour, StripKind::Input) => Color32::from_rgb(255, 255, 255),
            (Self::LumiereJour, StripKind::Aux) => Color32::from_rgb(236, 244, 253),
            (Self::LumiereJour, StripKind::Master) => Color32::from_rgb(253, 242, 238),
        }
    }

    fn strip_border(self) -> Color32 {
        match self {
            Self::NoirStudio => Color32::from_rgb(26, 31, 42),
            Self::NuitConsole => Color32::from_rgb(35, 41, 54),
            Self::Ardoise => Color32::from_rgb(64, 76, 96),
            Self::Titane => Color32::from_rgb(168, 178, 194),
            Self::LumiereJour => Color32::from_rgb(203, 213, 225),
        }
    }

    fn text_primary(self) -> Color32 {
        if self.is_light() {
            Color32::from_rgb(15, 23, 42)
        } else {
            Color32::from_rgb(236, 242, 250)
        }
    }

    fn text_muted(self) -> Color32 {
        if self.is_light() {
            Color32::from_rgb(71, 85, 105)
        } else {
            Color32::from_rgb(148, 163, 184)
        }
    }

    fn apply_to_ctx(self, ctx: &egui::Context) {
        let mut visuals = if self.is_light() {
            egui::Visuals::light()
        } else {
            egui::Visuals::dark()
        };
        visuals.panel_fill = self.panel_fill();
        visuals.window_fill = self.window_fill();
        visuals.extreme_bg_color = if self.is_light() {
            Color32::from_rgb(241, 245, 249)
        } else {
            Color32::from_rgb(9, 12, 18)
        };
        ctx.set_visuals(visuals);
    }
}

const BUFFER_PRESETS: [u32; 6] = [64, 128, 256, 512, 1024, 2048];

fn format_time(secs: f32) -> String {
    let s = secs.max(0.0).floor() as u32;
    format!("{:02}:{:02}", s / 60, s % 60)
}

fn format_input_route(route: InputSourceRoute) -> String {
    match route {
        InputSourceRoute::None => "Entrée: Aucune".into(),
        InputSourceRoute::Mono(ch) => format!("In {}", ch + 1),
        InputSourceRoute::StereoPair(ch) => format!("In {}/{}", ch + 1, ch + 2),
    }
}

fn format_output_route(route: OutputTargetRoute) -> String {
    match route {
        OutputTargetRoute::None => "Sortie: Aucune".into(),
        OutputTargetRoute::MasterBus => "Vers Master".into(),
        OutputTargetRoute::Mono(ch) => format!("Out {}", ch + 1),
        OutputTargetRoute::StereoPair(ch) => format!("Out {}/{}", ch + 1, ch + 2),
    }
}

pub struct UmcMixerApp {
    strips: Vec<StripState>,
    input_pair_stereo: [bool; MAX_INPUT_PAIRS],
    aux_pair_stereo: [bool; MAX_AUX_PAIRS],
    input_order: Vec<usize>,
    meters: [MeterFrame; TOTAL_STRIPS],
    // IMPORTANT : déclaré avant `offline_plugins` et `engine` pour fermer toutes les fenêtres natives avant le déchargement des plugins.
    native_editors: NativeEditorManager,
    native_handles: [[Option<NativePluginHandle>; MAX_INSERTS_PER_STRIP]; TOTAL_STRIPS],
    offline_plugins: [[Option<Box<dyn HostedPlugin>>; MAX_INSERTS_PER_STRIP]; TOTAL_STRIPS],
    engine: Option<AudioEngineHandle>,
    midi_manager: MidiInputManager,
    devices: Vec<String>,
    selected_device: String,
    requested_buffer_frames: u32,
    discovered_plugins: Vec<DiscoveredPlugin>,
    active_insert_target: Option<(usize, usize)>,
    modal_show_catalog: bool,
    plugin_search: String,
    plugin_format_filter: Option<PluginFormat>,
    last_plugin_error: Option<(usize, usize, String)>,
    last_native_ui_error: Option<(usize, usize, String)>,
    scale_mode: UiScaleMode,
    native_ppp: Option<f32>,
    view_filter: StripViewFilter,
    input_bank: InputBankFilter,
    theme: UiTheme,
    applied_theme: Option<UiTheme>,
    show_player_bar: bool,
    status_error: Option<String>,
    status_info: Option<String>,
    // Lecteur audio MP3 / WAV
    player_file_path: Option<String>,
    player_title: String,
    player_progress: PlayerProgress,
    player_loop: bool,
    player_gain: f32,
    player_target: Option<usize>,
    // Serveur télécommande iPad (HTTP + WebSocket + OSC)
    remote_server: Option<RemoteServer>,
    remote_error: Option<String>,
    remote_state_dirty: bool,
    last_state_broadcast: Instant,
    last_meter_broadcast: Instant,
}

impl Drop for UmcMixerApp {
    fn drop(&mut self) {
        self.native_editors.close_all();
    }
}

impl UmcMixerApp {
    pub fn new() -> Self {
        let mut strips = default_mixer_strips();
        let devices = list_audio_devices();
        let discovered_plugins = scan_system_plugins();
        let requested_buffer_frames = 128_u32;
        let (mut engine, status_error) =
            match start_audio_engine(None, Some(requested_buffer_frames)) {
                Ok(h) => (Some(h), None),
                Err(e) => (None, Some(e)),
            };
        let mut midi_manager = MidiInputManager::new();
        if let Some(eng) = engine.as_mut() {
            midi_manager.attach_sender(eng.midi_tx.take());
            if eng.out_channels < 10 {
                let master_idx = NUM_INPUT_STRIPS + NUM_AUX_STRIPS;
                strips[master_idx].output_route = OutputTargetRoute::StereoPair(0);
            }
        }
        let selected_device = engine
            .as_ref()
            .map(|e| e.device_name.clone())
            .unwrap_or_else(|| "Aucun périphérique".into());

        let (remote_server, remote_error) = match RemoteServer::start() {
            Ok(srv) => (Some(srv), None),
            Err(e) => (None, Some(e)),
        };

        let mut app = Self {
            strips,
            input_pair_stereo: [true; MAX_INPUT_PAIRS],
            aux_pair_stereo: [true; MAX_AUX_PAIRS],
            input_order: default_input_order(),
            meters: [MeterFrame::default(); TOTAL_STRIPS],
            native_editors: NativeEditorManager::new(),
            native_handles: std::array::from_fn(|_| std::array::from_fn(|_| None)),
            offline_plugins: std::array::from_fn(|_| std::array::from_fn(|_| None)),
            engine,
            midi_manager,
            devices,
            selected_device,
            requested_buffer_frames,
            discovered_plugins,
            active_insert_target: None,
            modal_show_catalog: false,
            plugin_search: String::new(),
            plugin_format_filter: None,
            last_plugin_error: None,
            last_native_ui_error: None,
            scale_mode: UiScaleMode::Auto,
            native_ppp: None,
            view_filter: StripViewFilter::All,
            input_bank: InputBankFilter::All,
            theme: UiTheme::NuitConsole,
            applied_theme: None,
            show_player_bar: false,
            status_error,
            status_info: None,
            player_file_path: None,
            player_title: "Aucun fichier MP3/WAV".into(),
            player_progress: PlayerProgress::default(),
            player_loop: false,
            player_gain: 1.0,
            player_target: None,
            remote_server,
            remote_error,
            remote_state_dirty: true,
            last_state_broadcast: Instant::now(),
            last_meter_broadcast: Instant::now(),
        };
        app.sync_all_state_to_engine(false);
        app
    }

    fn send(&mut self, cmd: MixerCommand) {
        if let Some(eng) = self.engine.as_mut() {
            let _ = eng.command_tx.try_push(cmd);
        }
        self.remote_state_dirty = true;
    }

    fn restart_audio_engine(&mut self, device_name: Option<String>, buffer_frames: u32) {
        self.native_editors.close_all();
        self.native_handles = std::array::from_fn(|_| std::array::from_fn(|_| None));
        self.offline_plugins = std::array::from_fn(|_| std::array::from_fn(|_| None));
        self.engine = None;
        self.requested_buffer_frames = buffer_frames.clamp(64, 2048);
        let pref_dev = device_name.or_else(|| {
            if self.selected_device == "Aucun périphérique" {
                None
            } else {
                Some(self.selected_device.clone())
            }
        });
        match start_audio_engine(pref_dev.as_deref(), Some(self.requested_buffer_frames)) {
            Ok(mut h) => {
                self.midi_manager.attach_sender(h.midi_tx.take());
                self.selected_device = h.device_name.clone();
                let master_idx = NUM_INPUT_STRIPS + NUM_AUX_STRIPS;
                if h.out_channels < 10
                    && self.strips[master_idx].output_route == OutputTargetRoute::StereoPair(8)
                {
                    self.strips[master_idx].output_route = OutputTargetRoute::StereoPair(0);
                }
                self.engine = Some(h);
                self.status_error = None;
            }
            Err(e) => self.status_error = Some(e),
        }
        self.sync_all_state_to_engine(true);
    }

    fn sync_strip_midi_devices(&mut self) {
        for s_idx in 0..NUM_INPUT_STRIPS {
            let filter = self.midi_manager.resolve_filter(&self.strips[s_idx].midi_device);
            self.send(MixerCommand::SetStripMidiDevice { strip: s_idx, filter });
        }
    }

    fn sync_all_state_to_engine(&mut self, reinstall_plugins: bool) {
        for pair in 0..MAX_INPUT_PAIRS {
            let stereo = self.input_pair_stereo[pair];
            self.send(MixerCommand::SetInputPairStereo { pair, stereo });
        }
        for pair in 0..MAX_AUX_PAIRS {
            let stereo = self.aux_pair_stereo[pair];
            self.send(MixerCommand::SetAuxPairStereo { pair, stereo });
        }
        for s_idx in 0..self.strips.len() {
            let st = self.strips[s_idx].clone();
            if st.kind == StripKind::Input {
                self.send(MixerCommand::SetInputRoute {
                    strip: s_idx,
                    route: st.input_route,
                });
                self.send(MixerCommand::SetGain {
                    strip: s_idx,
                    gain_db: st.gain_db,
                });
            }
            self.send(MixerCommand::SetOutputRoute {
                strip: s_idx,
                route: st.output_route,
            });
            self.send(MixerCommand::SetEq {
                strip: s_idx,
                eq: st.eq,
            });
            self.send(MixerCommand::SetMute {
                strip: s_idx,
                mute: st.mute,
            });
            if st.kind != StripKind::Master {
                self.send(MixerCommand::SetSolo {
                    strip: s_idx,
                    solo: st.solo,
                });
                for (aux_i, &lvl) in st.aux_sends.iter().enumerate() {
                    self.send(MixerCommand::SetAuxSend {
                        strip: s_idx,
                        aux_idx: aux_i,
                        level: lvl,
                    });
                }
            }
            self.send(MixerCommand::SetVolume {
                strip: s_idx,
                volume_db: st.volume_db,
            });
            if st.kind == StripKind::Input {
                self.send(MixerCommand::SetStripMidiMode {
                    strip: s_idx,
                    mode: st.midi_mode,
                });
                let filter = self.midi_manager.resolve_filter(&st.midi_device);
                self.send(MixerCommand::SetStripMidiDevice {
                    strip: s_idx,
                    filter,
                });
            }

            if reinstall_plugins {
                for sl_idx in 0..MAX_INSERTS_PER_STRIP {
                    let saved_slot = self.strips[s_idx].inserts[sl_idx].clone();
                    if let Some(plugin) = saved_slot.plugin {
                        self.install_insert_on_main_thread(s_idx, sl_idx, Some(plugin), false);
                        self.strips[s_idx].inserts[sl_idx].bypassed = saved_slot.bypassed;
                        self.send(MixerCommand::BypassInsert {
                            strip: s_idx,
                            slot: sl_idx,
                            bypassed: saved_slot.bypassed,
                        });
                        for saved_p in saved_slot.params {
                            if let Some(cur_p) = self.strips[s_idx].inserts[sl_idx]
                                .params
                                .iter_mut()
                                .find(|p| p.id == saved_p.id)
                            {
                                cur_p.value = saved_p.value;
                                if let Some(NativePluginHandle::Vst3 { controller_ptr, .. }) =
                                    self.native_handles[s_idx][sl_idx].as_ref()
                                {
                                    let norm = f64::from(
                                        ((saved_p.value - cur_p.min)
                                            / (cur_p.max - cur_p.min).max(1e-6))
                                        .clamp(0.0, 1.0),
                                    );
                                    self.native_editors.sync_vst3_param_normalized(
                                        *controller_ptr,
                                        saved_p.id,
                                        norm,
                                    );
                                }
                                self.send(MixerCommand::SetPluginParam {
                                    strip: s_idx,
                                    slot: sl_idx,
                                    param_id: saved_p.id,
                                    value: saved_p.value,
                                });
                            }
                        }
                    } else {
                        self.install_insert_on_main_thread(s_idx, sl_idx, None, false);
                    }
                }
            }
        }
        self.send(MixerCommand::PlayerSetLoop(self.player_loop));
        self.send(MixerCommand::PlayerSetGain(self.player_gain));
        self.send(MixerCommand::PlayerSetTarget(self.player_target));
    }

    fn toggle_input_pair_stereo(&mut self, pair: usize, stereo: bool) {
        if pair >= MAX_INPUT_PAIRS || self.input_pair_stereo[pair] == stereo {
            return;
        }
        self.input_pair_stereo[pair] = stereo;
        let idx_l = pair * 2;
        let idx_r = idx_l + 1;
        if stereo {
            self.strips[idx_l].name = format!("IN {}/{}", pair * 2 + 1, pair * 2 + 2);
            if let InputSourceRoute::Mono(ch) = self.strips[idx_l].input_route {
                self.strips[idx_l].input_route = InputSourceRoute::StereoPair(ch & !1);
                self.send(MixerCommand::SetInputRoute {
                    strip: idx_l,
                    route: self.strips[idx_l].input_route,
                });
            }
        } else {
            self.strips[idx_l].name = format!("IN {}", pair * 2 + 1);
            self.strips[idx_r].name = format!("IN {}", pair * 2 + 2);
            if let InputSourceRoute::StereoPair(ch) = self.strips[idx_l].input_route {
                self.strips[idx_l].input_route = InputSourceRoute::Mono(ch);
                self.strips[idx_r].input_route = InputSourceRoute::Mono(ch + 1);
                self.send(MixerCommand::SetInputRoute {
                    strip: idx_l,
                    route: self.strips[idx_l].input_route,
                });
                self.send(MixerCommand::SetInputRoute {
                    strip: idx_r,
                    route: self.strips[idx_r].input_route,
                });
            }
        }
        self.send(MixerCommand::SetInputPairStereo { pair, stereo });
    }

    fn toggle_aux_pair_stereo(&mut self, pair: usize, stereo: bool) {
        if pair >= MAX_AUX_PAIRS || self.aux_pair_stereo[pair] == stereo {
            return;
        }
        self.aux_pair_stereo[pair] = stereo;
        let idx_l = NUM_INPUT_STRIPS + pair * 2;
        let idx_r = idx_l + 1;
        if stereo {
            self.strips[idx_l].name = format!("AUX {}/{}", pair * 2 + 1, pair * 2 + 2);
            if let OutputTargetRoute::Mono(ch) = self.strips[idx_l].output_route {
                self.strips[idx_l].output_route = OutputTargetRoute::StereoPair(ch & !1);
                self.send(MixerCommand::SetOutputRoute {
                    strip: idx_l,
                    route: self.strips[idx_l].output_route,
                });
            }
        } else {
            self.strips[idx_l].name = format!("AUX {}", pair * 2 + 1);
            self.strips[idx_r].name = format!("AUX {}", pair * 2 + 2);
            if let OutputTargetRoute::StereoPair(ch) = self.strips[idx_l].output_route {
                self.strips[idx_l].output_route = OutputTargetRoute::Mono(ch);
                self.strips[idx_r].output_route = OutputTargetRoute::Mono(ch + 1);
                self.send(MixerCommand::SetOutputRoute {
                    strip: idx_l,
                    route: self.strips[idx_l].output_route,
                });
                self.send(MixerCommand::SetOutputRoute {
                    strip: idx_r,
                    route: self.strips[idx_r].output_route,
                });
            }
            for s_idx in 0..NUM_INPUT_STRIPS {
                if self.strips[s_idx].aux_sends[pair * 2 + 1] == 0.0
                    && self.strips[s_idx].aux_sends[pair * 2] > 0.0
                {
                    let val = self.strips[s_idx].aux_sends[pair * 2];
                    self.strips[s_idx].aux_sends[pair * 2 + 1] = val;
                    self.send(MixerCommand::SetAuxSend {
                        strip: s_idx,
                        aux_idx: pair * 2 + 1,
                        level: val,
                    });
                }
            }
        }
        self.send(MixerCommand::SetAuxPairStereo { pair, stereo });
    }

    fn load_audio_file_from_path(&mut self, path: &Path) {
        match decode_audio_file(path) {
            Ok(track) => {
                self.player_title = track.title.clone();
                self.player_file_path = Some(path.display().to_string());
                self.player_progress = PlayerProgress {
                    playing: false,
                    pos_secs: 0.0,
                    duration_secs: track.duration_secs(),
                };
                self.send(MixerCommand::LoadAudioTrack(Some(Arc::new(track))));
                self.show_player_bar = true;
                self.status_error = None;
                self.status_info = Some(format!("Audio chargé : {}", self.player_title));
            }
            Err(err) => {
                self.status_error = Some(err);
            }
        }
    }

    fn save_set_to_disk(&mut self) {
        let Some(mut path) = pick_save_file(
            "Enregistrer le set du Mixer",
            "session-umc1820.umcset",
            &["umcset", "json"],
        ) else {
            return;
        };
        if path.extension().is_none() {
            path.set_extension("umcset");
        }
        let set_data = MixerSetFile {
            version: 4,
            input_pair_stereo: self.input_pair_stereo,
            aux_pair_stereo: self.aux_pair_stereo,
            input_order: self.input_order.clone(),
            strips: self.strips.clone(),
            selected_device: Some(self.selected_device.clone()),
            buffer_frames: Some(self.requested_buffer_frames),
            player_file_path: self.player_file_path.clone(),
            player_loop: self.player_loop,
            player_gain: self.player_gain,
            player_target: self.player_target,
        };
        match serde_json::to_string_pretty(&set_data) {
            Ok(json) => match std::fs::write(&path, json) {
                Ok(()) => {
                    self.status_error = None;
                    let fname = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("set");
                    self.status_info = Some(format!("Set sauvegardé : {fname}"));
                }
                Err(e) => self.status_error = Some(format!("Échec écriture fichier set: {e}")),
            },
            Err(e) => self.status_error = Some(format!("Échec sérialisation set: {e}")),
        }
    }

    fn load_set_from_disk(&mut self) {
        let Some(path) = pick_open_file("Charger un set du Mixer", &["umcset", "json"]) else {
            return;
        };
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                self.status_error = Some(format!("Échec lecture fichier set: {e}"));
                return;
            }
        };
        let parsed: MixerSetFile = match serde_json::from_str(&raw) {
            Ok(s) => s,
            Err(e) => {
                self.status_error = Some(format!("Fichier set invalide: {e}"));
                return;
            }
        };

        self.native_editors.close_all();
        self.active_insert_target = None;

        let mut next_strips = default_mixer_strips();
        let mut next_input_pairs = parsed.input_pair_stereo;
        if parsed.strips.len() == TOTAL_STRIPS {
            for (i, mut st) in parsed.strips.into_iter().enumerate() {
                st.normalize(i);
                next_strips[i] = st;
            }
        } else {
            if parsed.version < 3 {
                next_input_pairs = [false, false, false, false, true, true, true, true];
            }
            for st_in in parsed.strips {
                let target_idx = match st_in.kind {
                    StripKind::Input if st_in.index < NUM_INPUT_STRIPS => Some(st_in.index),
                    StripKind::Aux => {
                        let legacy_in_count = if parsed.version < 3 { 8 } else { NUM_INPUT_STRIPS };
                        if st_in.index >= legacy_in_count {
                            let a = st_in.index - legacy_in_count;
                            if parsed.version < 2 && a < MAX_AUX_PAIRS {
                                Some(NUM_INPUT_STRIPS + a * 2)
                            } else if a < NUM_AUX_STRIPS {
                                Some(NUM_INPUT_STRIPS + a)
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    }
                    StripKind::Master => Some(NUM_INPUT_STRIPS + NUM_AUX_STRIPS),
                    _ => None,
                };
                if let Some(ti) = target_idx {
                    let mut st = st_in;
                    if parsed.version < 3 && st.kind == StripKind::Input && st.output_route == OutputTargetRoute::None {
                        st.output_route = OutputTargetRoute::MasterBus;
                    }
                    st.normalize(ti);
                    next_strips[ti] = st;
                }
            }
        }

        self.strips = next_strips;
        self.input_pair_stereo = next_input_pairs;
        self.aux_pair_stereo = parsed.aux_pair_stereo;
        self.input_order = normalize_input_order(&parsed.input_order);
        self.player_loop = parsed.player_loop;
        self.player_gain = parsed.player_gain.clamp(0.0, 2.0);
        self.player_target = parsed.player_target.filter(|&i| i < NUM_INPUT_STRIPS);

        if let Some(buf) = parsed.buffer_frames {
            let clamped = buf.clamp(64, 2048);
            if clamped != self.requested_buffer_frames {
                self.restart_audio_engine(parsed.selected_device.clone(), clamped);
            } else {
                self.sync_all_state_to_engine(true);
            }
        } else {
            self.sync_all_state_to_engine(true);
        }

        if let Some(track_path) = parsed.player_file_path {
            let p = Path::new(&track_path);
            if p.exists() {
                self.load_audio_file_from_path(p);
            }
        }

        self.status_error = None;
        let fname = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("set");
        self.status_info = Some(format!("Set chargé : {fname}"));
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
                        hosted.prepare(sr, self.requested_buffer_frames.max(2048) as usize);
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

    fn apply_window_resize_scale(&mut self, ctx: &egui::Context) -> f32 {
        let cur_ppp = ctx.pixels_per_point().max(0.4);
        let screen = ctx.input(|i| i.screen_rect());
        if !screen.width().is_finite()
            || !screen.height().is_finite()
            || screen.width() < 100.0
            || screen.height() < 100.0
        {
            return 1.0;
        }
        let phys_w = screen.width() * cur_ppp;
        let phys_h = screen.height() * cur_ppp;
        let base_ppp = *self
            .native_ppp
            .get_or_insert_with(|| ctx.native_pixels_per_point().unwrap_or(cur_ppp));

        let target_zoom = match self.scale_mode {
            UiScaleMode::Auto => {
                let logical_w = phys_w / base_ppp;
                let logical_h = phys_h / base_ppp;
                (logical_w / 1200.0).min(logical_h / 700.0).clamp(0.45, 2.0)
            }
            UiScaleMode::Scale50 => 0.50,
            UiScaleMode::Scale75 => 0.75,
            UiScaleMode::Scale85 => 0.85,
            UiScaleMode::Scale100 => 1.00,
            UiScaleMode::Scale115 => 1.15,
        };
        let target_ppp = (base_ppp * target_zoom).clamp(0.45, 4.0);
        if (cur_ppp - target_ppp).abs() > 0.02 {
            ctx.set_pixels_per_point(target_ppp);
            ctx.request_repaint();
        }
        1.0
    }

    fn visible_input_indices(&self) -> Vec<usize> {
        self.input_order
            .iter()
            .copied()
            .filter(|&idx| {
                if idx >= NUM_INPUT_STRIPS {
                    return false;
                }
                let pair = idx / 2;
                !(self.input_pair_stereo[pair] && idx % 2 == 1)
            })
            .collect()
    }

    fn move_input_strip(&mut self, strip_idx: usize, delta: i8) {
        if strip_idx >= NUM_INPUT_STRIPS || delta == 0 {
            return;
        }
        let vis = self.visible_input_indices();
        let Some(vis_pos) = vis.iter().position(|&id| id == strip_idx) else {
            return;
        };
        let target_vis_pos = if delta < 0 {
            if vis_pos == 0 {
                return;
            }
            vis_pos - 1
        } else {
            if vis_pos + 1 >= vis.len() {
                return;
            }
            vis_pos + 1
        };
        let other_idx = vis[target_vis_pos];
        let Some(pos_a) = self.input_order.iter().position(|&id| id == strip_idx) else {
            return;
        };
        let Some(pos_b) = self.input_order.iter().position(|&id| id == other_idx) else {
            return;
        };
        self.input_order.swap(pos_a, pos_b);
        self.remote_state_dirty = true;
    }

    fn visible_strip_indices(&self) -> Vec<usize> {
        let mut res = Vec::new();
        if self.view_filter != StripViewFilter::BusesOnly {
            let active_inputs = self.visible_input_indices();
            match self.input_bank {
                InputBankFilter::All => res.extend(active_inputs),
                InputBankFilter::Bank1 => res.extend(active_inputs.into_iter().take(8)),
                InputBankFilter::Bank2 => res.extend(active_inputs.into_iter().skip(8)),
            }
        }
        if self.view_filter != StripViewFilter::InputsOnly {
            for p in 0..MAX_AUX_PAIRS {
                let base = NUM_INPUT_STRIPS + p * 2;
                res.push(base);
                if !self.aux_pair_stereo[p] {
                    res.push(base + 1);
                }
            }
            res.push(NUM_INPUT_STRIPS + NUM_AUX_STRIPS);
        }
        res
    }

    fn build_remote_state_json(&self) -> String {
        #[derive(serde::Serialize)]
        struct RemotePlayerFull<'a> {
            title: &'a str,
            playing: bool,
            pos_secs: f32,
            duration_secs: f32,
            loop_enabled: bool,
            gain: f32,
            target: Option<usize>,
        }

        #[derive(serde::Serialize)]
        struct RemoteStatePacket<'a> {
            #[serde(rename = "type")]
            kind: &'static str,
            device: &'a str,
            sample_rate: u32,
            buffer_frames: u32,
            in_channels: usize,
            out_channels: usize,
            input_pair_stereo: [bool; MAX_INPUT_PAIRS],
            aux_pair_stereo: [bool; MAX_AUX_PAIRS],
            input_order: &'a [usize],
            midi_ports: &'a [String],
            strips: &'a [StripState],
            player: RemotePlayerFull<'a>,
        }

        let (sr, buf_frames, in_ch, out_ch) = self
            .engine
            .as_ref()
            .map(|e| (e.sample_rate, e.buffer_frames, e.in_channels, e.out_channels))
            .unwrap_or((48000, self.requested_buffer_frames, 8, 10));

        let pkt = RemoteStatePacket {
            kind: "state",
            device: &self.selected_device,
            sample_rate: sr,
            buffer_frames: buf_frames,
            in_channels: in_ch,
            out_channels: out_ch,
            input_pair_stereo: self.input_pair_stereo,
            aux_pair_stereo: self.aux_pair_stereo,
            input_order: &self.input_order,
            midi_ports: self.midi_manager.ports(),
            strips: &self.strips,
            player: RemotePlayerFull {
                title: &self.player_title,
                playing: self.player_progress.playing,
                pos_secs: self.player_progress.pos_secs,
                duration_secs: self.player_progress.duration_secs,
                loop_enabled: self.player_loop,
                gain: self.player_gain,
                target: self.player_target,
            },
        };
        serde_json::to_string(&pkt).unwrap_or_else(|_| "{}".to_string())
    }

    fn apply_remote_command(&mut self, cmd: RemoteCommand) {
        match cmd {
            RemoteCommand::RequestState => {
                self.remote_state_dirty = true;
            }
            RemoteCommand::SetVolume { strip, volume_db } => {
                if strip < self.strips.len() {
                    let v = volume_db.clamp(-60.0, 12.0);
                    self.strips[strip].volume_db = v;
                    self.send(MixerCommand::SetVolume { strip, volume_db: v });
                }
            }
            RemoteCommand::SetGain { strip, gain_db } => {
                if strip < self.strips.len() && self.strips[strip].kind == StripKind::Input {
                    let g = gain_db.clamp(-12.0, 24.0);
                    self.strips[strip].gain_db = g;
                    self.send(MixerCommand::SetGain { strip, gain_db: g });
                }
            }
            RemoteCommand::SetMute { strip, mute } => {
                if strip < self.strips.len() {
                    self.strips[strip].mute = mute;
                    self.send(MixerCommand::SetMute { strip, mute });
                }
            }
            RemoteCommand::SetSolo { strip, solo } => {
                if strip < self.strips.len() && self.strips[strip].kind != StripKind::Master {
                    self.strips[strip].solo = solo;
                    self.send(MixerCommand::SetSolo { strip, solo });
                }
            }
            RemoteCommand::ClearAllSolo => {
                for s_idx in 0..self.strips.len() {
                    if self.strips[s_idx].solo {
                        self.strips[s_idx].solo = false;
                        self.send(MixerCommand::SetSolo { strip: s_idx, solo: false });
                    }
                }
            }
            RemoteCommand::SetEqBand { strip, band, value_db } => {
                if strip < self.strips.len() {
                    let db = value_db.clamp(-15.0, 15.0);
                    let eq = &mut self.strips[strip].eq;
                    match band.as_str() {
                        "low" => eq.low_db = db,
                        "low_mid" => eq.low_mid_db = db,
                        "mid" => eq.mid_db = db,
                        "high_mid" => eq.high_mid_db = db,
                        "high" => eq.high_db = db,
                        _ => return,
                    }
                    let eq_copy = *eq;
                    self.send(MixerCommand::SetEq { strip, eq: eq_copy });
                }
            }
            RemoteCommand::SetEqBypass { strip, bypassed } => {
                if strip < self.strips.len() {
                    self.strips[strip].eq.bypassed = bypassed;
                    let eq_copy = self.strips[strip].eq;
                    self.send(MixerCommand::SetEq { strip, eq: eq_copy });
                }
            }
            RemoteCommand::SetAuxSend { strip, aux_idx, level } => {
                if strip < self.strips.len()
                    && self.strips[strip].kind != StripKind::Master
                    && aux_idx < NUM_AUX_STRIPS
                {
                    let lvl = level.clamp(0.0, 1.0);
                    self.strips[strip].aux_sends[aux_idx] = lvl;
                    self.send(MixerCommand::SetAuxSend { strip, aux_idx, level: lvl });
                }
            }
            RemoteCommand::SetInputPairStereo { pair, stereo } => {
                self.toggle_input_pair_stereo(pair, stereo);
            }
            RemoteCommand::SetAuxPairStereo { pair, stereo } => {
                self.toggle_aux_pair_stereo(pair, stereo);
            }
            RemoteCommand::SetInputRoute { strip, kind, channel } => {
                if strip < self.strips.len() && self.strips[strip].kind == StripKind::Input {
                    let route = match kind.as_str() {
                        "mono" => InputSourceRoute::Mono(channel),
                        "stereo" => InputSourceRoute::StereoPair(channel),
                        _ => InputSourceRoute::None,
                    };
                    self.strips[strip].input_route = route;
                    self.send(MixerCommand::SetInputRoute { strip, route });
                }
            }
            RemoteCommand::SetOutputRoute { strip, kind, channel } => {
                if strip < self.strips.len() {
                    let route = match kind.as_str() {
                        "master" if self.strips[strip].kind != StripKind::Master => {
                            OutputTargetRoute::MasterBus
                        }
                        "mono" => OutputTargetRoute::Mono(channel),
                        "stereo" => OutputTargetRoute::StereoPair(channel),
                        _ => OutputTargetRoute::None,
                    };
                    self.strips[strip].output_route = route;
                    self.send(MixerCommand::SetOutputRoute { strip, route });
                }
            }
            RemoteCommand::SetStripMidiMode { strip, mode } => {
                if strip < self.strips.len() && self.strips[strip].kind == StripKind::Input {
                    self.strips[strip].midi_mode = mode;
                    self.send(MixerCommand::SetStripMidiMode { strip, mode });
                }
            }
            RemoteCommand::SetStripMidiDevice { strip, device } => {
                if strip < self.strips.len() && self.strips[strip].kind == StripKind::Input {
                    let dev = match device.as_str() {
                        "all" | "All" => StripMidiDevice::All,
                        "none" | "None" => StripMidiDevice::None,
                        name => StripMidiDevice::Port(name.to_string()),
                    };
                    let filter = self.midi_manager.resolve_filter(&dev);
                    self.strips[strip].midi_device = dev;
                    self.send(MixerCommand::SetStripMidiDevice { strip, filter });
                }
            }
            RemoteCommand::SetStripName { strip, name } => {
                if strip < self.strips.len() {
                    self.strips[strip].name = name.chars().take(16).collect();
                    self.remote_state_dirty = true;
                }
            }
            RemoteCommand::MoveInputStrip { strip, delta } => {
                self.move_input_strip(strip, delta);
            }
            RemoteCommand::BypassInsert { strip, slot, bypassed } => {
                if strip < self.strips.len() && slot < MAX_INSERTS_PER_STRIP {
                    self.strips[strip].inserts[slot].bypassed = bypassed;
                    self.send(MixerCommand::BypassInsert { strip, slot, bypassed });
                }
            }
            RemoteCommand::SetPluginParam { strip, slot, param_id, value } => {
                if strip < self.strips.len() && slot < MAX_INSERTS_PER_STRIP {
                    if let Some(p) = self.strips[strip].inserts[slot]
                        .params
                        .iter_mut()
                        .find(|p| p.id == param_id)
                    {
                        let clamped = value.clamp(p.min, p.max);
                        p.value = clamped;
                        let p_min = p.min;
                        let p_max = p.max;
                        if let Some(NativePluginHandle::Vst3 { controller_ptr, .. }) =
                            self.native_handles[strip][slot].as_ref()
                        {
                            let norm = f64::from(
                                ((clamped - p_min) / (p_max - p_min).max(1e-6)).clamp(0.0, 1.0),
                            );
                            self.native_editors
                                .sync_vst3_param_normalized(*controller_ptr, param_id, norm);
                        }
                        self.send(MixerCommand::SetPluginParam {
                            strip,
                            slot,
                            param_id,
                            value: clamped,
                        });
                    }
                }
            }
            RemoteCommand::PlayerPlay => self.send(MixerCommand::PlayerPlay),
            RemoteCommand::PlayerPause => self.send(MixerCommand::PlayerPause),
            RemoteCommand::PlayerStop => self.send(MixerCommand::PlayerStop),
            RemoteCommand::PlayerSeek { pos_secs } => {
                self.send(MixerCommand::PlayerSeek(pos_secs.max(0.0)));
            }
            RemoteCommand::PlayerSetLoop { loop_enabled } => {
                self.player_loop = loop_enabled;
                self.send(MixerCommand::PlayerSetLoop(loop_enabled));
            }
            RemoteCommand::PlayerSetGain { gain } => {
                let g = gain.clamp(0.0, 2.0);
                self.player_gain = g;
                self.send(MixerCommand::PlayerSetGain(g));
            }
            RemoteCommand::PlayerSetTarget { target } => {
                let t = target.filter(|&i| i < NUM_INPUT_STRIPS);
                self.player_target = t;
                self.send(MixerCommand::PlayerSetTarget(t));
            }
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
            while let Some(prog) = eng.player_rx.try_pop() {
                self.player_progress = prog;
            }
            while let Some(_retired) = eng.retired_plugin_rx.try_pop() {
                // Libéré proprement sur le thread UI principal
            }
            while let Some(_retired_track) = eng.retired_track_rx.try_pop() {
                // Libéré proprement sur le thread UI principal
            }
        }

        if let Some(srv) = self.remote_server.as_ref() {
            let cmds = srv.poll_commands();
            for cmd in cmds {
                self.apply_remote_command(cmd);
            }
        }
        ctx.request_repaint_after(std::time::Duration::from_millis(16));

        let scale = self.apply_window_resize_scale(ctx);
        if self.applied_theme != Some(self.theme) {
            self.theme.apply_to_ctx(ctx);
            self.applied_theme = Some(self.theme);
        }
        let active_sr = self.engine.as_ref().map(|e| e.sample_rate).unwrap_or(48000);

        egui::TopBottomPanel::top("top_bar").show(ctx, |ui| {
            egui::menu::bar(ui, |ui| {
                ui.strong(egui::RichText::new("UMC1820 Studio Mixer").color(Color32::from_rgb(245, 158, 11)));
                ui.separator();

                // Menu Fichier
                ui.menu_button("Fichier", |ui| {
                    if ui.button("Sauver le Set (.umcset)...").clicked() {
                        ui.close_menu();
                        self.save_set_to_disk();
                    }
                    if ui.button("Charger un Set (.umcset)...").clicked() {
                        ui.close_menu();
                        self.load_set_from_disk();
                    }
                    ui.separator();
                    if ui.button("Ouvrir audio MP3 / WAV...").clicked() {
                        ui.close_menu();
                        if let Some(path) = pick_open_file("Choisir un fichier MP3 ou WAV", &["mp3", "wav"]) {
                            self.load_audio_file_from_path(&path);
                        }
                    }
                    if ui.button("Rescanner les Plugins (AU/VST3/VST2)").clicked() {
                        ui.close_menu();
                        self.discovered_plugins = scan_system_plugins();
                        self.status_info = Some(format!("{} plugins détectés", self.discovered_plugins.len()));
                    }
                });

                // Menu Audio (Carte son, Latence, Doublement Stéréo/Mono)
                ui.menu_button("Audio", |ui| {
                    ui.menu_button(format!("Carte son : {}", self.selected_device), |ui| {
                        for dev in self.devices.clone() {
                            if ui.selectable_label(self.selected_device == dev, &dev).clicked() {
                                let buf = self.requested_buffer_frames;
                                self.restart_audio_engine(Some(dev), buf);
                                ui.close_menu();
                            }
                        }
                    });
                    let cur_ms = (self.requested_buffer_frames as f32 / active_sr.max(1) as f32) * 1000.0;
                    ui.menu_button(
                        format!("Latence : {} smp ({:.1} ms)", self.requested_buffer_frames, cur_ms),
                        |ui| {
                            for &buf in &BUFFER_PRESETS {
                                let ms = (buf as f32 / active_sr.max(1) as f32) * 1000.0;
                                let lbl = format!("{buf} smp ({ms:.1} ms)");
                                if ui.selectable_label(self.requested_buffer_frames == buf, lbl).clicked() {
                                    self.restart_audio_engine(None, buf);
                                    ui.close_menu();
                                }
                            }
                        },
                    );
                    ui.separator();
                    let all_in_stereo = self.input_pair_stereo.iter().all(|&s| s);
                    let in_mode_label = if all_in_stereo {
                        "Entrées : 8 Stéréo → 16 Mono"
                    } else {
                        "Entrées : Mono → 8 Stéréo"
                    };
                    if ui.button(in_mode_label).clicked() {
                        let target = !all_in_stereo;
                        for p in 0..MAX_INPUT_PAIRS {
                            self.toggle_input_pair_stereo(p, target);
                        }
                        if !target && self.input_bank == InputBankFilter::All {
                            self.input_bank = InputBankFilter::Bank1;
                        } else if target {
                            self.input_bank = InputBankFilter::All;
                        }
                        ui.close_menu();
                    }
                    let all_aux_stereo = self.aux_pair_stereo.iter().all(|&s| s);
                    let aux_mode_label = if all_aux_stereo {
                        "Aux : 4 Stéréo → 8 Mono"
                    } else {
                        "Aux : Mono → 4 Stéréo"
                    };
                    if ui.button(aux_mode_label).clicked() {
                        let target = !all_aux_stereo;
                        for p in 0..MAX_AUX_PAIRS {
                            self.toggle_aux_pair_stereo(p, target);
                        }
                        ui.close_menu();
                    }
                });

                // Menu MIDI (État global, Rescan, Assignation rapide — sélection fine par piste d'entrée)
                ui.menu_button("MIDI", |ui| {
                    let mut midi_en = self.midi_manager.is_enabled();
                    if ui.checkbox(&mut midi_en, "Activer l'écoute MIDI").changed() {
                        self.midi_manager.set_enabled(midi_en);
                        self.sync_strip_midi_devices();
                    }
                    if ui.button("Rescanner les ports MIDI").clicked() {
                        self.midi_manager.refresh_ports();
                        self.sync_strip_midi_devices();
                        self.status_info = Some(format!(
                            "{} port(s) MIDI actif(s)",
                            self.midi_manager.connected_count()
                        ));
                        ui.close_menu();
                    }
                    ui.separator();
                    ui.menu_button("Assigner à toutes les pistes d'entrée", |ui| {
                        if ui.button("Tous les appareils").clicked() {
                            for s_idx in 0..NUM_INPUT_STRIPS {
                                self.strips[s_idx].midi_device = StripMidiDevice::All;
                            }
                            self.sync_strip_midi_devices();
                            ui.close_menu();
                        }
                        if ui.button("Aucun (Couper MIDI)").clicked() {
                            for s_idx in 0..NUM_INPUT_STRIPS {
                                self.strips[s_idx].midi_device = StripMidiDevice::None;
                            }
                            self.sync_strip_midi_devices();
                            ui.close_menu();
                        }
                        for port in self.midi_manager.ports().to_vec() {
                            if ui.button(&port).clicked() {
                                for s_idx in 0..NUM_INPUT_STRIPS {
                                    self.strips[s_idx].midi_device = StripMidiDevice::Port(port.clone());
                                }
                                self.sync_strip_midi_devices();
                                ui.close_menu();
                            }
                        }
                    });
                    ui.separator();
                    let ports = self.midi_manager.ports();
                    if ports.is_empty() {
                        ui.weak("Aucun appareil MIDI détecté");
                    } else {
                        ui.label(egui::RichText::new("Appareils détectés :").size(11.0).color(Color32::GRAY));
                        for p in ports {
                            ui.label(egui::RichText::new(format!("• {p}")).size(11.0));
                        }
                    }
                    ui.separator();
                    ui.weak("Chaque piste d'entrée choisit son appareil MIDI en haut de tranche.");
                });

                // Menu Affichage
                ui.menu_button("Affichage", |ui| {
                    ui.menu_button(format!("Vue : {}", self.view_filter.label()), |ui| {
                        for filter in [
                            StripViewFilter::All,
                            StripViewFilter::InputsOnly,
                            StripViewFilter::BusesOnly,
                        ] {
                            ui.selectable_value(&mut self.view_filter, filter, filter.label());
                        }
                    });
                    ui.menu_button(format!("Banque : {}", self.input_bank.label()), |ui| {
                        for bank in [
                            InputBankFilter::Bank1,
                            InputBankFilter::Bank2,
                            InputBankFilter::All,
                        ] {
                            ui.selectable_value(&mut self.input_bank, bank, bank.label());
                        }
                    });
                    ui.menu_button(format!("Taille : {}", self.scale_mode.label()), |ui| {
                        for mode in [
                            UiScaleMode::Auto,
                            UiScaleMode::Scale50,
                            UiScaleMode::Scale75,
                            UiScaleMode::Scale85,
                            UiScaleMode::Scale100,
                            UiScaleMode::Scale115,
                        ] {
                            ui.selectable_value(&mut self.scale_mode, mode, mode.label());
                        }
                    });
                    ui.menu_button(format!("Thème : {}", self.theme.label()), |ui| {
                        for theme_opt in UiTheme::ALL {
                            ui.selectable_value(&mut self.theme, theme_opt, theme_opt.label());
                        }
                    });
                    ui.separator();
                    ui.checkbox(&mut self.show_player_bar, "Afficher lecteur MP3/WAV");
                });

                // Menu Télécommande iPad / OSC
                let remote_menu_lbl = if self.remote_server.is_some() {
                    "iPad / OSC ●"
                } else {
                    "iPad / OSC"
                };
                ui.menu_button(remote_menu_lbl, |ui| {
                    let remote_active = self.remote_server.is_some();
                    let toggle_lbl = if remote_active {
                        "Arrêter le serveur iPad"
                    } else {
                        "Démarrer le serveur iPad"
                    };
                    if ui.button(toggle_lbl).clicked() {
                        if remote_active {
                            self.remote_server = None;
                        } else {
                            match RemoteServer::start() {
                                Ok(srv) => {
                                    self.remote_server = Some(srv);
                                    self.remote_error = None;
                                    self.remote_state_dirty = true;
                                }
                                Err(e) => self.remote_error = Some(e),
                            }
                        }
                    }
                    if let Some(srv) = self.remote_server.as_ref() {
                        let url = srv.url();
                        ui.separator();
                        ui.label(format!("Clients connectés : {}", srv.client_count()));
                        if ui
                            .button(egui::RichText::new(&url).monospace().color(Color32::from_rgb(56, 189, 248)))
                            .on_hover_text("Cliquer pour copier l'adresse Safari iPad")
                            .clicked()
                        {
                            ctx.copy_text(url.clone());
                            self.status_info = Some(format!("Adresse iPad copiée : {url}"));
                            ui.close_menu();
                        }
                        if let Some(osc_p) = srv.osc_port {
                            ui.weak(format!("Port OSC UDP : {osc_p}"));
                        }
                    }
                });

                // Menu À propos
                ui.menu_button("À propos", |ui| {
                    ui.strong("UMC1820 Studio Mixer");
                    ui.label("imaginé par Kapi");
                    ui.separator();
                    ui.weak("Console CoreAudio / ALSA · Plugins AU / VST3 / VST2 · iPad Remote");
                });

                // Accès rapide à droite : infos moteur + switch banque + alertes
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if let Some(err) = &self.status_error {
                        ui.colored_label(Color32::from_rgb(239, 68, 68), err);
                    } else if let Some(rerr) = &self.remote_error {
                        ui.colored_label(Color32::from_rgb(245, 158, 11), rerr);
                    } else if let Some(merr) = self.midi_manager.last_error() {
                        ui.colored_label(Color32::from_rgb(245, 158, 11), merr);
                    } else if let Some(info) = &self.status_info {
                        ui.colored_label(Color32::from_rgb(16, 185, 129), info);
                    }

                    if let Some(eng) = &self.engine {
                        let ms = (eng.buffer_frames as f32 / eng.sample_rate.max(1) as f32) * 1000.0;
                        ui.label(
                            egui::RichText::new(format!(
                                "{} Hz · {} smp ({:.1} ms) · {}IN/{}OUT",
                                eng.sample_rate, eng.buffer_frames, ms, eng.in_channels, eng.out_channels
                            ))
                            .size(11.0)
                            .color(Color32::GRAY),
                        );
                    }

                    if ui
                        .small_button(self.input_bank.label())
                        .on_hover_text("Basculer la banque d'entrées (1–8 / 9–16 / Tout)")
                        .clicked()
                    {
                        self.input_bank = self.input_bank.next();
                    }

                    let any_solo = self.strips.iter().any(|s| s.kind != StripKind::Master && s.solo);
                    if any_solo && ui.small_button("Solo Clear").clicked() {
                        for i in 0..self.strips.len() {
                            if self.strips[i].solo {
                                self.strips[i].solo = false;
                                self.send(MixerCommand::SetSolo { strip: i, solo: false });
                            }
                        }
                    }
                });
            });
        });

        // Barre Lecteur Audio MP3 / WAV (affichable/masquable depuis Affichage)
        if self.show_player_bar {
            egui::TopBottomPanel::top("player_bar").show(ctx, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label(egui::RichText::new("Lecteur MP3/WAV").strong().color(Color32::from_rgb(56, 189, 248)));
                if ui.button("Ouvrir fichier...").clicked() {
                    if let Some(path) = pick_open_file("Choisir un fichier MP3 ou WAV", &["mp3", "wav"]) {
                        self.load_audio_file_from_path(&path);
                    }
                }
                ui.label(
                    egui::RichText::new(&self.player_title)
                        .monospace()
                        .size(11.5)
                        .color(self.theme.text_primary()),
                );

                let has_track = self.player_progress.duration_secs > 0.0;
                ui.add_enabled_ui(has_track, |ui| {
                    if self.player_progress.playing {
                        if ui.button("⏸ Pause").clicked() {
                            self.send(MixerCommand::PlayerPause);
                        }
                    } else if ui.button("▶ Play").clicked() {
                        self.send(MixerCommand::PlayerPlay);
                    }
                    if ui.button("⏹ Stop").clicked() {
                        self.send(MixerCommand::PlayerStop);
                    }
                });

                if ui.checkbox(&mut self.player_loop, "Boucle").changed() {
                    self.send(MixerCommand::PlayerSetLoop(self.player_loop));
                }

                let dur = self.player_progress.duration_secs.max(0.01);
                let mut pos = self.player_progress.pos_secs.clamp(0.0, dur);
                if has_track {
                    if ui
                        .add(
                            egui::Slider::new(&mut pos, 0.0..=dur)
                                .show_value(false)
                                .trailing_fill(true),
                        )
                        .changed()
                    {
                        self.send(MixerCommand::PlayerSeek(pos));
                    }
                    ui.label(
                        egui::RichText::new(format!(
                            "{} / {}",
                            format_time(pos),
                            format_time(self.player_progress.duration_secs)
                        ))
                        .monospace()
                        .size(11.0),
                    );
                }

                let mut gain_pct = self.player_gain * 100.0;
                if ui
                    .add(
                        egui::Slider::new(&mut gain_pct, 0.0..=150.0)
                            .prefix("Niv ")
                            .suffix("%")
                            .fixed_decimals(0),
                    )
                    .changed()
                {
                    self.player_gain = gain_pct / 100.0;
                    self.send(MixerCommand::PlayerSetGain(self.player_gain));
                }

                let target_label = match self.player_target {
                    None => "Vers: Master".into(),
                    Some(i) => format!("Vers: {}", self.strips[i].name),
                };
                egui::ComboBox::from_id_salt("player_target_combo")
                    .selected_text(target_label)
                    .width(105.0)
                    .show_ui(ui, |ui| {
                        let mut next = self.player_target;
                        let mut changed = false;
                        changed |= ui.selectable_value(&mut next, None, "Master Direct").changed();
                        for i in 0..NUM_INPUT_STRIPS {
                            changed |= ui
                                .selectable_value(&mut next, Some(i), format!("Tranche {}", i + 1))
                                .changed();
                        }
                        if changed {
                            self.player_target = next;
                            self.send(MixerCommand::PlayerSetTarget(next));
                        }
                    });
            });
            });
        }

        let visible_indices = self.visible_strip_indices();
        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::both()
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    ui.horizontal_top(|ui| {
                        for idx in visible_indices {
                            self.draw_strip(ui, idx, scale);
                            ui.add_space(4.0 * scale);
                        }
                    });
                });
        });

        self.draw_plugin_picker_modal(ctx);

        // Diffusion temps réel vers les navigateurs iPad connectés (état + VU-mètres 20 Hz)
        if self.remote_server.is_some() {
            if self.remote_state_dirty
                && self.last_state_broadcast.elapsed() >= Duration::from_millis(35)
            {
                let json = self.build_remote_state_json();
                if let Some(srv) = self.remote_server.as_ref() {
                    srv.broadcast_state(json);
                }
                self.remote_state_dirty = false;
                self.last_state_broadcast = Instant::now();
            }

            if self
                .remote_server
                .as_ref()
                .map(|s| s.client_count() > 0)
                .unwrap_or(false)
                && self.last_meter_broadcast.elapsed() >= Duration::from_millis(50)
            {
                let meter_entries: Vec<RemoteMeterEntry> = self
                    .meters
                    .iter()
                    .map(|m| RemoteMeterEntry {
                        pl: (m.peak_l * 10.0).round() / 10.0,
                        pr: (m.peak_r * 10.0).round() / 10.0,
                        rl: (m.rms_l * 10.0).round() / 10.0,
                        rr: (m.rms_r * 10.0).round() / 10.0,
                        clip: m.clip,
                    })
                    .collect();
                let packet = RemoteMetersPacket {
                    kind: "meters",
                    meters: &meter_entries,
                    player: RemotePlayerProgressView {
                        playing: self.player_progress.playing,
                        pos_secs: self.player_progress.pos_secs,
                        duration_secs: self.player_progress.duration_secs,
                    },
                };
                if let Ok(json) = serde_json::to_string(&packet) {
                    if let Some(srv) = self.remote_server.as_ref() {
                        srv.broadcast_meters(&json);
                    }
                }
                self.last_meter_broadcast = Instant::now();
            }
        }
    }
}

impl UmcMixerApp {
    fn draw_strip(&mut self, ui: &mut egui::Ui, idx: usize, scale: f32) {
        let kind = self.strips[idx].kind;
        let is_master = kind == StripKind::Master;
        let bg = self.theme.strip_bg(kind);
        let border_col = self.theme.strip_border();
        let is_light = self.theme.is_light();

        let in_ch_count = self.engine.as_ref().map(|e| e.in_channels).unwrap_or(8).max(2);
        let out_ch_count = self.engine.as_ref().map(|e| e.out_channels).unwrap_or(10).max(2);

        let strip_w = (118.0 * scale).clamp(88.0, 140.0);
        let text_sm = (9.5 * scale).clamp(8.0, 11.0);
        let gain_knob_sz = (30.0 * scale).clamp(22.0, 36.0);
        let eq_knob_sz = (22.0 * scale).clamp(16.0, 27.0);
        let aux_knob_sz = (21.0 * scale).clamp(15.0, 26.0);
        let fader_h = (114.0 * scale).clamp(76.0, 146.0);

        let vis_inputs = if kind == StripKind::Input {
            self.visible_input_indices()
        } else {
            Vec::new()
        };
        let input_vis_pos = vis_inputs.iter().position(|&id| id == idx);
        let can_move_left = input_vis_pos.map_or(false, |p| p > 0);
        let can_move_right = input_vis_pos.map_or(false, |p| p + 1 < vis_inputs.len());
        let mut pending_move: i8 = 0;

        egui::Frame::none()
            .fill(bg)
            .stroke(egui::Stroke::new(1.0_f32, border_col))
            .inner_margin((6.0 * scale).clamp(4.0, 8.0))
            .rounding(4.0)
            .show(ui, |ui| {
                ui.set_width(strip_w);
                ui.spacing_mut().item_spacing.y = (3.0 * scale).clamp(2.0, 5.0);
                ui.vertical_centered(|ui| {
                    // Nom éditable (compatible macOS/Linux) + boutons déplacement ◀ ▶ sur les tranches d'entrée
                    let name_font_sz = (11.5 * scale).clamp(9.5, 13.5);
                    if kind == StripKind::Input {
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 2.0;
                            if ui
                                .add_enabled(
                                    can_move_left,
                                    egui::Button::new(egui::RichText::new("◀").size(text_sm))
                                        .min_size(egui::vec2(16.0, 18.0)),
                                )
                                .on_hover_text("Déplacer la piste d'entrée vers la gauche")
                                .clicked()
                            {
                                pending_move = -1;
                            }
                            let edit_w = (strip_w - 40.0).max(40.0);
                            let name_resp = ui.add_sized(
                                [edit_w, 19.0],
                                egui::TextEdit::singleline(&mut self.strips[idx].name)
                                    .horizontal_align(egui::Align::Center)
                                    .font(egui::FontId::proportional(name_font_sz))
                                    .char_limit(16),
                            );
                            if name_resp.changed() {
                                self.remote_state_dirty = true;
                            }
                            if ui
                                .add_enabled(
                                    can_move_right,
                                    egui::Button::new(egui::RichText::new("▶").size(text_sm))
                                        .min_size(egui::vec2(16.0, 18.0)),
                                )
                                .on_hover_text("Déplacer la piste d'entrée vers la droite")
                                .clicked()
                            {
                                pending_move = 1;
                            }
                        });
                    } else {
                        let name_resp = ui.add_sized(
                            [strip_w - 4.0, 19.0],
                            egui::TextEdit::singleline(&mut self.strips[idx].name)
                                .horizontal_align(egui::Align::Center)
                                .font(egui::FontId::proportional(name_font_sz))
                                .char_limit(16),
                        );
                        if name_resp.changed() {
                            self.remote_state_dirty = true;
                        }
                    }

                    // Sélecteur d'entrée (Input) + Sélecteur de sortie sur CHAQUE tranche
                    if kind == StripKind::Input {
                        let cur_in_route = self.strips[idx].input_route;
                        egui::ComboBox::from_id_salt(format!("in_route_{idx}"))
                            .selected_text(egui::RichText::new(format_input_route(cur_in_route)).size(text_sm))
                            .width(strip_w - 4.0)
                            .show_ui(ui, |ui| {
                                let mut next = cur_in_route;
                                let mut changed = false;
                                changed |= ui
                                    .selectable_value(&mut next, InputSourceRoute::None, "Aucune / Synth")
                                    .changed();
                                for ch in 0..in_ch_count.max(16) {
                                    changed |= ui
                                        .selectable_value(
                                            &mut next,
                                            InputSourceRoute::Mono(ch),
                                            format!("In {} (Mono)", ch + 1),
                                        )
                                        .changed();
                                }
                                let mut ch = 0;
                                while ch + 1 < in_ch_count.max(16) {
                                    changed |= ui
                                        .selectable_value(
                                            &mut next,
                                            InputSourceRoute::StereoPair(ch),
                                            format!("In {}/{} (Stéréo)", ch + 1, ch + 2),
                                        )
                                        .changed();
                                    ch += 2;
                                }
                                if changed {
                                    self.strips[idx].input_route = next;
                                    self.send(MixerCommand::SetInputRoute { strip: idx, route: next });
                                }
                            });
                    }

                    let cur_out_route = self.strips[idx].output_route;
                    egui::ComboBox::from_id_salt(format!("out_route_{idx}"))
                        .selected_text(egui::RichText::new(format_output_route(cur_out_route)).size(text_sm))
                        .width(strip_w - 4.0)
                        .show_ui(ui, |ui| {
                            let mut next = cur_out_route;
                            let mut changed = false;
                            if kind != StripKind::Master {
                                changed |= ui
                                    .selectable_value(
                                        &mut next,
                                        OutputTargetRoute::MasterBus,
                                        "Vers Master",
                                    )
                                    .changed();
                            }
                            changed |= ui
                                .selectable_value(&mut next, OutputTargetRoute::None, "Sortie: Aucune")
                                .changed();
                            let mut ch = 0;
                            while ch + 1 < out_ch_count.max(10) {
                                changed |= ui
                                    .selectable_value(
                                        &mut next,
                                        OutputTargetRoute::StereoPair(ch),
                                        format!("Out {}/{} (Stéréo)", ch + 1, ch + 2),
                                    )
                                    .changed();
                                ch += 2;
                            }
                            for ch_m in 0..out_ch_count.max(10) {
                                changed |= ui
                                    .selectable_value(
                                        &mut next,
                                        OutputTargetRoute::Mono(ch_m),
                                        format!("Out {} (Mono)", ch_m + 1),
                                    )
                                    .changed();
                            }
                            if changed {
                                self.strips[idx].output_route = next;
                                self.send(MixerCommand::SetOutputRoute { strip: idx, route: next });
                            }
                        });

                    // 1. Gain rotatif + Switch Stéréo/Mono sur les tranches d'entrée, ou sélecteur Mono/Stéréo sur Aux
                    if kind == StripKind::Input {
                        let in_pair = idx / 2;
                        let is_in_stereo = self.input_pair_stereo[in_pair];
                        let switch_lbl = if is_in_stereo {
                            "Stéréo → Mono"
                        } else {
                            "Mono → Stéréo"
                        };
                        if ui
                            .small_button(egui::RichText::new(switch_lbl).size(text_sm * 0.9))
                            .clicked()
                        {
                            self.toggle_input_pair_stereo(in_pair, !is_in_stereo);
                        }
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
                    } else if kind == StripKind::Aux {
                        let aux_i = idx - NUM_INPUT_STRIPS;
                        let pair = aux_i / 2;
                        let is_stereo = self.aux_pair_stereo[pair];
                        let spacer_h = gain_knob_sz + (gain_knob_sz * 0.48).clamp(11.0, 16.0) + 74.0 * scale;
                        ui.allocate_ui(egui::vec2(strip_w, spacer_h), |ui| {
                            ui.vertical_centered(|ui| {
                                ui.label(
                                    egui::RichText::new(if is_stereo {
                                        "BUS AUX STÉRÉO"
                                    } else {
                                        "BUS AUX MONO"
                                    })
                                    .size(text_sm)
                                    .color(if is_stereo {
                                        Color32::from_rgb(56, 189, 248)
                                    } else {
                                        Color32::from_rgb(16, 185, 129)
                                    }),
                                );
                                let btn_lbl = if is_stereo {
                                    "Séparer Mono"
                                } else {
                                    "Lier Stéréo"
                                };
                                if ui.small_button(egui::RichText::new(btn_lbl).size(text_sm * 0.92)).clicked() {
                                    self.toggle_aux_pair_stereo(pair, !is_stereo);
                                }
                            });
                        });
                    } else {
                        let spacer_h = gain_knob_sz + (gain_knob_sz * 0.48).clamp(11.0, 16.0) + 92.0 * scale;
                        ui.allocate_ui(egui::vec2(strip_w, spacer_h), |ui| {
                            ui.centered_and_justified(|ui| {
                                ui.label(egui::RichText::new("BUS MASTER").size(text_sm).color(Color32::GRAY));
                            });
                        });
                    }

                    ui.separator();

                    // Routage MIDI (Appareil + Canal) — PISTES D'ENTRÉE UNIQUEMENT (retiré des Aux et du Master)
                    if kind == StripKind::Input {
                        let midi_dev_label = match &self.strips[idx].midi_device {
                            StripMidiDevice::All => "MIDI: Tous".to_string(),
                            StripMidiDevice::None => "MIDI: Aucun".to_string(),
                            StripMidiDevice::Port(p) => format!("MIDI: {p}"),
                        };
                        let midi_ports = self.midi_manager.ports().to_vec();
                        egui::ComboBox::from_id_salt(format!("midi_dev_{idx}"))
                            .selected_text(egui::RichText::new(&midi_dev_label).size(text_sm))
                            .width(strip_w - 4.0)
                            .show_ui(ui, |ui| {
                                let mut dev = self.strips[idx].midi_device.clone();
                                let mut changed = false;
                                changed |= ui
                                    .selectable_value(&mut dev, StripMidiDevice::All, "Tous les appareils")
                                    .changed();
                                changed |= ui
                                    .selectable_value(&mut dev, StripMidiDevice::None, "Aucun (MIDI Off)")
                                    .changed();
                                for port in midi_ports {
                                    changed |= ui
                                        .selectable_value(&mut dev, StripMidiDevice::Port(port.clone()), port)
                                        .changed();
                                }
                                if changed {
                                    let filter = self.midi_manager.resolve_filter(&dev);
                                    self.strips[idx].midi_device = dev;
                                    self.send(MixerCommand::SetStripMidiDevice { strip: idx, filter });
                                }
                            });

                        let midi_label = match self.strips[idx].midi_mode {
                            None => "Canal: OFF".to_string(),
                            Some(0) => "Canal: OMNI".to_string(),
                            Some(ch) => format!("Canal: CH {ch}"),
                        };
                        egui::ComboBox::from_id_salt(format!("midi_ch_{idx}"))
                            .selected_text(egui::RichText::new(midi_label).size(text_sm))
                            .width(strip_w - 4.0)
                            .show_ui(ui, |ui| {
                                let mut mode = self.strips[idx].midi_mode;
                                let mut changed = false;
                                changed |= ui.selectable_value(&mut mode, None, "OFF").changed();
                                changed |= ui.selectable_value(&mut mode, Some(0), "OMNI (1-16)").changed();
                                for ch in 1..=16_u8 {
                                    changed |= ui
                                        .selectable_value(&mut mode, Some(ch), format!("Canal {ch}"))
                                        .changed();
                                }
                                if changed {
                                    self.strips[idx].midi_mode = mode;
                                    self.send(MixerCommand::SetStripMidiMode { strip: idx, mode });
                                }
                            });
                    }

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
                                        self.theme.text_muted()
                                    } else if slot_state.bypassed {
                                        Color32::from_rgb(120, 128, 145)
                                    } else if native_open {
                                        if is_light {
                                            Color32::from_rgb(3, 105, 161)
                                        } else {
                                            Color32::from_rgb(125, 211, 252)
                                        }
                                    } else {
                                        self.theme.text_primary()
                                    }),
                            )
                            .fill(if has_plugin && !slot_state.bypassed {
                                if is_light {
                                    Color32::from_rgb(219, 234, 254)
                                } else {
                                    Color32::from_rgb(26, 36, 54)
                                }
                            } else if is_light {
                                Color32::from_rgb(235, 240, 247)
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
                                if has_plugin {
                                    if !self.native_editors.is_open(idx, slot) {
                                        if let Some(handle) = self.native_handles[idx][slot].clone() {
                                            if let Err(err) = self
                                                .native_editors
                                                .open_editor(idx, slot, &handle)
                                            {
                                                self.last_native_ui_error = Some((idx, slot, err));
                                            }
                                        }
                                    } else {
                                        self.native_editors.focus_slot(idx, slot);
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

                    // 3. EQ 5 bandes avec potentiomètre central MID (1 kHz) au milieu
                    ui.label(egui::RichText::new("EQ 5 BANDES").size(text_sm * 0.92).color(Color32::GRAY));
                    let mut eq = self.strips[idx].eq;
                    let mut eq_changed = false;
                    egui::Grid::new(format!("eq_top_{idx}"))
                        .spacing([2.0, 2.0])
                        .show(ui, |ui| {
                            eq_changed |= rotary_knob(ui, &mut eq.high_db, -15.0..=15.0, 0.0, "HI", "dB", Color32::from_rgb(56, 189, 248), eq_knob_sz).changed();
                            eq_changed |= rotary_knob(ui, &mut eq.high_mid_db, -15.0..=15.0, 0.0, "HM", "dB", Color32::from_rgb(56, 189, 248), eq_knob_sz).changed();
                            ui.end_row();
                        });
                    // 5ème potentiomètre Médiums centré au milieu
                    eq_changed |= rotary_knob(ui, &mut eq.mid_db, -15.0..=15.0, 0.0, "MID", "dB", Color32::from_rgb(125, 211, 252), eq_knob_sz).changed();
                    egui::Grid::new(format!("eq_bot_{idx}"))
                        .spacing([2.0, 2.0])
                        .show(ui, |ui| {
                            eq_changed |= rotary_knob(ui, &mut eq.low_mid_db, -15.0..=15.0, 0.0, "LM", "dB", Color32::from_rgb(56, 189, 248), eq_knob_sz).changed();
                            eq_changed |= rotary_knob(ui, &mut eq.low_db, -15.0..=15.0, 0.0, "LO", "dB", Color32::from_rgb(56, 189, 248), eq_knob_sz).changed();
                            ui.end_row();
                        });
                    if eq_changed {
                        self.strips[idx].eq = eq;
                        self.send(MixerCommand::SetEq { strip: idx, eq });
                    }

                    ui.separator();

                    // 4. Envois Auxiliaires (4 stéréo ou jusqu'à 8 mono si séparés)
                    if !is_master {
                        ui.label(egui::RichText::new("ENVOIS AUX").size(text_sm * 0.92).color(Color32::GRAY));
                        let mut active_sends: Vec<(usize, String)> = Vec::new();
                        for p in 0..MAX_AUX_PAIRS {
                            if self.aux_pair_stereo[p] {
                                active_sends.push((p * 2, format!("A{}/{}", p * 2 + 1, p * 2 + 2)));
                            } else {
                                active_sends.push((p * 2, format!("A{}", p * 2 + 1)));
                                active_sends.push((p * 2 + 1, format!("A{}", p * 2 + 2)));
                            }
                        }
                        egui::Grid::new(format!("aux_grid_{idx}"))
                            .spacing([2.0, 2.0])
                            .show(ui, |ui| {
                                for (col_i, (aux_i, lbl)) in active_sends.iter().enumerate() {
                                    let mut val = self.strips[idx].aux_sends[*aux_i] * 100.0;
                                    if rotary_knob(
                                        ui,
                                        &mut val,
                                        0.0..=100.0,
                                        0.0,
                                        lbl,
                                        "%",
                                        Color32::from_rgb(16, 185, 129),
                                        aux_knob_sz,
                                    )
                                    .changed()
                                    {
                                        let norm = val / 100.0;
                                        self.strips[idx].aux_sends[*aux_i] = norm;
                                        self.send(MixerCommand::SetAuxSend {
                                            strip: idx,
                                            aux_idx: *aux_i,
                                            level: norm,
                                        });
                                    }
                                    if col_i % 2 == 1 {
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
        if pending_move != 0 {
            self.move_input_strip(idx, pending_move);
        }
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
