#!/usr/bin/env python3
"""Yggdrasil tray icon for Linux.

Mirrors scripts/yggdrasil-tray.ps1: same menu items, same CLI actions, same
per-action log files. Uses AppIndicator (StatusNotifierItem), which KDE, XFCE,
Cinnamon and GNOME-with-an-extension show; stock GNOME has no tray area at all.
"""

import argparse
import os
import re
import subprocess
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gio, GLib, Gtk

try:  # Debian 13+/Ubuntu 24.04+/Fedora ship the Ayatana fork.
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator
except (ValueError, ImportError):  # Older distros ship the original name.
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3 as AppIndicator

APP_ID = "io.yggdrasil.tray"
DEFAULT_PORT = 2302

# Exit codes match src/cli/commands/check-update.ts: 0 up to date, 1 update
# available, anything else failed.
SUCCESS = {
    "check-update": "Yggdrasil is up to date.",
    "update": "Yggdrasil updated successfully.",
    "restart": "Yggdrasil restarted.",
    "start": "Yggdrasil started.",
}
FAILURE = {
    "check-update": "Update check failed. See data/logs.",
    "update": "Update failed. See data/logs.",
    "restart": "Restart failed. See data/logs.",
    "start": "Start failed. See data/logs.",
}


def read_port(base_dir):
    """Port from the install's .env, falling back to the installer default."""
    try:
        with open(os.path.join(base_dir, ".env"), encoding="utf-8") as fh:
            for line in fh:
                match = re.match(r"^PORT=(\d{1,5})$", line.strip())
                if match and 1 <= int(match.group(1)) <= 65535:
                    return int(match.group(1))
    except OSError:
        pass
    return DEFAULT_PORT


class Tray:
    def __init__(self, app, base_dir, node):
        self.app = app
        self.base_dir = base_dir
        self.node = node
        self.bin_dir = os.path.join(base_dir, "bin")
        self.entry = os.path.join(base_dir, "app", "bin", "yggdrasil.mjs")
        self.log_dir = os.path.join(base_dir, "data", "logs")
        self.pid_file = os.path.join(self.bin_dir, "yggdrasil-tray.pid")
        self.proc = None
        self.action = None
        self.action_items = []

        self.indicator = AppIndicator.Indicator.new(
            "yggdrasil-tray",
            "yggdrasil-tray",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS,
        )
        self.indicator.set_icon_theme_path(self.bin_dir)
        self.indicator.set_title("Yggdrasil")

        self.menu = Gtk.Menu()
        self._item("Open Yggdrasil", self._open)
        self.menu.append(Gtk.SeparatorMenuItem())
        for action, label in (
            ("start", "Start service"),
            ("restart", "Restart service"),
            ("check-update", "Check for updates"),
            ("update", "Update Yggdrasil"),
        ):
            self.action_items.append(self._item(label, lambda _i, a=action: self._run(a)))
        self.menu.append(Gtk.SeparatorMenuItem())
        self._item("Exit tray app", lambda _i: self._quit())
        self.menu.show_all()
        self.indicator.set_menu(self.menu)
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)

        os.makedirs(self.bin_dir, exist_ok=True)
        with open(self.pid_file, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))

        GLib.timeout_add(1000, self._tick)

    def _item(self, label, handler):
        item = Gtk.MenuItem(label=label)
        item.connect("activate", handler)
        self.menu.append(item)
        return item

    def _tick(self):
        if self.proc is not None and self.proc.poll() is not None:
            code = self.proc.returncode
            self.proc = None
            self._set_busy(False)
            self.app.send_notification(
                "yggdrasil-action", Gio.Notification.new(self._message(self.action, code))
            )
            self.action = None
        return True

    @staticmethod
    def _message(action, code):
        if code == 0:
            return SUCCESS.get(action, "Done.")
        if action == "check-update" and code == 1:
            return "An update is available."
        return FAILURE.get(action, "Action failed. See data/logs.")

    def _run(self, action):
        if self.proc is not None:
            return
        os.makedirs(self.log_dir, exist_ok=True)
        self._set_busy(True)
        self.action = action
        with open(os.path.join(self.log_dir, "tray-%s-last.log" % action), "wb") as log:
            self.proc = subprocess.Popen(
                [self.node, self.entry, action, "--dir", self.base_dir],
                stdout=log,
                stderr=subprocess.STDOUT,
            )

    def _set_busy(self, busy):
        for item in self.action_items:
            item.set_sensitive(not busy)

    def _open(self, _item):
        Gio.AppInfo.launch_default_for_uri(
            "http://127.0.0.1:%d" % read_port(self.base_dir), None
        )

    def _quit(self):
        try:
            os.remove(self.pid_file)
        except OSError:
            pass
        self.app.release()
        self.app.quit()


def main():
    parser = argparse.ArgumentParser(description="Yggdrasil tray icon")
    parser.add_argument("--base-dir", required=True)
    parser.add_argument("--node", default="node", help="Node.js binary used for CLI actions")
    args = parser.parse_args()

    # The application id also makes this single-instance: a second launch just
    # activates the running tray over D-Bus and exits.
    app = Gtk.Application(application_id=APP_ID)

    def activate(application):
        if getattr(application, "tray", None) is not None:
            return
        application.hold()
        application.tray = Tray(application, os.path.abspath(args.base_dir), args.node)

    app.connect("activate", activate)
    return app.run([])


if __name__ == "__main__":
    sys.exit(main())
