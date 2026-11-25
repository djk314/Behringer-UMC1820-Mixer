use std::fs::File;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Clone)]
pub struct DecodedAudioTrack {
    pub title: String,
    pub path: PathBuf,
    pub sample_rate: u32,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl DecodedAudioTrack {
    pub fn duration_secs(&self) -> f32 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.left.len() as f32 / self.sample_rate as f32
        }
    }
}

pub fn decode_audio_file(path: &Path) -> Result<DecodedAudioTrack, String> {
    let file = File::open(path).map_err(|e| format!("Impossible d'ouvrir le fichier: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("Format audio non supporté (MP3/WAV): {e}"))?;

    let mut format = probed.format;
    let track = format
        .default_track()
        .or_else(|| {
            format
                .tracks()
                .iter()
                .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        })
        .ok_or_else(|| "Aucune piste audio trouvée dans le fichier".to_string())?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let fallback_sr = codec_params.sample_rate.unwrap_or(44_100);

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Initialisation décodeur impossible: {e}"))?;

    let mut left = Vec::new();
    let mut right = Vec::new();
    let mut sample_rate = 0_u32;

    loop {
        let packet = match format.next_packet() {
            Ok(pkt) => pkt,
            Err(SymphoniaError::IoError(err)) if err.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(err) => return Err(format!("Erreur lecture flux audio: {err}")),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                let ch_count = spec.channels.count().max(1);
                if sample_rate == 0 {
                    sample_rate = spec.rate;
                }
                let mut sbuf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
                sbuf.copy_interleaved_ref(decoded);
                let samples = sbuf.samples();
                for frame in samples.chunks_exact(ch_count) {
                    let l = frame[0];
                    let r = if ch_count > 1 { frame[1] } else { l };
                    left.push(l);
                    right.push(r);
                }
            }
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(err)) if err.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(err) => return Err(format!("Erreur décodage audio: {err}")),
        }
    }

    if left.is_empty() {
        return Err("Le fichier audio ne contient aucun échantillon exploitable".into());
    }
    if sample_rate == 0 {
        sample_rate = fallback_sr;
    }

    let title = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Piste audio")
        .to_string();

    Ok(DecodedAudioTrack {
        title,
        path: path.to_path_buf(),
        sample_rate,
        left,
        right,
    })
}
