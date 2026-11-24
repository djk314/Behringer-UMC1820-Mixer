use crate::audio::engine::{
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
    // IMPORTANT : déclaré avant `offline_plugins` et `engine` pour fermer toutes les fenêtres natives avant le déchargement des plugins.
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
                                ui.label(egui::RichText::new("SOMMATION
MAIN OUT").size(text_sm).color(Color32::from_rgb(110, 120, 140)));
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
