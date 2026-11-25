# UMC1820 Studio Mixer (Rust + egui + CoreAudio / ALSA)

Console de mixage logicielle multi-plateforme (macOS & Linux) compatible **Behringer UMC1820** et **toute carte son CoreAudio / ALSA / JACK**.

## Architecture du Mixer
- **8 Tranches d'entrée (IN 1 à IN 8)** : Sélecteur d'entrée physique en haut de tranche (`In 1..N` mono, paires stéréo ou `Aucune/Synth`), Gain rotatif (-12 à +24 dB), 5 slots d'inserts (Apple AU / VST3 / VST2), **EQ 5 bandes** avec potentiomètre **Médiums (1 kHz) au milieu** (80 Hz, 400 Hz, 1 kHz, 2.5 kHz, 10 kHz), envois auxiliaires, Solo & Mute, Fader et VU-mètre Peak/RMS.
- **Bus Auxiliaires Stéréo ou Mono séparés** : 4 paires stéréo (`1/2`, `3/4`, `5/6`, `7/8`) commutables à la volée en **8 bus Mono indépendants** (par paire ou globalement), avec sélecteur de sortie physique (`Out 1..N`, `Out 1/2..`, `Vers Master` ou `Aucune`).
- **1 Tranche Master** : Sélecteur de sortie physique en haut de tranche, 5 inserts, EQ 5 bandes, Mute, Fader et VU-mètre stéréo (**sans Gain, sans Solo et sans envois Aux**).
- **Lecteur MP3 / WAV intégré** : Ouverture de fichiers `.mp3` / `.wav`, Play / Pause / Stop, barre de progression, boucle, niveau et routage vers Master ou une tranche d'entrée.
- **Sauvegarde & Chargement de Set (`.umcset`)** : Sauvegarde JSON complète des tranches, gains, EQ, routages I/O, modes Aux, lecteur et plugins + paramètres.

## Interfaces natives des plugins (GUI) & Synthétiseurs MIDI
- **Apple AudioUnit (macOS)** : détection système via `AudioComponentFindNext` (`aufx`, `aumf` & `aumu` instruments), interface Cocoa native (`kAudioUnitProperty_CocoaUI` ou `CoreAudioKit::AUGenericView`) et routage MIDI via `MusicDeviceMIDIEvent`.
- **VST3 (macOS & Linux)** : hébergement COM complet (`IComponent`, `IAudioProcessor`, `IEditController`, `IPlugView`, `IPlugFrame`) avec support MIDI (`IEventList` + `IMidiMapping`) et fenêtre native `NSView` / X11.
- **VST2 (macOS & Linux)** : hébergement C-ABI (`AEffect`, `effProcessEvents` MIDI, `effEditOpen` / `effEditIdle`) avec fenêtre graphique native.
- **Entrées MIDI temps réel (CoreMIDI / ALSA)** : sélection globale du port MIDI dans la barre supérieure et filtre par tranche (`OFF`, `OMNI`, `Canal 1–16`).

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
1. Installer les bibliothèques système requises :
   - **Ubuntu / Debian / Mint / Pop!_OS** :
     ```bash
     sudo apt update && sudo apt install -y build-essential pkg-config libasound2-dev libgtk-3-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev zenity
     ```
   - **Fedora / RHEL** :
     ```bash
     sudo dnf install -y gcc pkgconf-pkg-config alsa-lib-devel gtk3-devel zenity
     ```
   - **Arch / Manjaro** :
     ```bash
     sudo pacman -S --needed base-devel pkgconf alsa-lib gtk3 zenity
     ```
2. Compiler et lancer :
   ```bash
   cargo run --release
   ```
   <img width="1905" height="908" alt="2026-11-25_14-01" src="https://github.com/user-attachments/assets/dda757f0-bb63-4e79-baad-fde372be80c9" />
