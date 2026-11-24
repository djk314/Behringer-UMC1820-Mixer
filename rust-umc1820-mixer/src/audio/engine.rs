use super::dsp::{db_to_linear, BallisticMeter, FourBandEqProcessor};
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
