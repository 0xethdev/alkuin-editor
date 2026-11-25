//! An invite link (`alkuin://share/…`) that arrived and could not be opened.
//!
//! One copy for the whole app, kept here and not in a window, so every window
//! reads the same answer: the link can arrive before any window is listening
//! (a cold start from the email), and the sign-in that follows can happen in
//! any of them.

use crate::error::AppError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// What became of the invite links that could not be opened.
pub struct InviteArrival {
    /// A link arrived with nobody signed in. It holds until someone signs in.
    waiting: AtomicBool,
    /// Why a link was refused for the account that is signed in. The link can
    /// arrive before any window is listening (a cold start from the email), so
    /// the reason waits here until a window asks for it, once.
    refusal: Mutex<Option<String>>,
}

/// The sign-in refusal for an address that is not on the list, after an invite link.
pub const NOT_ADMITTED_AFTER_INVITE: &str = "not_admitted:invite";

impl InviteArrival {
    pub const fn new() -> Self {
        Self {
            waiting: AtomicBool::new(false),
            refusal: Mutex::new(None),
        }
    }

    /// A link could not be opened. Nobody signed in: the next sign-in is about
    /// this invite. Anything else is kept for the desk; a later one replaces it.
    pub fn note(&self, error: &AppError) {
        let code = error.to_string();
        if matches!(
            code.as_str(),
            "unauthorized" | "bad_jwt" | "session_expired" | "session_not_found"
        ) {
            self.waiting.store(true, Ordering::SeqCst);
            return;
        }
        if let Ok(mut kept) = self.refusal.lock() {
            *kept = Some(code);
        }
    }

    /// The kept refusal, once. `None` when no link has been refused since the last read.
    pub fn take_refusal(&self) -> Option<String> {
        self.refusal.lock().ok().and_then(|mut kept| kept.take())
    }

    /// A sign-in, in any window. Signed in: the invite is under Shared with
    /// you now and nothing waits. Refused because the address is not on the
    /// list while an invite waits: the refusal says so.
    pub fn sign_in<T>(&self, signed: Result<T, AppError>) -> Result<T, AppError> {
        match signed {
            Ok(value) => {
                self.waiting.store(false, Ordering::SeqCst);
                Ok(value)
            }
            Err(AppError::Account(code))
                if code == "not_admitted" && self.waiting.load(Ordering::SeqCst) =>
            {
                Err(AppError::Account(NOT_ADMITTED_AFTER_INVITE.into()))
            }
            Err(error) => Err(error),
        }
    }
}

impl Default for InviteArrival {
    fn default() -> Self {
        Self::new()
    }
}

pub static INVITE_ARRIVAL: InviteArrival = InviteArrival::new();

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(code: &str) -> AppError {
        AppError::Account(code.into())
    }

    #[test]
    fn a_link_refused_for_the_signed_in_account_is_kept_and_read_once() {
        let arrival = InviteArrival::new();
        assert_eq!(arrival.take_refusal(), None);
        arrival.note(&refused("unreachable"));
        arrival.note(&refused("not_admitted"));
        assert_eq!(arrival.take_refusal().as_deref(), Some("not_admitted"));
        assert_eq!(arrival.take_refusal(), None);
    }

    #[test]
    fn a_link_opened_signed_out_marks_the_next_refused_sign_in() {
        for code in [
            "unauthorized",
            "bad_jwt",
            "session_expired",
            "session_not_found",
        ] {
            let arrival = InviteArrival::new();
            arrival.note(&refused(code));
            // Nothing for the desk: the sign-in step is what the person sees.
            assert_eq!(arrival.take_refusal(), None);
            let signed: Result<(), AppError> = arrival.sign_in(Err(refused("not_admitted")));
            assert_eq!(signed.unwrap_err().to_string(), NOT_ADMITTED_AFTER_INVITE);
            // A second try with another address is still about the invite.
            let again: Result<(), AppError> = arrival.sign_in(Err(refused("not_admitted")));
            assert_eq!(again.unwrap_err().to_string(), NOT_ADMITTED_AFTER_INVITE);
        }
    }

    #[test]
    fn a_sign_in_settles_the_invite_and_other_refusals_are_untouched() {
        let arrival = InviteArrival::new();
        // No invite: the plain refusal.
        let plain: Result<(), AppError> = arrival.sign_in(Err(refused("not_admitted")));
        assert_eq!(plain.unwrap_err().to_string(), "not_admitted");
        arrival.note(&refused("unauthorized"));
        // A wrong code is a wrong code, invite or not.
        let wrong: Result<(), AppError> = arrival.sign_in(Err(refused("bad_code")));
        assert_eq!(wrong.unwrap_err().to_string(), "bad_code");
        // Signed in: the next refusal, in any window, is not about that invite.
        assert_eq!(arrival.sign_in(Ok(7)).unwrap(), 7);
        let later: Result<(), AppError> = arrival.sign_in(Err(refused("not_admitted")));
        assert_eq!(later.unwrap_err().to_string(), "not_admitted");
    }
}
