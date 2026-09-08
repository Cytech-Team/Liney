//! Connection state — push/poll health, offline banner
use super::State;

pub fn is_offline(_state: &State) -> bool {
    false
}
