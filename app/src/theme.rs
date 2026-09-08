use gtk4 as gtk;
use gtk::prelude::*;
use crate::settings::AppSettings;

/// Centralized design tokens — single source for colors, spacing, radii,
/// typography per AGENTS.md:15-16. Values mirror the polished LINE-like design
/// language of the previous WebView UI, applied here natively on GTK4.
pub struct Theme {
    pub bg: &'static str,
    pub panel: &'static str,
    pub panel2: &'static str,
    pub stage: &'static str,
    pub border: &'static str,
    pub text: &'static str,
    pub muted: &'static str,
    pub subtle: &'static str,
    pub input: &'static str,
    pub bubble: &'static str,
    pub mine: &'static str,
    pub nav: &'static str,
    pub nav_hover: &'static str,
    pub accent: &'static str,
    pub accent_hover: &'static str,
    pub accent_soft: &'static str,
    pub radius: &'static str,
    pub radius_small: &'static str,
}

impl Theme {
    pub fn from_settings(settings: &AppSettings) -> Self {
        let light = match settings.theme.as_str() {
            "light" => true,
            "dark" => false,
            _ => gtk::Settings::default()
                .map(|s| !s.is_gtk_application_prefer_dark_theme())
                .unwrap_or(true),
        };
        let (bg, panel, panel2, stage, border, text, muted, subtle, input, bubble, mine, nav, nav_hover) = if light {
            (
                "#edf2f6", "#ffffff", "#f4f7fb", "#f7fafc", "#e7ebf0",
                "#182033", "#7b8799", "#a4adba", "#eef2f6", "#ffffff",
                "#dff7e9", "#202b3f", "#2b3850",
            )
        } else {
            (
                "#101318", "#15191f", "#12161c", "#101318", "#252c35",
                "#edf2f7", "#9aa5b5", "#6f7b8c", "#1e2530", "#15191f",
                "#183a29", "#0f141d", "#202936",
            )
        };
        Self {
            bg, panel, panel2, stage, border, text, muted, subtle, input, bubble, mine, nav, nav_hover,
            accent: "#20c96e",
            accent_hover: "#12b85e",
            accent_soft: "rgba(32,201,110,.14)",
            radius: if settings.radius == "soft" { "14px" } else { "16px" },
            radius_small: "9px",
        }
    }
}

pub fn load_css(provider: &gtk::CssProvider, settings: &AppSettings) {
    let t = Theme::from_settings(settings);
    let css = format!(r#"
        window {{ background: {bg}; color: {text}; font-family: Inter, "Noto Sans Thai", sans-serif; }}
        button {{ border: 0; box-shadow: none; }}

        /* Left navigation rail (dark glass, active = green accent bar) */
        .nav-rail {{ background: linear-gradient(180deg, {nav} 0%, {nav} 58%, #1c2638 100%); border-right: 1px solid transparent; padding: 8px 6px; }}
        .brand-button {{ min-width: 38px; min-height: 38px; padding: 2px; border-radius: {radius_small}; background: transparent; }}
        .rail-button, .icon-button {{ min-width: 38px; min-height: 38px; padding: 0; border-radius: 11px; color: #aeb9cb; background: transparent; }}
        .rail-button:hover, .icon-button:hover {{ color: #ffffff; background: {nav_hover}; }}
        .rail-button.active {{ color: #ffffff; background: rgba(255,255,255,.11); box-shadow: inset 0 0 0 1px rgba(255,255,255,.05), inset 3px 0 {accent}; }}
        .icon-button {{ color: {muted}; }} .icon-button:hover {{ color: {text}; background: {input}; }}

        /* Chat list panel (white / dark panel, soft selected = green gradient) */
        .sidebar {{ background: {panel}; border-right: 1px solid {border}; }}
        .sidebar-heading {{ font-size: 17px; font-weight: 800; color: {text}; }} .eyebrow {{ color: {subtle}; font-size: 9px; font-weight: 800; letter-spacing: .16em; }}
        .search {{ margin: 0 10px 5px; min-height: 36px; border-radius: 11px; background: {input}; color: {text}; border: 1px solid transparent; }} .search:focus {{ border-color: {accent}; }}
        .filter {{ margin: 0 10px 7px; min-height: 30px; background: transparent; color: {muted}; border-radius: 8px; font-size: 11px; }}
        .chat-list row {{ margin: 2px 6px; border-radius: 12px; background: transparent; }} .chat-list row:hover {{ background: {input}; }} .chat-list row:selected {{ background: linear-gradient(90deg, {accent_soft}, transparent); }}
        .chat-row {{ padding: 9px 10px; }} .avatar {{ min-width: 46px; min-height: 46px; border-radius: 23px; background: {panel2}; color: {text}; font-size: 14px; font-weight: 800; }}
        .chat-name {{ color: {text}; font-size: 13px; font-weight: 700; }} .chat-preview {{ color: {muted}; font-size: 11px; }} .chat-time {{ color: {subtle}; font-size: 9px; }}
        .pin-button {{ min-width: 22px; min-height: 22px; padding: 0; border-radius: 7px; background: transparent; color: {subtle}; }} .pin-button:hover {{ color: {text}; }}
        .unread {{ min-width: 19px; min-height: 19px; padding: 0 5px; border-radius: 99px; background: {accent}; color: #ffffff; font-size: 9px; font-weight: 800; box-shadow: 0 4px 10px rgba(32,201,110,.25); }}

        /* Conversation */
        .conversation {{ background: {panel}; }} .conversation-header {{ min-height: 64px; padding: 0 22px; border-bottom: 1px solid {border}; background: {panel}; }} .header-avatar {{ min-width: 40px; min-height: 40px; }} .chat-title {{ color: {text}; font-size: 15px; font-weight: 800; }} .chat-subtitle {{ color: {muted}; font-size: 10px; }}
        .message-stage {{ background: linear-gradient(180deg, {panel}, {bg}); }} .scroll-bottom {{ min-width: 38px; min-height: 38px; border-radius: 19px; background: {panel}; color: {muted}; border: 1px solid {border}; box-shadow: 0 6px 18px rgba(44,54,72,.16); }} .scroll-bottom:hover {{ color: {text}; }}
        .message-list {{ padding: 16px 30px 24px; }} .message-list row {{ background: transparent; }} .message-list row.jump-highlight {{ background: {accent_soft}; border-radius: {radius}; }}
        .message-wrap {{ margin: 6px 0; }} .sender {{ color: {muted}; font-size: 10px; font-weight: 650; margin: 0 2px 4px; }}
        .message {{ border-radius: {radius_small} {radius_small} {radius_small} 5px; border: 1px solid {border}; background: {bubble}; color: {text}; padding: 10px 13px; font-size: 13px; line-height: 1.55; box-shadow: 0 3px 12px rgba(45,56,73,.06); }} .message.mine {{ background: {mine}; border-color: transparent; border-radius: {radius_small} {radius_small} 5px {radius_small}; }}
        .message-meta {{ color: {subtle}; font-size: 9px; }} .message-actions {{ opacity: 0; margin-top: 2px; }} .message-list row:hover .message-actions, .message-list row:focus-within .message-actions {{ opacity: 1; }} .small-action {{ min-height: 24px; padding: 2px 8px; border-radius: 8px; background: transparent; color: {muted}; font-size: 9px; }} .small-action:hover {{ background: {input}; color: {text}; }}

        .reply-preview, .reply-bar {{ color: {muted}; background: {input}; border-radius: 8px; padding: 6px 8px; }} .reaction-choice {{ min-width: 36px; min-height: 36px; border-radius: 18px; background: {panel}; border: 1px solid {border}; }} .reaction-choice.active {{ border: 1px solid {accent}; }}
        .reaction {{ background: {input}; border-radius: 9px; padding: 2px 7px; font-size: 10px; }} .mine-reaction {{ border: 1px solid {accent}; }}

        .image-button {{ padding: 0; background: transparent; }} .message-image, .message-sticker {{ border-radius: 14px; }} .structured-card {{ background: {input}; border-radius: 12px; padding: 9px; }} .structured-title {{ font-weight: 800; }} .rich-native, .flex-native {{ background: {panel}; border-radius: 14px; }} .rich-fallback {{ color: {muted}; padding: 18px; }} .rich-hotspot {{ background: rgba(255,255,255,.001); border: 0; }} .rich-hotspot:hover {{ border: 1px solid {accent}; background: {accent_soft}; }} .post-card {{ background: {input}; border-radius: 12px; padding: 12px; }} .flex-bubble-native {{ background: {panel}; border: 1px solid {border}; border-radius: 16px; padding: 12px; }} .flex-text-native {{ color: {text}; }} .flex-bold {{ font-weight: 800; }} .flex-button-native {{ min-height: 36px; border-radius: 10px; background: {input}; color: {text}; }} .flex-action-native {{ padding: 0; background: transparent; }}

        /* Composer (rounded pill, soft shadow) */
        .composer-wrap {{ padding: 10px 30px 14px; background: {panel}; border-top: 1px solid {border}; }} .composer {{ min-height: 46px; padding: 8px 10px 8px 13px; border: 1px solid {border}; border-radius: 18px; background: {panel}; box-shadow: 0 8px 28px rgba(35,46,62,.08); }} .composer textview, .composer textview text {{ background: transparent; color: {text}; }} .composer-placeholder {{ color: {muted}; font-size: 13px; }} .composer .icon-button {{ min-width: 30px; min-height: 30px; border-radius: 8px; }}

        .send {{ min-width: 34px; min-height: 34px; border-radius: 10px; background: {accent}; color: #062912; }} .send:hover {{ background: {accent_hover}; }} .primary {{ min-height: 42px; border-radius: 12px; background: {accent}; color: #062912; font-weight: 800; }} .primary:hover {{ background: {accent_hover}; }} .primary:disabled, .send:disabled {{ background: {input}; color: {muted}; }} .danger {{ background: #7f1d1d; color: #fff; }}

        .status {{ color: {subtle}; font-size: 10px; padding: 0 22px 8px; }} .sync-label {{ color: {muted}; font-size: 10px; }} .empty-note, .conversation-empty {{ color: {muted}; }}

        .login-page {{ padding: 32px; background: {bg}; }} .login-content {{ min-width: 720px; }} .login-brand {{ color: {text}; font-size: 22px; font-weight: 800; }} .login-card {{ padding: 26px; border: 1px solid {border}; border-radius: 16px; background: {panel}; box-shadow: 0 20px 54px rgba(37,48,66,.10); }} .login-heading {{ color: {text}; font-size: 22px; font-weight: 750; }} .login-secondary-title {{ color: {text}; font-size: 18px; font-weight: 750; margin-bottom: 2px; }} .login-help, .login-status {{ color: {muted}; font-size: 13px; }} .login-warning {{ color: #b8860b; font-size: 12px; padding: 0 4px; }} .login-consent {{ color: {text}; font-size: 12px; margin: 2px 0 0 2px; }} .qr-preview {{ min-width: 250px; min-height: 220px; border-radius: 14px; background: {input}; border: 1px solid {border}; color: {muted}; }} .login-card entry {{ min-height: 46px; border-radius: 12px; background: {input}; border: 1px solid {border}; color: {text}; padding: 0 14px; }} .login-card entry:disabled {{ color: {muted}; }}

        .secondary {{ min-height: 42px; border-radius: 12px; background: {input}; color: {text}; }} .sync-gate {{ background: {bg}; }} .sync-gate-card {{ min-width: 520px; padding: 34px; border-radius: 20px; background: {panel}; border: 1px solid {border}; box-shadow: 0 24px 72px rgba(0,0,0,.28); }} .sync-gate-title {{ font-size: 24px; font-weight: 850; }} .sync-gate-detail, .sync-gate-footnote {{ color: {muted}; }} .sync-gate-percent {{ font-size: 20px; font-weight: 800; color: {accent}; }} .modal-backdrop {{ background: rgba(8,12,20,.72); }} .qr-card {{ min-width: 430px; padding: 28px; border-radius: 18px; background: {panel}; border: 1px solid {border}; }} .qr-frame {{ min-width: 260px; min-height: 260px; padding: 12px; border-radius: 12px; background: #fff; }} .qr-status {{ color: {muted}; font-size: 12px; }}

        .image-editor {{ background: {bg}; }} .image-editor-header {{ background: {panel}; border-bottom: 1px solid {border}; }} .image-editor-title {{ color: {text}; font-size: 14px; font-weight: 800; }} .image-editor-subtitle {{ color: {muted}; font-size: 10px; }} .editor-tool, .editor-action, .editor-zoom {{ min-height: 34px; padding: 3px 8px; border-radius: 8px; background: transparent; color: {muted}; font-size: 11px; }} .editor-tool:hover, .editor-action:hover, .editor-zoom:hover {{ background: {input}; color: {text}; }} .editor-tool.active {{ background: {accent_soft}; color: {accent}; box-shadow: inset 0 -2px {accent}; }} .editor-action.save {{ background: {accent}; color: #062912; font-weight: 800; }} .editor-action.close {{ color: {text}; }} .image-viewer {{ margin: 12px; border: 1px solid {border}; border-radius: 12px; background: {stage}; }} .image-viewer viewport {{ background: {stage}; }} .image-editor-canvas {{ margin: 28px; background: {panel}; box-shadow: 0 2px 12px rgba(0,0,0,.18); }}

        .offline-banner {{ background: #f59e0b; color: #1a1a1a; padding: 6px 12px; border-radius: 8px; margin: 6px 12px; }} .offline-label {{ font-weight: 700; font-size: 12px; }}

        .settings-title, .call-peer {{ font-size: 20px; font-weight: 800; }} .settings-subtitle, .call-status {{ color: {muted}; }} .settings-row {{ padding: 10px 8px; border-bottom: 1px solid {border}; }} .asset-button {{ background: {input}; border-radius: 12px; padding: 4px; }} .pack-tab {{ min-width: 64px; min-height: 64px; border-radius: 12px; background: {input}; color: {muted}; padding: 4px; }} .pack-tab.active {{ border: 1px solid {accent}; background: {accent_soft}; }} .pack-label {{ color: {muted}; font-size: 11px; font-weight: 800; padding: 4px; }}

        .compact .chat-row {{ padding-top: 6px; padding-bottom: 6px; }} .compact .message-wrap {{ margin-top: 2px; margin-bottom: 2px; }} .compact .composer-wrap {{ padding-top: 6px; padding-bottom: 10px; }}
        .spacious .chat-row {{ padding-top: 15px; padding-bottom: 15px; }} .spacious .message-wrap {{ margin-top: 10px; margin-bottom: 10px; }} .spacious .composer-wrap {{ padding-top: 15px; padding-bottom: 22px; }}
    "#,
        bg = t.bg, panel = t.panel, panel2 = t.panel2, stage = t.stage, border = t.border,
        text = t.text, muted = t.muted, subtle = t.subtle, input = t.input, bubble = t.bubble,
        mine = t.mine, nav = t.nav, nav_hover = t.nav_hover,
        accent = t.accent, accent_hover = t.accent_hover, accent_soft = t.accent_soft,
        radius = t.radius, radius_small = t.radius_small
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
