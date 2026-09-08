//! Auth state — login, logout, restore, QR
//! Extracted from state/mod.rs for manager clarity. State struct stays in mod.rs.

use super::{Pending, State};
use crate::models::Profile;

pub fn handle_auth_qr(_state: &std::rc::Rc<std::cell::RefCell<State>>, _url: &str) {
    // moved from main.rs handle_engine_event "auth.qr"
}
pub fn handle_auth_ready(_state: &std::rc::Rc<std::cell::RefCell<State>>, _profile: Option<Profile>) {
    // placeholder for future split
}
