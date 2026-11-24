use super::state::{
    DiscoveredPlugin, NativePluginHandle, PluginFormat, PluginParamDesc, MAX_INSERTS_PER_STRIP,
};
use super::vst3_abi::{
    utf16_to_string, AudioBusBuffers, BusInfo, ComObj, HostApplication, HostBStream,
    HostComponentHandler, HostParameterChanges, IAudioProcessorVtbl, IComponentVtbl,
    IConnectionPointVtbl, IEditControllerVtbl, IPluginFactoryVtbl, PClassInfo, ParameterInfo,
    ProcessData, ProcessSetup, IID_IAUDIO_PROCESSOR, IID_ICOMPONENT, IID_ICONNECTION_POINT,
    IID_IEDIT_CONTROLLER, K_DIR_INPUT, K_DIR_OUTPUT, K_MEDIA_AUDIO, K_REALTIME, K_RESULT_OK,
    K_SAMPLE_32, K_SPEAKER_MONO, K_SPEAKER_STEREO,
};
use libloading::Library;
use std::ffi::{c_void, CStr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// Interface unifiée exécutée dans le thread audio pour chaque insert (VST2, VST3, AudioUnit).
pub trait HostedPlugin: Send {
    fn name(&self) -> &str;
    fn format(&self) -> PluginFormat;
    fn prepare(&mut self, sample_rate: f32, max_block_size: usize);
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]);
    fn set_bypassed(&mut self, bypassed: bool);
    fn parameters(&self) -> Vec<PluginParamDesc>;
    fn set_parameter(&mut self, param_id: u32, value: f32);
    fn native_handle(&self) -> Option<NativePluginHandle> {
        None
    }
}

/// Chaîne de 5 inserts maximum par tranche.
pub struct StripInsertRack {
    pub slots: [Option<Box<dyn HostedPlugin>>; MAX_INSERTS_PER_STRIP],
    pub bypassed: [bool; MAX_INSERTS_PER_STRIP],
}

impl Default for StripInsertRack {
    fn default() -> Self {
        Self {
            slots: std::array::from_fn(|_| None),
            bypassed: [false; MAX_INSERTS_PER_STRIP],
        }
    }
}

impl StripInsertRack {
    pub fn set_bypass(&mut self, slot: usize, bypassed: bool) {
        self.bypassed[slot] = bypassed;
        if let Some(plugin) = self.slots[slot].as_mut() {
            plugin.set_bypassed(bypassed);
        }
    }

    pub fn set_parameter(&mut self, slot: usize, param_id: u32, value: f32) {
        if let Some(plugin) = self.slots[slot].as_mut() {
            plugin.set_parameter(param_id, value);
        }
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        for i in 0..MAX_INSERTS_PER_STRIP {
            if self.bypassed[i] {
                continue;
            }
            if let Some(plugin) = self.slots[i].as_mut() {
                plugin.process_stereo(left, right);
            }
        }
    }
}

/// Scanner de plugins compatible macOS (AU + VST3 + VST2) et Linux (VST3 + VST2).
pub fn scan_system_plugins() -> Vec<DiscoveredPlugin> {
    let mut found = Vec::new();

    #[cfg(target_os = "macos")]
    {
        scan_macos_audiounits(&mut found);

        let home = std::env::var("HOME").unwrap_or_default();
        let vst3_dirs = [
            PathBuf::from("/Library/Audio/Plug-Ins/VST3"),
            PathBuf::from(format!("{home}/Library/Audio/Plug-Ins/VST3")),
        ];
        let vst2_dirs = [
            PathBuf::from("/Library/Audio/Plug-Ins/VST"),
            PathBuf::from(format!("{home}/Library/Audio/Plug-Ins/VST")),
        ];

        scan_bundle_dir(&vst3_dirs, "vst3", PluginFormat::Vst3, &mut found);
        scan_bundle_dir(&vst2_dirs, "vst", PluginFormat::Vst2, &mut found);
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let vst3_dirs = [
            PathBuf::from("/usr/lib/vst3"),
            PathBuf::from("/usr/local/lib/vst3"),
            PathBuf::from(format!("{home}/.vst3")),
        ];
        let vst2_dirs = [
            PathBuf::from("/usr/lib/vst"),
            PathBuf::from("/usr/lib/lxvst"),
            PathBuf::from(format!("{home}/.vst")),
        ];

        scan_bundle_dir(&vst3_dirs, "vst3", PluginFormat::Vst3, &mut found);
        scan_bundle_dir(&vst2_dirs, "so", PluginFormat::Vst2, &mut found);
    }

    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

#[cfg(target_os = "macos")]
fn fourcc_string(code: u32) -> String {
    let bytes = code.to_be_bytes();
    bytes
        .iter()
        .map(|&b| if b.is_ascii_graphic() { b as char } else { '?' })
        .collect()
}

#[cfg(target_os = "macos")]
fn scan_macos_audiounits(out: &mut Vec<DiscoveredPlugin>) {
    use coreaudio_sys::*;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    let mut seen_codes: Vec<[u32; 3]> = Vec::new();
    let types = [u32::from_be_bytes(*b"aufx"), u32::from_be_bytes(*b"aumf")];

    unsafe {
        for comp_type in types {
            let search = AudioComponentDescription {
                componentType: comp_type,
                componentSubType: 0,
                componentManufacturer: 0,
                componentFlags: 0,
                componentFlagsMask: 0,
            };
            let mut comp = AudioComponentFindNext(std::ptr::null_mut(), &search);
            while !comp.is_null() {
                let mut desc: AudioComponentDescription = std::mem::zeroed();
                if AudioComponentGetDescription(comp, &mut desc) == 0 {
                    let codes = [
                        desc.componentType,
                        desc.componentSubType,
                        desc.componentManufacturer,
                    ];
                    if !seen_codes.contains(&codes) {
                        seen_codes.push(codes);
                        let mut full_name = String::new();
                        let mut cf_name: CFStringRef = std::ptr::null();
                        if AudioComponentCopyName(comp, &mut cf_name) == 0 && !cf_name.is_null() {
                            let mut buf = [0 as std::ffi::c_char; 256];
                            if CFStringGetCString(
                                cf_name,
                                buf.as_mut_ptr(),
                                buf.len() as CFIndex,
                                K_CF_STRING_ENCODING_UTF8,
                            ) != 0
                            {
                                full_name = CStr::from_ptr(buf.as_ptr())
                                    .to_string_lossy()
                                    .trim()
                                    .to_string();
                            }
                            CFRelease(cf_name as *const c_void);
                        }
                        let (vendor, name) = if let Some((v, n)) = full_name.split_once(": ") {
                            (v.trim().to_string(), n.trim().to_string())
                        } else if !full_name.is_empty() {
                            (fourcc_string(codes[2]), full_name)
                        } else {
                            (
                                fourcc_string(codes[2]),
                                format!("AudioUnit {}", fourcc_string(codes[1])),
                            )
                        };
                        out.push(DiscoveredPlugin {
                            name,
                            vendor,
                            format: PluginFormat::AudioUnit,
                            path: PathBuf::from(format!(
                                "AudioUnit [{}/{}/{}]",
                                fourcc_string(codes[0]),
                                fourcc_string(codes[1]),
                                fourcc_string(codes[2]),
                            )),
                            au_component_code: Some(codes),
                        });
                    }
                }
                comp = AudioComponentFindNext(comp, &search);
            }
        }
    }
}

fn scan_bundle_dir(
    dirs: &[PathBuf],
    ext: &str,
    format: PluginFormat,
    out: &mut Vec<DiscoveredPlugin>,
) {
    for dir in dirs {
        scan_dir_recursive(dir, ext, format, 0, out);
    }
}

fn scan_dir_recursive(
    dir: &Path,
    ext: &str,
    format: PluginFormat,
    depth: usize,
    out: &mut Vec<DiscoveredPlugin>,
) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some(ext) {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown Plugin")
                .to_string();
            out.push(DiscoveredPlugin {
                name,
                vendor: match format {
                    PluginFormat::AudioUnit => "Apple AudioUnit".into(),
                    PluginFormat::Vst3 => "VST3".into(),
                    PluginFormat::Vst2 => "VST2".into(),
                },
                format,
                path,
                au_component_code: None,
            });
        } else if path.is_dir() {
            scan_dir_recursive(&path, ext, format, depth + 1, out);
        }
    }
}

/// Charge dynamiquement un plugin VST3 (.vst3), VST2 (.vst/.so) ou AudioUnit (.component).
pub fn instantiate_plugin(desc: &DiscoveredPlugin) -> Result<Box<dyn HostedPlugin>, String> {
    match desc.format {
        PluginFormat::Vst3 => Vst3PluginInstance::load(&desc.name, &desc.path)
            .map(|p| Box::new(p) as Box<dyn HostedPlugin>),
        PluginFormat::Vst2 => Vst2PluginInstance::load(&desc.name, &desc.path)
            .map(|p| Box::new(p) as Box<dyn HostedPlugin>),
        PluginFormat::AudioUnit => {
            #[cfg(target_os = "macos")]
            {
                AudioUnitInstance::load(desc).map(|p| Box::new(p) as Box<dyn HostedPlugin>)
            }
            #[cfg(not(target_os = "macos"))]
            {
                Err("Apple AudioUnit est uniquement disponible sur macOS CoreAudio.".into())
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(
        allocator: *const c_void,
        buffer: *const u8,
        buf_len: isize,
        is_directory: u8,
    ) -> *const c_void;
    fn CFBundleCreate(allocator: *const c_void, bundle_url: *const c_void) -> *mut c_void;
    fn CFRelease(cf: *const c_void);
}

enum Vst3ModuleHandle {
    #[cfg(target_os = "macos")]
    MacOs {
        lib: Library,
        cf_bundle: *mut c_void,
    },
    #[cfg(target_os = "linux")]
    Linux {
        raw_handle: *mut c_void,
    },
}

impl Vst3ModuleHandle {
    unsafe fn open(bundle_path: &Path, binary_path: &Path) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        {
            let lib = Library::new(binary_path)
                .map_err(|e| format!("Erreur chargement VST3 {}: {e}", binary_path.display()))?;
            let path_bytes = bundle_path.to_string_lossy().into_owned().into_bytes();
            let cf_url = CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                path_bytes.as_ptr(),
                path_bytes.len() as isize,
                1,
            );
            let cf_bundle = if !cf_url.is_null() {
                let b = CFBundleCreate(std::ptr::null(), cf_url);
                CFRelease(cf_url);
                b
            } else {
                std::ptr::null_mut()
            };
            if let Ok(entry) = lib.get::<unsafe extern "C" fn(*mut c_void) -> bool>(b"bundleEntry") {
                if !entry(cf_bundle) {
                    if !cf_bundle.is_null() {
                        CFRelease(cf_bundle);
                    }
                    return Err("Échec bundleEntry() sur le bundle VST3 macOS".into());
                }
            }
            Ok(Self::MacOs { lib, cf_bundle })
        }

        #[cfg(target_os = "linux")]
        {
            let _ = bundle_path;
            let c_path = std::ffi::CString::new(binary_path.to_string_lossy().as_bytes())
                .map_err(|_| "Chemin binaire VST3 invalide".to_string())?;
            let raw_handle = libc::dlopen(c_path.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
            if raw_handle.is_null() {
                return Err(format!("dlopen impossible sur {}", binary_path.display()));
            }
            let sym_entry = libc::dlsym(raw_handle, b"ModuleEntry\0".as_ptr() as *const std::ffi::c_char);
            if !sym_entry.is_null() {
                let entry: unsafe extern "C" fn(*mut c_void) -> bool = std::mem::transmute(sym_entry);
                if !entry(raw_handle) {
                    libc::dlclose(raw_handle);
                    return Err("Échec ModuleEntry() sur le plugin VST3 Linux".into());
                }
            }
            Ok(Self::Linux { raw_handle })
        }
    }

    unsafe fn get_factory(&self) -> Result<*mut ComObj<IPluginFactoryVtbl>, String> {
        type GetPluginFactoryFn = unsafe extern "C" fn() -> *mut ComObj<IPluginFactoryVtbl>;
        match self {
            #[cfg(target_os = "macos")]
            Self::MacOs { lib, .. } => {
                let sym: libloading::Symbol<GetPluginFactoryFn> = lib
                    .get(b"GetPluginFactory")
                    .map_err(|e| format!("Symbole GetPluginFactory absent: {e}"))?;
                let factory = sym();
                if factory.is_null() {
                    Err("GetPluginFactory() a retourné un pointeur nul".into())
                } else {
                    Ok(factory)
                }
            }
            #[cfg(target_os = "linux")]
            Self::Linux { raw_handle } => {
                let sym = libc::dlsym(*raw_handle, b"GetPluginFactory\0".as_ptr() as *const std::ffi::c_char);
                if sym.is_null() {
                    return Err("Symbole GetPluginFactory absent".into());
                }
                let f: GetPluginFactoryFn = std::mem::transmute(sym);
                let factory = f();
                if factory.is_null() {
                    Err("GetPluginFactory() a retourné un pointeur nul".into())
                } else {
                    Ok(factory)
                }
            }
        }
    }

    unsafe fn exit_hook(&mut self) {
        match self {
            #[cfg(target_os = "macos")]
            Self::MacOs { lib, cf_bundle } => {
                if let Ok(exit_fn) = lib.get::<unsafe extern "C" fn() -> bool>(b"bundleExit") {
                    let _ = exit_fn();
                }
                if !cf_bundle.is_null() {
                    CFRelease(*cf_bundle);
                    *cf_bundle = std::ptr::null_mut();
                }
            }
            #[cfg(target_os = "linux")]
            Self::Linux { raw_handle } => {
                if !raw_handle.is_null() {
                    let sym_exit = libc::dlsym(*raw_handle, b"ModuleExit\0".as_ptr() as *const std::ffi::c_char);
                    if !sym_exit.is_null() {
                        let exit_fn: unsafe extern "C" fn() -> bool = std::mem::transmute(sym_exit);
                        let _ = exit_fn();
                    }
                    libc::dlclose(*raw_handle);
                    *raw_handle = std::ptr::null_mut();
                }
            }
        }
    }
}

/// Hôte VST3 COM complet : DSP temps réel + paramètres + contrôleur GUI natif (`IPlugView`).
pub struct Vst3PluginInstance {
    name: String,
    module: Vst3ModuleHandle,
    host_app: *mut HostApplication,
    comp_handler: *mut HostComponentHandler,
    factory: *mut ComObj<IPluginFactoryVtbl>,
    comp: *mut ComObj<IComponentVtbl>,
    proc: *mut ComObj<IAudioProcessorVtbl>,
    ctrl: *mut ComObj<IEditControllerVtbl>,
    ctrl_is_separate: bool,
    comp_cp: *mut ComObj<IConnectionPointVtbl>,
    ctrl_cp: *mut ComObj<IConnectionPointVtbl>,
    pending_edits: Arc<Mutex<Vec<(u32, f64)>>>,
    param_changes: HostParameterChanges,
    in_left: Vec<f32>,
    in_right: Vec<f32>,
    out_left: Vec<f32>,
    out_right: Vec<f32>,
    in_channels: usize,
    out_channels: usize,
    has_input_bus: bool,
    bypassed: bool,
    params: Vec<PluginParamDesc>,
}

// SAFETY: La durée de vie COM est possédée par le thread audio ; les vues UI sont fermées avant tout déchargement.
unsafe impl Send for Vst3PluginInstance {}

impl Vst3PluginInstance {
    pub fn load(name: &str, bundle_path: &Path) -> Result<Self, String> {
        let binary_path = resolve_vst3_binary(bundle_path)?;
        unsafe {
            let mut module = Vst3ModuleHandle::open(bundle_path, &binary_path)?;
            let factory = match module.get_factory() {
                Ok(f) => f,
                Err(e) => {
                    module.exit_hook();
                    return Err(e);
                }
            };

            let host_app = HostApplication::new_raw();
            let pending_edits = Arc::new(Mutex::new(Vec::new()));
            let comp_handler = HostComponentHandler::new_raw(Arc::clone(&pending_edits));

            let count = ((*(*factory).vtbl).count_classes)(factory as *mut c_void);
            let mut audio_cid: Option<[u8; 16]> = None;
            for idx in 0..count {
                let mut info: PClassInfo = std::mem::zeroed();
                if ((*(*factory).vtbl).get_class_info)(factory as *mut c_void, idx, &mut info) == K_RESULT_OK {
                    let cat = CStr::from_ptr(info.category.as_ptr()).to_string_lossy();
                    if cat.starts_with("Audio Module Class") {
                        audio_cid = Some(info.cid);
                        break;
                    }
                }
            }
            let Some(cid) = audio_cid else {
                ((*(*factory).vtbl).base.release)(factory as *mut c_void);
                module.exit_hook();
                return Err("Aucune classe 'Audio Module Class' dans le plugin VST3".into());
            };

            let mut comp_void: *mut c_void = std::ptr::null_mut();
            let res = ((*(*factory).vtbl).create_instance)(
                factory as *mut c_void,
                cid.as_ptr(),
                IID_ICOMPONENT.as_ptr(),
                &mut comp_void,
            );
            if res != K_RESULT_OK || comp_void.is_null() {
                ((*(*factory).vtbl).base.release)(factory as *mut c_void);
                module.exit_hook();
                return Err("Échec createInstance(IComponent) sur ce VST3".into());
            }
            let comp = comp_void as *mut ComObj<IComponentVtbl>;
            let init_res = ((*(*comp).vtbl).initialize)(comp as *mut c_void, host_app as *mut c_void);
            if init_res != K_RESULT_OK {
                ((*(*comp).vtbl).base.release)(comp as *mut c_void);
                ((*(*factory).vtbl).base.release)(factory as *mut c_void);
                module.exit_hook();
                return Err(format!("IComponent::initialize a échoué (code {init_res})"));
            }

            let mut proc_void: *mut c_void = std::ptr::null_mut();
            let _ = ((*(*comp).vtbl).base.query_interface)(
                comp as *mut c_void,
                IID_IAUDIO_PROCESSOR.as_ptr(),
                &mut proc_void,
            );
            if proc_void.is_null() {
                ((*(*comp).vtbl).terminate)(comp as *mut c_void);
                ((*(*comp).vtbl).base.release)(comp as *mut c_void);
                ((*(*factory).vtbl).base.release)(factory as *mut c_void);
                module.exit_hook();
                return Err("IAudioProcessor indisponible sur ce VST3".into());
            }
            let proc = proc_void as *mut ComObj<IAudioProcessorVtbl>;

            // Obtention de IEditController (composant unique ou contrôleur séparé)
            let mut ctrl_void: *mut c_void = std::ptr::null_mut();
            let mut ctrl_is_separate = false;
            if ((*(*comp).vtbl).base.query_interface)(
                comp as *mut c_void,
                IID_IEDIT_CONTROLLER.as_ptr(),
                &mut ctrl_void,
            ) != K_RESULT_OK
                || ctrl_void.is_null()
            {
                let mut ctrl_cid = [0_u8; 16];
                if ((*(*comp).vtbl).get_controller_class_id)(comp as *mut c_void, &mut ctrl_cid) == K_RESULT_OK {
                    if ((*(*factory).vtbl).create_instance)(
                        factory as *mut c_void,
                        ctrl_cid.as_ptr(),
                        IID_IEDIT_CONTROLLER.as_ptr(),
                        &mut ctrl_void,
                    ) == K_RESULT_OK
                        && !ctrl_void.is_null()
                    {
                        let ctrl = ctrl_void as *mut ComObj<IEditControllerVtbl>;
                        let _ = ((*(*ctrl).vtbl).initialize)(ctrl as *mut c_void, host_app as *mut c_void);
                        ctrl_is_separate = true;
                    }
                }
            }
            let ctrl = ctrl_void as *mut ComObj<IEditControllerVtbl>;

            let mut comp_cp: *mut ComObj<IConnectionPointVtbl> = std::ptr::null_mut();
            let mut ctrl_cp: *mut ComObj<IConnectionPointVtbl> = std::ptr::null_mut();
            if !ctrl.is_null() {
                let _ = ((*(*ctrl).vtbl).set_component_handler)(
                    ctrl as *mut c_void,
                    comp_handler as *mut c_void,
                );
                if ctrl_is_separate {
                    let mut p1: *mut c_void = std::ptr::null_mut();
                    let mut p2: *mut c_void = std::ptr::null_mut();
                    let _ = ((*(*comp).vtbl).base.query_interface)(
                        comp as *mut c_void,
                        IID_ICONNECTION_POINT.as_ptr(),
                        &mut p1,
                    );
                    let _ = ((*(*ctrl).vtbl).base.query_interface)(
                        ctrl as *mut c_void,
                        IID_ICONNECTION_POINT.as_ptr(),
                        &mut p2,
                    );
                    if !p1.is_null() && !p2.is_null() {
                        comp_cp = p1 as *mut ComObj<IConnectionPointVtbl>;
                        ctrl_cp = p2 as *mut ComObj<IConnectionPointVtbl>;
                        let _ = ((*(*comp_cp).vtbl).connect)(comp_cp as *mut c_void, ctrl_cp as *mut c_void);
                        let _ = ((*(*ctrl_cp).vtbl).connect)(ctrl_cp as *mut c_void, comp_cp as *mut c_void);
                    }
                    let stream = HostBStream::new_raw();
                    if ((*(*comp).vtbl).get_state)(comp as *mut c_void, stream as *mut c_void) == K_RESULT_OK {
                        let _ = ((*(*stream).vtbl).seek)(stream as *mut c_void, 0, 0, std::ptr::null_mut());
                        let _ = ((*(*ctrl).vtbl).set_component_state)(ctrl as *mut c_void, stream as *mut c_void);
                    }
                    ((*(*stream).vtbl).base.release)(stream as *mut c_void);
                }
            }

            // Activation des bus audio principaux
            let in_buses = ((*(*comp).vtbl).get_bus_count)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_INPUT);
            for b in 0..in_buses {
                let mut bi: BusInfo = std::mem::zeroed();
                if ((*(*comp).vtbl).get_bus_info)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_INPUT, b, &mut bi) == K_RESULT_OK {
                    let _ = ((*(*comp).vtbl).activate_bus)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_INPUT, b, u8::from(b == 0));
                }
            }
            let out_buses = ((*(*comp).vtbl).get_bus_count)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_OUTPUT);
            for b in 0..out_buses {
                let mut bi: BusInfo = std::mem::zeroed();
                if ((*(*comp).vtbl).get_bus_info)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_OUTPUT, b, &mut bi) == K_RESULT_OK {
                    let _ = ((*(*comp).vtbl).activate_bus)(comp as *mut c_void, K_MEDIA_AUDIO, K_DIR_OUTPUT, b, u8::from(b == 0));
                }
            }

            let mut in_arr = K_SPEAKER_STEREO;
            let mut out_arr = K_SPEAKER_STEREO;
            if ((*(*proc).vtbl).set_bus_arrangements)(proc as *mut c_void, &mut in_arr, 1, &mut out_arr, 1)
                != K_RESULT_OK
            {
                in_arr = K_SPEAKER_MONO;
                out_arr = K_SPEAKER_STEREO;
                let _ = ((*(*proc).vtbl).set_bus_arrangements)(
                    proc as *mut c_void,
                    &mut in_arr,
                    1,
                    &mut out_arr,
                    1,
                );
            }

            let mut actual_in_ch = if in_arr == K_SPEAKER_MONO { 1 } else { 2 };
            if in_buses > 0 {
                let mut bi: BusInfo = std::mem::zeroed();
                if ((*(*comp).vtbl).get_bus_info)(
                    comp as *mut c_void,
                    K_MEDIA_AUDIO,
                    K_DIR_INPUT,
                    0,
                    &mut bi,
                ) == K_RESULT_OK
                    && (bi.channel_count == 1 || bi.channel_count == 2)
                {
                    actual_in_ch = bi.channel_count as usize;
                }
            }
            let mut actual_out_ch = if out_arr == K_SPEAKER_MONO { 1 } else { 2 };
            if out_buses > 0 {
                let mut bi: BusInfo = std::mem::zeroed();
                if ((*(*comp).vtbl).get_bus_info)(
                    comp as *mut c_void,
                    K_MEDIA_AUDIO,
                    K_DIR_OUTPUT,
                    0,
                    &mut bi,
                ) == K_RESULT_OK
                    && (bi.channel_count == 1 || bi.channel_count == 2)
                {
                    actual_out_ch = bi.channel_count as usize;
                }
            }

            let mut setup = ProcessSetup {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                max_samples_per_block: 2048,
                sample_rate: 48000.0,
            };
            let _ = ((*(*proc).vtbl).setup_processing)(proc as *mut c_void, &mut setup);
            let _ = ((*(*comp).vtbl).set_active)(comp as *mut c_void, 1);
            let _ = ((*(*proc).vtbl).set_processing)(proc as *mut c_void, 1);

            // Lecture des paramètres réels depuis IEditController
            let mut params = Vec::new();
            if !ctrl.is_null() {
                let p_count = ((*(*ctrl).vtbl).get_parameter_count)(ctrl as *mut c_void).clamp(0, 128);
                for i in 0..p_count {
                    let mut pinfo: ParameterInfo = std::mem::zeroed();
                    if ((*(*ctrl).vtbl).get_parameter_info)(ctrl as *mut c_void, i, &mut pinfo) == K_RESULT_OK {
                        let pname = utf16_to_string(&pinfo.title);
                        let punit = utf16_to_string(&pinfo.units);
                        let min_plain = ((*(*ctrl).vtbl).normalized_param_to_plain)(ctrl as *mut c_void, pinfo.id, 0.0) as f32;
                        let max_plain = ((*(*ctrl).vtbl).normalized_param_to_plain)(ctrl as *mut c_void, pinfo.id, 1.0) as f32;
                        let cur_norm = ((*(*ctrl).vtbl).get_param_normalized)(ctrl as *mut c_void, pinfo.id);
                        let (min, max, def_v, cur_v) = if min_plain.is_finite()
                            && max_plain.is_finite()
                            && (max_plain - min_plain).abs() > 1e-4
                        {
                            let lo = min_plain.min(max_plain);
                            let hi = min_plain.max(max_plain);
                            let d = ((*(*ctrl).vtbl).normalized_param_to_plain)(
                                ctrl as *mut c_void,
                                pinfo.id,
                                pinfo.default_normalized_value,
                            ) as f32;
                            let c = ((*(*ctrl).vtbl).normalized_param_to_plain)(ctrl as *mut c_void, pinfo.id, cur_norm) as f32;
                            (lo, hi, d.clamp(lo, hi), c.clamp(lo, hi))
                        } else {
                            (
                                0.0_f32,
                                1.0_f32,
                                (pinfo.default_normalized_value as f32).clamp(0.0, 1.0),
                                (cur_norm as f32).clamp(0.0, 1.0),
                            )
                        };
                        params.push(PluginParamDesc {
                            id: pinfo.id,
                            name: if pname.is_empty() { format!("Param {}", pinfo.id) } else { pname },
                            unit: punit,
                            min,
                            max,
                            default: def_v,
                            value: cur_v,
                        });
                    }
                }
            }

            Ok(Self {
                name: name.to_string(),
                module,
                host_app,
                comp_handler,
                factory,
                comp,
                proc,
                ctrl,
                ctrl_is_separate,
                comp_cp,
                ctrl_cp,
                pending_edits,
                param_changes: HostParameterChanges::new(),
                in_left: vec![0.0_f32; 2048],
                in_right: vec![0.0_f32; 2048],
                out_left: vec![0.0_f32; 2048],
                out_right: vec![0.0_f32; 2048],
                in_channels: actual_in_ch,
                out_channels: actual_out_ch,
                has_input_bus: in_buses > 0,
                bypassed: false,
                params,
            })
        }
    }
}

impl Drop for Vst3PluginInstance {
    fn drop(&mut self) {
        unsafe {
            if !self.proc.is_null() {
                let _ = ((*(*self.proc).vtbl).set_processing)(self.proc as *mut c_void, 0);
            }
            if !self.comp.is_null() {
                let _ = ((*(*self.comp).vtbl).set_active)(self.comp as *mut c_void, 0);
            }
            if !self.comp_cp.is_null() && !self.ctrl_cp.is_null() {
                let _ = ((*(*self.comp_cp).vtbl).disconnect)(self.comp_cp as *mut c_void, self.ctrl_cp as *mut c_void);
                let _ = ((*(*self.ctrl_cp).vtbl).disconnect)(self.ctrl_cp as *mut c_void, self.comp_cp as *mut c_void);
            }
            if !self.comp_cp.is_null() {
                ((*(*self.comp_cp).vtbl).base.release)(self.comp_cp as *mut c_void);
            }
            if !self.ctrl_cp.is_null() {
                ((*(*self.ctrl_cp).vtbl).base.release)(self.ctrl_cp as *mut c_void);
            }
            if !self.ctrl.is_null() {
                let _ = ((*(*self.ctrl).vtbl).set_component_handler)(self.ctrl as *mut c_void, std::ptr::null_mut());
                if self.ctrl_is_separate {
                    let _ = ((*(*self.ctrl).vtbl).terminate)(self.ctrl as *mut c_void);
                }
                ((*(*self.ctrl).vtbl).base.release)(self.ctrl as *mut c_void);
            }
            if !self.proc.is_null() {
                ((*(*self.proc).vtbl).base.release)(self.proc as *mut c_void);
            }
            if !self.comp.is_null() {
                let _ = ((*(*self.comp).vtbl).terminate)(self.comp as *mut c_void);
                ((*(*self.comp).vtbl).base.release)(self.comp as *mut c_void);
            }
            if !self.factory.is_null() {
                ((*(*self.factory).vtbl).base.release)(self.factory as *mut c_void);
            }
            if !self.comp_handler.is_null() {
                ((*(*self.comp_handler).vtbl).base.release)(self.comp_handler as *mut c_void);
            }
            if !self.host_app.is_null() {
                ((*(*self.host_app).vtbl).base.release)(self.host_app as *mut c_void);
            }
            self.module.exit_hook();
        }
    }
}

impl HostedPlugin for Vst3PluginInstance {
    fn name(&self) -> &str {
        &self.name
    }
    fn format(&self) -> PluginFormat {
        PluginFormat::Vst3
    }
    fn native_handle(&self) -> Option<NativePluginHandle> {
        if self.ctrl.is_null() {
            None
        } else {
            Some(NativePluginHandle::Vst3 {
                controller_ptr: self.ctrl as usize,
                title: self.name.clone(),
            })
        }
    }
    fn prepare(&mut self, sample_rate: f32, max_block_size: usize) {
        let block = max_block_size.clamp(64, 2048);
        unsafe {
            let _ = ((*(*self.proc).vtbl).set_processing)(self.proc as *mut c_void, 0);
            let _ = ((*(*self.comp).vtbl).set_active)(self.comp as *mut c_void, 0);
            let mut setup = ProcessSetup {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                max_samples_per_block: block as i32,
                sample_rate: f64::from(sample_rate),
            };
            let _ = ((*(*self.proc).vtbl).setup_processing)(self.proc as *mut c_void, &mut setup);
            let _ = ((*(*self.comp).vtbl).set_active)(self.comp as *mut c_void, 1);
            let _ = ((*(*self.proc).vtbl).set_processing)(self.proc as *mut c_void, 1);
        }
    }
    fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
    fn parameters(&self) -> Vec<PluginParamDesc> {
        self.params.clone()
    }
    fn set_parameter(&mut self, param_id: u32, value: f32) {
        if let Some(p) = self.params.iter_mut().find(|p| p.id == param_id) {
            p.value = value.clamp(p.min, p.max);
            let span = (p.max - p.min).max(1e-6);
            let norm = f64::from(((p.value - p.min) / span).clamp(0.0, 1.0));
            if let Ok(mut q) = self.pending_edits.lock() {
                q.push((param_id, norm));
            }
        }
    }
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.proc.is_null() {
            return;
        }
        let frames = left.len().min(right.len()).min(2048);
        if frames == 0 {
            return;
        }

        self.param_changes.clear();
        if let Ok(mut q) = self.pending_edits.try_lock() {
            for (id, norm) in q.drain(..) {
                self.param_changes.push(id, norm);
            }
        }

        if self.in_channels == 1 {
            for i in 0..frames {
                self.in_left[i] = 0.5 * (left[i] + right[i]);
            }
        } else {
            self.in_left[..frames].copy_from_slice(&left[..frames]);
            self.in_right[..frames].copy_from_slice(&right[..frames]);
        }
        self.out_left[..frames].fill(0.0);
        self.out_right[..frames].fill(0.0);

        let mut in_ptrs = [self.in_left.as_mut_ptr(), self.in_right.as_mut_ptr()];
        let mut out_ptrs = [self.out_left.as_mut_ptr(), self.out_right.as_mut_ptr()];

        let mut in_bus = AudioBusBuffers {
            num_channels: self.in_channels as i32,
            silence_flags: 0,
            channel_buffers32: in_ptrs.as_mut_ptr(),
        };
        let mut out_bus = AudioBusBuffers {
            num_channels: self.out_channels as i32,
            silence_flags: 0,
            channel_buffers32: out_ptrs.as_mut_ptr(),
        };
        let mut data = ProcessData {
            process_mode: K_REALTIME,
            symbolic_sample_size: K_SAMPLE_32,
            num_samples: frames as i32,
            num_inputs: i32::from(self.has_input_bus),
            num_outputs: 1,
            inputs: if self.has_input_bus { &mut in_bus } else { std::ptr::null_mut() },
            outputs: &mut out_bus,
            input_parameter_changes: &mut self.param_changes as *mut HostParameterChanges as *mut c_void,
            output_parameter_changes: std::ptr::null_mut(),
            input_events: std::ptr::null_mut(),
            output_events: std::ptr::null_mut(),
            process_context: std::ptr::null_mut(),
        };

        let status = unsafe { ((*(*self.proc).vtbl).process)(self.proc as *mut c_void, &mut data) };
        if status == K_RESULT_OK {
            left[..frames].copy_from_slice(&self.out_left[..frames]);
            if self.out_channels == 1 {
                right[..frames].copy_from_slice(&self.out_left[..frames]);
            } else {
                right[..frames].copy_from_slice(&self.out_right[..frames]);
            }
        }
    }
}

const VST2_MAGIC: i32 = 0x5673_7450; // 'VstP'
const VST2_EFF_OPEN: i32 = 0;
const VST2_EFF_CLOSE: i32 = 1;
const VST2_EFF_GET_PARAM_LABEL: i32 = 6;
const VST2_EFF_GET_PARAM_NAME: i32 = 8;
const VST2_EFF_SET_SAMPLE_RATE: i32 = 10;
const VST2_EFF_SET_BLOCK_SIZE: i32 = 11;
const VST2_EFF_MAINS_CHANGED: i32 = 12;
pub const VST2_EFF_EDIT_GET_RECT: i32 = 13;
pub const VST2_EFF_EDIT_OPEN: i32 = 14;
pub const VST2_EFF_EDIT_CLOSE: i32 = 15;
pub const VST2_EFF_EDIT_IDLE: i32 = 19;
const VST2_FLAGS_HAS_EDITOR: i32 = 1 << 0;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Vst2Rect {
    pub top: i16,
    pub left: i16,
    pub bottom: i16,
    pub right: i16,
}

#[repr(C)]
pub struct AEffect {
    pub magic: i32,
    pub dispatcher: unsafe extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize,
    pub process: unsafe extern "C" fn(*mut AEffect, *mut *mut f32, *mut *mut f32, i32),
    pub set_parameter: unsafe extern "C" fn(*mut AEffect, i32, f32),
    pub get_parameter: unsafe extern "C" fn(*mut AEffect, i32) -> f32,
    pub num_programs: i32,
    pub num_params: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub flags: i32,
    pub resvd1: isize,
    pub resvd2: isize,
    pub initial_delay: i32,
    pub real_qualities: i32,
    pub off_qualities: i32,
    pub io_ratio: f32,
    pub object: *mut c_void,
    pub user: *mut c_void,
    pub unique_id: i32,
    pub version: i32,
    pub process_replacing: unsafe extern "C" fn(*mut AEffect, *mut *mut f32, *mut *mut f32, i32),
    pub process_double_replacing: unsafe extern "C" fn(*mut AEffect, *mut *mut f64, *mut *mut f64, i32),
    pub future: [u8; 56],
}

type Vst2AudioMasterCb =
    unsafe extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize;
type Vst2MainFn = unsafe extern "C" fn(Vst2AudioMasterCb) -> *mut AEffect;

struct Vst2HostState {
    sample_rate: f32,
    block_size: i32,
    pending_resize: Option<(i32, i32)>,
}

static VST2_HOST_STATES: OnceLock<Mutex<Vec<(usize, Vst2HostState)>>> = OnceLock::new();

fn vst2_states() -> &'static Mutex<Vec<(usize, Vst2HostState)>> {
    VST2_HOST_STATES.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn vst2_take_pending_resize(effect_ptr: usize) -> Option<(i32, i32)> {
    let mut guard = vst2_states().lock().ok()?;
    guard
        .iter_mut()
        .find(|(k, _)| *k == effect_ptr)
        .and_then(|(_, st)| st.pending_resize.take())
}

pub unsafe fn vst2_dispatcher(
    effect_ptr: usize,
    opcode: i32,
    index: i32,
    value: isize,
    ptr: *mut c_void,
    opt: f32,
) -> isize {
    let effect = effect_ptr as *mut AEffect;
    if effect.is_null() {
        return 0;
    }
    ((*effect).dispatcher)(effect, opcode, index, value, ptr, opt)
}

unsafe fn copy_vst2_cstr(dst: *mut c_void, text: &[u8]) {
    if dst.is_null() || text.is_empty() {
        return;
    }
    std::ptr::copy_nonoverlapping(text.as_ptr(), dst as *mut u8, text.len());
}

unsafe extern "C" fn vst2_host_callback(
    effect: *mut AEffect,
    opcode: i32,
    index: i32,
    value: isize,
    ptr: *mut c_void,
    _opt: f32,
) -> isize {
    let key = effect as usize;
    match opcode {
        1 => 2400, // audioMasterVersion
        2 => 0,    // audioMasterCurrentId
        15 => {
            // audioMasterSizeWindow
            if key != 0 {
                if let Ok(mut guard) = vst2_states().lock() {
                    if let Some((_, st)) = guard.iter_mut().find(|(k, _)| *k == key) {
                        st.pending_resize = Some((index, value as i32));
                    }
                }
            }
            1
        }
        16 => {
            // audioMasterGetSampleRate
            if let Ok(guard) = vst2_states().lock() {
                if let Some((_, st)) = guard.iter().find(|(k, _)| *k == key) {
                    return st.sample_rate as isize;
                }
            }
            48000
        }
        17 => {
            // audioMasterGetBlockSize
            if let Ok(guard) = vst2_states().lock() {
                if let Some((_, st)) = guard.iter().find(|(k, _)| *k == key) {
                    return st.block_size as isize;
                }
            }
            2048
        }
        23 => 1, // audioMasterGetCurrentProcessLevel
        24 => 1, // audioMasterGetAutomationState
        32 => {
            copy_vst2_cstr(ptr, c"UMC1820".to_bytes_with_nul());
            1
        }
        33 => {
            copy_vst2_cstr(ptr, c"UMC1820 Studio Mixer".to_bytes_with_nul());
            1
        }
        34 => 1000, // audioMasterGetVendorVersion
        37 => {
            // audioMasterCanDo
            if ptr.is_null() {
                return 0;
            }
            let req = CStr::from_ptr(ptr as *const std::ffi::c_char).to_string_lossy();
            match req.as_ref() {
                "sizeWindow" | "supplyIdle" | "sendVstTimeInfo" | "acceptIOChanges" => 1,
                _ => 0,
            }
        }
        38 => 1, // audioMasterGetLanguage (kVstLangEnglish)
        _ => 0,
    }
}

/// Hôte VST2 C-ABI complet (AEffect + processReplacing + éditeur natif effEditOpen).
pub struct Vst2PluginInstance {
    name: String,
    _lib: Library,
    effect: *mut AEffect,
    num_inputs: usize,
    num_outputs: usize,
    in_left: Vec<f32>,
    in_right: Vec<f32>,
    in_scratch: Vec<f32>,
    out_left: Vec<f32>,
    out_right: Vec<f32>,
    out_scratch: Vec<f32>,
    bypassed: bool,
    params: Vec<PluginParamDesc>,
}

unsafe impl Send for Vst2PluginInstance {}

impl Vst2PluginInstance {
    pub fn load(name: &str, path: &Path) -> Result<Self, String> {
        let binary_path = resolve_vst2_binary(path)?;
        unsafe {
            let lib = Library::new(&binary_path)
                .map_err(|e| format!("Erreur chargement VST2 {}: {e}", binary_path.display()))?;
            let entry: Vst2MainFn = if let Ok(sym) = lib.get::<Vst2MainFn>(b"VSTPluginMain") {
                *sym
            } else if let Ok(sym) = lib.get::<Vst2MainFn>(b"main_macho") {
                *sym
            } else if let Ok(sym) = lib.get::<Vst2MainFn>(b"main") {
                *sym
            } else {
                return Err("Point d'entrée VSTPluginMain introuvable".into());
            };

            let effect = entry(vst2_host_callback);
            if effect.is_null() || (*effect).magic != VST2_MAGIC {
                return Err("AEffect VST2 invalide ou magic incorrect".into());
            }

            if let Ok(mut guard) = vst2_states().lock() {
                guard.push((
                    effect as usize,
                    Vst2HostState {
                        sample_rate: 48000.0,
                        block_size: 2048,
                        pending_resize: None,
                    },
                ));
            }

            ((*effect).dispatcher)(effect, VST2_EFF_OPEN, 0, 0, std::ptr::null_mut(), 0.0);
            ((*effect).dispatcher)(effect, VST2_EFF_SET_SAMPLE_RATE, 0, 0, std::ptr::null_mut(), 48000.0);
            ((*effect).dispatcher)(effect, VST2_EFF_SET_BLOCK_SIZE, 0, 2048, std::ptr::null_mut(), 0.0);
            ((*effect).dispatcher)(effect, VST2_EFF_MAINS_CHANGED, 0, 1, std::ptr::null_mut(), 0.0);

            let mut params = Vec::new();
            let p_count = (*effect).num_params.clamp(0, 128);
            for i in 0..p_count {
                let mut name_buf = [0_u8; 64];
                let mut unit_buf = [0_u8; 64];
                ((*effect).dispatcher)(
                    effect,
                    VST2_EFF_GET_PARAM_NAME,
                    i,
                    0,
                    name_buf.as_mut_ptr() as *mut c_void,
                    0.0,
                );
                ((*effect).dispatcher)(
                    effect,
                    VST2_EFF_GET_PARAM_LABEL,
                    i,
                    0,
                    unit_buf.as_mut_ptr() as *mut c_void,
                    0.0,
                );
                let pname = CStr::from_ptr(name_buf.as_ptr() as *const std::ffi::c_char)
                    .to_string_lossy()
                    .trim()
                    .to_string();
                let punit = CStr::from_ptr(unit_buf.as_ptr() as *const std::ffi::c_char)
                    .to_string_lossy()
                    .trim()
                    .to_string();
                let cur = ((*effect).get_parameter)(effect, i).clamp(0.0, 1.0);
                params.push(PluginParamDesc {
                    id: i as u32,
                    name: if pname.is_empty() { format!("Param {i}") } else { pname },
                    unit: punit,
                    min: 0.0,
                    max: 1.0,
                    default: cur,
                    value: cur,
                });
            }

            Ok(Self {
                name: name.to_string(),
                _lib: lib,
                effect,
                num_inputs: (*effect).num_inputs.max(0) as usize,
                num_outputs: (*effect).num_outputs.max(0) as usize,
                in_left: vec![0.0_f32; 2048],
                in_right: vec![0.0_f32; 2048],
                in_scratch: vec![0.0_f32; 2048],
                out_left: vec![0.0_f32; 2048],
                out_right: vec![0.0_f32; 2048],
                out_scratch: vec![0.0_f32; 2048],
                bypassed: false,
                params,
            })
        }
    }
}

impl Drop for Vst2PluginInstance {
    fn drop(&mut self) {
        unsafe {
            if !self.effect.is_null() {
                ((*self.effect).dispatcher)(
                    self.effect,
                    VST2_EFF_MAINS_CHANGED,
                    0,
                    0,
                    std::ptr::null_mut(),
                    0.0,
                );
                ((*self.effect).dispatcher)(
                    self.effect,
                    VST2_EFF_CLOSE,
                    0,
                    0,
                    std::ptr::null_mut(),
                    0.0,
                );
                if let Ok(mut guard) = vst2_states().lock() {
                    guard.retain(|(k, _)| *k != self.effect as usize);
                }
            }
        }
    }
}

impl HostedPlugin for Vst2PluginInstance {
    fn name(&self) -> &str {
        &self.name
    }
    fn format(&self) -> PluginFormat {
        PluginFormat::Vst2
    }
    fn native_handle(&self) -> Option<NativePluginHandle> {
        if self.effect.is_null() {
            return None;
        }
        let flags = unsafe { (*self.effect).flags };
        if (flags & VST2_FLAGS_HAS_EDITOR) != 0 {
            Some(NativePluginHandle::Vst2 {
                effect_ptr: self.effect as usize,
                title: self.name.clone(),
            })
        } else {
            None
        }
    }
    fn prepare(&mut self, sample_rate: f32, max_block_size: usize) {
        let block = max_block_size.clamp(64, 2048) as i32;
        if let Ok(mut guard) = vst2_states().lock() {
            if let Some((_, st)) = guard.iter_mut().find(|(k, _)| *k == self.effect as usize) {
                st.sample_rate = sample_rate;
                st.block_size = block;
            }
        }
        unsafe {
            ((*self.effect).dispatcher)(
                self.effect,
                VST2_EFF_MAINS_CHANGED,
                0,
                0,
                std::ptr::null_mut(),
                0.0,
            );
            ((*self.effect).dispatcher)(
                self.effect,
                VST2_EFF_SET_SAMPLE_RATE,
                0,
                0,
                std::ptr::null_mut(),
                sample_rate,
            );
            ((*self.effect).dispatcher)(
                self.effect,
                VST2_EFF_SET_BLOCK_SIZE,
                0,
                block as isize,
                std::ptr::null_mut(),
                0.0,
            );
            ((*self.effect).dispatcher)(
                self.effect,
                VST2_EFF_MAINS_CHANGED,
                0,
                1,
                std::ptr::null_mut(),
                0.0,
            );
        }
    }
    fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
    fn parameters(&self) -> Vec<PluginParamDesc> {
        self.params.clone()
    }
    fn set_parameter(&mut self, param_id: u32, value: f32) {
        let clamped = value.clamp(0.0, 1.0);
        if let Some(p) = self.params.iter_mut().find(|p| p.id == param_id) {
            p.value = clamped;
        }
        unsafe {
            if !self.effect.is_null() {
                ((*self.effect).set_parameter)(self.effect, param_id as i32, clamped);
            }
        }
    }
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.effect.is_null() {
            return;
        }
        let frames = left.len().min(right.len()).min(2048);
        if frames == 0 {
            return;
        }

        if self.num_inputs == 1 {
            for i in 0..frames {
                self.in_left[i] = 0.5 * (left[i] + right[i]);
            }
        } else {
            self.in_left[..frames].copy_from_slice(&left[..frames]);
            self.in_right[..frames].copy_from_slice(&right[..frames]);
        }
        self.in_scratch[..frames].fill(0.0);
        self.out_left[..frames].fill(0.0);
        self.out_right[..frames].fill(0.0);

        let in_count = self.num_inputs.min(8);
        let out_count = self.num_outputs.min(8);
        let mut in_ptrs = [self.in_scratch.as_mut_ptr(); 8];
        if in_count >= 1 {
            in_ptrs[0] = self.in_left.as_mut_ptr();
        }
        if in_count >= 2 {
            in_ptrs[1] = self.in_right.as_mut_ptr();
        }
        let mut out_ptrs = [self.out_scratch.as_mut_ptr(); 8];
        if out_count >= 1 {
            out_ptrs[0] = self.out_left.as_mut_ptr();
        }
        if out_count >= 2 {
            out_ptrs[1] = self.out_right.as_mut_ptr();
        }

        unsafe {
            ((*self.effect).process_replacing)(
                self.effect,
                in_ptrs.as_mut_ptr(),
                out_ptrs.as_mut_ptr(),
                frames as i32,
            );
        }

        if out_count >= 2 {
            left[..frames].copy_from_slice(&self.out_left[..frames]);
            right[..frames].copy_from_slice(&self.out_right[..frames]);
        } else if out_count == 1 {
            left[..frames].copy_from_slice(&self.out_left[..frames]);
            right[..frames].copy_from_slice(&self.out_left[..frames]);
        }
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct AuInputScratch {
    left: [f32; 2048],
    right: [f32; 2048],
    available_frames: usize,
}

#[cfg(target_os = "macos")]
impl Default for AuInputScratch {
    fn default() -> Self {
        Self {
            left: [0.0_f32; 2048],
            right: [0.0_f32; 2048],
            available_frames: 0,
        }
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct StereoAudioBufferList {
    m_number_buffers: u32,
    m_buffers: [coreaudio_sys::AudioBuffer; 2],
}

#[cfg(target_os = "macos")]
unsafe extern "C" fn au_input_render_callback(
    in_ref_con: *mut c_void,
    _io_action_flags: *mut coreaudio_sys::AudioUnitRenderActionFlags,
    _in_time_stamp: *const coreaudio_sys::AudioTimeStamp,
    _in_bus_number: coreaudio_sys::UInt32,
    in_number_frames: coreaudio_sys::UInt32,
    io_data: *mut coreaudio_sys::AudioBufferList,
) -> coreaudio_sys::OSStatus {
    if in_ref_con.is_null() || io_data.is_null() {
        return -50;
    }
    let scratch = &*(in_ref_con as *const AuInputScratch);
    let abl = &mut *io_data;
    let count = (in_number_frames as usize).min(scratch.available_frames).min(2048);
    let num_bufs = abl.mNumberBuffers as usize;
    let bufs = std::slice::from_raw_parts_mut(abl.mBuffers.as_mut_ptr(), num_bufs);
    if num_bufs >= 1 && !bufs[0].mData.is_null() {
        let dst = std::slice::from_raw_parts_mut(bufs[0].mData as *mut f32, count);
        dst.copy_from_slice(&scratch.left[..count]);
        bufs[0].mDataByteSize = (count * std::mem::size_of::<f32>()) as u32;
    }
    if num_bufs >= 2 && !bufs[1].mData.is_null() {
        let dst = std::slice::from_raw_parts_mut(bufs[1].mData as *mut f32, count);
        dst.copy_from_slice(&scratch.right[..count]);
        bufs[1].mDataByteSize = (count * std::mem::size_of::<f32>()) as u32;
    }
    0
}

#[cfg(target_os = "macos")]
pub struct AudioUnitInstance {
    name: String,
    unit: coreaudio_sys::AudioComponentInstance,
    input_scratch: *mut AuInputScratch,
    in_channels: usize,
    out_channels: usize,
    out_left: Vec<f32>,
    out_right: Vec<f32>,
    sample_pos: f64,
    bypassed: bool,
    params: Vec<PluginParamDesc>,
}

#[cfg(target_os = "macos")]
unsafe impl Send for AudioUnitInstance {}

#[cfg(target_os = "macos")]
impl AudioUnitInstance {
    unsafe fn configure_stream_format(
        unit: coreaudio_sys::AudioComponentInstance,
        sample_rate: f64,
    ) -> (usize, usize) {
        use coreaudio_sys::*;
        let make_asbd = |channels: u32| AudioStreamBasicDescription {
            mSampleRate: sample_rate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: channels,
            mBitsPerChannel: 32,
            mReserved: 0,
        };
        let asbd_sz = std::mem::size_of::<AudioStreamBasicDescription>() as UInt32;
        let stereo = make_asbd(2);
        let mono = make_asbd(1);

        let mut in_ch = 2_usize;
        if AudioUnitSetProperty(
            unit,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Input,
            0,
            &stereo as *const _ as *const c_void,
            asbd_sz,
        ) != 0
        {
            if AudioUnitSetProperty(
                unit,
                kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Input,
                0,
                &mono as *const _ as *const c_void,
                asbd_sz,
            ) == 0
            {
                in_ch = 1;
            }
        }

        let mut out_ch = 2_usize;
        if AudioUnitSetProperty(
            unit,
            kAudioUnitProperty_StreamFormat,
            kAudioUnitScope_Output,
            0,
            &stereo as *const _ as *const c_void,
            asbd_sz,
        ) != 0
        {
            if AudioUnitSetProperty(
                unit,
                kAudioUnitProperty_StreamFormat,
                kAudioUnitScope_Output,
                0,
                &mono as *const _ as *const c_void,
                asbd_sz,
            ) == 0
            {
                out_ch = 1;
            }
        }
        (in_ch, out_ch)
    }

    pub fn load(desc: &DiscoveredPlugin) -> Result<Self, String> {
        use coreaudio_sys::*;
        unsafe {
            let codes = desc.au_component_code.ok_or_else(|| {
                format!("Code ComponentType/SubType manquant pour AudioUnit {}", desc.name)
            })?;
            let comp_desc = AudioComponentDescription {
                componentType: codes[0],
                componentSubType: codes[1],
                componentManufacturer: codes[2],
                componentFlags: 0,
                componentFlagsMask: 0,
            };
            let comp = AudioComponentFindNext(std::ptr::null_mut(), &comp_desc);
            if comp.is_null() {
                return Err(format!("AudioUnit {} introuvable via AudioComponentFindNext", desc.name));
            }
            let mut unit: AudioComponentInstance = std::ptr::null_mut();
            let status = AudioComponentInstanceNew(comp, &mut unit);
            if status != 0 || unit.is_null() {
                return Err(format!("Échec AudioComponentInstanceNew (OSStatus={status})"));
            }

            let input_scratch = Box::into_raw(Box::new(AuInputScratch::default()));
            let max_frames: UInt32 = 2048;
            let _ = AudioUnitSetProperty(
                unit,
                kAudioUnitProperty_MaximumFramesPerSlice,
                kAudioUnitScope_Global,
                0,
                &max_frames as *const UInt32 as *const c_void,
                std::mem::size_of::<UInt32>() as UInt32,
            );
            let (in_channels, out_channels) = Self::configure_stream_format(unit, 48000.0);

            let cb = AURenderCallbackStruct {
                inputProc: Some(au_input_render_callback),
                inputProcRefCon: input_scratch as *mut c_void,
            };
            let _ = AudioUnitSetProperty(
                unit,
                kAudioUnitProperty_SetRenderCallback,
                kAudioUnitScope_Input,
                0,
                &cb as *const _ as *const c_void,
                std::mem::size_of::<AURenderCallbackStruct>() as UInt32,
            );

            AudioUnitInitialize(unit);

            // Lecture des paramètres réels exposés par l'AudioUnit CoreAudio
            let mut params = Vec::new();
            let mut list_size: UInt32 = 0;
            let mut writable: Boolean = 0;
            if AudioUnitGetPropertyInfo(
                unit,
                kAudioUnitProperty_ParameterList,
                kAudioUnitScope_Global,
                0,
                &mut list_size,
                &mut writable,
            ) == 0 && list_size > 0
            {
                let count = list_size as usize / std::mem::size_of::<AudioUnitParameterID>();
                let mut ids = vec![0_u32; count];
                if AudioUnitGetProperty(
                    unit,
                    kAudioUnitProperty_ParameterList,
                    kAudioUnitScope_Global,
                    0,
                    ids.as_mut_ptr() as *mut c_void,
                    &mut list_size,
                ) == 0
                {
                    for param_id in ids {
                        let mut info: AudioUnitParameterInfo = std::mem::zeroed();
                        let mut info_size = std::mem::size_of::<AudioUnitParameterInfo>() as UInt32;
                        if AudioUnitGetProperty(
                            unit,
                            kAudioUnitProperty_ParameterInfo,
                            kAudioUnitScope_Global,
                            param_id,
                            &mut info as *mut _ as *mut c_void,
                            &mut info_size,
                        ) == 0
                        {
                            let mut cur_val: f32 = info.defaultValue;
                            let _ = AudioUnitGetParameter(
                                unit,
                                param_id,
                                kAudioUnitScope_Global,
                                0,
                                &mut cur_val,
                            );
                            info.name[info.name.len() - 1] = 0;
                            let name = CStr::from_ptr(info.name.as_ptr())
                                .to_string_lossy()
                                .trim()
                                .to_string();
                            params.push(PluginParamDesc {
                                id: param_id,
                                name: if name.is_empty() { format!("Param {param_id}") } else { name },
                                unit: String::new(),
                                min: info.minValue,
                                max: info.maxValue.max(info.minValue + 0.001),
                                default: info.defaultValue,
                                value: cur_val,
                            });
                        }
                    }
                }
            }

            Ok(Self {
                name: desc.name.clone(),
                unit,
                input_scratch,
                in_channels,
                out_channels,
                out_left: vec![0.0_f32; 2048],
                out_right: vec![0.0_f32; 2048],
                sample_pos: 0.0,
                bypassed: false,
                params,
            })
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for AudioUnitInstance {
    fn drop(&mut self) {
        unsafe {
            coreaudio_sys::AudioUnitUninitialize(self.unit);
            coreaudio_sys::AudioComponentInstanceDispose(self.unit);
            if !self.input_scratch.is_null() {
                drop(Box::from_raw(self.input_scratch));
                self.input_scratch = std::ptr::null_mut();
            }
        }
    }
}

#[cfg(target_os = "macos")]
impl HostedPlugin for AudioUnitInstance {
    fn name(&self) -> &str {
        &self.name
    }
    fn format(&self) -> PluginFormat {
        PluginFormat::AudioUnit
    }
    fn native_handle(&self) -> Option<NativePluginHandle> {
        Some(NativePluginHandle::AudioUnit {
            unit_ptr: self.unit as usize,
            title: self.name.clone(),
        })
    }
    fn prepare(&mut self, sample_rate: f32, _max_block_size: usize) {
        unsafe {
            coreaudio_sys::AudioUnitUninitialize(self.unit);
            let (in_ch, out_ch) = Self::configure_stream_format(self.unit, f64::from(sample_rate));
            self.in_channels = in_ch;
            self.out_channels = out_ch;
            coreaudio_sys::AudioUnitInitialize(self.unit);
        }
    }
    fn set_bypassed(&mut self, bypassed: bool) {
        self.bypassed = bypassed;
    }
    fn parameters(&self) -> Vec<PluginParamDesc> {
        self.params.clone()
    }
    fn set_parameter(&mut self, param_id: u32, value: f32) {
        if let Some(p) = self.params.iter_mut().find(|p| p.id == param_id) {
            p.value = value.clamp(p.min, p.max);
        }
        unsafe {
            let _ = coreaudio_sys::AudioUnitSetParameter(
                self.unit,
                param_id,
                coreaudio_sys::kAudioUnitScope_Global,
                0,
                value,
                0,
            );
        }
    }
    fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        if self.bypassed || self.input_scratch.is_null() {
            return;
        }
        let frames = left.len().min(right.len()).min(2048);
        if frames == 0 {
            return;
        }
        unsafe {
            let scratch = &mut *self.input_scratch;
            if self.in_channels == 1 {
                for i in 0..frames {
                    scratch.left[i] = 0.5 * (left[i] + right[i]);
                }
            } else {
                scratch.left[..frames].copy_from_slice(&left[..frames]);
                scratch.right[..frames].copy_from_slice(&right[..frames]);
            }
            scratch.available_frames = frames;

            let byte_sz = (frames * std::mem::size_of::<f32>()) as u32;
            let mut abl = StereoAudioBufferList {
                m_number_buffers: self.out_channels as u32,
                m_buffers: [
                    coreaudio_sys::AudioBuffer {
                        mNumberChannels: 1,
                        mDataByteSize: byte_sz,
                        mData: self.out_left.as_mut_ptr() as *mut c_void,
                    },
                    coreaudio_sys::AudioBuffer {
                        mNumberChannels: 1,
                        mDataByteSize: byte_sz,
                        mData: self.out_right.as_mut_ptr() as *mut c_void,
                    },
                ],
            };
            let mut flags: coreaudio_sys::AudioUnitRenderActionFlags = 0;
            let mut ts: coreaudio_sys::AudioTimeStamp = std::mem::zeroed();
            ts.mSampleTime = self.sample_pos;
            ts.mFlags = 1; // kAudioTimeStampSampleTimeValid
            self.sample_pos += frames as f64;

            let status = coreaudio_sys::AudioUnitRender(
                self.unit,
                &mut flags,
                &ts,
                0,
                frames as u32,
                &mut abl as *mut StereoAudioBufferList as *mut coreaudio_sys::AudioBufferList,
            );
            if status == 0 {
                left[..frames].copy_from_slice(&self.out_left[..frames]);
                if self.out_channels == 1 {
                    right[..frames].copy_from_slice(&self.out_left[..frames]);
                } else {
                    right[..frames].copy_from_slice(&self.out_right[..frames]);
                }
            }
        }
    }
}

fn first_file_in_dir(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.is_file())
}

fn resolve_vst3_binary(bundle: &Path) -> Result<PathBuf, String> {
    if bundle.is_file() {
        return Ok(bundle.to_path_buf());
    }
    let stem = bundle.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    #[cfg(target_os = "macos")]
    let dir = bundle.join("Contents/MacOS");
    #[cfg(target_os = "macos")]
    let candidate = dir.join(stem);

    #[cfg(target_os = "linux")]
    let dir = {
        let x64 = bundle.join("Contents/x86_64-linux");
        if x64.exists() { x64 } else { bundle.join("Contents/aarch64-linux") }
    };
    #[cfg(target_os = "linux")]
    let candidate = dir.join(format!("{stem}.so"));

    if candidate.exists() {
        Ok(candidate)
    } else if let Some(found) = first_file_in_dir(&dir) {
        Ok(found)
    } else {
        Err(format!("Binaire VST3 introuvable dans {}", bundle.display()))
    }
}

fn resolve_vst2_binary(bundle: &Path) -> Result<PathBuf, String> {
    if bundle.is_file() {
        return Ok(bundle.to_path_buf());
    }
    let stem = bundle.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let dir = bundle.join("Contents/MacOS");
    let candidate = dir.join(stem);
    if candidate.exists() {
        Ok(candidate)
    } else if let Some(found) = first_file_in_dir(&dir) {
        Ok(found)
    } else {
        Err(format!("Binaire VST2 introuvable dans {}", bundle.display()))
    }
}
