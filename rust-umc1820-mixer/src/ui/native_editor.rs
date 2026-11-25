#[derive(Clone, Copy, PartialEq, Eq)]
struct SlotKey {
    strip: usize,
    slot: usize,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::SlotKey;
    use crate::audio::plugin_host::{
        vst2_dispatcher, vst2_take_pending_resize, Vst2Rect, VST2_EFF_EDIT_CLOSE,
        VST2_EFF_EDIT_GET_RECT, VST2_EFF_EDIT_IDLE, VST2_EFF_EDIT_OPEN,
    };
    use crate::audio::state::NativePluginHandle;
    use crate::audio::vst3_abi::{
        ComObj, HostPlugFrame, IEditControllerVtbl, IPlugViewVtbl, PlugFrameState, ViewRect,
        K_RESULT_OK,
    };
    use std::ffi::{c_char, c_void, CString};
    use std::sync::{Arc, Mutex};

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
        #[cfg(target_arch = "x86_64")]
        fn objc_msgSend_stret();
    }

    #[link(name = "Foundation", kind = "framework")]
    extern "C" {
        fn NSClassFromString(a_class_name: *const c_void) -> *mut c_void;
    }

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "CoreAudioKit", kind = "framework")]
    extern "C" {}

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    #[allow(dead_code)]
    struct NSPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct NSSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    #[allow(dead_code)]
    struct NSRect {
        origin: NSPoint,
        size: NSSize,
    }

    #[inline]
    unsafe fn sel(name: &std::ffi::CStr) -> *mut c_void {
        sel_registerName(name.as_ptr())
    }

    #[inline]
    unsafe fn msg0(obj: *mut c_void, s: *mut c_void) -> *mut c_void {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s)
    }

    #[inline]
    unsafe fn msg0_void(obj: *mut c_void, s: *mut c_void) {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s);
    }

    #[inline]
    unsafe fn msg0_u8(obj: *mut c_void, s: *mut c_void) -> u8 {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> u8 =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s)
    }

    #[inline]
    unsafe fn msg1_ptr(obj: *mut c_void, s: *mut c_void, arg: *mut c_void) -> *mut c_void {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s, arg)
    }

    #[inline]
    unsafe fn msg1_u8_void(obj: *mut c_void, s: *mut c_void, arg: u8) {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, u8) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s, arg);
    }

    #[inline]
    unsafe fn msg1_size_void(obj: *mut c_void, s: *mut c_void, arg: NSSize) {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, NSSize) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s, arg);
    }

    unsafe fn nsview_frame(view: *mut c_void) -> NSRect {
        let s = sel(c"frame");
        #[cfg(target_arch = "aarch64")]
        {
            let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> NSRect =
                std::mem::transmute(objc_msgSend as *const ());
            f(view, s)
        }
        #[cfg(target_arch = "x86_64")]
        {
            let mut rect = NSRect::default();
            let f: unsafe extern "C" fn(*mut NSRect, *mut c_void, *mut c_void) =
                std::mem::transmute(objc_msgSend_stret as *const ());
            f(&mut rect, view, s);
            rect
        }
    }

    unsafe fn make_nsstring(text: &str) -> *mut c_void {
        let c_text = CString::new(text).unwrap_or_else(|_| CString::new("Plugin").unwrap());
        let cls = objc_getClass(c"NSString".as_ptr());
        let alloc = msg0(cls, sel(c"alloc"));
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(alloc, sel(c"initWithUTF8String:"), c_text.as_ptr())
    }

    unsafe fn create_nswindow(width: f64, height: f64, title: &str, resizable: bool) -> *mut c_void {
        let cls = objc_getClass(c"NSWindow".as_ptr());
        let alloc = msg0(cls, sel(c"alloc"));
        let rect = NSRect {
            origin: NSPoint { x: 160.0, y: 160.0 },
            size: NSSize {
                width: width.max(240.0),
                height: height.max(160.0),
            },
        };
        let style_mask: usize = if resizable { 1 | 2 | 4 | 8 } else { 1 | 2 | 4 };
        let init_fn: unsafe extern "C" fn(
            *mut c_void,
            *mut c_void,
            NSRect,
            usize,
            usize,
            u8,
        ) -> *mut c_void = std::mem::transmute(objc_msgSend as *const ());
        let window = init_fn(
            alloc,
            sel(c"initWithContentRect:styleMask:backing:defer:"),
            rect,
            style_mask,
            2, // NSBackingStoreBuffered
            0, // NO
        );
        if !window.is_null() {
            msg1_u8_void(window, sel(c"setReleasedWhenClosed:"), 0);
            let ns_title = make_nsstring(title);
            if !ns_title.is_null() {
                let _ = msg1_ptr(window, sel(c"setTitle:"), ns_title);
                msg0_void(ns_title, sel(c"release"));
            }
            msg0_void(window, sel(c"center"));
        }
        window
    }

    enum NativeBackend {
        AudioUnit {
            au_factory: *mut c_void,
        },
        Vst3 {
            view: *mut ComObj<IPlugViewVtbl>,
            frame: *mut HostPlugFrame,
            frame_state: Arc<Mutex<PlugFrameState>>,
        },
        Vst2 {
            effect_ptr: usize,
        },
    }

    struct OpenEditor {
        key: SlotKey,
        window: *mut c_void,
        backend: NativeBackend,
    }

    pub struct NativeEditorManager {
        open: Vec<OpenEditor>,
    }

    impl NativeEditorManager {
        pub fn new() -> Self {
            Self { open: Vec::new() }
        }

        pub fn is_open(&self, strip: usize, slot: usize) -> bool {
            self.open.iter().any(|e| e.key == SlotKey { strip, slot })
        }

        pub fn open_editor(
            &mut self,
            strip: usize,
            slot: usize,
            handle: &NativePluginHandle,
        ) -> Result<(), String> {
            self.close_slot(strip, slot);
            let key = SlotKey { strip, slot };
            match handle {
                NativePluginHandle::AudioUnit { unit_ptr, title } => {
                    let editor = unsafe { open_au_editor(key, *unit_ptr, title)? };
                    self.open.push(editor);
                    Ok(())
                }
                NativePluginHandle::Vst3 {
                    controller_ptr,
                    title,
                } => {
                    let editor = unsafe { open_vst3_editor(key, *controller_ptr, title)? };
                    self.open.push(editor);
                    Ok(())
                }
                NativePluginHandle::Vst2 { effect_ptr, title } => {
                    let editor = unsafe { open_vst2_editor(key, *effect_ptr, title)? };
                    self.open.push(editor);
                    Ok(())
                }
            }
        }

        pub fn close_slot(&mut self, strip: usize, slot: usize) {
            let key = SlotKey { strip, slot };
            if let Some(idx) = self.open.iter().position(|e| e.key == key) {
                let ed = self.open.remove(idx);
                unsafe { destroy_editor(ed) };
            }
        }

        pub fn close_all(&mut self) {
            for ed in self.open.drain(..) {
                unsafe { destroy_editor(ed) };
            }
        }

        pub fn pump_events(&mut self) {
            let mut to_close = Vec::new();
            for ed in &self.open {
                unsafe {
                    if ed.window.is_null() || msg0_u8(ed.window, sel(c"isVisible")) == 0 {
                        to_close.push(ed.key);
                        continue;
                    }
                    match &ed.backend {
                        NativeBackend::Vst3 { frame_state, .. } => {
                            let resize = frame_state
                                .lock()
                                .ok()
                                .and_then(|mut st| st.pending_resize.take());
                            if let Some((w, h)) = resize {
                                msg1_size_void(
                                    ed.window,
                                    sel(c"setContentSize:"),
                                    NSSize {
                                        width: f64::from(w.max(100)),
                                        height: f64::from(h.max(100)),
                                    },
                                );
                            }
                        }
                        NativeBackend::Vst2 { effect_ptr } => {
                            vst2_dispatcher(
                                *effect_ptr,
                                VST2_EFF_EDIT_IDLE,
                                0,
                                0,
                                std::ptr::null_mut(),
                                0.0,
                            );
                            if let Some((w, h)) = vst2_take_pending_resize(*effect_ptr) {
                                msg1_size_void(
                                    ed.window,
                                    sel(c"setContentSize:"),
                                    NSSize {
                                        width: f64::from(w.max(100)),
                                        height: f64::from(h.max(100)),
                                    },
                                );
                            }
                        }
                        NativeBackend::AudioUnit { .. } => {}
                    }
                }
            }
            for key in to_close {
                self.close_slot(key.strip, key.slot);
            }
        }

        pub fn sync_vst3_param_normalized(
            &self,
            controller_ptr: usize,
            param_id: u32,
            norm_value: f64,
        ) {
            let ctrl = controller_ptr as *mut ComObj<IEditControllerVtbl>;
            if !ctrl.is_null() {
                unsafe {
                    let _ = ((*(*ctrl).vtbl).set_param_normalized)(
                        ctrl as *mut c_void,
                        param_id,
                        norm_value.clamp(0.0, 1.0),
                    );
                }
            }
        }
    }

    impl Drop for NativeEditorManager {
        fn drop(&mut self) {
            self.close_all();
        }
    }

    unsafe fn destroy_editor(ed: OpenEditor) {
        match ed.backend {
            NativeBackend::Vst3 {
                view,
                frame,
                frame_state,
            } => {
                if let Ok(mut st) = frame_state.lock() {
                    st.clear_run_loop();
                }
                if !view.is_null() {
                    let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
                    let _ = ((*(*view).vtbl).removed)(view as *mut c_void);
                    let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                }
                if !frame.is_null() {
                    let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
                }
            }
            NativeBackend::Vst2 { effect_ptr } => {
                vst2_dispatcher(
                    effect_ptr,
                    VST2_EFF_EDIT_CLOSE,
                    0,
                    0,
                    std::ptr::null_mut(),
                    0.0,
                );
            }
            NativeBackend::AudioUnit { au_factory } => {
                if !au_factory.is_null() {
                    msg0_void(au_factory, sel(c"release"));
                }
            }
        }
        if !ed.window.is_null() {
            let _ = msg1_ptr(ed.window, sel(c"orderOut:"), std::ptr::null_mut());
            let _ = msg1_ptr(ed.window, sel(c"setContentView:"), std::ptr::null_mut());
            msg0_void(ed.window, sel(c"close"));
            msg0_void(ed.window, sel(c"release"));
        }
    }

    unsafe fn open_au_editor(
        key: SlotKey,
        unit_ptr: usize,
        title: &str,
    ) -> Result<OpenEditor, String> {
        use coreaudio_sys::*;
        const K_AUDIO_UNIT_PROPERTY_COCOA_UI: UInt32 = 14;
        let unit = unit_ptr as AudioComponentInstance;
        if unit.is_null() {
            return Err("AudioUnit invalide.".into());
        }

        let mut view: *mut c_void = std::ptr::null_mut();
        let mut owned_view = false;
        let mut au_factory: *mut c_void = std::ptr::null_mut();

        let mut prop_size: UInt32 = 0;
        let mut writable: Boolean = 0;
        if AudioUnitGetPropertyInfo(
            unit,
            K_AUDIO_UNIT_PROPERTY_COCOA_UI,
            kAudioUnitScope_Global,
            0,
            &mut prop_size,
            &mut writable,
        ) == 0
            && prop_size as usize >= std::mem::size_of::<AudioUnitCocoaViewInfo>()
        {
            let mut buf = vec![0_u8; prop_size as usize];
            if AudioUnitGetProperty(
                unit,
                K_AUDIO_UNIT_PROPERTY_COCOA_UI,
                kAudioUnitScope_Global,
                0,
                buf.as_mut_ptr() as *mut c_void,
                &mut prop_size,
            ) == 0
            {
                let info = &*(buf.as_ptr() as *const AudioUnitCocoaViewInfo);
                let bundle_url = info.mCocoaAUViewBundleLocation as *const c_void;
                let class_name = info.mCocoaAUViewClass[0] as *const c_void;

                if !bundle_url.is_null() && !class_name.is_null() {
                    let ns_bundle_cls = objc_getClass(c"NSBundle".as_ptr());
                    let alloc_b = msg0(ns_bundle_cls, sel(c"alloc"));
                    let bundle = msg1_ptr(alloc_b, sel(c"initWithURL:"), bundle_url as *mut c_void);
                    if !bundle.is_null() {
                        let _ = msg0_u8(bundle, sel(c"load"));
                        let mut view_cls = msg1_ptr(bundle, sel(c"classNamed:"), class_name as *mut c_void);
                        if view_cls.is_null() {
                            view_cls = NSClassFromString(class_name);
                        }
                        if !view_cls.is_null() {
                            let factory_alloc = msg0(view_cls, sel(c"alloc"));
                            let factory = msg0(factory_alloc, sel(c"init"));
                            if !factory.is_null() {
                                let ui_fn: unsafe extern "C" fn(
                                    *mut c_void,
                                    *mut c_void,
                                    *mut c_void,
                                    NSSize,
                                ) -> *mut c_void = std::mem::transmute(objc_msgSend as *const ());
                                view = ui_fn(
                                    factory,
                                    sel(c"uiViewForAudioUnit:withSize:"),
                                    unit as *mut c_void,
                                    NSSize {
                                        width: 800.0,
                                        height: 560.0,
                                    },
                                );
                                au_factory = factory;
                            }
                        }
                        msg0_void(bundle, sel(c"release"));
                    }
                }

                // Libération CF selon la règle Create/Copy de kAudioUnitProperty_CocoaUI
                if !bundle_url.is_null() {
                    CFRelease(bundle_url);
                }
                let ptr_sz = std::mem::size_of::<*const c_void>();
                let num_classes = (prop_size as usize).saturating_sub(ptr_sz) / ptr_sz;
                let class_ptrs = std::slice::from_raw_parts(
                    buf.as_ptr().add(ptr_sz) as *const *const c_void,
                    num_classes,
                );
                for &cf_str in class_ptrs {
                    if !cf_str.is_null() {
                        CFRelease(cf_str);
                    }
                }
            }
        }

        // Repli CoreAudioKit::AUGenericView (ex: AudioUnits intégrés Apple)
        if view.is_null() {
            let generic_cls = objc_getClass(c"AUGenericView".as_ptr());
            if !generic_cls.is_null() {
                let alloc = msg0(generic_cls, sel(c"alloc"));
                let v = msg1_ptr(alloc, sel(c"initWithAudioUnit:"), unit as *mut c_void);
                if !v.is_null() {
                    view = v;
                    owned_view = true;
                }
            }
        }

        if view.is_null() {
            if !au_factory.is_null() {
                msg0_void(au_factory, sel(c"release"));
            }
            return Err("Impossible de créer la vue Cocoa ou AUGenericView pour cet AudioUnit.".into());
        }

        let frame = nsview_frame(view);
        let width = if frame.size.width > 10.0 { frame.size.width } else { 720.0 };
        let height = if frame.size.height > 10.0 { frame.size.height } else { 460.0 };
        let window = create_nswindow(
            width,
            height,
            &format!("{title} — AU (Tranche {} Insert {})", key.strip + 1, key.slot + 1),
            true,
        );
        if window.is_null() {
            if owned_view {
                msg0_void(view, sel(c"release"));
            }
            if !au_factory.is_null() {
                msg0_void(au_factory, sel(c"release"));
            }
            return Err("Échec création NSWindow pour l'AudioUnit.".into());
        }

        let _ = msg1_ptr(window, sel(c"setContentView:"), view);
        if owned_view {
            msg0_void(view, sel(c"release"));
        }
        let _ = msg1_ptr(window, sel(c"makeKeyAndOrderFront:"), std::ptr::null_mut());

        Ok(OpenEditor {
            key,
            window,
            backend: NativeBackend::AudioUnit { au_factory },
        })
    }

    unsafe fn open_vst3_editor(
        key: SlotKey,
        controller_ptr: usize,
        title: &str,
    ) -> Result<OpenEditor, String> {
        let ctrl = controller_ptr as *mut ComObj<IEditControllerVtbl>;
        if ctrl.is_null() {
            return Err("Ce plugin VST3 n'expose pas de contrôleur GUI (IEditController).".into());
        }
        let view = ((*(*ctrl).vtbl).create_view)(ctrl as *mut c_void, c"editor".as_ptr());
        if view.is_null() {
            return Err("Ce plugin VST3 ne fournit pas de vue graphique native ('editor').".into());
        }
        let platform_type = c"NSView".as_ptr();
        if ((*(*view).vtbl).is_platform_type_supported)(view as *mut c_void, platform_type)
            != K_RESULT_OK
        {
            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
            return Err("Ce plugin VST3 ne supporte pas le type de vue macOS 'NSView'.".into());
        }

        let frame_state = Arc::new(Mutex::new(PlugFrameState::default()));
        let frame = HostPlugFrame::new_raw(Arc::clone(&frame_state));
        let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, frame as *mut c_void);

        let mut rect = ViewRect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 540,
        };
        let _ = ((*(*view).vtbl).get_size)(view as *mut c_void, &mut rect);
        let resizable = ((*(*view).vtbl).can_resize)(view as *mut c_void) == K_RESULT_OK;
        let window = create_nswindow(
            f64::from(rect.width()),
            f64::from(rect.height()),
            &format!("{title} — VST3 (Tranche {} Insert {})", key.strip + 1, key.slot + 1),
            resizable,
        );
        if window.is_null() {
            let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
            return Err("Échec création NSWindow pour le VST3.".into());
        }

        let content_view = msg0(window, sel(c"contentView"));
        if ((*(*view).vtbl).attached)(view as *mut c_void, content_view, platform_type)
            != K_RESULT_OK
        {
            let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
            msg0_void(window, sel(c"close"));
            msg0_void(window, sel(c"release"));
            return Err("IPlugView::attached(NSView) a échoué sur ce VST3.".into());
        }

        if let Ok(mut st) = frame_state.lock() {
            if let Some((w, h)) = st.pending_resize.take() {
                rect.right = rect.left + w.max(100);
                rect.bottom = rect.top + h.max(100);
                msg1_size_void(
                    window,
                    sel(c"setContentSize:"),
                    NSSize {
                        width: f64::from(w.max(100)),
                        height: f64::from(h.max(100)),
                    },
                );
            }
        }

        let _ = ((*(*view).vtbl).on_size)(view as *mut c_void, &mut rect);
        let _ = ((*(*view).vtbl).on_focus)(view as *mut c_void, 1);
        let _ = msg1_ptr(window, sel(c"makeKeyAndOrderFront:"), std::ptr::null_mut());

        Ok(OpenEditor {
            key,
            window,
            backend: NativeBackend::Vst3 {
                view,
                frame,
                frame_state,
            },
        })
    }

    unsafe fn open_vst2_editor(
        key: SlotKey,
        effect_ptr: usize,
        title: &str,
    ) -> Result<OpenEditor, String> {
        let mut rect_ptr: *mut Vst2Rect = std::ptr::null_mut();
        vst2_dispatcher(
            effect_ptr,
            VST2_EFF_EDIT_GET_RECT,
            0,
            0,
            &mut rect_ptr as *mut *mut Vst2Rect as *mut c_void,
            0.0,
        );
        let (init_w, init_h) = if !rect_ptr.is_null() {
            let r = *rect_ptr;
            let w = (i32::from(r.right) - i32::from(r.left)).max(240);
            let h = (i32::from(r.bottom) - i32::from(r.top)).max(160);
            (f64::from(w), f64::from(h))
        } else {
            (800.0, 540.0)
        };

        let window = create_nswindow(
            init_w,
            init_h,
            &format!("{title} — VST2 (Tranche {} Insert {})", key.strip + 1, key.slot + 1),
            true,
        );
        if window.is_null() {
            return Err("Échec création NSWindow pour le VST2.".into());
        }

        let content_view = msg0(window, sel(c"contentView"));
        vst2_dispatcher(effect_ptr, VST2_EFF_EDIT_OPEN, 0, 0, content_view, 0.0);

        let mut final_w = init_w;
        let mut final_h = init_h;
        if let Some((rw, rh)) = vst2_take_pending_resize(effect_ptr) {
            final_w = f64::from(rw.max(120));
            final_h = f64::from(rh.max(120));
        } else {
            let mut post_rect: *mut Vst2Rect = std::ptr::null_mut();
            vst2_dispatcher(
                effect_ptr,
                VST2_EFF_EDIT_GET_RECT,
                0,
                0,
                &mut post_rect as *mut *mut Vst2Rect as *mut c_void,
                0.0,
            );
            if !post_rect.is_null() {
                let r = *post_rect;
                let rw = i32::from(r.right) - i32::from(r.left);
                let rh = i32::from(r.bottom) - i32::from(r.top);
                if rw > 40 && rh > 40 {
                    final_w = f64::from(rw);
                    final_h = f64::from(rh);
                }
            }
        }

        msg1_size_void(
            window,
            sel(c"setContentSize:"),
            NSSize {
                width: final_w.max(200.0),
                height: final_h.max(150.0),
            },
        );
        let _ = msg1_ptr(window, sel(c"makeKeyAndOrderFront:"), std::ptr::null_mut());
        vst2_dispatcher(
            effect_ptr,
            VST2_EFF_EDIT_IDLE,
            0,
            0,
            std::ptr::null_mut(),
            0.0,
        );

        Ok(OpenEditor {
            key,
            window,
            backend: NativeBackend::Vst2 { effect_ptr },
        })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::SlotKey;
    use crate::audio::plugin_host::{
        vst2_dispatcher, vst2_take_pending_resize, Vst2Rect, VST2_EFF_EDIT_CLOSE,
        VST2_EFF_EDIT_GET_RECT, VST2_EFF_EDIT_IDLE, VST2_EFF_EDIT_OPEN,
    };
    use crate::audio::state::NativePluginHandle;
    use crate::audio::vst3_abi::{
        ComObj, HostPlugFrame, IEditControllerVtbl, IPlugViewVtbl, PlugFrameState, ViewRect,
        K_RESULT_OK,
    };
    use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void, CString};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const EXPOSURE_MASK: c_long = 1 << 15;
    const STRUCTURE_NOTIFY_MASK: c_long = 1 << 17;
    const CONFIGURE_NOTIFY: c_int = 22;
    const CLIENT_MESSAGE: c_int = 33;

    #[repr(C)]
    #[derive(Clone, Copy)]
    #[allow(dead_code)]
    struct XConfigureEvent {
        type_: c_int,
        serial: c_ulong,
        send_event: c_int,
        display: *mut c_void,
        event: c_ulong,
        window: c_ulong,
        x: c_int,
        y: c_int,
        width: c_int,
        height: c_int,
        border_width: c_int,
        above: c_ulong,
        override_redirect: c_int,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    #[allow(dead_code)]
    struct XClientMessageEvent {
        type_: c_int,
        serial: c_ulong,
        send_event: c_int,
        display: *mut c_void,
        window: c_ulong,
        message_type: c_ulong,
        format: c_int,
        data: [c_long; 5],
    }

    #[repr(C)]
    #[allow(dead_code)]
    union XEvent {
        type_: c_int,
        configure: XConfigureEvent,
        client: XClientMessageEvent,
        pad: [c_long; 24],
    }

    struct X11Api {
        _lib: *mut c_void,
        open_display: unsafe extern "C" fn(*const c_char) -> *mut c_void,
        close_display: unsafe extern "C" fn(*mut c_void) -> c_int,
        default_screen: unsafe extern "C" fn(*mut c_void) -> c_int,
        root_window: unsafe extern "C" fn(*mut c_void, c_int) -> c_ulong,
        black_pixel: unsafe extern "C" fn(*mut c_void, c_int) -> c_ulong,
        create_simple_window: unsafe extern "C" fn(
            *mut c_void,
            c_ulong,
            c_int,
            c_int,
            c_uint,
            c_uint,
            c_uint,
            c_ulong,
            c_ulong,
        ) -> c_ulong,
        store_name: unsafe extern "C" fn(*mut c_void, c_ulong, *const c_char) -> c_int,
        intern_atom: unsafe extern "C" fn(*mut c_void, *const c_char, c_int) -> c_ulong,
        set_wm_protocols: unsafe extern "C" fn(*mut c_void, c_ulong, *mut c_ulong, c_int) -> c_int,
        select_input: unsafe extern "C" fn(*mut c_void, c_ulong, c_long) -> c_int,
        map_window: unsafe extern "C" fn(*mut c_void, c_ulong) -> c_int,
        resize_window: unsafe extern "C" fn(*mut c_void, c_ulong, c_uint, c_uint) -> c_int,
        pending: unsafe extern "C" fn(*mut c_void) -> c_int,
        next_event: unsafe extern "C" fn(*mut c_void, *mut XEvent) -> c_int,
        destroy_window: unsafe extern "C" fn(*mut c_void, c_ulong) -> c_int,
        flush: unsafe extern "C" fn(*mut c_void) -> c_int,
    }

    impl X11Api {
        unsafe fn load() -> Result<Self, String> {
            let mut handle = libc::dlopen(c"libX11.so.6".as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
            if handle.is_null() {
                handle = libc::dlopen(c"libX11.so".as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
            }
            if handle.is_null() {
                return Err("libX11.so.6 introuvable (X11/XWayland requis pour les GUI VST3 Linux).".into());
            }
            macro_rules! sym {
                ($name:expr) => {{
                    let ptr = libc::dlsym(handle, $name.as_ptr());
                    if ptr.is_null() {
                        libc::dlclose(handle);
                        return Err("Symbole X11 manquant".into());
                    }
                    std::mem::transmute(ptr)
                }};
            }
            Ok(Self {
                _lib: handle,
                open_display: sym!(c"XOpenDisplay"),
                close_display: sym!(c"XCloseDisplay"),
                default_screen: sym!(c"XDefaultScreen"),
                root_window: sym!(c"XRootWindow"),
                black_pixel: sym!(c"XBlackPixel"),
                create_simple_window: sym!(c"XCreateSimpleWindow"),
                store_name: sym!(c"XStoreName"),
                intern_atom: sym!(c"XInternAtom"),
                set_wm_protocols: sym!(c"XSetWMProtocols"),
                select_input: sym!(c"XSelectInput"),
                map_window: sym!(c"XMapWindow"),
                resize_window: sym!(c"XResizeWindow"),
                pending: sym!(c"XPending"),
                next_event: sym!(c"XNextEvent"),
                destroy_window: sym!(c"XDestroyWindow"),
                flush: sym!(c"XFlush"),
            })
        }
    }

    impl Drop for X11Api {
        fn drop(&mut self) {
            unsafe {
                if !self._lib.is_null() {
                    libc::dlclose(self._lib);
                }
            }
        }
    }

    enum X11Backend {
        Vst3 {
            view: *mut ComObj<IPlugViewVtbl>,
            frame: *mut HostPlugFrame,
            frame_state: Arc<Mutex<PlugFrameState>>,
        },
        Vst2 {
            effect_ptr: usize,
        },
    }

    struct OpenX11Editor {
        key: SlotKey,
        window: c_ulong,
        backend: X11Backend,
    }

    pub struct NativeEditorManager {
        x11: Option<X11Api>,
        display: *mut c_void,
        wm_delete_window: c_ulong,
        open: Vec<OpenX11Editor>,
    }

    impl NativeEditorManager {
        pub fn new() -> Self {
            Self {
                x11: None,
                display: std::ptr::null_mut(),
                wm_delete_window: 0,
                open: Vec::new(),
            }
        }

        fn ensure_display(&mut self) -> Result<(), String> {
            if self.x11.is_some() && !self.display.is_null() {
                return Ok(());
            }
            unsafe {
                let api = X11Api::load()?;
                let display = (api.open_display)(std::ptr::null());
                if display.is_null() {
                    return Err(
                        "XOpenDisplay() a échoué (session Wayland pure sans XWayland ?).".into(),
                    );
                }
                let wm_del = (api.intern_atom)(display, c"WM_DELETE_WINDOW".as_ptr(), 0);
                self.display = display;
                self.wm_delete_window = wm_del;
                self.x11 = Some(api);
                Ok(())
            }
        }

        pub fn is_open(&self, strip: usize, slot: usize) -> bool {
            self.open.iter().any(|e| e.key == SlotKey { strip, slot })
        }

        pub fn open_editor(
            &mut self,
            strip: usize,
            slot: usize,
            handle: &NativePluginHandle,
        ) -> Result<(), String> {
            self.close_slot(strip, slot);
            match handle {
                NativePluginHandle::AudioUnit { .. } => {
                    Err("Apple AudioUnit n'est pas disponible sur Linux.".into())
                }
                NativePluginHandle::Vst3 {
                    controller_ptr,
                    title,
                } => {
                    self.ensure_display()?;
                    let x11 = self.x11.as_ref().unwrap();
                    let ctrl = *controller_ptr as *mut ComObj<IEditControllerVtbl>;
                    if ctrl.is_null() {
                        return Err("Contrôleur VST3 nul.".into());
                    }
                    unsafe {
                        let view = ((*(*ctrl).vtbl).create_view)(
                            ctrl as *mut c_void,
                            c"editor".as_ptr(),
                        );
                        if view.is_null() {
                            return Err("Ce plugin VST3 n'expose pas de vue graphique ('editor').".into());
                        }
                        let platform_type = c"X11EmbedWindowID".as_ptr();
                        if ((*(*view).vtbl).is_platform_type_supported)(
                            view as *mut c_void,
                            platform_type,
                        ) != K_RESULT_OK
                        {
                            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                            return Err("Ce plugin VST3 ne supporte pas 'X11EmbedWindowID'.".into());
                        }

                        let frame_state = Arc::new(Mutex::new(PlugFrameState::default()));
                        let frame = HostPlugFrame::new_raw(Arc::clone(&frame_state));
                        let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, frame as *mut c_void);

                        let mut rect = ViewRect {
                            left: 0,
                            top: 0,
                            right: 800,
                            bottom: 540,
                        };
                        let _ = ((*(*view).vtbl).get_size)(view as *mut c_void, &mut rect);
                        let w = rect.width().max(200) as c_uint;
                        let h = rect.height().max(150) as c_uint;

                        let screen = (x11.default_screen)(self.display);
                        let root = (x11.root_window)(self.display, screen);
                        let black = (x11.black_pixel)(self.display, screen);
                        let window = (x11.create_simple_window)(
                            self.display,
                            root,
                            120,
                            120,
                            w,
                            h,
                            0,
                            black,
                            black,
                        );
                        if window == 0 {
                            let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
                            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
                            return Err("XCreateSimpleWindow() a échoué.".into());
                        }

                        let win_title = CString::new(format!(
                            "{title} — VST3 (Tranche {} Insert {})",
                            strip + 1,
                            slot + 1
                        ))
                        .unwrap_or_else(|_| CString::new("VST3 Plugin").unwrap());
                        (x11.store_name)(self.display, window, win_title.as_ptr());
                        let mut proto = self.wm_delete_window;
                        (x11.set_wm_protocols)(self.display, window, &mut proto, 1);
                        (x11.select_input)(self.display, window, EXPOSURE_MASK | STRUCTURE_NOTIFY_MASK);
                        (x11.map_window)(self.display, window);
                        (x11.flush)(self.display);

                        if ((*(*view).vtbl).attached)(
                            view as *mut c_void,
                            window as usize as *mut c_void,
                            platform_type,
                        ) != K_RESULT_OK
                        {
                            let _ = ((*(*view).vtbl).set_frame)(view as *mut c_void, std::ptr::null_mut());
                            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
                            (x11.destroy_window)(self.display, window);
                            (x11.flush)(self.display);
                            return Err("IPlugView::attached(X11EmbedWindowID) a échoué.".into());
                        }

                        let _ = ((*(*view).vtbl).on_size)(view as *mut c_void, &mut rect);
                        let _ = ((*(*view).vtbl).on_focus)(view as *mut c_void, 1);
                        (x11.flush)(self.display);

                        self.open.push(OpenX11Editor {
                            key: SlotKey { strip, slot },
                            window,
                            backend: X11Backend::Vst3 {
                                view,
                                frame,
                                frame_state,
                            },
                        });
                        Ok(())
                    }
                }
                NativePluginHandle::Vst2 { effect_ptr, title } => {
                    self.ensure_display()?;
                    let x11 = self.x11.as_ref().unwrap();
                    unsafe {
                        let mut rect_ptr: *mut Vst2Rect = std::ptr::null_mut();
                        vst2_dispatcher(
                            *effect_ptr,
                            VST2_EFF_EDIT_GET_RECT,
                            0,
                            0,
                            &mut rect_ptr as *mut *mut Vst2Rect as *mut c_void,
                            0.0,
                        );
                        let (w, h) = if !rect_ptr.is_null() {
                            let r = *rect_ptr;
                            (
                                (i32::from(r.right) - i32::from(r.left)).max(240) as c_uint,
                                (i32::from(r.bottom) - i32::from(r.top)).max(160) as c_uint,
                            )
                        } else {
                            (800, 540)
                        };

                        let screen = (x11.default_screen)(self.display);
                        let root = (x11.root_window)(self.display, screen);
                        let black = (x11.black_pixel)(self.display, screen);
                        let window = (x11.create_simple_window)(
                            self.display,
                            root,
                            120,
                            120,
                            w,
                            h,
                            0,
                            black,
                            black,
                        );
                        if window == 0 {
                            return Err("XCreateSimpleWindow() a échoué pour VST2.".into());
                        }
                        let win_title = CString::new(format!(
                            "{title} — VST2 (Tranche {} Insert {})",
                            strip + 1,
                            slot + 1
                        ))
                        .unwrap_or_else(|_| CString::new("VST2 Plugin").unwrap());
                        (x11.store_name)(self.display, window, win_title.as_ptr());
                        let mut proto = self.wm_delete_window;
                        (x11.set_wm_protocols)(self.display, window, &mut proto, 1);
                        (x11.select_input)(self.display, window, EXPOSURE_MASK | STRUCTURE_NOTIFY_MASK);
                        (x11.map_window)(self.display, window);
                        (x11.flush)(self.display);

                        vst2_dispatcher(
                            *effect_ptr,
                            VST2_EFF_EDIT_OPEN,
                            0,
                            0,
                            window as usize as *mut c_void,
                            0.0,
                        );
                        if let Some((rw, rh)) = vst2_take_pending_resize(*effect_ptr) {
                            (x11.resize_window)(
                                self.display,
                                window,
                                rw.max(120) as c_uint,
                                rh.max(120) as c_uint,
                            );
                        } else {
                            let mut post_rect: *mut Vst2Rect = std::ptr::null_mut();
                            vst2_dispatcher(
                                *effect_ptr,
                                VST2_EFF_EDIT_GET_RECT,
                                0,
                                0,
                                &mut post_rect as *mut *mut Vst2Rect as *mut c_void,
                                0.0,
                            );
                            if !post_rect.is_null() {
                                let r = *post_rect;
                                let rw = i32::from(r.right) - i32::from(r.left);
                                let rh = i32::from(r.bottom) - i32::from(r.top);
                                if rw > 40 && rh > 40 {
                                    (x11.resize_window)(
                                        self.display,
                                        window,
                                        rw as c_uint,
                                        rh as c_uint,
                                    );
                                }
                            }
                        }
                        (x11.flush)(self.display);

                        self.open.push(OpenX11Editor {
                            key: SlotKey { strip, slot },
                            window,
                            backend: X11Backend::Vst2 {
                                effect_ptr: *effect_ptr,
                            },
                        });
                        Ok(())
                    }
                }
            }
        }

        pub fn close_slot(&mut self, strip: usize, slot: usize) {
            let key = SlotKey { strip, slot };
            if let Some(idx) = self.open.iter().position(|e| e.key == key) {
                let ed = self.open.remove(idx);
                self.destroy_x11_editor(ed);
            }
        }

        pub fn close_all(&mut self) {
            let drained: Vec<_> = self.open.drain(..).collect();
            for ed in drained {
                self.destroy_x11_editor(ed);
            }
            if let Some(x11) = self.x11.take() {
                if !self.display.is_null() {
                    unsafe {
                        (x11.close_display)(self.display);
                    }
                    self.display = std::ptr::null_mut();
                }
            }
        }

        fn destroy_x11_editor(&self, ed: OpenX11Editor) {
            unsafe {
                match ed.backend {
                    X11Backend::Vst3 {
                        view,
                        frame,
                        frame_state,
                    } => {
                        if let Ok(mut st) = frame_state.lock() {
                            st.clear_run_loop();
                        }
                        if !view.is_null() {
                            let _ = ((*(*view).vtbl).set_frame)(
                                view as *mut c_void,
                                std::ptr::null_mut(),
                            );
                            let _ = ((*(*view).vtbl).removed)(view as *mut c_void);
                            let _ = ((*(*view).vtbl).base.release)(view as *mut c_void);
                        }
                        if !frame.is_null() {
                            let _ = ((*(*frame).vtbl).base.release)(frame as *mut c_void);
                        }
                    }
                    X11Backend::Vst2 { effect_ptr } => {
                        vst2_dispatcher(
                            effect_ptr,
                            VST2_EFF_EDIT_CLOSE,
                            0,
                            0,
                            std::ptr::null_mut(),
                            0.0,
                        );
                    }
                }
                if let Some(x11) = &self.x11 {
                    if !self.display.is_null() && ed.window != 0 {
                        (x11.destroy_window)(self.display, ed.window);
                        (x11.flush)(self.display);
                    }
                }
            }
        }

        pub fn pump_events(&mut self) {
            let Some(x11) = self.x11.as_ref() else {
                return;
            };
            if self.display.is_null() || self.open.is_empty() {
                return;
            }

            let mut to_close = Vec::new();
            unsafe {
                while (x11.pending)(self.display) > 0 {
                    let mut ev: XEvent = std::mem::zeroed();
                    (x11.next_event)(self.display, &mut ev);
                    let ev_type = ev.type_;
                    if ev_type == CLIENT_MESSAGE {
                        let cm = ev.client;
                        if cm.data[0] as c_ulong == self.wm_delete_window {
                            if let Some(ed) = self.open.iter().find(|e| e.window == cm.window) {
                                to_close.push(ed.key);
                            }
                        }
                    } else if ev_type == CONFIGURE_NOTIFY {
                        let cfg = ev.configure;
                        if let Some(ed) = self.open.iter().find(|e| e.window == cfg.window) {
                            if let X11Backend::Vst3 { view, .. } = &ed.backend {
                                let mut vr = ViewRect {
                                    left: 0,
                                    top: 0,
                                    right: cfg.width.max(100),
                                    bottom: cfg.height.max(100),
                                };
                                let _ = ((*(*view).vtbl).on_size)(*view as *mut c_void, &mut vr);
                            }
                        }
                    }
                }

                let now = Instant::now();
                for ed in &self.open {
                    match &ed.backend {
                        X11Backend::Vst3 { frame_state, .. } => {
                            let (resize, ev_handlers, due_timers) = {
                                let Ok(mut st) = frame_state.lock() else {
                                    continue;
                                };
                                let resize = st.pending_resize.take();
                                let ev_handlers = st.event_handlers.clone();
                                let mut due_timers = Vec::new();
                                for t in &mut st.timers {
                                    if now.duration_since(t.last_fired)
                                        >= Duration::from_millis(t.interval_ms)
                                    {
                                        t.last_fired = now;
                                        due_timers.push(t.handler);
                                    }
                                }
                                (resize, ev_handlers, due_timers)
                            };

                            if let Some((w, h)) = resize {
                                (x11.resize_window)(
                                    self.display,
                                    ed.window,
                                    w.max(100) as c_uint,
                                    h.max(100) as c_uint,
                                );
                                (x11.flush)(self.display);
                            }

                            if !ev_handlers.is_empty() {
                                let mut pfds: Vec<libc::pollfd> = ev_handlers
                                    .iter()
                                    .map(|h| libc::pollfd {
                                        fd: h.fd,
                                        events: libc::POLLIN,
                                        revents: 0,
                                    })
                                    .collect();
                                if libc::poll(pfds.as_mut_ptr(), pfds.len() as libc::nfds_t, 0) > 0
                                {
                                    for (pfd, ev) in pfds.iter().zip(ev_handlers.iter()) {
                                        if (pfd.revents & libc::POLLIN) != 0 && !ev.handler.is_null()
                                        {
                                            ((*(*ev.handler).vtbl).on_fd_is_set)(
                                                ev.handler as *mut c_void,
                                                ev.fd,
                                            );
                                        }
                                    }
                                }
                            }

                            for timer_handler in due_timers {
                                if !timer_handler.is_null() {
                                    ((*(*timer_handler).vtbl).on_timer)(
                                        timer_handler as *mut c_void,
                                    );
                                }
                            }
                        }
                        X11Backend::Vst2 { effect_ptr } => {
                            vst2_dispatcher(
                                *effect_ptr,
                                VST2_EFF_EDIT_IDLE,
                                0,
                                0,
                                std::ptr::null_mut(),
                                0.0,
                            );
                            if let Some((w, h)) = vst2_take_pending_resize(*effect_ptr) {
                                (x11.resize_window)(
                                    self.display,
                                    ed.window,
                                    w.max(100) as c_uint,
                                    h.max(100) as c_uint,
                                );
                                (x11.flush)(self.display);
                            }
                        }
                    }
                }
            }

            for key in to_close {
                self.close_slot(key.strip, key.slot);
            }
        }

        pub fn sync_vst3_param_normalized(
            &self,
            controller_ptr: usize,
            param_id: u32,
            norm_value: f64,
        ) {
            let ctrl = controller_ptr as *mut ComObj<IEditControllerVtbl>;
            if !ctrl.is_null() {
                unsafe {
                    let _ = ((*(*ctrl).vtbl).set_param_normalized)(
                        ctrl as *mut c_void,
                        param_id,
                        norm_value.clamp(0.0, 1.0),
                    );
                }
            }
        }
    }

    impl Drop for NativeEditorManager {
        fn drop(&mut self) {
            self.close_all();
        }
    }
}

pub use platform::NativeEditorManager;
