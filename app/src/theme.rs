use gtk4 as gtk;
use gtk::prelude::*;
use crate::settings::AppSettings;

/// Centralized design tokens — single source for colors, spacing, radii, typography
/// per AGENTS.md:15-16. No hard-coded values outside this module.
pub struct Theme {
    pub bg: &'static str,
    pub panel: &'static str,
    pub panel2: &'static str,
    pub stage: &'static str,
    pub border: &'static str,
    pub text: &'static str,
    pub muted: &'static str,
    pub input: &'static str,
    pub bubble: &'static str,
    pub mine: &'static str,
    pub accent: &'static str,
    pub accent_hover: &'static str,
    pub accent_subtle: &'static str,
    pub radius: &'static str,
}

impl Theme {
    pub fn from_settings(settings: &AppSettings) -> Self {
        let light = match settings.theme.as_str() {
            "light" => true,
            "dark" => false,
            _ => gtk::Settings::default()
                .map(|s| !s.is_gtk_application_prefer_dark_theme())
                .unwrap_or(false),
        };
        let (bg, panel, panel2, stage, border, text, muted, input, bubble, mine) = if light {
            ("#f7f8f8", "#ffffff", "#f3f4f4", "#f7f8f8", "#e1e4e3", "#202124", "#73777a", "#f1f3f3", "#ffffff", "#d9f5df")
        } else {
            ("#151515", "#1b1b1b", "#202020", "#141414", "#303030", "#f1f1f1", "#9d9d9d", "#242424", "#242424", "#1d7e4c")
        };
        Self {
            bg, panel, panel2, stage, border, text, muted, input, bubble, mine,
            accent: "#06c755",          // Liney Green — product accent only
            accent_hover: "#20d967",
            accent_subtle: "rgba(6,199,85,.14)",
            radius: if settings.radius == "soft" { "6px" } else { "9px" },
        }
    }
}

pub fn load_css(provider: &gtk::CssProvider, settings: &AppSettings) {
    let t = Theme::from_settings(settings);
    // Keep template single-sourcing accent through {accent} placeholders
    let css = format!(r#"
        window {{ background: {bg}; color: {text}; font-family: Inter, "Noto Sans Thai", sans-serif; }}
        button {{ border: 0; box-shadow: none; }}
        .nav-rail {{ background: {panel2}; border-right: 1px solid {border}; padding: 8px 6px; }}
        .brand-button {{ min-width: 38px; min-height: 38px; padding: 2px; border-radius: 8px; background: transparent; }}
        .rail-button, .icon-button {{ min-width: 36px; min-height: 36px; padding: 0; border-radius: 7px; color: {muted}; background: transparent; }}
        .rail-button:hover, .icon-button:hover {{ background: {input}; color: {text}; }}
        .rail-button.active {{ background: transparent; color: {accent}; box-shadow: inset 2px 0 {accent}; }}
        .sidebar {{ background: {panel}; border-right: 1px solid {border}; }}
        .sidebar-heading {{ font-size: 17px; font-weight: 750; color: {text}; }} .eyebrow {{ color: #6f7b8c; font-size: 9px; font-weight: 800; letter-spacing: .16em; }}
        .search {{ margin: 0 10px 5px; min-height: 34px; border-radius: 6px; background: {input}; color: {text}; border: 1px solid transparent; }} .search:focus {{ border-color: {accent}; }}
        .filter {{ margin: 0 10px 7px; min-height: 28px; background: transparent; color: {muted}; border-radius: 5px; font-size: 11px; }}
        .chat-list row {{ margin: 1px 4px; border-radius: 6px; background: transparent; }} .chat-list row:hover {{ background: {input}; }} .chat-list row:selected {{ background: {input}; box-shadow: inset 2px 0 {accent}; }}
        .chat-row {{ padding: 7px 8px; }} .avatar {{ min-width: 44px; min-height: 44px; border-radius: 22px; background: #52575b; color: #f8fafc; font-size: 13px; font-weight: 800; }}
        .chat-name {{ color: {text}; font-size: 13px; font-weight: 750; }} .chat-preview {{ color: {muted}; font-size: 11px; }} .chat-time {{ color: {muted}; font-size: 9px; }}
        .pin-button {{ min-width: 22px; min-height: 22px; padding: 0; border-radius: 7px; background: transparent; color: {muted}; }}
        .unread {{ min-width: 20px; min-height: 20px; border-radius: 10px; background: {accent_hover}; color: #082314; font-size: 10px; font-weight: 900; }}
        .conversation {{ background: {panel}; }} .conversation-header {{ min-height: 58px; padding: 0 18px; border-bottom: 1px solid {border}; }} .header-avatar {{ min-width: 38px; min-height: 38px; }} .chat-title {{ color: {text}; font-size: 14px; font-weight: 750; }} .chat-subtitle {{ color: {muted}; font-size: 10px; }}
        .message-stage {{ background: {stage}; }} .scroll-bottom {{ min-width: 36px; min-height: 36px; border-radius: 18px; background: {input}; color: {text}; border: 1px solid {border}; }} .message-list {{ padding: 14px 30px 18px; }} .message-list row {{ background: transparent; }} .message-list row.jump-highlight {{ background: {accent_subtle}; border-radius: 6px; }} .message-wrap {{ margin: 4px 0; }} .sender {{ color: {muted}; font-size: 10px; font-weight: 700; margin: 0 2px 2px; }}
        .message {{ border-radius: {radius}; border: 1px solid {border}; background: {bubble}; color: {text}; padding: 7px 10px; font-size: 13px; }} .message.mine {{ background: {mine}; border-color: transparent; }}
        .message-meta {{ color: {muted}; font-size: 9px; }} .message-actions {{ opacity: 0; margin-top: 2px; }} .message-list row:hover .message-actions, .message-list row:focus-within .message-actions {{ opacity: 1; }} .small-action {{ min-height: 23px; padding: 2px 7px; border-radius: 7px; background: transparent; color: {muted}; font-size: 9px; }} .small-action:hover {{ background: {input}; color: {text}; }}
        .reply-preview, .reply-bar {{ color: {muted}; background: {input}; border-radius: 5px; padding: 6px 8px; }} .reaction-choice {{ min-width: 34px; min-height: 34px; border-radius: 17px; background: {input}; }} .reaction-choice.active {{ border: 1px solid {accent}; }}
        .reaction {{ background: {input}; border-radius: 8px; padding: 2px 6px; font-size: 10px; }} .mine-reaction {{ border: 1px solid {accent}; }}
        .image-button {{ padding: 0; background: transparent; }} .message-image, .message-sticker {{ border-radius: 12px; }} .structured-card {{ background: {input}; border-radius: 10px; padding: 9px; }} .structured-title {{ font-weight: 800; }} .rich-native, .flex-native {{ background: {panel}; border-radius: 12px; }} .rich-fallback {{ color: {muted}; padding: 18px; }} .rich-hotspot {{ background: rgba(255,255,255,.001); border: 0; }} .rich-hotspot:hover {{ border: 1px solid {accent_hover}; background: rgba(32,201,110,.08); }} .post-card {{ background: {input}; border-radius: 12px; padding: 12px; }} .flex-bubble-native {{ background: {panel}; border: 1px solid {border}; border-radius: 14px; padding: 10px; }} .flex-text-native {{ color: {text}; }} .flex-bold {{ font-weight: 800; }} .flex-button-native {{ min-height: 34px; border-radius: 9px; background: {input}; color: {text}; }} .flex-action-native {{ padding: 0; background: transparent; }}
        .composer-wrap {{ padding: 7px 18px 12px; background: {panel}; border-top: 1px solid {border}; }} .composer {{ min-height: 42px; padding: 3px 5px; border: 1px solid {border}; border-radius: 7px; background: {input}; }} .composer textview, .composer textview text {{ background: transparent; color: {text}; }} .composer-placeholder {{ color: {muted}; font-size: 13px; }} .composer .icon-button {{ min-width: 30px; min-height: 30px; border-radius: 5px; }}
        .send {{ min-width: 32px; min-height: 32px; border-radius: 6px; background: {accent}; color: #062912; }} .send:hover {{ background: {accent_hover}; }} .primary {{ min-height: 38px; border-radius: 8px; background: {accent}; color: #062912; font-weight: 800; }} .primary:hover {{ background: {accent_hover}; }} .primary:disabled, .send:disabled {{ background: {input}; color: {muted}; }} .danger {{ background: #7f1d1d; color: #fff; }}
        .status {{ color: #6f7b8c; font-size: 10px; padding: 0 22px 8px; }} .sync-label {{ color: {muted}; font-size: 10px; }} .empty-note, .conversation-empty {{ color: {muted}; }}
        .login-page {{ padding: 44px; background: {bg}; }} .login-content {{ min-width: 928px; }} .login-brand {{ color: {text}; font-size: 22px; font-weight: 800; }} .login-card {{ padding: 28px; border: 1px solid {border}; border-radius: 16px; background: {panel}; }} .secondary-card {{ min-width: 336px; }} .login-heading {{ color: {text}; font-size: 22px; font-weight: 750; }} .login-secondary-title {{ color: {text}; font-size: 18px; font-weight: 750; }} .login-help, .login-status {{ color: {muted}; font-size: 13px; }} .login-warning {{ color: #d7a84b; font-size: 12px; }} .login-consent {{ color: {text}; font-size: 12px; }} .qr-preview {{ min-width: 250px; min-height: 250px; border-radius: 12px; background: {input}; border: 1px solid {border}; color: {muted}; }} .login-card entry {{ min-height: 44px; border-radius: 8px; background: {input}; border: 1px solid {border}; color: {text}; padding: 0 14px; }} .login-card entry:disabled {{ color: {muted}; }}
        .secondary {{ min-height: 38px; border-radius: 10px; background: {input}; color: {text}; }} .sync-gate {{ background: {bg}; }} .sync-gate-card {{ min-width: 520px; padding: 34px; border-radius: 20px; background: {panel}; border: 1px solid {border}; }} .sync-gate-title {{ font-size: 24px; font-weight: 850; }} .sync-gate-detail, .sync-gate-footnote {{ color: {muted}; }} .sync-gate-percent {{ font-size: 20px; font-weight: 800; color: {accent_hover}; }} .modal-backdrop {{ background: rgba(5,8,7,.76); }} .qr-card {{ min-width: 430px; padding: 28px; border-radius: 18px; background: {panel}; border: 1px solid {border}; }} .qr-frame {{ min-width: 260px; min-height: 260px; padding: 12px; border-radius: 12px; background: #fff; }} .qr-status {{ color: {muted}; font-size: 12px; }}
        .image-editor {{ background: {bg}; }} .image-editor-header {{ background: {panel}; border-bottom: 1px solid {border}; }} .image-editor-title {{ color: {text}; font-size: 14px; font-weight: 800; }} .image-editor-subtitle {{ color: {muted}; font-size: 10px; }} .editor-tool, .editor-action, .editor-zoom {{ min-height: 32px; padding: 3px 7px; border-radius: 6px; background: transparent; color: {muted}; font-size: 11px; }} .editor-tool:hover, .editor-action:hover, .editor-zoom:hover {{ background: {input}; color: {text}; }} .editor-tool.active {{ background: {accent_subtle}; color: {accent_hover}; box-shadow: inset 0 -2px {accent_hover}; }} .editor-action.save {{ background: {accent}; color: #062912; font-weight: 800; }} .editor-action.close {{ color: {text}; }} .image-viewer {{ margin: 12px; border: 1px solid {border}; border-radius: 10px; background: {stage}; }} .image-viewer viewport {{ background: {stage}; }} .image-editor-canvas {{ margin: 28px; background: {panel}; box-shadow: 0 2px 12px rgba(0,0,0,.18); }}
        .offline-banner {{ background: #f59e0b; color: #1a1a1a; padding: 6px 12px; border-radius: 6px; margin: 6px 12px; }} .offline-label {{ font-weight: 700; font-size: 12px; }}
        .settings-title, .call-peer {{ font-size: 20px; font-weight: 800; }} .settings-subtitle, .call-status {{ color: {muted}; }} .settings-row {{ padding: 10px 8px; border-bottom: 1px solid {border}; }} .asset-button {{ background: {input}; border-radius: 10px; padding: 4px; }} .pack-tab {{ min-width: 62px; min-height: 62px; border-radius: 10px; background: {input}; color: {muted}; padding: 4px; }} .pack-tab.active {{ border: 1px solid {accent_hover}; background: #173a29; }} .pack-label {{ color: {muted}; font-size: 11px; font-weight: 800; padding: 4px; }}
        .compact .chat-row {{ padding-top: 5px; padding-bottom: 5px; }} .compact .message-wrap {{ margin-top: 2px; margin-bottom: 2px; }} .compact .composer-wrap {{ padding-top: 5px; padding-bottom: 9px; }}
        .spacious .chat-row {{ padding-top: 14px; padding-bottom: 14px; }} .spacious .message-wrap {{ margin-top: 9px; margin-bottom: 9px; }} .spacious .composer-wrap {{ padding-top: 14px; padding-bottom: 21px; }}
    "#,
        bg = t.bg, panel = t.panel, panel2 = t.panel2, stage = t.stage, border = t.border,
        text = t.text, muted = t.muted, input = t.input, bubble = t.bubble, mine = t.mine,
        accent = t.accent, accent_hover = t.accent_hover, accent_subtle = t.accent_subtle,
        radius = t.radius
    );
    provider.load_from_data(&css);
}

pub fn apply_window_density(window: &gtk::ApplicationWindow, settings: &AppSettings) {
    window.remove_css_class("compact");
    window.remove_css_class("spacious");
    if settings.density == "compact" {
        window.add_css_class("compact");
    } else if settings.density == "spacious" {
        window.add_css_class("spacious");
    }
}
