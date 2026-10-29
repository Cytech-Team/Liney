"""GTK4 + Libadwaita native Liney shell (migration preview).

The UI intentionally never imports LINEJS, Tauri, React or WebKit.
"""
from __future__ import annotations

import io
import time
import uuid

from gi.repository import Adw, Gdk, Gio, GLib, GObject, Gtk

from bridge.rpc import EngineBridge


class ChatItem(GObject.Object):
    def __init__(self, data):
        super().__init__()
        self.data = data
        self.chat_id = str(data.get("id") or "")
        self.kind = str(data.get("kind") or "dm")
        self.name = str(data.get("name") or "Unknown")
        self.preview = str(data.get("preview") or "")
        self.unread = int(data.get("unread") or 0)


class MessageItem(GObject.Object):
    def __init__(self, data):
        super().__init__()
        self.data = data
        self.id = str(data.get("id") or "")
        self.mine = bool(data.get("isMine"))
        self.sender = str(data.get("senderName") or "")
        self.body = str(data.get("text") or "").strip()
        if not self.body:
            media = {1: "Photo", 2: "Video", 3: "Audio", 7: "Sticker"}
            self.body = media.get(int(data.get("contentType") or 0), "Attachment")
        self.timestamp = int(data.get("createdTime") or 0)


def _chat_factory():
    factory = Gtk.SignalListItemFactory()

    def setup(_factory, item):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.set_margin_start(12)
        box.set_margin_end(12)
        box.set_margin_top(8)
        box.set_margin_bottom(8)
        name = Gtk.Label(xalign=0)
        name.add_css_class("heading")
        name.set_ellipsize(3)  # Pango.EllipsizeMode.END
        preview = Gtk.Label(xalign=0)
        preview.add_css_class("dim-label")
        preview.set_ellipsize(3)
        box.append(name)
        box.append(preview)
        item.set_child(box)

    def bind(_factory, item):
        chat = item.get_item()
        name, preview = [item.get_child().get_first_child(),
                         item.get_child().get_last_child()]
        name.set_text(chat.name + (f"  ({chat.unread})" if chat.unread else ""))
        preview.set_text(chat.preview or chat.kind)

    factory.connect("setup", setup)
    factory.connect("bind", bind)
    return factory


def _message_factory():
    factory = Gtk.SignalListItemFactory()

    def setup(_factory, item):
        row = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        row.set_margin_top(7)
        row.set_margin_bottom(7)
        row.set_margin_start(12)
        row.set_margin_end(12)
        who = Gtk.Label(xalign=0)
        who.add_css_class("dim-label")
        who.add_css_class("caption")
        content = Gtk.Label(xalign=0, wrap=True, selectable=True)
        content.set_wrap_mode(2)  # Pango.WrapMode.WORD_CHAR
        row.append(who)
        row.append(content)
        item.set_child(row)

    def bind(_factory, item):
        message = item.get_item()
        row = item.get_child()
        who, content = row.get_first_child(), row.get_last_child()
        who.set_text(("You" if message.mine else message.sender or "Contact")
                     + (f"  ·  {time.strftime('%H:%M', time.localtime(message.timestamp / 1000))}"
                        if message.timestamp else ""))
        content.set_text(message.body)
        row.set_halign(Gtk.Align.END if message.mine else Gtk.Align.START)

    factory.connect("setup", setup)
    factory.connect("bind", bind)
    return factory


class LineyWindow(Adw.ApplicationWindow):
    def __init__(self, application):
        super().__init__(application=application, title="Liney — Native Preview")
        self.set_default_size(1120, 720)
        self.set_size_request(650, 420)
        self.authenticated = False
        self.current_chat = None
        self.chats = {}
        self.messages = {}
        self.login_window = None
        self.qr_label = None
        self.qr_picture = None
        self.pin_label = None
        self.status = Gtk.Label(label="Starting local engine...", xalign=0)
        self.status.add_css_class("dim-label")
        self.status.add_css_class("caption")

        self.chat_store = Gio.ListStore.new(ChatItem)
        self.chat_filter = Gtk.CustomFilter.new(self._chat_matches)
        self.filtered_chats = Gtk.FilterListModel.new(self.chat_store, self.chat_filter)
        self.chat_selection = Gtk.SingleSelection.new(self.filtered_chats)
        self.chat_selection.connect("notify::selected-item", self._chat_selected)

        self.message_store = Gio.ListStore.new(MessageItem)
        self.message_selection = Gtk.NoSelection.new(self.message_store)
        self._build_ui()

        self.bridge = EngineBridge(self._on_event, self._on_closed)
        self.connect("close-request", self._close)
        GLib.idle_add(self._start_engine)

    def _build_ui(self):
        paned = Gtk.Paned.new(Gtk.Orientation.HORIZONTAL)
        paned.set_position(330)
        paned.set_resize_start_child(False)
        paned.set_shrink_start_child(False)
        paned.set_shrink_end_child(False)

        left = Adw.ToolbarView()
        left_header = Adw.HeaderBar()
        title = Gtk.Label(label="Liney")
        title.add_css_class("title-2")
        left_header.set_title_widget(title)
        left.add_top_bar(left_header)

        search = Gtk.SearchEntry(placeholder_text="Search chats")
        search.set_margin_start(12)
        search.set_margin_end(12)
        search.set_margin_top(10)
        search.set_margin_bottom(6)
        search.connect("search-changed", lambda *_: self.chat_filter.changed(Gtk.FilterChange.DIFFERENT))

        login = Gtk.Button(label="Sign in")
        login.add_css_class("suggested-action")
        login.connect("clicked", lambda *_: self._login_dialog())
        self.login_button = login

        refresh = Gtk.Button(icon_name="view-refresh-symbolic")
        refresh.set_tooltip_text("Refresh cached chat list")
        refresh.connect("clicked", lambda *_: self._load_chats())
        left_header.pack_start(refresh)

        self.chat_list = Gtk.ListView.new(self.chat_selection, _chat_factory())
        self.chat_list.set_single_click_activate(True)
        self.chat_list.add_css_class("navigation-sidebar")
        chat_scroll = Gtk.ScrolledWindow()
        chat_scroll.set_child(self.chat_list)
        chat_scroll.set_vexpand(True)
        sidebar = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        sidebar.append(search)
        sidebar.append(chat_scroll)
        sidebar.append(Gtk.Separator())
        bottom = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        bottom.set_margin_start(12)
        bottom.set_margin_end(12)
        bottom.set_margin_top(10)
        bottom.set_margin_bottom(10)
        bottom.append(self.status)
        bottom.append(login)
        bottom.set_hexpand(True)
        self.status.set_hexpand(True)
        sidebar.append(bottom)
        left.set_content(sidebar)
        paned.set_start_child(left)

        right = Adw.ToolbarView()
        right_header = Adw.HeaderBar()
        self.room_title = Gtk.Label(label="Choose a conversation")
        self.room_title.add_css_class("title-3")
        right_header.set_title_widget(self.room_title)
        right.add_top_bar(right_header)

        main = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        self.message_list = Gtk.ListView.new(self.message_selection, _message_factory())
        self.message_list.set_vexpand(True)
        scroll = Gtk.ScrolledWindow()
        scroll.set_child(self.message_list)
        scroll.set_vexpand(True)
        main.append(scroll)

        composer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        composer.set_margin_start(14)
        composer.set_margin_end(14)
        composer.set_margin_top(10)
        composer.set_margin_bottom(12)
        self.message_input = Gtk.Entry(placeholder_text="Message")
        self.message_input.set_hexpand(True)
        self.message_input.connect("activate", lambda *_: self._send())
        self.send_button = Gtk.Button(label="Send")
        self.send_button.add_css_class("suggested-action")
        self.send_button.connect("clicked", lambda *_: self._send())
        composer.append(self.message_input)
        composer.append(self.send_button)
        main.append(Gtk.Separator())
        main.append(composer)
        self.message_input.set_sensitive(False)
        self.send_button.set_sensitive(False)
        right.set_content(main)
        paned.set_end_child(right)
        self.set_content(paned)

    def _chat_matches(self, chat):
        text = self._search_text()
        return not text or text in chat.name.casefold() or text in chat.preview.casefold()

    def _search_text(self):
        # Search widget is the first child inside the sidebar content.
        sidebar = self.get_content().get_start_child().get_content()
        return sidebar.get_first_child().get_text().casefold().strip()

    def _start_engine(self):
        try:
            self.bridge.start()
        except (OSError, ValueError) as exc:
            self._set_status("Engine unavailable: " + str(exc))
            return GLib.SOURCE_REMOVE
        self.bridge.request("ping", callback=self._on_ping, timeout=8)
        # Cached responses are served without network authorization when present.
        self._load_chats()
        self.bridge.request("capabilities", callback=self._on_capabilities, timeout=120)
        return GLib.SOURCE_REMOVE

    def _on_ping(self, data, error):
        if error or not isinstance(data, dict) or data.get("protocolVersion") != 1:
            self._set_status(error or "Unsupported engine protocol")
        else:
            self._set_status("Loading local chats...")

    def _on_capabilities(self, data, error):
        if error:
            self._set_status("Offline · Cached history available")
            return
        if isinstance(data, dict):
            self.authenticated = bool(data.get("authenticated"))
            self._update_controls()
            self._set_status("Connected" if self.authenticated else "Sign in to sync")
            if self.authenticated:
                self._load_chats()

    def _load_chats(self):
        self.bridge.request("chats.list", callback=self._on_chats, timeout=90)

    def _on_chats(self, data, error):
        if isinstance(data, list):
            self._merge_chats(data, replace=True)
            self._set_status(f"{len(self.chats)} chats · local cache")
        elif error and not self.chats:
            self._set_status("Sign in to load chats")

    def _merge_chats(self, entries, replace=False):
        if replace:
            self.chats = {}
        for item in entries:
            if isinstance(item, dict) and item.get("id"):
                self.chats[str(item["id"])] = item
        selected_id = self.current_chat.chat_id if self.current_chat else None
        sorted_chats = sorted(self.chats.values(), key=lambda x: int(x.get("lastMessageTime") or 0), reverse=True)
        self.chat_store.splice(0, self.chat_store.get_n_items(), [ChatItem(x) for x in sorted_chats])
        if selected_id:
            for index, chat in enumerate(sorted_chats):
                if str(chat.get("id")) == selected_id and not self._search_text():
                    self.chat_selection.set_selected(index)
                    break

    def _chat_selected(self, selection, _pspec):
        chat = selection.get_selected_item()
        if chat is None:
            return
        if self.current_chat and self.current_chat.chat_id == chat.chat_id:
            return
        self.current_chat = chat
        self.room_title.set_text(chat.name)
        self.message_store.remove_all()
        self.messages = {}
        self._update_controls()
        self.bridge.request("message.list", {
            "chatId": chat.chat_id, "kind": chat.kind, "limit": 100
        }, callback=lambda data, error: self._on_messages(chat.chat_id, data, error), timeout=65)

    def _on_messages(self, chat_id, data, error):
        if not self.current_chat or chat_id != self.current_chat.chat_id:
            return
        if isinstance(data, list):
            self.messages = {str(x["id"]): x for x in data if isinstance(x, dict) and x.get("id")}
            self._render_messages()
        elif error:
            self._set_status("Cached history unavailable · " + error)

    def _render_messages(self):
        if not self.current_chat:
            return
        ordered = sorted(self.messages.values(), key=lambda x: int(x.get("createdTime") or 0))
        self.message_store.splice(0, self.message_store.get_n_items(), [MessageItem(x) for x in ordered])

    def _send(self):
        if not self.current_chat or not self.authenticated:
            return
        text = self.message_input.get_text()
        if not text.strip():
            return
        chat = self.current_chat
        local_id = str(uuid.uuid4())
        now = int(time.time() * 1000)
        self.messages[local_id] = {
            "id": local_id, "chatId": chat.chat_id,
            "text": text, "createdTime": now,
            "isMine": True, "status": "sending",
        }
        self._render_messages()
        self.message_input.set_text("")
        self.bridge.request("message.send", {
            "chatId": chat.chat_id, "kind": chat.kind,
            "text": text, "localId": local_id, "createdAt": now,
        }, callback=lambda data, error: self._sent(chat.chat_id, local_id, data, error), timeout=60)

    def _sent(self, chat_id, local_id, data, error):
        if not self.current_chat or self.current_chat.chat_id != chat_id:
            return
        if error:
            self._set_status("Send failed: " + error)
            if local_id in self.messages:
                self.messages[local_id]["status"] = "failed"
        else:
            self._set_status("Sent")
        # Engine owns authoritative server IDs and outbox reconciliation.
        self.bridge.request("message.list", {
            "chatId": chat_id, "kind": self.current_chat.kind, "limit": 100
        }, callback=lambda data, error: self._on_messages(chat_id, data, error))

    def _on_event(self, event):
        kind = event.get("type")
        if kind == "auth.ready":
            self.authenticated = True
            self._update_controls()
            self._set_status("Connected")
            if self.login_window:
                self.login_window.close()
                self.login_window = None
            self._load_chats()
        elif kind in ("auth.logged_out", "auth.restore_failed"):
            self.authenticated = False
            self._update_controls()
            self._set_status("Sign in to reconnect")
        elif kind == "auth.qr" and self.qr_label:
            self._show_qr(str(event.get("url") or ""))
        elif kind == "auth.pin" and self.pin_label:
            self.pin_label.set_text("Device verification PIN: " + str(event.get("pin") or ""))
        elif kind == "event.chats.updated" and isinstance(event.get("chats"), list):
            self._merge_chats(event["chats"])
        elif kind in ("event.message", "event.message.updated") and isinstance(event.get("message"), dict):
            if self.current_chat and str(event.get("chatId")) == self.current_chat.chat_id:
                message = event["message"]
                if message.get("id"):
                    self.messages[str(message["id"])] = message
                    self._render_messages()
        elif kind == "event.message.removed":
            if self.current_chat and str(event.get("chatId")) == self.current_chat.chat_id:
                self.messages.pop(str(event.get("messageId")), None)
                self._render_messages()

    def _on_closed(self):
        self.authenticated = False
        self._update_controls()
        self._set_status("Engine stopped · Restart Liney to reconnect")

    def _update_controls(self):
        self.login_button.set_visible(not self.authenticated)
        enabled = self.authenticated and self.current_chat is not None
        self.message_input.set_sensitive(enabled)
        self.send_button.set_sensitive(enabled)

    def _set_status(self, value):
        self.status.set_text(value)

    def _login_dialog(self):
        if self.login_window:
            self.login_window.present()
            return
        window = Gtk.Window(title="Sign in to LINE", transient_for=self, modal=True)
        window.set_default_size(430, 400)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        box.set_margin_start(20)
        box.set_margin_end(20)
        box.set_margin_top(20)
        box.set_margin_bottom(20)
        title = Gtk.Label(label="Liney · Unofficial LINE client", xalign=0)
        title.add_css_class("title-2")
        box.append(title)
        notice = Gtk.Label(label="Use at your own risk. Liney is not affiliated with LINE.", wrap=True, xalign=0)
        notice.add_css_class("dim-label")
        box.append(notice)

        qr = Gtk.Button(label="Sign in with QR")
        qr.add_css_class("suggested-action")
        qr.connect("clicked", lambda *_: self.bridge.request(
            "auth.qr.start", {}, callback=self._login_result, timeout=180))
        box.append(qr)

        self.qr_picture = Gtk.Picture()
        self.qr_picture.set_size_request(170, 170)
        self.qr_picture.set_can_shrink(True)
        box.append(self.qr_picture)
        self.qr_label = Gtk.Label(label="QR code will appear here", wrap=True, selectable=True)
        box.append(self.qr_label)
        copy = Gtk.Button(label="Copy login link")
        copy.connect("clicked", lambda *_: Gdk.Display.get_default().get_clipboard().set(self.qr_url or ""))
        box.append(copy)
        self.qr_url = ""
        self.pin_label = Gtk.Label(label="")
        box.append(self.pin_label)
        window.set_child(box)
        window.connect("close-request", lambda *_: self._clear_login())
        self.login_window = window
        window.present()

    def _login_result(self, _result, error):
        if error and self.qr_label:
            self.qr_label.set_text("QR login error: " + error)

    def _show_qr(self, url):
        self.qr_url = url
        self.qr_label.set_text(url or "QR code not available")
        try:
            import qrcode
            image = qrcode.make(url)
            data = io.BytesIO()
            image.save(data, format="PNG")
            texture = Gdk.Texture.new_from_bytes(GLib.Bytes.new(data.getvalue()))
            self.qr_picture.set_paintable(texture)
        except (ImportError, ValueError, TypeError):
            self.qr_label.set_text("Install python3-qrcode for image display. Copy link: " + url)

    def _clear_login(self):
        self.login_window = None
        self.qr_label = None
        self.qr_picture = None
        self.pin_label = None
        self.qr_url = ""
        return False

    def _close(self, *_):
        self.bridge.close()
        return False
