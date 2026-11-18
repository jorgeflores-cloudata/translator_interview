import importlib.util
import io
from contextlib import redirect_stdout
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


APP = Path(__file__).resolve().parents[1] / 'app'
spec = importlib.util.spec_from_file_location('launcher', APP / 'launcher.py')
launcher = importlib.util.module_from_spec(spec)
with patch.object(sys, 'path', [str(APP), *sys.path]):
    spec.loader.exec_module(launcher)


class ReleasePortTests(unittest.TestCase):
    def setUp(self):
        self.self_pid = patch.object(launcher.os, 'getpid', return_value=90001)
        self.parent_pid = patch.object(launcher.os, 'getppid', return_value=90002)
        self.self_pid.start()
        self.parent_pid.start()
        self.addCleanup(self.self_pid.stop)
        self.addCleanup(self.parent_pid.stop)

    def test_free_port_does_not_stop_any_process(self):
        with patch.object(launcher, 'listener_pids', return_value=set()) as listeners, \
                patch.object(launcher, 'stop_process') as stop:
            launcher.release_port(8765)
        listeners.assert_called_with(8765)
        stop.assert_not_called()

    def test_occupied_port_is_released_before_returning(self):
        owners = {701}
        with patch.object(launcher, 'listener_pids', side_effect=lambda port: set(owners)), \
                patch.object(launcher, 'stop_process', side_effect=owners.remove) as stop, \
                patch.object(launcher.time, 'sleep'):
            launcher.release_port(8765)
        stop.assert_called_once_with(701)
        self.assertFalse(owners)

    def test_all_listener_processes_are_stopped(self):
        owners = {701, 702}
        with patch.object(launcher, 'listener_pids', side_effect=lambda port: set(owners)), \
                patch.object(launcher, 'stop_process', side_effect=owners.remove) as stop, \
                patch.object(launcher.time, 'sleep'):
            launcher.release_port(9123)
        self.assertEqual({call.args[0] for call in stop.call_args_list}, {701, 702})
        self.assertFalse(owners)

    def test_new_listener_during_cleanup_is_also_released(self):
        owners = {701}

        def terminate(pid):
            owners.remove(pid)
            if pid == 701:
                owners.add(702)

        with patch.object(launcher, 'listener_pids', side_effect=lambda port: set(owners)), \
                patch.object(launcher, 'stop_process', side_effect=terminate) as stop, \
                patch.object(launcher.time, 'sleep'):
            launcher.release_port(8765)
        self.assertEqual({call.args[0] for call in stop.call_args_list}, {701, 702})
        self.assertFalse(owners)

    def test_process_that_stopped_listening_is_not_killed(self):
        responses = iter(({701}, set()))
        with patch.object(launcher, 'listener_pids', side_effect=lambda port: next(responses, set())), \
                patch.object(launcher, 'stop_process') as stop:
            launcher.release_port(8765)
        stop.assert_not_called()

    def test_protected_processes_are_never_stopped(self):
        for pid in (0, 4, 90001, 90002):
            with self.subTest(pid=pid), \
                    patch.object(launcher, 'listener_pids', return_value={pid}), \
                    patch.object(launcher, 'stop_process') as stop:
                with self.assertRaises(RuntimeError):
                    launcher.release_port(8765)
                stop.assert_not_called()

    def test_failure_to_stop_process_is_not_ignored(self):
        with patch.object(launcher, 'listener_pids', return_value={701}), \
                patch.object(launcher, 'stop_process', side_effect=RuntimeError('Access denied')):
            with self.assertRaises(RuntimeError):
                launcher.release_port(8765)

    def test_cleanup_times_out_instead_of_waiting_forever(self):
        ticks = iter(i / 10 for i in range(100))
        with patch.object(launcher, 'listener_pids', return_value={701}), \
                patch.object(launcher, 'stop_process'), \
                patch.object(launcher.time, 'sleep'), \
                patch.object(launcher.time, 'monotonic', side_effect=lambda: next(ticks)):
            with self.assertRaises((RuntimeError, TimeoutError)):
                launcher.release_port(8765, timeout=0.2)

    def test_invalid_port_never_starts_cleanup(self):
        for port in (-1, 0, 65536):
            with self.subTest(port=port), \
                    patch.object(launcher, 'listener_pids') as listeners, \
                    patch.object(launcher, 'stop_process') as stop:
                with self.assertRaises(ValueError):
                    launcher.release_port(port)
                listeners.assert_not_called()
                stop.assert_not_called()


class LauncherMainTests(unittest.TestCase):
    def test_main_checks_chrome_then_releases_port_then_starts_server(self):
        events = []
        with patch.object(launcher.server, 'load_env', side_effect=lambda: events.append('env')), \
                patch.object(launcher.server, 'find_chrome', side_effect=lambda: events.append('chrome') or Path('chrome.exe')), \
                patch.object(launcher.server, 'port_from_env', return_value=9123), \
                patch.object(launcher, 'release_port', side_effect=lambda port: events.append(('release', port))), \
                patch.object(launcher.server, 'main', side_effect=lambda *args, **kwargs: events.append('server') or 0):
            self.assertEqual(launcher.main(), 0)
        self.assertLess(events.index('chrome'), events.index(('release', 9123)))
        self.assertLess(events.index(('release', 9123)), events.index('server'))

    def test_main_does_not_kill_anything_without_chrome(self):
        with patch.object(launcher.server, 'load_env'), \
                patch.object(launcher.server, 'find_chrome', side_effect=FileNotFoundError('Chrome missing')), \
                patch.object(launcher.server, 'port_from_env', return_value=8765), \
                patch.object(launcher, 'release_port') as release, \
                patch.object(launcher.server, 'main') as start, redirect_stdout(io.StringIO()):
            self.assertEqual(launcher.main(), 1)
        release.assert_not_called()
        start.assert_not_called()

    def test_main_does_not_start_if_cleanup_fails(self):
        with patch.object(launcher.server, 'load_env'), \
                patch.object(launcher.server, 'find_chrome', return_value=Path('chrome.exe')), \
                patch.object(launcher.server, 'port_from_env', return_value=8765), \
                patch.object(launcher, 'release_port', side_effect=RuntimeError('Access denied')), \
                patch.object(launcher.server, 'main') as start, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(launcher.main(), 1)
        start.assert_not_called()
        self.assertTrue(output.getvalue())


if __name__ == '__main__':
    unittest.main()
