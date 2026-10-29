"""Purely isolated tests: UI bridge against the fake local engine."""
import sys
import time
import unittest
from pathlib import Path

import gi
gi.require_version("GLib", "2.0")
from gi.repository import GLib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.rpc import EngineBridge

MOCK = Path(__file__).with_name("fake_engine.py")

class TestBridge(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.closed = []
        self.bridge = EngineBridge(self.events.append, lambda: self.closed.append(True))
        self.bridge.start(MOCK)

    def tearDown(self):
        self.bridge.close()

    def _wait(self, task, seconds=4):
        loop = GLib.MainLoop()
        got = []
        def cb(value, error):
            got.append((value,error))
            loop.quit()
        task(cb)
        timer = GLib.timeout_add_seconds(seconds, lambda: loop.quit() or GLib.SOURCE_REMOVE)
        loop.run()
        if got:
            GLib.source_remove(timer)
        self.assertTrue(got, "Timed out waiting for mock engine")
        self.assertIsNone(got[0][1], got[0][1])
        return got[0][0]

    def test_ping(self):
        value = self._wait(lambda done: self.bridge.request("ping", callback=done))
        self.assertEqual(value["protocolVersion"], 1)

    def test_cached_chats(self):
        value = self._wait(lambda done: self.bridge.request("chats.list", callback=done))
        self.assertEqual(value[0]["name"], "Native GUI verification")

    def test_cached_messages(self):
        value = self._wait(lambda done: self.bridge.request("message.list",
            {"chatId":"c-test"}, callback=done))
        self.assertEqual(len(value), 2)

if __name__ == "__main__":
    unittest.main()
