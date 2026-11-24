use egui::{Color32, Pos2, Rect, Response, Sense, Stroke, Ui, Vec2};
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
