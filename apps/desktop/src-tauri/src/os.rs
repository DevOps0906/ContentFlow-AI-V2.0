//! Windows process helpers: Job Object (kill children with the app) and stale-pid cleanup.

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    };

    /// Job with KILL_ON_JOB_CLOSE: when this app dies (even by crash), Windows kills members.
    pub struct Job(HANDLE);

    // SAFETY: a job handle is just a kernel object reference, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            // SAFETY: plain Win32 calls with a zero-initialised, correctly sized struct.
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if h.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(info).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(h);
                    return None;
                }
                Some(Job(h))
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> bool {
            // SAFETY: the child handle stays valid while `child` is borrowed.
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0 }
        }
    }

    /// Kills `pid` only if its executable is exactly `exe` (guards against pid reuse).
    pub fn kill_if_image(pid: u32, exe: &Path) -> bool {
        // SAFETY: the handle is closed on every path; buffer length is passed in/out.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let mut killed = false;
            if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0 {
                let image = String::from_utf16_lossy(&buf[..len as usize]);
                if image.eq_ignore_ascii_case(&exe.to_string_lossy()) {
                    killed = TerminateProcess(h, 1) != 0;
                }
            }
            CloseHandle(h);
            killed
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;
    pub struct Job;
    impl Job {
        pub fn new() -> Option<Job> {
            Some(Job)
        }
        pub fn assign(&self, _child: &std::process::Child) -> bool {
            true
        }
    }
    pub fn kill_if_image(_pid: u32, _exe: &Path) -> bool {
        false
    }
}

pub use imp::{kill_if_image, Job};
