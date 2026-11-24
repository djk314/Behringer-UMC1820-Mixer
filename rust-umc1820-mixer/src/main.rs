mod audio;
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
