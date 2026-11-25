//! Native menu bar tweaks.
//!
//! AppKit injects an Apple Intelligence "Writing Tools" submenu into any menu
//! titled Edit, when that menu is about to open. The item is not part of the
//! menu we build. Drop it on the next turn of the main queue, after AppKit
//! has inserted it.

/// The submenu macOS adds under Edit. Exact title, so a writer-authored item
/// with a different name is left alone. Linux builds only need it for the test.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn is_writing_tools_title(title: &str) -> bool {
    title == "Writing Tools"
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn install() {}

#[cfg(target_os = "macos")]
mod macos_menu {
    use crate::macos::{app_delegate, ns_string, ns_string_to_string};
    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};

    const VOID_OBJECT_SIGNATURE: &[u8] = b"v@:@\0";

    pub(crate) fn install() {
        static INSTALLED: AtomicBool = AtomicBool::new(false);
        if INSTALLED.swap(true, Ordering::AcqRel) {
            return;
        }
        unsafe { register() };
    }

    unsafe fn register() {
        let Some(delegate) = (unsafe { app_delegate() }) else {
            eprintln!("writing tools: application delegate unavailable");
            return;
        };
        let delegate_class: *mut AnyClass = unsafe { msg_send![delegate, class] };
        if delegate_class.is_null() {
            eprintln!("writing tools: delegate class unavailable");
            return;
        }

        let open_imp: Imp = unsafe {
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                Imp,
            >(menu_will_open)
        };
        let strip_imp: Imp = unsafe {
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject),
                Imp,
            >(strip_writing_tools)
        };
        let open_added = unsafe {
            class_addMethod(
                delegate_class,
                sel!(alkuinMenuWillOpen:),
                open_imp,
                VOID_OBJECT_SIGNATURE.as_ptr().cast(),
            )
            .as_bool()
        };
        let strip_added = unsafe {
            class_addMethod(
                delegate_class,
                sel!(alkuinStripWritingTools:),
                strip_imp,
                VOID_OBJECT_SIGNATURE.as_ptr().cast(),
            )
            .as_bool()
        };
        if !open_added || !strip_added {
            eprintln!("writing tools: menu selectors could not be added");
            return;
        }

        let center: *mut AnyObject =
            unsafe { msg_send![class!(NSNotificationCenter), defaultCenter] };
        if center.is_null() {
            return;
        }
        for name in [
            "NSMenuWillOpenNotification",
            "NSMenuDidBeginTrackingNotification",
        ] {
            let note_name = unsafe { ns_string(name) };
            if note_name.is_null() {
                continue;
            }
            let _: () = unsafe {
                msg_send![
                    center,
                    addObserver: delegate,
                    selector: sel!(alkuinMenuWillOpen:),
                    name: note_name,
                    object: ptr::null::<AnyObject>()
                ]
            };
        }

        let app: *mut AnyObject = unsafe { msg_send![class!(NSApplication), sharedApplication] };
        if app.is_null() {
            return;
        }
        let main: *mut AnyObject = unsafe { msg_send![app, mainMenu] };
        unsafe { remove_writing_tools(main) };
    }

    unsafe extern "C-unwind" fn menu_will_open(
        this: *mut AnyObject,
        _cmd: Sel,
        note: *mut AnyObject,
    ) {
        if this.is_null() || note.is_null() {
            return;
        }
        let menu: *mut AnyObject = unsafe { msg_send![note, object] };
        if menu.is_null() {
            return;
        }
        // AppKit inserts Writing Tools while the menu opens. Strip on the
        // next main-queue turn, after that insert.
        let _: () = unsafe {
            msg_send![
                this,
                performSelector: sel!(alkuinStripWritingTools:),
                withObject: menu,
                afterDelay: 0.0_f64
            ]
        };
    }

    unsafe extern "C-unwind" fn strip_writing_tools(
        _this: *mut AnyObject,
        _cmd: Sel,
        menu: *mut AnyObject,
    ) {
        unsafe { remove_writing_tools(menu) };
    }

    unsafe fn remove_writing_tools(menu: *mut AnyObject) {
        if menu.is_null() {
            return;
        }
        let count: isize = unsafe { msg_send![menu, numberOfItems] };
        let mut drop_at = Vec::new();
        for index in 0..count {
            let item: *mut AnyObject = unsafe { msg_send![menu, itemAtIndex: index] };
            if item.is_null() {
                continue;
            }
            let title: *mut AnyObject = unsafe { msg_send![item, title] };
            if unsafe { ns_string_to_string(title) }
                .is_some_and(|text| super::is_writing_tools_title(&text))
            {
                drop_at.push(index);
                continue;
            }
            let submenu: *mut AnyObject = unsafe { msg_send![item, submenu] };
            if !submenu.is_null() {
                unsafe { remove_writing_tools(submenu) };
            }
        }
        for index in drop_at.into_iter().rev() {
            let _: () = unsafe { msg_send![menu, removeItemAtIndex: index] };
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos_menu::install;

#[cfg(test)]
mod tests {
    use super::is_writing_tools_title;

    #[test]
    fn writing_tools_title_is_exact() {
        assert!(is_writing_tools_title("Writing Tools"));
        assert!(!is_writing_tools_title("Edit"));
        assert!(!is_writing_tools_title("Writing tools"));
    }
}
