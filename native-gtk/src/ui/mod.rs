pub mod chat_list;
pub mod dialogs;
pub mod helpers;
pub mod message_list;
pub mod shell;

pub(crate) use helpers::{
    avatar_widget, clear_list, composer_text, flex_spacing, icon_button, is_arranged_sticker_url,
    is_safe_external_uri, logo_widget, media_type, message_time, new_local_id, now_ms, numeric_leq,
    open_safe_uri, picture_from_data_url, pixbuf_from_data_url, reaction_icon, small_button,
    sticker_candidate_urls, LOCAL_ID, SEND_SEQUENCE,
};
