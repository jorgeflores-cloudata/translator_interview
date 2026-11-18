import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('window_server', Path(__file__).parents[1] / 'app/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class FakeWindows:
    def __init__(self, windows, app_handles):
        self.handles = windows
        self.app_handles = app_handles
        self.locked = []

    def windows(self):
        return self.handles

    def is_app_window(self, handle, chrome):
        return handle in self.app_handles

    def lock(self, handle):
        self.locked.append(handle)

    def enforce(self, handle):
        pass


class CompactWindowTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(server, 'start_window_guard')
        guard.start()
        self.addCleanup(guard.stop)

    def test_selects_new_app_window_without_touching_old_app_or_browser(self):
        api = FakeWindows([1, 2, 3], {1, 3})
        self.assertTrue(server.lock_compact_window('chrome.exe', before_handles=[1, 2], api=api))
        self.assertEqual(api.locked, [3])

    def test_does_not_modify_unrelated_windows(self):
        api = FakeWindows([2, 3], set())
        self.assertFalse(server.lock_compact_window('chrome.exe', timeout=0, api=api))
        self.assertEqual(api.locked, [])

    def test_reused_window_requires_unique_match(self):
        unique = FakeWindows([1, 2], {1})
        self.assertTrue(server.lock_compact_window('chrome.exe', [1, 2], timeout=0, api=unique))
        self.assertEqual(unique.locked, [1])
        ambiguous = FakeWindows([1, 2], {1, 2})
        self.assertFalse(server.lock_compact_window('chrome.exe', [1, 2], timeout=0, api=ambiguous))
        self.assertEqual(ambiguous.locked, [])

    def test_waits_for_new_window_before_selecting_existing_one(self):
        api = FakeWindows([1], {1, 3})
        def appear(_):
            api.handles = [1, 3]
        with patch.object(server.time, 'sleep', side_effect=appear):
            self.assertTrue(server.lock_compact_window('chrome.exe', [1], api=api))
        self.assertEqual(api.locked, [3])

    def test_physical_size_accounts_for_dpi_and_available_area(self):
        self.assertEqual(server.compact_window_size(96, 1920, 1080), (840, 760))
        self.assertEqual(server.compact_window_size(144, 2560, 1440), (1260, 1140))
        self.assertEqual(server.compact_window_size(192, 1000, 900), (1000, 900))

    def test_custom_maximize_is_repaired_even_with_removed_style_flags(self):
        self.assertTrue(server.needs_window_restore(False, True, 1920, 1080, 840, 760, 0))
        self.assertTrue(server.needs_window_restore(False, False, 1000, 800, 840, 760, 0))
        self.assertTrue(server.needs_window_restore(False, False, 840, 760, 840, 760, 0x50000))
        self.assertFalse(server.needs_window_restore(False, False, 840, 760, 840, 760, 0))
        self.assertFalse(server.needs_window_restore(True, False, 0, 0, 840, 760, 0x50000))

    def test_guard_rechecks_selected_window_and_exits_when_it_changes(self):
        class CustomFrame:
            def __init__(self):
                self.validations = 0
                self.enforced = []

            def is_app_window(self, handle, chrome):
                self.validations += 1
                return self.validations <= 2

            def enforce(self, handle):
                self.enforced.append(handle)

        api = CustomFrame()
        with patch.object(server.time, 'sleep') as sleep:
            server.watch_compact_window(25, 'chrome.exe', api)
        self.assertEqual(api.enforced, [25, 25])
        self.assertEqual(sleep.call_count, 2)


if __name__ == '__main__':
    unittest.main()
