#!/usr/bin/env python3
"""Liney 0.2 native GTK4 + Libadwaita preview; no embedded browser."""
import sys

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw

from ui.window import LineyWindow


class LineyApplication(Adw.Application):
    def __init__(self):
        super().__init__(application_id="dev.cytechteam.Liney.Native",
                         flags=0)

    def do_activate(self):
        window = self.props.active_window
        if window is None:
            window = LineyWindow(self)
        window.present()


if __name__ == "__main__":
    raise SystemExit(LineyApplication().run(sys.argv))
