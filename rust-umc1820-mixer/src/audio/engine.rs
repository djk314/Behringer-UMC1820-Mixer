use super::dsp::{db_to_linear, BallisticMeter, FiveBandEqProcessor};
use super::player::DecodedAudioTrack;
use super::plugin_host::{HostedPlugin, StripInsertRack};
use super::state::{
    InputSourceRoute, MeterFrame, MidiMessage, MixerCommand, OutputTargetRoute, PlayerProgress,
    StripKind, StripState, MAX_AUX_PAIRS, MAX_INPUT_PAIRS, MAX_INSERTS_PER_STRIP,
    NUM_AUX_STRIPS, NUM_INPUT_STRIPS, TOTAL_STRIPS,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleRate, Stream, StreamConfig};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;
use std::sync::{Arc, Mutex};

const MAX_AUDIO_FRAMES: usize = 4096;

pub struct AudioEngineHandle {
    pub command_tx: ringbuf::HeapProd<MixerCommand>,
    pub midi_tx: Option<ringbuf::HeapProd<MidiMessage>>,
    pub meter_rx: ringbuf::HeapCons<[MeterFrame; TOTAL_STRIPS]>,
    pub player_rx: ringbuf::HeapCons<PlayerProgress>,
    pub retired_plugin_rx: ringbuf::HeapCons<Box<dyn HostedPlugin>>,
    pub retired_track_rx: ringbuf::HeapCons<Arc<DecodedAudioTrack>>,
    pub device_name: String,
    pub sample_rate: u32,
    pub buffer_frames: u32,
    pub in_channels: usize,
    pub out_channels: usize,
    _input_stream: Option<Stream>,
    _output_stream: Option<Stream>,
}

struct StripDspRuntime {
    kind: StripKind,
    input_route: InputSourceRoute,
    output_route: OutputTargetRoute,
    gain_db: f32,
    volume_db: f32,
    mute: bool,
    solo: bool,
    midi_mode: Option<u8>,
    aux_sends: [f32; NUM_AUX_STRIPS],
    eq: FiveBandEqProcessor,
    inserts: StripInsertRack,
    meter: BallisticMeter,
}

impl StripDspRuntime {
    fn new(index: usize, kind: StripKind, out_channels: usize) -> Self {
        let input_route = if kind == StripKind::Input {
            if index % 2 == 0 {
                InputSourceRoute::StereoPair(index)
            } else {
                InputSourceRoute::Mono(index)
            }
        } else {
            InputSourceRoute::None
        };
        let output_route = match kind {
            StripKind::Input => OutputTargetRoute::MasterBus,
            StripKind::Aux => {
                let aux_i = index.saturating_sub(NUM_INPUT_STRIPS);
                if aux_i % 2 == 0 {
                    OutputTargetRoute::StereoPair(aux_i)
                } else {
                    OutputTargetRoute::Mono(aux_i)
                }
            }
            StripKind::Master => {
                if out_channels >= 10 {
                    OutputTargetRoute::StereoPair(8)
                } else {
                    OutputTargetRoute::StereoPair(0)
                }
            }
        };
        Self {
            kind,
            input_route,
            output_route,
            gain_db: 0.0,
            volume_db: 0.0,
            mute: false,
            solo: false,
            midi_mode: if kind == StripKind::Input { Some(0) } else { None },
            aux_sends: [0.0; NUM_AUX_STRIPS],
            eq: FiveBandEqProcessor::default(),
            inserts: StripInsertRack::default(),
            meter: BallisticMeter::default(),
        }
    }
}

struct PlayerRuntime {
    track: Option<Arc<DecodedAudioTrack>>,
    pos_frames: f64,
    playing: bool,
    looping: bool,
    gain: f32,
    target: Option<usize>,
}

impl Default for PlayerRuntime {
    fn default() -> Self {
        Self {
            track: None,
            pos_frames: 0.0,
            playing: false,
            looping: false,
            gain: 1.0,
            target: None,
        }
    }
}

impl PlayerRuntime {
    fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32], engine_sr: f32) -> PlayerProgress {
        out_l.fill(0.0);
        out_r.fill(0.0);
        let Some(track) = self.track.as_ref() else {
            self.playing = false;
            return PlayerProgress::default();
        };
        let len = track.left.len();
        if len == 0 || track.sample_rate == 0 {
            self.playing = false;
            return PlayerProgress::default();
        }
        let duration_secs = len as f32 / track.sample_rate as f32;
        if self.playing {
            let step = f64::from(track.sample_rate) / f64::from(engine_sr.max(1.0));
            let gain = self.gain;
            for i in 0..out_l.len() {
                let idx = self.pos_frames.floor() as usize;
                if idx >= len {
                    if self.looping {
                        self.pos_frames = 0.0;
                    } else {
                        self.playing = false;
                        self.pos_frames = 0.0;
                        break;
                    }
                }
                let i0 = (self.pos_frames.floor() as usize).min(len - 1);
                let i1 = (i0 + 1).min(len - 1);
                let frac = (self.pos_frames - i0 as f64) as f32;
                let sl = track.left[i0] + (track.left[i1] - track.left[i0]) * frac;
                let sr = track.right[i0] + (track.right[i1] - track.right[i0]) * frac;
                out_l[i] = sl * gain;
                out_r[i] = sr * gain;
                self.pos_frames += step;
            }
        }
        let pos_secs = ((self.pos_frames as f32) / track.sample_rate as f32).clamp(0.0, duration_secs);
        PlayerProgress {
            playing: self.playing,
            pos_secs,
            duration_secs,
        }
    }
}

#[inline]
fn filter_midi_for_strip(
    mode: Option<u8>,
    src: &[MidiMessage],
    dst: &mut [MidiMessage; 128],
) -> usize {
    let Some(target) = mode else {
        return 0;
    };
    if target == 0 {
        let n = src.len().min(128);
        dst[..n].copy_from_slice(&src[..n]);
        return n;
    }
    let mut n = 0;
    for &m in src {
        if m.channel() == Some(target) {
            dst[n] = m;
            n += 1;
            if n == 128 {
                break;
            }
        }
    }
    n
}

#[inline]
fn mix_to_hardware(
    route: OutputTargetRoute,
    bus_l: &[f32],
    bus_r: &[f32],
    out: &mut [f32],
    frames: usize,
    out_channels: usize,
) {
    match route {
        OutputTargetRoute::None | OutputTargetRoute::MasterBus => {}
        OutputTargetRoute::Mono(ch) => {
            if ch < out_channels {
                for f in 0..frames {
                    out[f * out_channels + ch] += 0.5 * (bus_l[f] + bus_r[f]);
                }
            }
        }
        OutputTargetRoute::StereoPair(ch) => {
            if ch < out_channels {
                for f in 0..frames {
                    let base = f * out_channels;
                    out[base + ch] += bus_l[f];
                    if ch + 1 < out_channels {
                        out[base + ch + 1] += bus_r[f];
                    }
                }
            }
        }
    }
}

pub fn list_audio_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices()
        .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

pub fn start_audio_engine(
    preferred_device: Option<&str>,
    preferred_buffer_frames: Option<u32>,
) -> Result<AudioEngineHandle, String> {
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
    let buffer_frames = preferred_buffer_frames.unwrap_or(128).clamp(64, 2048);

    let (cmd_tx, cmd_rx) = HeapRb::<MixerCommand>::new(512).split();
    let (midi_tx, midi_rx) = HeapRb::<MidiMessage>::new(512).split();
    let (meter_tx, meter_rx) = HeapRb::<[MeterFrame; TOTAL_STRIPS]>::new(16).split();
    let (player_tx, player_rx) = HeapRb::<PlayerProgress>::new(16).split();
    let (retired_tx, retired_plugin_rx) = HeapRb::<Box<dyn HostedPlugin>>::new(32).split();
    let (retired_track_tx, retired_track_rx) =
        HeapRb::<Arc<DecodedAudioTrack>>::new(8).split();
    let (mut audio_in_tx, mut audio_in_rx) = HeapRb::<f32>::new(sample_rate as usize * 16).split();

    let mut input_stream = None;
    let mut in_channels = 0_usize;

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
                    let (mut tx2, rx2) =
                        HeapRb::<f32>::new(sample_rate as usize * in_channels.max(18)).split();
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

    let runtimes: Vec<StripDspRuntime> = (0..TOTAL_STRIPS)
        .map(|i| {
            if i < NUM_INPUT_STRIPS {
                StripDspRuntime::new(i, StripKind::Input, out_channels)
            } else if i < NUM_INPUT_STRIPS + NUM_AUX_STRIPS {
                StripDspRuntime::new(i, StripKind::Aux, out_channels)
            } else {
                StripDspRuntime::new(i, StripKind::Master, out_channels)
            }
        })
        .collect();

    struct OutputCallbackState {
        sr_f32: f32,
        in_channels: usize,
        out_channels: usize,
        cmd_rx: ringbuf::HeapCons<MixerCommand>,
        midi_rx: ringbuf::HeapCons<MidiMessage>,
        meter_tx: ringbuf::HeapProd<[MeterFrame; TOTAL_STRIPS]>,
        player_tx: ringbuf::HeapProd<PlayerProgress>,
        retired_tx: ringbuf::HeapProd<Box<dyn HostedPlugin>>,
        retired_track_tx: ringbuf::HeapProd<Arc<DecodedAudioTrack>>,
        audio_in_rx: ringbuf::HeapCons<f32>,
        runtimes: Vec<StripDspRuntime>,
        input_pair_stereo: [bool; MAX_INPUT_PAIRS],
        aux_pair_stereo: [bool; MAX_AUX_PAIRS],
        player: PlayerRuntime,
        scratch_in: Vec<f32>,
        block_l: Vec<f32>,
        block_r: Vec<f32>,
        player_l: Vec<f32>,
        player_r: Vec<f32>,
        aux_bus_l: Vec<Vec<f32>>,
        aux_bus_r: Vec<Vec<f32>>,
        master_l: Vec<f32>,
        master_r: Vec<f32>,
        direct_hw_out: Vec<f32>,
    }

    let cb_state = OutputCallbackState {
        sr_f32: sample_rate as f32,
        in_channels,
        out_channels,
        cmd_rx,
        midi_rx,
        meter_tx,
        player_tx,
        retired_tx,
        retired_track_tx,
        audio_in_rx,
        runtimes,
        input_pair_stereo: [true; MAX_INPUT_PAIRS],
        aux_pair_stereo: [true; MAX_AUX_PAIRS],
        player: PlayerRuntime::default(),
        scratch_in: vec![0.0_f32; MAX_AUDIO_FRAMES * in_channels.max(18)],
        block_l: vec![0.0_f32; MAX_AUDIO_FRAMES],
        block_r: vec![0.0_f32; MAX_AUDIO_FRAMES],
        player_l: vec![0.0_f32; MAX_AUDIO_FRAMES],
        player_r: vec![0.0_f32; MAX_AUDIO_FRAMES],
        aux_bus_l: (0..NUM_AUX_STRIPS).map(|_| vec![0.0_f32; MAX_AUDIO_FRAMES]).collect(),
        aux_bus_r: (0..NUM_AUX_STRIPS).map(|_| vec![0.0_f32; MAX_AUDIO_FRAMES]).collect(),
        master_l: vec![0.0_f32; MAX_AUDIO_FRAMES],
        master_r: vec![0.0_f32; MAX_AUDIO_FRAMES],
        direct_hw_out: vec![0.0_f32; MAX_AUDIO_FRAMES * out_channels.max(16)],
    };

    let shared_cb = Arc::new(Mutex::new(Some(cb_state)));

    let make_callback = |holder: Arc<Mutex<Option<OutputCallbackState>>>| {
        let mut local_state: Option<OutputCallbackState> = None;
        move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
            if local_state.is_none() {
                if let Ok(mut guard) = holder.try_lock() {
                    local_state = guard.take();
                }
            }
            let Some(st) = local_state.as_mut() else {
                out.fill(0.0);
                return;
            };
            let sr_f32 = st.sr_f32;
            let in_channels = st.in_channels;
            let out_channels = st.out_channels;

            // 1. Appliquer toutes les commandes UI sans bloquer
            while let Some(cmd) = st.cmd_rx.try_pop() {
                match cmd {
                    MixerCommand::SetGain { strip, gain_db } => {
                        if strip < TOTAL_STRIPS && st.runtimes[strip].kind == StripKind::Input {
                            st.runtimes[strip].gain_db = gain_db;
                        }
                    }
                    MixerCommand::SetVolume { strip, volume_db } => {
                        if strip < TOTAL_STRIPS {
                            st.runtimes[strip].volume_db = volume_db;
                        }
                    }
                    MixerCommand::SetMute { strip, mute } => {
                        if strip < TOTAL_STRIPS {
                            st.runtimes[strip].mute = mute;
                        }
                    }
                    MixerCommand::SetSolo { strip, solo } => {
                        if strip < TOTAL_STRIPS && st.runtimes[strip].kind != StripKind::Master {
                            st.runtimes[strip].solo = solo;
                        }
                    }
                    MixerCommand::SetEq { strip, eq } => {
                        if strip < TOTAL_STRIPS {
                            st.runtimes[strip].eq.update(sr_f32, eq);
                        }
                    }
                    MixerCommand::SetAuxSend { strip, aux_idx, level } => {
                        if strip < TOTAL_STRIPS
                            && st.runtimes[strip].kind != StripKind::Master
                            && aux_idx < NUM_AUX_STRIPS
                        {
                            st.runtimes[strip].aux_sends[aux_idx] = level;
                        }
                    }
                    MixerCommand::SetInputPairStereo { pair, stereo } => {
                        if pair < MAX_INPUT_PAIRS {
                            st.input_pair_stereo[pair] = stereo;
                        }
                    }
                    MixerCommand::SetAuxPairStereo { pair, stereo } => {
                        if pair < MAX_AUX_PAIRS {
                            st.aux_pair_stereo[pair] = stereo;
                        }
                    }
                    MixerCommand::SetInputRoute { strip, route } => {
                        if strip < NUM_INPUT_STRIPS {
                            st.runtimes[strip].input_route = route;
                        }
                    }
                    MixerCommand::SetOutputRoute { strip, route } => {
                        if strip < TOTAL_STRIPS {
                            st.runtimes[strip].output_route = route;
                        }
                    }
                    MixerCommand::SetStripMidiMode { strip, mode } => {
                        if strip < TOTAL_STRIPS {
                            st.runtimes[strip].midi_mode = mode;
                        }
                    }
                    MixerCommand::InstallInsert { strip, slot, plugin } => {
                        if strip < TOTAL_STRIPS && slot < MAX_INSERTS_PER_STRIP {
                            let prev = std::mem::replace(
                                &mut st.runtimes[strip].inserts.slots[slot],
                                plugin,
                            );
                            if let Some(old_plugin) = prev {
                                let _ = st.retired_tx.try_push(old_plugin);
                            }
                        }
                    }
                    MixerCommand::BypassInsert { strip, slot, bypassed } => {
                        if strip < TOTAL_STRIPS && slot < MAX_INSERTS_PER_STRIP {
                            st.runtimes[strip].inserts.set_bypass(slot, bypassed);
                        }
                    }
                    MixerCommand::SetPluginParam { strip, slot, param_id, value } => {
                        if strip < TOTAL_STRIPS && slot < MAX_INSERTS_PER_STRIP {
                            st.runtimes[strip].inserts.set_parameter(slot, param_id, value);
                        }
                    }
                    MixerCommand::LoadAudioTrack(new_track) => {
                        st.player.playing = false;
                        st.player.pos_frames = 0.0;
                        if let Some(old) = std::mem::replace(&mut st.player.track, new_track) {
                            let _ = st.retired_track_tx.try_push(old);
                        }
                    }
                    MixerCommand::PlayerPlay => {
                        if st.player.track.is_some() {
                            st.player.playing = true;
                        }
                    }
                    MixerCommand::PlayerPause => {
                        st.player.playing = false;
                    }
                    MixerCommand::PlayerStop => {
                        st.player.playing = false;
                        st.player.pos_frames = 0.0;
                    }
                    MixerCommand::PlayerSeek(secs) => {
                        if let Some(track) = st.player.track.as_ref() {
                            let max_f = track.left.len().saturating_sub(1) as f64;
                            st.player.pos_frames =
                                (f64::from(secs.max(0.0)) * f64::from(track.sample_rate)).min(max_f);
                        }
                    }
                    MixerCommand::PlayerSetLoop(looping) => {
                        st.player.looping = looping;
                    }
                    MixerCommand::PlayerSetGain(gain) => {
                        st.player.gain = gain.clamp(0.0, 2.0);
                    }
                    MixerCommand::PlayerSetTarget(target) => {
                        st.player.target = target.filter(|&i| i < NUM_INPUT_STRIPS);
                    }
                }
            }

            let mut midi_buf = [MidiMessage::default(); 128];
            let mut midi_count = 0_usize;
            while midi_count < midi_buf.len() {
                if let Some(m) = st.midi_rx.try_pop() {
                    midi_buf[midi_count] = m;
                    midi_count += 1;
                } else {
                    break;
                }
            }
            let mut strip_midi = [MidiMessage::default(); 128];

            let frames = (out.len() / out_channels.max(1)).min(MAX_AUDIO_FRAMES);
            if in_channels > 0 {
                let needed_in = frames * in_channels;
                st.scratch_in[..needed_in].fill(0.0);
                let _ = st.audio_in_rx.pop_slice(&mut st.scratch_in[..needed_in]);
            }

            for b in 0..NUM_AUX_STRIPS {
                st.aux_bus_l[b][..frames].fill(0.0);
                st.aux_bus_r[b][..frames].fill(0.0);
            }
            st.master_l[..frames].fill(0.0);
            st.master_r[..frames].fill(0.0);
            st.direct_hw_out[..frames * out_channels].fill(0.0);

            // Rendu du lecteur MP3/WAV
            let progress = st.player.render(&mut st.player_l[..frames], &mut st.player_r[..frames], sr_f32);
            let _ = st.player_tx.try_push(progress);
            if st.player.target.is_none() {
                for f in 0..frames {
                    st.master_l[f] += st.player_l[f];
                    st.master_r[f] += st.player_r[f];
                }
            }

            // Détection Solo sur les tranches actives (Entrées + Aux actifs)
            let mut any_solo = false;
            for p in 0..MAX_INPUT_PAIRS {
                let base = p * 2;
                if st.runtimes[base].solo || (!st.input_pair_stereo[p] && st.runtimes[base + 1].solo) {
                    any_solo = true;
                    break;
                }
            }
            if !any_solo {
                for p in 0..MAX_AUX_PAIRS {
                    let base = NUM_INPUT_STRIPS + p * 2;
                    if st.runtimes[base].solo || (!st.aux_pair_stereo[p] && st.runtimes[base + 1].solo) {
                        any_solo = true;
                        break;
                    }
                }
            }
            let mut meters = [MeterFrame::default(); TOTAL_STRIPS];

            // 2. Traitement des tranches d'entrée (8 paires stéréo ou jusqu'à 16 mono séparées)
            for p in 0..MAX_INPUT_PAIRS {
                let sub_count = if st.input_pair_stereo[p] { 1 } else { 2 };
                for sub in 0..sub_count {
                    let ch = p * 2 + sub;
                    let rt = &mut st.runtimes[ch];
                    let trim = db_to_linear(rt.gain_db);
                    let add_player = st.player.target == Some(ch);

                    for f in 0..frames {
                        let (mut in_l, mut in_r) = match rt.input_route {
                            InputSourceRoute::None => (0.0, 0.0),
                            InputSourceRoute::Mono(hw_ch) => {
                                if hw_ch < in_channels {
                                    let s = st.scratch_in[f * in_channels + hw_ch];
                                    (s, s)
                                } else {
                                    (0.0, 0.0)
                                }
                            }
                            InputSourceRoute::StereoPair(hw_ch) => {
                                if hw_ch < in_channels {
                                    let l = st.scratch_in[f * in_channels + hw_ch];
                                    let r = if hw_ch + 1 < in_channels {
                                        st.scratch_in[f * in_channels + hw_ch + 1]
                                    } else {
                                        l
                                    };
                                    (l, r)
                                } else {
                                    (0.0, 0.0)
                                }
                            }
                        };
                        if add_player {
                            in_l += st.player_l[f];
                            in_r += st.player_r[f];
                        }
                        st.block_l[f] = in_l * trim;
                        st.block_r[f] = in_r * trim;
                    }

                    let n_midi =
                        filter_midi_for_strip(rt.midi_mode, &midi_buf[..midi_count], &mut strip_midi);
                    rt.inserts.process_with_midi(
                        &mut st.block_l[..frames],
                        &mut st.block_r[..frames],
                        &strip_midi[..n_midi],
                    );

                    let audible = if any_solo { rt.solo && !rt.mute } else { !rt.mute };
                    let fader = if audible { db_to_linear(rt.volume_db) } else { 0.0 };

                    for f in 0..frames {
                        let (el, er) = rt.eq.process(st.block_l[f], st.block_r[f]);
                        let sl = el * fader;
                        let sr = er * fader;
                        if st.input_pair_stereo[p] {
                            st.block_l[f] = sl;
                            st.block_r[f] = sr;
                        } else {
                            let mono = 0.5 * (sl + sr);
                            st.block_l[f] = mono;
                            st.block_r[f] = mono;
                        }

                        if rt.output_route == OutputTargetRoute::MasterBus {
                            st.master_l[f] += st.block_l[f];
                            st.master_r[f] += st.block_r[f];
                        }

                        for ap in 0..MAX_AUX_PAIRS {
                            let a_l = ap * 2;
                            let a_r = ap * 2 + 1;
                            if st.aux_pair_stereo[ap] {
                                let send = rt.aux_sends[a_l];
                                st.aux_bus_l[a_l][f] += st.block_l[f] * send;
                                st.aux_bus_r[a_l][f] += st.block_r[f] * send;
                            } else {
                                let mono = 0.5 * (st.block_l[f] + st.block_r[f]);
                                let s_l = mono * rt.aux_sends[a_l];
                                let s_r = mono * rt.aux_sends[a_r];
                                st.aux_bus_l[a_l][f] += s_l;
                                st.aux_bus_r[a_l][f] += s_l;
                                st.aux_bus_l[a_r][f] += s_r;
                                st.aux_bus_r[a_r][f] += s_r;
                            }
                        }
                    }

                    mix_to_hardware(
                        rt.output_route,
                        &st.block_l,
                        &st.block_r,
                        &mut st.direct_hw_out,
                        frames,
                        out_channels,
                    );

                    meters[ch] = rt.meter.push_block(&st.block_l[..frames], &st.block_r[..frames], sr_f32);
                }
            }

            // 3. Traitement des bus Aux (Stéréo liés ou Mono séparés)
            for p in 0..MAX_AUX_PAIRS {
                let sub_count = if st.aux_pair_stereo[p] { 1 } else { 2 };
                for sub in 0..sub_count {
                    let aux_i = p * 2 + sub;
                    let idx = NUM_INPUT_STRIPS + aux_i;
                    let rt = &mut st.runtimes[idx];
                    for f in 0..frames {
                        st.block_l[f] = st.aux_bus_l[aux_i][f];
                        st.block_r[f] = st.aux_bus_r[aux_i][f];
                    }

                    let n_midi = filter_midi_for_strip(
                        rt.midi_mode,
                        &midi_buf[..midi_count],
                        &mut strip_midi,
                    );
                    rt.inserts.process_with_midi(
                        &mut st.block_l[..frames],
                        &mut st.block_r[..frames],
                        &strip_midi[..n_midi],
                    );

                    let audible = if any_solo { rt.solo && !rt.mute } else { !rt.mute };
                    let fader = if audible { db_to_linear(rt.volume_db) } else { 0.0 };

                    for f in 0..frames {
                        let (el, er) = rt.eq.process(st.block_l[f], st.block_r[f]);
                        let ol = el * fader;
                        let or = er * fader;
                        if st.aux_pair_stereo[p] {
                            st.aux_bus_l[aux_i][f] = ol;
                            st.aux_bus_r[aux_i][f] = or;
                        } else {
                            let mono = 0.5 * (ol + or);
                            st.aux_bus_l[aux_i][f] = mono;
                            st.aux_bus_r[aux_i][f] = mono;
                        }
                        if rt.output_route == OutputTargetRoute::MasterBus {
                            st.master_l[f] += st.aux_bus_l[aux_i][f];
                            st.master_r[f] += st.aux_bus_r[aux_i][f];
                        }
                    }

                    meters[idx] = rt.meter.push_block(
                        &st.aux_bus_l[aux_i][..frames],
                        &st.aux_bus_r[aux_i][..frames],
                        sr_f32,
                    );
                }
            }

            // 4. Traitement de la tranche Master (SANS Gain et SANS Solo)
            let master_idx = NUM_INPUT_STRIPS + NUM_AUX_STRIPS;
            {
                let rt = &mut st.runtimes[master_idx];
                let n_midi =
                    filter_midi_for_strip(rt.midi_mode, &midi_buf[..midi_count], &mut strip_midi);
                rt.inserts.process_with_midi(
                    &mut st.master_l[..frames],
                    &mut st.master_r[..frames],
                    &strip_midi[..n_midi],
                );
                let fader = if !rt.mute { db_to_linear(rt.volume_db) } else { 0.0 };

                for f in 0..frames {
                    let (el, er) = rt.eq.process(st.master_l[f], st.master_r[f]);
                    st.master_l[f] = (el * fader).tanh();
                    st.master_r[f] = (er * fader).tanh();
                }
                meters[master_idx] = rt.meter.push_block(
                    &st.master_l[..frames],
                    &st.master_r[..frames],
                    sr_f32,
                );
            }

            // 5. Routage dynamique vers les sorties physiques du périphérique audio
            out[..frames * out_channels].copy_from_slice(&st.direct_hw_out[..frames * out_channels]);
            for p in 0..MAX_AUX_PAIRS {
                let sub_count = if st.aux_pair_stereo[p] { 1 } else { 2 };
                for sub in 0..sub_count {
                    let aux_i = p * 2 + sub;
                    let idx = NUM_INPUT_STRIPS + aux_i;
                    mix_to_hardware(
                        st.runtimes[idx].output_route,
                        &st.aux_bus_l[aux_i],
                        &st.aux_bus_r[aux_i],
                        out,
                        frames,
                        out_channels,
                    );
                }
            }
            mix_to_hardware(
                st.runtimes[master_idx].output_route,
                &st.master_l,
                &st.master_r,
                out,
                frames,
                out_channels,
            );

            let _ = st.meter_tx.try_push(meters);
        }
    };

    let fixed_out_cfg = StreamConfig {
        channels: out_channels as u16,
        sample_rate: SampleRate(sample_rate),
        buffer_size: BufferSize::Fixed(buffer_frames),
    };
    let default_out_cfg = StreamConfig {
        channels: out_channels as u16,
        sample_rate: SampleRate(sample_rate),
        buffer_size: BufferSize::Default,
    };

    let output_stream = output_device
        .build_output_stream(
            &fixed_out_cfg,
            make_callback(Arc::clone(&shared_cb)),
            |err| eprintln!("Erreur flux sortie CoreAudio/ALSA: {err}"),
            None,
        )
        .or_else(|_| {
            output_device.build_output_stream(
                &default_out_cfg,
                make_callback(Arc::clone(&shared_cb)),
                |err| eprintln!("Erreur flux sortie CoreAudio/ALSA: {err}"),
                None,
            )
        })
        .map_err(|e| format!("Échec ouverture flux sortie: {e}"))?;

    output_stream
        .play()
        .map_err(|e| format!("Échec démarrage flux sortie: {e}"))?;

    Ok(AudioEngineHandle {
        command_tx: cmd_tx,
        midi_tx: Some(midi_tx),
        meter_rx,
        player_rx,
        retired_plugin_rx,
        retired_track_rx,
        device_name,
        sample_rate,
        buffer_frames,
        in_channels,
        out_channels,
        _input_stream: input_stream,
        _output_stream: Some(output_stream),
    })
}

pub fn default_mixer_strips() -> Vec<StripState> {
    let mut strips = Vec::with_capacity(TOTAL_STRIPS);
    for i in 0..NUM_INPUT_STRIPS {
        let p = i / 2;
        let label = if i % 2 == 0 {
            format!("IN {}/{}", p * 2 + 1, p * 2 + 2)
        } else {
            format!("IN {}", i + 1)
        };
        strips.push(StripState::new(i, StripKind::Input, label));
    }
    let aux_names = [
        "AUX 1/2",
        "AUX 2",
        "AUX 3/4",
        "AUX 4",
        "AUX 5/6",
        "AUX 6",
        "AUX 7/8",
        "AUX 8",
    ];
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
