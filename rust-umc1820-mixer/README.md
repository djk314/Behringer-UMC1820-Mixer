# UMC1820 Studio Mixer (Rust + egui + CoreAudio / ALSA)

Console de mixage logicielle multi-plateforme (macOS & Linux) conçue pour la **Behringer UMC1820** via le pilote **CoreAudio** (macOS) ou **ALSA / JACK / PipeWire** (Linux).

## Architecture du Mixer
- **8 Tranches d'entrée (IN 1 à IN 8)** : Gain rotatif (-12 à +24 dB), 5 slots d'inserts maximum (Apple AU / VST3 / VST2), EQ 4 bandes rotatif (80 Hz, 400 Hz, 2.5 kHz, 10 kHz), 4 envois auxiliaires rotatifs (1/2, 3/4, 5/6, 7/8), boutons Push Solo & Mute, Fader volume et VU-mètre Peak/RMS.
- **4 Tranches Auxiliaires Stéréo (Out 1/2, 3/4, 5/6, 7/8)** : routées directement vers les paires de sorties ligne de l'UMC1820 (sans gain d'entrée).
- **1 Tranche Master** : mêmes réglages (5 inserts, EQ 4 bandes, Mute, Fader, VU-mètre stéréo) **sans Gain, sans Solo et sans envois Aux**.

## Interfaces natives des plugins (GUI)
- **Apple AudioUnit (macOS)** : détection système via `AudioComponentFindNext` (`aufx` & `aumf`) et ouverture automatique de l'interface Cocoa native (`kAudioUnitProperty_CocoaUI`) dans une fenêtre `NSWindow`, avec repli sur `CoreAudioKit::AUGenericView`.
- **VST3 (macOS & Linux)** : hébergement COM complet (`IComponent`, `IAudioProcessor` stéréo & mono->stéréo, `IEditController`, `IPlugView`, `IPlugFrame`) attaché dans une `NSWindow` (`NSView`) sur macOS ou une fenêtre X11 (`X11EmbedWindowID` + `IRunLoop`) sur Linux (sous Wayland pur, activer XWayland).
- **VST2 (macOS & Linux)** : hébergement C-ABI (`AEffect`, `effEditOpen` / `effEditIdle`) avec ouverture automatique de la fenêtre graphique native (`NSWindow` / X11) en plus des curseurs de paramètres.

## Compilation sur macOS (CoreAudio + AU/VST3/VST2)
1. Installer ou mettre à jour Rust (**rustc >= 1.88 requis**) :
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   rustup update stable
   ```
2. Vérifier que les outils Xcode sont installés : `xcode-select --install`
3. Compiler et lancer :
   ```bash
   cargo run --release
   ```

## Compilation sur Linux (ALSA / PipeWire-JACK + VST3/VST2)
1. Installer les bibliothèques système requises (`alsa.pc` et `pkg-config` pour `alsa-sys`) :
   - **Ubuntu / Debian / Mint / Pop!_OS** :
     ```bash
     sudo apt update && sudo apt install -y build-essential pkg-config libasound2-dev libgtk-3-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev
     ```
   - **Fedora / RHEL** :
     ```bash
     sudo dnf install -y gcc pkgconf-pkg-config alsa-lib-devel gtk3-devel
     ```
   - **Arch / Manjaro** :
     ```bash
     sudo pacman -S --needed base-devel pkgconf alsa-lib gtk3
     ```
2. Compiler et lancer :
   ```bash
   cargo run --release
   ```

## Utilisation en parallèle de Bitwig Studio sur macOS
CoreAudio autorise plusieurs clients audio simultanés sur l'UMC1820, ou vous pouvez créer un périphérique virtuel **BlackHole 16ch** / **Périphérique agrégé** dans *Configuration audio et MIDI* pour chaîner les sorties du Mixer vers Bitwig Studio.
