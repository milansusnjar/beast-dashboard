use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_uint, c_void, CStr};
use std::fmt::Write as _;
use std::fs;
use std::io::{self, BufRead, Write};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::unix::fs::MetadataExt;
use std::time::{Duration, Instant};

const PAGE: u64 = 4096;

struct Proc {
    pid: u32,
    ppid: u32,
    cpu_ticks: u64,
    rss: u64,
    start: u64,
    uid: u32,
    comm: String,
}

struct Listen {
    addr: String,
    port: u16,
    inode: u64,
}

fn pids() -> Vec<u32> {
    let mut list: Vec<u32> = match fs::read_dir("/proc") {
        Ok(dir) => dir
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect(),
        Err(_) => Vec::new(),
    };
    list.sort_unstable();
    list
}

fn read_proc(pid: u32) -> Option<Proc> {
    let dir = format!("/proc/{pid}");
    let uid = fs::metadata(&dir).ok()?.uid();
    let stat = fs::read(format!("{dir}/stat")).ok()?;
    let open = stat.iter().position(|&b| b == b'(')?;
    let close = stat.iter().rposition(|&b| b == b')')?;
    let comm = String::from_utf8_lossy(&stat[open + 1..close]).into_owned();
    let rest = std::str::from_utf8(stat.get(close + 2..)?).ok()?;
    let fields: Vec<&str> = rest.split(' ').collect();
    let num = |i: usize| fields.get(i).and_then(|s| s.trim().parse::<u64>().ok());
    Some(Proc {
        pid,
        ppid: num(1)? as u32,
        cpu_ticks: num(11)? + num(12)?,
        rss: num(21)? * PAGE,
        start: num(19)?,
        uid,
        comm,
    })
}

fn word_bytes(hex: &str) -> Option<[u8; 4]> {
    Some(u32::from_str_radix(hex, 16).ok()?.to_ne_bytes())
}

fn parse_addr(hex: &str) -> Option<String> {
    match hex.len() {
        8 => Some(Ipv4Addr::from(word_bytes(hex)?).to_string()),
        32 => {
            let mut bytes = [0u8; 16];
            for i in 0..4 {
                bytes[i * 4..i * 4 + 4].copy_from_slice(&word_bytes(&hex[i * 8..i * 8 + 8])?);
            }
            Some(Ipv6Addr::from(bytes).to_string())
        }
        _ => None,
    }
}

fn listening() -> Vec<Listen> {
    let mut out = Vec::new();
    for file in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = fs::read_to_string(file) else { continue };
        for line in text.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 || f[3] != "0A" {
                continue;
            }
            let Some((addr_hex, port_hex)) = f[1].split_once(':') else { continue };
            let (Some(addr), Ok(port), Ok(inode)) = (parse_addr(addr_hex), u16::from_str_radix(port_hex, 16), f[9].parse::<u64>()) else { continue };
            out.push(Listen { addr, port, inode });
        }
    }
    out
}

fn socket_owners(listens: &[Listen], procs: &[Proc]) -> HashMap<u64, usize> {
    let mut want: HashMap<u64, Option<usize>> = listens.iter().filter(|l| l.inode != 0).map(|l| (l.inode, None)).collect();
    let mut left = want.len();
    for (idx, p) in procs.iter().enumerate().rev() {
        if left == 0 {
            break;
        }
        let Ok(fds) = fs::read_dir(format!("/proc/{}/fd", p.pid)) else { continue };
        for fd in fds.flatten() {
            let Ok(target) = fs::read_link(fd.path()) else { continue };
            let Some(inode) = target.to_str().and_then(|t| t.strip_prefix("socket:[")).and_then(|t| t.strip_suffix(']')).and_then(|t| t.parse::<u64>().ok()) else { continue };
            if let Some(slot @ None) = want.get_mut(&inode) {
                *slot = Some(idx);
                left -= 1;
            }
        }
    }
    want.into_iter().filter_map(|(inode, owner)| Some((inode, owner?))).collect()
}

extern "C" {
    fn dlopen(file: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}

const RTLD_NOW: c_int = 2;
const NVML_SUCCESS: c_uint = 0;
const NVML_TEMPERATURE_GPU: c_uint = 0;

type Device = *mut c_void;

#[repr(C)]
#[derive(Default)]
struct Utilization {
    gpu: c_uint,
    memory: c_uint,
}

#[repr(C)]
#[derive(Default)]
struct MemoryV1 {
    total: u64,
    free: u64,
    used: u64,
}

#[repr(C)]
#[derive(Default)]
struct MemoryV2 {
    version: c_uint,
    total: u64,
    reserved: u64,
    free: u64,
    used: u64,
}

struct Nvml {
    device: Device,
    name: unsafe extern "C" fn(Device, *mut c_char, c_uint) -> c_uint,
    utilization: unsafe extern "C" fn(Device, *mut Utilization) -> c_uint,
    memory_v1: unsafe extern "C" fn(Device, *mut MemoryV1) -> c_uint,
    memory_v2: Option<unsafe extern "C" fn(Device, *mut MemoryV2) -> c_uint>,
    temperature: unsafe extern "C" fn(Device, c_uint, *mut c_uint) -> c_uint,
    power: unsafe extern "C" fn(Device, *mut c_uint) -> c_uint,
}

unsafe fn symbol(lib: *mut c_void, name: &CStr) -> Option<*mut c_void> {
    let ptr = dlsym(lib, name.as_ptr());
    (!ptr.is_null()).then_some(ptr)
}

impl Nvml {
    fn open() -> Option<Nvml> {
        unsafe {
            let lib = dlopen(c"libnvidia-ml.so.1".as_ptr(), RTLD_NOW);
            if lib.is_null() {
                return None;
            }
            let init: unsafe extern "C" fn() -> c_uint = std::mem::transmute(symbol(lib, c"nvmlInit_v2")?);
            let by_index: unsafe extern "C" fn(c_uint, *mut Device) -> c_uint = std::mem::transmute(symbol(lib, c"nvmlDeviceGetHandleByIndex_v2")?);
            if init() != NVML_SUCCESS {
                return None;
            }
            let mut device: Device = std::ptr::null_mut();
            if by_index(0, &mut device) != NVML_SUCCESS {
                return None;
            }
            Some(Nvml {
                device,
                name: std::mem::transmute(symbol(lib, c"nvmlDeviceGetName")?),
                utilization: std::mem::transmute(symbol(lib, c"nvmlDeviceGetUtilizationRates")?),
                memory_v1: std::mem::transmute(symbol(lib, c"nvmlDeviceGetMemoryInfo")?),
                memory_v2: symbol(lib, c"nvmlDeviceGetMemoryInfo_v2").map(|p| std::mem::transmute(p)),
                temperature: std::mem::transmute(symbol(lib, c"nvmlDeviceGetTemperature")?),
                power: std::mem::transmute(symbol(lib, c"nvmlDeviceGetPowerUsage")?),
            })
        }
    }

    fn memory(&self) -> Option<(u64, u64)> {
        unsafe {
            if let Some(v2) = self.memory_v2 {
                let mut m = MemoryV2 { version: (std::mem::size_of::<MemoryV2>() as c_uint) | (2 << 24), ..Default::default() };
                if v2(self.device, &mut m) == NVML_SUCCESS {
                    return Some((m.used, m.total));
                }
            }
            let mut m = MemoryV1::default();
            ((self.memory_v1)(self.device, &mut m) == NVML_SUCCESS).then_some((m.used, m.total))
        }
    }

    fn json(&self) -> Option<String> {
        unsafe {
            let mut name = [0 as c_char; 96];
            if (self.name)(self.device, name.as_mut_ptr(), name.len() as c_uint) != NVML_SUCCESS {
                return None;
            }
            let mut util = Utilization::default();
            if (self.utilization)(self.device, &mut util) != NVML_SUCCESS {
                return None;
            }
            let (mem_used, mem_total) = self.memory()?;
            let mut temp: c_uint = 0;
            if (self.temperature)(self.device, NVML_TEMPERATURE_GPU, &mut temp) != NVML_SUCCESS {
                return None;
            }
            let mut milliwatts: c_uint = 0;
            let power = ((self.power)(self.device, &mut milliwatts) == NVML_SUCCESS).then(|| milliwatts as f64 / 1000.0);
            let mut out = String::from("{\"name\":");
            let bytes: Vec<u8> = name.iter().map(|&c| c as u8).collect();
            let name = CStr::from_bytes_until_nul(&bytes).ok()?.to_string_lossy();
            push_str(&mut out, &name);
            let mib = 1024 * 1024;
            let _ = write!(out, ",\"util\":{},\"memUsed\":{},\"memTotal\":{},\"temp\":{},\"power\":", util.gpu, mem_used.div_ceil(mib) * mib, mem_total.div_ceil(mib) * mib, temp);
            match power {
                Some(w) => {
                    let _ = write!(out, "{w:.2}");
                }
                None => out.push_str("null"),
            }
            out.push('}');
            Some(out)
        }
    }
}

const NVML_RETRY: Duration = Duration::from_secs(60);

struct Gpu {
    nvml: Option<Nvml>,
    tried: Option<Instant>,
}

fn gpu_snapshot(state: &mut Gpu) -> String {
    if state.nvml.is_none() && state.tried.map_or(true, |t| t.elapsed() >= NVML_RETRY) {
        state.nvml = Nvml::open();
        state.tried = Some(Instant::now());
    }
    let gpu = state.nvml.as_ref().and_then(Nvml::json);
    format!("{{\"gpu\":{}}}", gpu.as_deref().unwrap_or("null"))
}

fn push_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn snapshot(with_ports: bool) -> String {
    let procs: Vec<Proc> = pids().into_iter().filter_map(read_proc).collect();
    let mut out = String::with_capacity(64 * 1024);
    out.push_str("{\"procs\":[");
    for (i, p) in procs.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(out, "[{},{},{},{},{},{},", p.pid, p.ppid, p.cpu_ticks, p.rss, p.start, p.uid);
        push_str(&mut out, &p.comm);
        out.push(']');
    }
    out.push(']');
    if with_ports {
        let listens = listening();
        let owners = socket_owners(&listens, &procs);
        out.push_str(",\"ports\":[");
        for (i, l) in listens.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push('[');
            push_str(&mut out, &l.addr);
            let _ = write!(out, ",{},", l.port);
            match owners.get(&l.inode).map(|&idx| &procs[idx]) {
                Some(p) => {
                    let _ = write!(out, "{},", p.pid);
                    push_str(&mut out, &p.comm);
                }
                None => out.push_str("null,null"),
            }
            out.push(']');
        }
        out.push(']');
    }
    out.push('}');
    out
}

fn main() {
    let mut nvml = Gpu { nvml: None, tried: None };
    match std::env::args().nth(1).as_deref() {
        Some("--once") => return println!("{}", snapshot(true)),
        Some("--gpu") => return println!("{}", gpu_snapshot(&mut nvml)),
        _ => {}
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(cmd) = line else { break };
        let body = match cmd.trim() {
            "procs" => snapshot(false),
            "snap" => snapshot(true),
            "gpu" => gpu_snapshot(&mut nvml),
            _ => String::from("{\"error\":\"unknown command\"}"),
        };
        if writeln!(stdout, "{body}").and_then(|_| stdout.flush()).is_err() {
            break;
        }
    }
}
