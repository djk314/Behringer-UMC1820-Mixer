use std::path::PathBuf;

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::path::PathBuf;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    #[inline]
    unsafe fn sel(name: &CStr) -> *mut c_void {
        sel_registerName(name.as_ptr())
    }

    #[inline]
    unsafe fn msg0(obj: *mut c_void, s: *mut c_void) -> *mut c_void {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s)
    }

    #[inline]
    unsafe fn msg0_isize(obj: *mut c_void, s: *mut c_void) -> isize {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void) -> isize =
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
    unsafe fn msg1_ptr_void(obj: *mut c_void, s: *mut c_void, arg: *mut c_void) {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s, arg);
    }

    #[inline]
    unsafe fn msg1_i8_void(obj: *mut c_void, s: *mut c_void, arg: i8) {
        let f: unsafe extern "C" fn(*mut c_void, *mut c_void, i8) =
            std::mem::transmute(objc_msgSend as *const ());
        f(obj, s, arg);
    }

    unsafe fn make_nsstring(text: &str) -> *mut c_void {
        let cls = objc_getClass(c"NSString".as_ptr());
        let cstr = CString::new(text).unwrap_or_default();
        msg1_ptr(cls, sel(c"stringWithUTF8String:".as_ref()), cstr.as_ptr() as *mut c_void)
    }

    unsafe fn make_ext_array(exts: &[&str]) -> *mut c_void {
        let cls = objc_getClass(c"NSMutableArray".as_ptr());
        let arr = msg0(cls, sel(c"array"));
        for ext in exts {
            let s = make_nsstring(ext);
            msg1_ptr_void(arr, sel(c"addObject:"), s);
        }
        arr
    }

    unsafe fn extract_panel_path(panel: *mut c_void) -> Option<PathBuf> {
        let url = msg0(panel, sel(c"URL"));
        if url.is_null() {
            return None;
        }
        let ns_path = msg0(url, sel(c"path"));
        if ns_path.is_null() {
            return None;
        }
        let utf8 = msg0(ns_path, sel(c"UTF8String")) as *const c_char;
        if utf8.is_null() {
            return None;
        }
        CStr::from_ptr(utf8).to_str().ok().map(PathBuf::from)
    }

    pub fn pick_open_file(title: &str, exts: &[&str]) -> Option<PathBuf> {
        unsafe {
            let cls = objc_getClass(c"NSOpenPanel".as_ptr());
            let panel = msg0(cls, sel(c"openPanel"));
            if panel.is_null() {
                return None;
            }
            msg1_i8_void(panel, sel(c"setCanChooseFiles:"), 1);
            msg1_i8_void(panel, sel(c"setCanChooseDirectories:"), 0);
            msg1_i8_void(panel, sel(c"setAllowsMultipleSelection:"), 0);
            msg1_ptr_void(panel, sel(c"setTitle:"), make_nsstring(title));
            if !exts.is_empty() {
                msg1_ptr_void(panel, sel(c"setAllowedFileTypes:"), make_ext_array(exts));
            }
            if msg0_isize(panel, sel(c"runModal")) == 1 {
                extract_panel_path(panel)
            } else {
                None
            }
        }
    }

    pub fn pick_save_file(title: &str, default_name: &str, exts: &[&str]) -> Option<PathBuf> {
        unsafe {
            let cls = objc_getClass(c"NSSavePanel".as_ptr());
            let panel = msg0(cls, sel(c"savePanel"));
            if panel.is_null() {
                return None;
            }
            msg1_ptr_void(panel, sel(c"setTitle:"), make_nsstring(title));
            msg1_ptr_void(
                panel,
                sel(c"setNameFieldStringValue:"),
                make_nsstring(default_name),
            );
            if !exts.is_empty() {
                msg1_ptr_void(panel, sel(c"setAllowedFileTypes:"), make_ext_array(exts));
            }
            if msg0_isize(panel, sel(c"runModal")) == 1 {
                extract_panel_path(panel)
            } else {
                None
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::PathBuf;
    use std::process::Command;

    pub fn pick_open_file(title: &str, exts: &[&str]) -> Option<PathBuf> {
        let mut cmd = Command::new("zenity");
        cmd.arg("--file-selection")
            .arg(format!("--title={title}"));
        if !exts.is_empty() {
            let pattern = exts
                .iter()
                .map(|e| format!("*.{e}"))
                .collect::<Vec<_>>()
                .join(" ");
            cmd.arg(format!("--file-filter=Fichiers ({pattern}) | {pattern}"));
        }
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(PathBuf::from(s));
                }
            }
            return None;
        }
        if let Ok(out) = Command::new("kdialog")
            .arg("--getopenfilename")
            .arg(".")
            .arg(format!("--title={title}"))
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(PathBuf::from(s));
                }
            }
        }
        None
    }

    pub fn pick_save_file(title: &str, default_name: &str, exts: &[&str]) -> Option<PathBuf> {
        let mut cmd = Command::new("zenity");
        cmd.arg("--file-selection")
            .arg("--save")
            .arg("--confirm-overwrite")
            .arg(format!("--title={title}"))
            .arg(format!("--filename={default_name}"));
        if !exts.is_empty() {
            let pattern = exts
                .iter()
                .map(|e| format!("*.{e}"))
                .collect::<Vec<_>>()
                .join(" ");
            cmd.arg(format!("--file-filter=Set ({pattern}) | {pattern}"));
        }
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(PathBuf::from(s));
                }
            }
            return None;
        }
        if let Ok(out) = Command::new("kdialog")
            .arg("--getsavefilename")
            .arg(default_name)
            .arg(format!("--title={title}"))
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !s.is_empty() {
                    return Some(PathBuf::from(s));
                }
            }
        }
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use std::path::PathBuf;

    pub fn pick_open_file(_title: &str, _exts: &[&str]) -> Option<PathBuf> {
        None
    }

    pub fn pick_save_file(_title: &str, _default_name: &str, _exts: &[&str]) -> Option<PathBuf> {
        None
    }
}

pub fn pick_open_file(title: &str, exts: &[&str]) -> Option<PathBuf> {
    platform::pick_open_file(title, exts)
}

pub fn pick_save_file(title: &str, default_name: &str, exts: &[&str]) -> Option<PathBuf> {
    platform::pick_save_file(title, default_name, exts)
}
