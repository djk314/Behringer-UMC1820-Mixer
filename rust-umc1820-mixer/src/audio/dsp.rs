use super::state::{FiveBandEqParams, MeterFrame};
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
pub struct FiveBandEqProcessor {
    low: Biquad,
    low_mid: Biquad,
    mid: Biquad,
    high_mid: Biquad,
    high: Biquad,
    bypassed: bool,
}

impl FiveBandEqProcessor {
    pub fn update(&mut self, sample_rate: f32, params: FiveBandEqParams) {
        self.bypassed = params.bypassed;
        self.low.set_low_shelf(sample_rate, 80.0, params.low_db);
        self.low_mid.set_peaking(sample_rate, 400.0, 1.0, params.low_mid_db);
        self.mid.set_peaking(sample_rate, 1000.0, 1.0, params.mid_db);
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
        (l, r) = self.mid.process_stereo(l, r);
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
