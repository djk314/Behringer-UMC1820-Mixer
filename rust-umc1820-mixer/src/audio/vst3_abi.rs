#![allow(dead_code)]

use std::ffi::{c_char, c_void};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[inline]
pub const fn tuid(a: u32, b: u32, c: u32, d: u32) -> [u8; 16] {
    let ab = a.to_be_bytes();
    let bb = b.to_be_bytes();
    let cb = c.to_be_bytes();
    let db = d.to_be_bytes();
    [
        ab[0], ab[1], ab[2], ab[3],
        bb[0], bb[1], bb[2], bb[3],
        cb[0], cb[1], cb[2], cb[3],
        db[0], db[1], db[2], db[3],
    ]
}

pub const K_RESULT_OK: i32 = 0;
pub const K_RESULT_FALSE: i32 = 1;
pub const K_NO_INTERFACE: i32 = -1;
pub const K_NOT_IMPLEMENTED: i32 = 3;

pub const K_MEDIA_AUDIO: i32 = 0;
pub const K_DIR_INPUT: i32 = 0;
pub const K_DIR_OUTPUT: i32 = 1;
pub const K_SAMPLE_32: i32 = 0;
pub const K_REALTIME: i32 = 0;
pub const K_SPEAKER_MONO: u64 = 0x1;
pub const K_SPEAKER_STEREO: u64 = 0x3;

pub const IID_FUNKNOWN: [u8; 16] = tuid(0x00000000, 0x00000000, 0xC0000000, 0x00000046);
pub const IID_IPLUGIN_BASE: [u8; 16] = tuid(0x22888DDB, 0x156E45AE, 0x8358B348, 0x08190625);
pub const IID_IPLUGIN_FACTORY: [u8; 16] = tuid(0x7A4D811C, 0x52114A1F, 0xAED9D2EE, 0x0B43BF9F);
pub const IID_ICOMPONENT: [u8; 16] = tuid(0xE831FF31, 0xF2D54301, 0x928EBBEE, 0x25697802);
pub const IID_IAUDIO_PROCESSOR: [u8; 16] = tuid(0x42043F99, 0xB7DA453C, 0xA569E79D, 0x9AAEC33D);
pub const IID_IEDIT_CONTROLLER: [u8; 16] = tuid(0xDCD7BBE3, 0x7742448D, 0xA874AACC, 0x979C759E);
pub const IID_ICOMPONENT_HANDLER: [u8; 16] = tuid(0x93A0BEA3, 0x0BD045DB, 0x8E890B0C, 0xC1E46AC6);
pub const IID_IHOST_APPLICATION: [u8; 16] = tuid(0x58E595CC, 0xDB2D4969, 0x8B6AAF8C, 0x36A664E5);
pub const IID_ICONNECTION_POINT: [u8; 16] = tuid(0x70A4156F, 0x6E6E4026, 0x989148BF, 0xAA60D8D1);
pub const IID_IPLUG_VIEW: [u8; 16] = tuid(0x5BC32507, 0xD06049EA, 0xA6151B52, 0x2B755B29);
pub const IID_IPLUG_FRAME: [u8; 16] = tuid(0x367FAF01, 0xAFA94693, 0x8D4DA2A0, 0xED0882A3);
pub const IID_IRUN_LOOP: [u8; 16] = tuid(0x18C35366, 0x97764F1A, 0x9C5B8385, 0x7A871389);
pub const IID_IBSTREAM: [u8; 16] = tuid(0xC3BF6EA2, 0x30994752, 0x9B6BF990, 0x1EE33E9B);
pub const IID_IPARAMETER_CHANGES: [u8; 16] = tuid(0xA4779663, 0x0BB64A56, 0xB44384A8, 0x466FEB9D);
pub const IID_IPARAM_VALUE_QUEUE: [u8; 16] = tuid(0x01263A18, 0xED074F6F, 0x98C9D356, 0x4686F9BA);

#[inline]
pub unsafe fn uid_eq(a: *const u8, b: &[u8; 16]) -> bool {
    if a.is_null() {
        return false;
    }
    std::slice::from_raw_parts(a, 16) == b
}

pub fn utf16_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end]).trim().to_string()
}

pub fn write_utf16(dst: &mut [u16], text: &str) {
    dst.fill(0);
    for (i, ch) in text.encode_utf16().take(dst.len().saturating_sub(1)).enumerate() {
        dst[i] = ch;
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PClassInfo {
    pub cid: [u8; 16],
    pub cardinality: i32,
    pub category: [c_char; 32],
    pub name: [c_char; 64],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct BusInfo {
    pub media_type: i32,
    pub direction: i32,
    pub channel_count: i32,
    pub name: [u16; 128],
    pub bus_type: i32,
    pub flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ParameterInfo {
    pub id: u32,
    pub title: [u16; 128],
    pub short_title: [u16; 128],
    pub units: [u16; 128],
    pub step_count: i32,
    pub default_normalized_value: f64,
    pub unit_id: i32,
    pub flags: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct ProcessSetup {
    pub process_mode: i32,
    pub symbolic_sample_size: i32,
    pub max_samples_per_block: i32,
    pub sample_rate: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct AudioBusBuffers {
    pub num_channels: i32,
    pub silence_flags: u64,
    pub channel_buffers32: *mut *mut f32,
}

#[repr(C)]
pub struct ProcessData {
    pub process_mode: i32,
    pub symbolic_sample_size: i32,
    pub num_samples: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub inputs: *mut AudioBusBuffers,
    pub outputs: *mut AudioBusBuffers,
    pub input_parameter_changes: *mut c_void,
    pub output_parameter_changes: *mut c_void,
    pub input_events: *mut c_void,
    pub output_events: *mut c_void,
    pub process_context: *mut c_void,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct ViewRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl ViewRect {
    pub fn width(&self) -> i32 {
        (self.right - self.left).max(1)
    }
    pub fn height(&self) -> i32 {
        (self.bottom - self.top).max(1)
    }
}

#[repr(C)]
pub struct ComObj<V> {
    pub vtbl: *const V,
}

#[repr(C)]
pub struct FUnknownVtbl {
    pub query_interface: unsafe extern "C" fn(*mut c_void, *const u8, *mut *mut c_void) -> i32,
    pub add_ref: unsafe extern "C" fn(*mut c_void) -> u32,
    pub release: unsafe extern "C" fn(*mut c_void) -> u32,
}

#[repr(C)]
pub struct IPluginFactoryVtbl {
    pub base: FUnknownVtbl,
    pub get_factory_info: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub count_classes: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_class_info: unsafe extern "C" fn(*mut c_void, i32, *mut PClassInfo) -> i32,
    pub create_instance: unsafe extern "C" fn(*mut c_void, *const u8, *const u8, *mut *mut c_void) -> i32,
}

#[repr(C)]
pub struct IComponentVtbl {
    pub base: FUnknownVtbl,
    pub initialize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub terminate: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_controller_class_id: unsafe extern "C" fn(*mut c_void, *mut [u8; 16]) -> i32,
    pub set_io_mode: unsafe extern "C" fn(*mut c_void, i32) -> i32,
    pub get_bus_count: unsafe extern "C" fn(*mut c_void, i32, i32) -> i32,
    pub get_bus_info: unsafe extern "C" fn(*mut c_void, i32, i32, i32, *mut BusInfo) -> i32,
    pub get_routing_info: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32,
    pub activate_bus: unsafe extern "C" fn(*mut c_void, i32, i32, i32, u8) -> i32,
    pub set_active: unsafe extern "C" fn(*mut c_void, u8) -> i32,
    pub set_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub get_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
}

#[repr(C)]
pub struct IAudioProcessorVtbl {
    pub base: FUnknownVtbl,
    pub set_bus_arrangements: unsafe extern "C" fn(*mut c_void, *mut u64, i32, *mut u64, i32) -> i32,
    pub get_bus_arrangement: unsafe extern "C" fn(*mut c_void, i32, i32, *mut u64) -> i32,
    pub can_process_sample_size: unsafe extern "C" fn(*mut c_void, i32) -> i32,
    pub get_latency_samples: unsafe extern "C" fn(*mut c_void) -> u32,
    pub setup_processing: unsafe extern "C" fn(*mut c_void, *mut ProcessSetup) -> i32,
    pub set_processing: unsafe extern "C" fn(*mut c_void, u8) -> i32,
    pub process: unsafe extern "C" fn(*mut c_void, *mut ProcessData) -> i32,
    pub get_tail_samples: unsafe extern "C" fn(*mut c_void) -> u32,
}

#[repr(C)]
pub struct IEditControllerVtbl {
    pub base: FUnknownVtbl,
    pub initialize: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub terminate: unsafe extern "C" fn(*mut c_void) -> i32,
    pub set_component_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub set_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub get_state: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub get_parameter_count: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_parameter_info: unsafe extern "C" fn(*mut c_void, i32, *mut ParameterInfo) -> i32,
    pub get_param_string_by_value: unsafe extern "C" fn(*mut c_void, u32, f64, *mut [u16; 128]) -> i32,
    pub get_param_value_by_string: unsafe extern "C" fn(*mut c_void, u32, *const u16, *mut f64) -> i32,
    pub normalized_param_to_plain: unsafe extern "C" fn(*mut c_void, u32, f64) -> f64,
    pub plain_param_to_normalized: unsafe extern "C" fn(*mut c_void, u32, f64) -> f64,
    pub get_param_normalized: unsafe extern "C" fn(*mut c_void, u32) -> f64,
    pub set_param_normalized: unsafe extern "C" fn(*mut c_void, u32, f64) -> i32,
    pub set_component_handler: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub create_view: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut ComObj<IPlugViewVtbl>,
}

#[repr(C)]
pub struct IConnectionPointVtbl {
    pub base: FUnknownVtbl,
    pub connect: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub disconnect: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub notify: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
}

#[repr(C)]
pub struct IPlugViewVtbl {
    pub base: FUnknownVtbl,
    pub is_platform_type_supported: unsafe extern "C" fn(*mut c_void, *const c_char) -> i32,
    pub attached: unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> i32,
    pub removed: unsafe extern "C" fn(*mut c_void) -> i32,
    pub on_wheel: unsafe extern "C" fn(*mut c_void, f32) -> i32,
    pub on_key_down: unsafe extern "C" fn(*mut c_void, u16, i16, i16) -> i32,
    pub on_key_up: unsafe extern "C" fn(*mut c_void, u16, i16, i16) -> i32,
    pub get_size: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> i32,
    pub on_size: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> i32,
    pub on_focus: unsafe extern "C" fn(*mut c_void, u8) -> i32,
    pub set_frame: unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32,
    pub can_resize: unsafe extern "C" fn(*mut c_void) -> i32,
    pub check_size_constraint: unsafe extern "C" fn(*mut c_void, *mut ViewRect) -> i32,
}

#[repr(C)]
pub struct IPlugFrameVtbl {
    pub base: FUnknownVtbl,
    pub resize_view: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut ViewRect) -> i32,
}

#[repr(C)]
pub struct IRunLoopVtbl {
    pub base: FUnknownVtbl,
    pub register_event_handler: unsafe extern "C" fn(*mut c_void, *mut ComObj<IEventHandlerVtbl>, i32) -> i32,
    pub unregister_event_handler: unsafe extern "C" fn(*mut c_void, *mut ComObj<IEventHandlerVtbl>) -> i32,
    pub register_timer: unsafe extern "C" fn(*mut c_void, *mut ComObj<ITimerHandlerVtbl>, u64) -> i32,
    pub unregister_timer: unsafe extern "C" fn(*mut c_void, *mut ComObj<ITimerHandlerVtbl>) -> i32,
}

#[repr(C)]
pub struct IEventHandlerVtbl {
    pub base: FUnknownVtbl,
    pub on_fd_is_set: unsafe extern "C" fn(*mut c_void, i32),
}

#[repr(C)]
pub struct ITimerHandlerVtbl {
    pub base: FUnknownVtbl,
    pub on_timer: unsafe extern "C" fn(*mut c_void),
}

#[repr(C)]
pub struct IHostApplicationVtbl {
    pub base: FUnknownVtbl,
    pub get_name: unsafe extern "C" fn(*mut c_void, *mut [u16; 128]) -> i32,
    pub create_instance: unsafe extern "C" fn(*mut c_void, *const u8, *const u8, *mut *mut c_void) -> i32,
}

#[repr(C)]
pub struct IComponentHandlerVtbl {
    pub base: FUnknownVtbl,
    pub begin_edit: unsafe extern "C" fn(*mut c_void, u32) -> i32,
    pub perform_edit: unsafe extern "C" fn(*mut c_void, u32, f64) -> i32,
    pub end_edit: unsafe extern "C" fn(*mut c_void, u32) -> i32,
    pub restart_component: unsafe extern "C" fn(*mut c_void, i32) -> i32,
}

#[repr(C)]
pub struct IBStreamVtbl {
    pub base: FUnknownVtbl,
    pub read: unsafe extern "C" fn(*mut c_void, *mut c_void, i32, *mut i32) -> i32,
    pub write: unsafe extern "C" fn(*mut c_void, *const c_void, i32, *mut i32) -> i32,
    pub seek: unsafe extern "C" fn(*mut c_void, i64, i32, *mut i64) -> i32,
    pub tell: unsafe extern "C" fn(*mut c_void, *mut i64) -> i32,
}

#[repr(C)]
pub struct IParameterChangesVtbl {
    pub base: FUnknownVtbl,
    pub get_parameter_count: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_parameter_data: unsafe extern "C" fn(*mut c_void, i32) -> *mut c_void,
    pub add_parameter_data: unsafe extern "C" fn(*mut c_void, *const u32, *mut i32) -> *mut c_void,
}

#[repr(C)]
pub struct IParamValueQueueVtbl {
    pub base: FUnknownVtbl,
    pub get_parameter_id: unsafe extern "C" fn(*mut c_void) -> u32,
    pub get_point_count: unsafe extern "C" fn(*mut c_void) -> i32,
    pub get_point: unsafe extern "C" fn(*mut c_void, i32, *mut i32, *mut f64) -> i32,
    pub add_point: unsafe extern "C" fn(*mut c_void, i32, f64, *mut i32) -> i32,
}

// ---------- Implémentations côté hôte ----------

#[repr(C)]
pub struct HostApplication {
    pub vtbl: *const IHostApplicationVtbl,
    ref_count: AtomicU32,
}

static HOST_APP_VTBL: IHostApplicationVtbl = IHostApplicationVtbl {
    base: FUnknownVtbl {
        query_interface: host_app_qi,
        add_ref: host_app_add_ref,
        release: host_app_release,
    },
    get_name: host_app_get_name,
    create_instance: host_app_create_instance,
};

impl HostApplication {
    pub fn new_raw() -> *mut Self {
        Box::into_raw(Box::new(Self {
            vtbl: &HOST_APP_VTBL,
            ref_count: AtomicU32::new(1),
        }))
    }
}

unsafe extern "C" fn host_app_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IHOST_APPLICATION) {
        host_app_add_ref(this);
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn host_app_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostApplication);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "C" fn host_app_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostApplication);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut HostApplication));
        0
    } else {
        prev - 1
    }
}

unsafe extern "C" fn host_app_get_name(_this: *mut c_void, name: *mut [u16; 128]) -> i32 {
    if !name.is_null() {
        write_utf16(&mut *name, "UMC1820 Studio Mixer");
    }
    K_RESULT_OK
}

unsafe extern "C" fn host_app_create_instance(
    _this: *mut c_void,
    _cid: *const u8,
    _iid: *const u8,
    obj: *mut *mut c_void,
) -> i32 {
    if !obj.is_null() {
        *obj = std::ptr::null_mut();
    }
    K_NOT_IMPLEMENTED
}

// ---------- HostComponentHandler ----------

#[repr(C)]
pub struct HostComponentHandler {
    pub vtbl: *const IComponentHandlerVtbl,
    ref_count: AtomicU32,
    pending_edits: Arc<Mutex<Vec<(u32, f64)>>>,
}

static COMP_HANDLER_VTBL: IComponentHandlerVtbl = IComponentHandlerVtbl {
    base: FUnknownVtbl {
        query_interface: ch_qi,
        add_ref: ch_add_ref,
        release: ch_release,
    },
    begin_edit: ch_begin_edit,
    perform_edit: ch_perform_edit,
    end_edit: ch_end_edit,
    restart_component: ch_restart_component,
};

impl HostComponentHandler {
    pub fn new_raw(pending_edits: Arc<Mutex<Vec<(u32, f64)>>>) -> *mut Self {
        Box::into_raw(Box::new(Self {
            vtbl: &COMP_HANDLER_VTBL,
            ref_count: AtomicU32::new(1),
            pending_edits,
        }))
    }
}

unsafe extern "C" fn ch_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_ICOMPONENT_HANDLER) {
        ch_add_ref(this);
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn ch_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostComponentHandler);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "C" fn ch_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostComponentHandler);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut HostComponentHandler));
        0
    } else {
        prev - 1
    }
}

unsafe extern "C" fn ch_begin_edit(_this: *mut c_void, _id: u32) -> i32 {
    K_RESULT_OK
}

unsafe extern "C" fn ch_perform_edit(this: *mut c_void, id: u32, value: f64) -> i32 {
    let me = &*(this as *const HostComponentHandler);
    if let Ok(mut q) = me.pending_edits.lock() {
        q.push((id, value));
    }
    K_RESULT_OK
}

unsafe extern "C" fn ch_end_edit(_this: *mut c_void, _id: u32) -> i32 {
    K_RESULT_OK
}

unsafe extern "C" fn ch_restart_component(_this: *mut c_void, _flags: i32) -> i32 {
    K_RESULT_OK
}

// ---------- HostBStream (pour synchroniser getState -> setComponentState) ----------

#[repr(C)]
pub struct HostBStream {
    pub vtbl: *const IBStreamVtbl,
    ref_count: AtomicU32,
    data: Vec<u8>,
    pos: usize,
}

static BSTREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    base: FUnknownVtbl {
        query_interface: bs_qi,
        add_ref: bs_add_ref,
        release: bs_release,
    },
    read: bs_read,
    write: bs_write,
    seek: bs_seek,
    tell: bs_tell,
};

impl HostBStream {
    pub fn new_raw() -> *mut Self {
        Box::into_raw(Box::new(Self {
            vtbl: &BSTREAM_VTBL,
            ref_count: AtomicU32::new(1),
            data: Vec::new(),
            pos: 0,
        }))
    }
}

unsafe extern "C" fn bs_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IBSTREAM) {
        bs_add_ref(this);
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn bs_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostBStream);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "C" fn bs_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostBStream);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut HostBStream));
        0
    } else {
        prev - 1
    }
}

unsafe extern "C" fn bs_read(
    this: *mut c_void,
    buffer: *mut c_void,
    num_bytes: i32,
    num_bytes_read: *mut i32,
) -> i32 {
    let me = &mut *(this as *mut HostBStream);
    if buffer.is_null() || num_bytes <= 0 || me.pos >= me.data.len() {
        if !num_bytes_read.is_null() {
            *num_bytes_read = 0;
        }
        return K_RESULT_OK;
    }
    let avail = (me.data.len() - me.pos).min(num_bytes as usize);
    std::ptr::copy_nonoverlapping(me.data[me.pos..].as_ptr(), buffer as *mut u8, avail);
    me.pos += avail;
    if !num_bytes_read.is_null() {
        *num_bytes_read = avail as i32;
    }
    K_RESULT_OK
}

unsafe extern "C" fn bs_write(
    this: *mut c_void,
    buffer: *const c_void,
    num_bytes: i32,
    num_bytes_written: *mut i32,
) -> i32 {
    let me = &mut *(this as *mut HostBStream);
    if buffer.is_null() || num_bytes <= 0 {
        if !num_bytes_written.is_null() {
            *num_bytes_written = 0;
        }
        return K_RESULT_OK;
    }
    let count = num_bytes as usize;
    let slice = std::slice::from_raw_parts(buffer as *const u8, count);
    if me.pos + count > me.data.len() {
        me.data.resize(me.pos + count, 0);
    }
    me.data[me.pos..me.pos + count].copy_from_slice(slice);
    me.pos += count;
    if !num_bytes_written.is_null() {
        *num_bytes_written = count as i32;
    }
    K_RESULT_OK
}

unsafe extern "C" fn bs_seek(
    this: *mut c_void,
    pos: i64,
    mode: i32,
    result: *mut i64,
) -> i32 {
    let me = &mut *(this as *mut HostBStream);
    let base: i64 = match mode {
        0 => 0,
        1 => me.pos as i64,
        2 => me.data.len() as i64,
        _ => return K_RESULT_FALSE,
    };
    let next = (base + pos).max(0) as usize;
    me.pos = next.min(me.data.len());
    if !result.is_null() {
        *result = me.pos as i64;
    }
    K_RESULT_OK
}

unsafe extern "C" fn bs_tell(this: *mut c_void, pos: *mut i64) -> i32 {
    let me = &*(this as *const HostBStream);
    if !pos.is_null() {
        *pos = me.pos as i64;
    }
    K_RESULT_OK
}

// ---------- HostParameterChanges (temps réel vers IAudioProcessor::process) ----------

#[repr(C)]
pub struct HostParamValueQueue {
    vtbl: *const IParamValueQueueVtbl,
    param_id: u32,
    value: f64,
}

static PARAM_QUEUE_VTBL: IParamValueQueueVtbl = IParamValueQueueVtbl {
    base: FUnknownVtbl {
        query_interface: pq_qi,
        add_ref: noop_ref,
        release: noop_ref,
    },
    get_parameter_id: pq_get_id,
    get_point_count: pq_get_point_count,
    get_point: pq_get_point,
    add_point: pq_add_point,
};

#[repr(C)]
pub struct HostParameterChanges {
    vtbl: *const IParameterChangesVtbl,
    queues: Vec<Box<HostParamValueQueue>>,
}

static PARAM_CHANGES_VTBL: IParameterChangesVtbl = IParameterChangesVtbl {
    base: FUnknownVtbl {
        query_interface: pc_qi,
        add_ref: noop_ref,
        release: noop_ref,
    },
    get_parameter_count: pc_get_count,
    get_parameter_data: pc_get_data,
    add_parameter_data: pc_add_data,
};

impl HostParameterChanges {
    pub fn new() -> Self {
        Self {
            vtbl: &PARAM_CHANGES_VTBL,
            queues: Vec::with_capacity(32),
        }
    }

    pub fn clear(&mut self) {
        self.queues.clear();
    }

    pub fn push(&mut self, param_id: u32, value: f64) {
        if let Some(existing) = self.queues.iter_mut().find(|q| q.param_id == param_id) {
            existing.value = value;
        } else {
            self.queues.push(Box::new(HostParamValueQueue {
                vtbl: &PARAM_QUEUE_VTBL,
                param_id,
                value,
            }));
        }
    }
}

unsafe extern "C" fn noop_ref(_this: *mut c_void) -> u32 {
    1
}

unsafe extern "C" fn pq_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IPARAM_VALUE_QUEUE) {
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn pq_get_id(this: *mut c_void) -> u32 {
    (*(this as *const HostParamValueQueue)).param_id
}

unsafe extern "C" fn pq_get_point_count(_this: *mut c_void) -> i32 {
    1
}

unsafe extern "C" fn pq_get_point(
    this: *mut c_void,
    index: i32,
    sample_offset: *mut i32,
    value: *mut f64,
) -> i32 {
    if index != 0 {
        return K_RESULT_FALSE;
    }
    let q = &*(this as *const HostParamValueQueue);
    if !sample_offset.is_null() {
        *sample_offset = 0;
    }
    if !value.is_null() {
        *value = q.value;
    }
    K_RESULT_OK
}

unsafe extern "C" fn pq_add_point(
    _this: *mut c_void,
    _sample_offset: i32,
    _value: f64,
    _index: *mut i32,
) -> i32 {
    K_NOT_IMPLEMENTED
}

unsafe extern "C" fn pc_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IPARAMETER_CHANGES) {
        *obj = this;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn pc_get_count(this: *mut c_void) -> i32 {
    (*(this as *const HostParameterChanges)).queues.len() as i32
}

unsafe extern "C" fn pc_get_data(this: *mut c_void, index: i32) -> *mut c_void {
    let me = &mut *(this as *mut HostParameterChanges);
    if index < 0 || (index as usize) >= me.queues.len() {
        std::ptr::null_mut()
    } else {
        me.queues[index as usize].as_mut() as *mut HostParamValueQueue as *mut c_void
    }
}

unsafe extern "C" fn pc_add_data(
    _this: *mut c_void,
    _id: *const u32,
    _index: *mut i32,
) -> *mut c_void {
    std::ptr::null_mut()
}

// ---------- HostPlugFrame + IRunLoop (macOS & Linux GUI) ----------

#[derive(Clone)]
pub struct RegisteredEventHandler {
    pub fd: i32,
    pub handler: *mut ComObj<IEventHandlerVtbl>,
}

#[derive(Clone)]
pub struct RegisteredTimer {
    pub handler: *mut ComObj<ITimerHandlerVtbl>,
    pub interval_ms: u64,
    pub last_fired: Instant,
}

#[derive(Default)]
pub struct PlugFrameState {
    pub pending_resize: Option<(i32, i32)>,
    pub event_handlers: Vec<RegisteredEventHandler>,
    pub timers: Vec<RegisteredTimer>,
}

impl PlugFrameState {
    pub unsafe fn clear_run_loop(&mut self) {
        for ev in self.event_handlers.drain(..) {
            if !ev.handler.is_null() {
                ((*(*ev.handler).vtbl).base.release)(ev.handler as *mut c_void);
            }
        }
        for t in self.timers.drain(..) {
            if !t.handler.is_null() {
                ((*(*t.handler).vtbl).base.release)(t.handler as *mut c_void);
            }
        }
    }
}

#[repr(C)]
pub struct HostPlugFrame {
    pub vtbl: *const IPlugFrameVtbl,
    pub run_loop_vtbl: *const IRunLoopVtbl,
    pub ref_count: AtomicU32,
    pub state: Arc<Mutex<PlugFrameState>>,
}

static PLUG_FRAME_VTBL: IPlugFrameVtbl = IPlugFrameVtbl {
    base: FUnknownVtbl {
        query_interface: pf_qi,
        add_ref: pf_add_ref,
        release: pf_release,
    },
    resize_view: pf_resize_view,
};

static RUN_LOOP_VTBL: IRunLoopVtbl = IRunLoopVtbl {
    base: FUnknownVtbl {
        query_interface: rl_qi,
        add_ref: rl_add_ref,
        release: rl_release,
    },
    register_event_handler: rl_register_event_handler,
    unregister_event_handler: rl_unregister_event_handler,
    register_timer: rl_register_timer,
    unregister_timer: rl_unregister_timer,
};

impl HostPlugFrame {
    pub fn new_raw(state: Arc<Mutex<PlugFrameState>>) -> *mut Self {
        Box::into_raw(Box::new(Self {
            vtbl: &PLUG_FRAME_VTBL,
            run_loop_vtbl: &RUN_LOOP_VTBL,
            ref_count: AtomicU32::new(1),
            state,
        }))
    }
}

#[inline]
unsafe fn frame_from_run_loop(ptr: *mut c_void) -> *mut HostPlugFrame {
    (ptr as *mut u8).sub(std::mem::offset_of!(HostPlugFrame, run_loop_vtbl)) as *mut HostPlugFrame
}

unsafe extern "C" fn pf_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    if obj.is_null() {
        return K_NO_INTERFACE;
    }
    let me = &mut *(this as *mut HostPlugFrame);
    if uid_eq(iid, &IID_FUNKNOWN) || uid_eq(iid, &IID_IPLUG_FRAME) {
        pf_add_ref(this);
        *obj = this;
        K_RESULT_OK
    } else if uid_eq(iid, &IID_IRUN_LOOP) {
        pf_add_ref(this);
        *obj = &mut me.run_loop_vtbl as *mut *const IRunLoopVtbl as *mut c_void;
        K_RESULT_OK
    } else {
        *obj = std::ptr::null_mut();
        K_NO_INTERFACE
    }
}

unsafe extern "C" fn pf_add_ref(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostPlugFrame);
    me.ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "C" fn pf_release(this: *mut c_void) -> u32 {
    let me = &*(this as *const HostPlugFrame);
    let prev = me.ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(this as *mut HostPlugFrame));
        0
    } else {
        prev - 1
    }
}

unsafe extern "C" fn pf_resize_view(
    this: *mut c_void,
    view: *mut c_void,
    new_size: *mut ViewRect,
) -> i32 {
    if new_size.is_null() {
        return K_RESULT_FALSE;
    }
    let me = &*(this as *const HostPlugFrame);
    let rect = *new_size;
    if let Ok(mut st) = me.state.lock() {
        st.pending_resize = Some((rect.width(), rect.height()));
    }
    if !view.is_null() {
        let pv = view as *mut ComObj<IPlugViewVtbl>;
        ((*(*pv).vtbl).on_size)(view, new_size);
    }
    K_RESULT_OK
}

unsafe extern "C" fn rl_qi(this: *mut c_void, iid: *const u8, obj: *mut *mut c_void) -> i32 {
    pf_qi(frame_from_run_loop(this) as *mut c_void, iid, obj)
}

unsafe extern "C" fn rl_add_ref(this: *mut c_void) -> u32 {
    pf_add_ref(frame_from_run_loop(this) as *mut c_void)
}

unsafe extern "C" fn rl_release(this: *mut c_void) -> u32 {
    pf_release(frame_from_run_loop(this) as *mut c_void)
}

unsafe extern "C" fn rl_register_event_handler(
    this: *mut c_void,
    handler: *mut ComObj<IEventHandlerVtbl>,
    fd: i32,
) -> i32 {
    if handler.is_null() {
        return K_RESULT_FALSE;
    }
    let me = &*(frame_from_run_loop(this));
    if let Ok(mut st) = me.state.lock() {
        if !st.event_handlers.iter().any(|h| h.handler == handler && h.fd == fd) {
            ((*(*handler).vtbl).base.add_ref)(handler as *mut c_void);
            st.event_handlers.push(RegisteredEventHandler { fd, handler });
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn rl_unregister_event_handler(
    this: *mut c_void,
    handler: *mut ComObj<IEventHandlerVtbl>,
) -> i32 {
    let me = &*(frame_from_run_loop(this));
    if let Ok(mut st) = me.state.lock() {
        let mut idx = 0;
        while idx < st.event_handlers.len() {
            if st.event_handlers[idx].handler == handler {
                let removed = st.event_handlers.remove(idx);
                if !removed.handler.is_null() {
                    ((*(*removed.handler).vtbl).base.release)(removed.handler as *mut c_void);
                }
            } else {
                idx += 1;
            }
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn rl_register_timer(
    this: *mut c_void,
    handler: *mut ComObj<ITimerHandlerVtbl>,
    milliseconds: u64,
) -> i32 {
    if handler.is_null() {
        return K_RESULT_FALSE;
    }
    let me = &*(frame_from_run_loop(this));
    if let Ok(mut st) = me.state.lock() {
        if let Some(existing) = st.timers.iter_mut().find(|t| t.handler == handler) {
            existing.interval_ms = milliseconds.max(10);
        } else {
            ((*(*handler).vtbl).base.add_ref)(handler as *mut c_void);
            st.timers.push(RegisteredTimer {
                handler,
                interval_ms: milliseconds.max(10),
                last_fired: Instant::now(),
            });
        }
    }
    K_RESULT_OK
}

unsafe extern "C" fn rl_unregister_timer(
    this: *mut c_void,
    handler: *mut ComObj<ITimerHandlerVtbl>,
) -> i32 {
    let me = &*(frame_from_run_loop(this));
    if let Ok(mut st) = me.state.lock() {
        let mut idx = 0;
        while idx < st.timers.len() {
            if st.timers[idx].handler == handler {
                let removed = st.timers.remove(idx);
                if !removed.handler.is_null() {
                    ((*(*removed.handler).vtbl).base.release)(removed.handler as *mut c_void);
                }
            } else {
                idx += 1;
            }
        }
    }
    K_RESULT_OK
}
