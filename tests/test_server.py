import importlib.util
import json
from pathlib import Path
import threading
import tempfile
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location('server', Path(__file__).parents[1] / 'app/server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class AppTests(unittest.TestCase):
    def test_local_server_prevents_duplicate_listener(self):
        with server.LocalHTTPServer(('127.0.0.1', 0), server.Handler) as first:
            with self.assertRaises(OSError):
                server.LocalHTTPServer(first.server_address, server.Handler)

    @classmethod
    def setUpClass(cls):
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.origin = f'http://127.0.0.1:{cls.http.server_port}'
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.settings = server.KeySettings(Path(self.directory.name) / 'api-key.bin')
        self.patcher = patch.object(server, 'key_settings', self.settings)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.environment = patch.dict(server.os.environ, {'OPENAI_API_KEY': ''})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def post(self, path, body, origin=None):
        req = urllib.request.Request(self.origin + path, data=body,
            headers={'Origin': origin or self.origin, 'Content-Type': 'application/json'})
        return urllib.request.urlopen(req)

    def test_static_and_no_secret_exposure(self):
        for path in ('/', '/app.js', '/audio-worklet.js', '/style.css', '/api/status'):
            with urllib.request.urlopen(self.origin + path) as response:
                self.assertEqual(response.status, 200)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(self.origin + '/.env')
        self.assertEqual(caught.exception.code, 404)
        caught.exception.close()

    def test_cross_origin_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post('/api/answer', b'{}', 'https://example.com')
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()

    def test_invalid_inputs(self):
        for path, body in (('/api/answer', b'[]'), ('/api/answer', b'{'),
                           ('/api/answer', b'{"question":""}'), ('/api/transcribe', b'bad')):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post(path, body)
            self.assertEqual(caught.exception.code, 400)
            caught.exception.close()

    def test_answer_collects_text_and_disables_storage(self):
        output = {'output': [{'type': 'reasoning'}, {'content': [
            {'type': 'output_text', 'text': 'My approach is to test first.'}]}]}
        with patch.object(server, 'api', return_value=output) as mocked:
            with self.post('/api/answer', b'{"question":"How do you work?"}') as response:
                self.assertIn('My approach', json.load(response)['answer'])
            payload = json.loads(mocked.call_args.args[1])
            self.assertFalse(payload['store'])
            self.assertIn('English', payload['instructions'])

    def test_wav_multipart(self):
        with patch.object(server, 'api', return_value={'text': 'Hello?'}) as mocked:
            result = server.transcribe(b'RIFF' + bytes(4) + b'WAVE' + bytes(32))
            self.assertEqual(result['text'], 'Hello?')
            self.assertIn(b'filename="turn.wav"', mocked.call_args.args[1])
            self.assertIn('multipart/form-data', mocked.call_args.args[2])

    def analysis_response(self, result):
        return {'status': 'completed', 'output': [{'type': 'reasoning'}, {'type': 'message',
            'content': [{'type': 'output_text', 'text': json.dumps(result)}]}]}

    def test_analysis_detects_without_translation_or_answer(self):
        result = {'is_question': True, 'question': 'Tell me about your experience.',
                  'questions': ['Tell me about your experience.']}
        with patch.object(server, 'api', return_value=self.analysis_response(result)) as mocked, \
                patch.object(server, 'answer') as answer:
            with self.post('/api/analyze', json.dumps({
                    'text': 'Tell me about your experience.', 'history': 'We are interviewing today.'}).encode()) as response:
                self.assertEqual(json.load(response), result)
            answer.assert_not_called()
            self.assertEqual(mocked.call_args.args[0], 'responses')
            payload = json.loads(mocked.call_args.args[1])
            self.assertFalse(payload['store'])
            self.assertEqual(payload['text']['format']['type'], 'json_schema')
            self.assertTrue(payload['text']['format']['strict'])
            self.assertFalse(payload['text']['format']['schema']['additionalProperties'])
            self.assertEqual(set(payload['text']['format']['schema']['required']),
                             {'is_question', 'question', 'questions'})
            self.assertIn('Never answer', payload['instructions'])
            self.assertIn('never translate', payload['instructions'])
            self.assertIn('old question', payload['instructions'])
            self.assertEqual(json.loads(payload['input'])['latest_text'], 'Tell me about your experience.')

    def test_analysis_statement_and_model_override(self):
        result = {'is_question': False, 'question': '', 'questions': []}
        with patch.dict(server.os.environ, {'ANALYSIS_MODEL': 'analysis-test-model'}), \
                patch.object(server, 'api', return_value=self.analysis_response(result)) as mocked:
            self.assertEqual(server.analyze({'text': 'We are reviewing the project today.'}), result)
            self.assertEqual(json.loads(mocked.call_args.args[1])['model'], 'analysis-test-model')

    def test_analysis_rejects_invalid_inputs_before_using_api(self):
        invalid = ({}, {'text': ' '}, {'text': []}, {'text': 'Hello', 'history': []},
                   {'text': 'x' * 16001}, {'text': 'Hello', 'history': 'x' * 100001})
        with patch.object(server, 'api') as mocked:
            for data in invalid:
                with self.subTest(data_type=type(data.get('text')).__name__):
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        self.post('/api/analyze', json.dumps(data).encode())
                    self.assertEqual(caught.exception.code, 400)
                    caught.exception.close()
            mocked.assert_not_called()

    def test_analysis_rejects_bad_model_output_without_leaking_it(self):
        private = 'do-not-return-this-provider-output'
        outputs = [
            {'status': 'incomplete', 'output': []},
            {'output': [{'content': [{'type': 'refusal', 'refusal': private}]}]},
            {'output': [{'content': [{'type': 'output_text', 'text': private}]}]},
            self.analysis_response({'is_question': 'false', 'question': ''}),
            self.analysis_response({'is_question': False, 'question': 'Old question?'}),
            self.analysis_response({'is_question': True, 'question': ''}),
            self.analysis_response({'is_question': False, 'question': '', 'extra': private}),
            self.analysis_response({'is_question': True, 'question': 'First?', 'questions': []}),
            self.analysis_response({'is_question': False, 'question': '', 'questions': ['Question?']}),
            self.analysis_response({'is_question': True, 'question': 'Wrong?', 'questions': ['Actual?']}),
            self.analysis_response({'is_question': True, 'question': 'First?', 'questions': ['First?', ' ']}),
            self.analysis_response({'is_question': True, 'question': 'First?', 'questions': 'First?'}),
        ]
        for response in outputs:
            with self.subTest(response=response), patch.object(server, 'api', return_value=response):
                with self.assertRaises(ValueError) as caught:
                    server.analyze({'text': 'Hello'})
                self.assertNotIn(private, str(caught.exception))

    def test_cross_origin_analysis_is_rejected(self):
        with patch.object(server, 'api') as mocked:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post('/api/analyze', b'{"text":"Hello"}', 'https://example.com')
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
            mocked.assert_not_called()

    def test_contextual_question_uses_full_accumulated_history(self):
        history = 'Earlier we discussed database isolation. ' + 'x' * 30000
        result = {'is_question': True, 'question': 'Why did you choose database isolation?',
                  'questions': ['Why did you choose database isolation?']}
        with patch.object(server, 'api', return_value=self.analysis_response(result)) as mocked:
            self.assertEqual(server.analyze({'text': 'Why?', 'history': history}), result)
            payload = json.loads(mocked.call_args.args[1])
            self.assertEqual(json.loads(payload['input'])['recent_transcript'], history)
            self.assertIn('short follow-ups', payload['instructions'])
            self.assertIn('incomplete', payload['instructions'])
        with patch.object(server, 'api', return_value={'output': [{'content': [
                {'type': 'output_text', 'text': 'Isolation prevents conflicting writes.'}]}]}) as mocked:
            server.answer({'question': 'Why?', 'history': history})
            payload = json.loads(mocked.call_args.args[1])
            self.assertEqual(json.loads(payload['input'])['recent_transcript'], history)

    def test_analysis_returns_every_question_in_order(self):
        questions = ['Do I count the dog and the cat?', 'Do you have any siblings?',
                     'How old is your sibling?']
        result = {'is_question': True, 'question': questions[0], 'questions': questions}
        with patch.object(server, 'api', return_value=self.analysis_response(result)) as mocked:
            with self.post('/api/analyze', json.dumps({'text': ' '.join(questions),
                    'history': 'We are discussing family members.'}).encode()) as response:
                self.assertEqual(json.load(response), result)
            payload = json.loads(mocked.call_args.args[1])
            self.assertEqual(payload['max_output_tokens'], 1536)
            self.assertIn('EVERY question', payload['instructions'])
            self.assertIn('Do not merge', payload['instructions'])

    def test_realtime_token_has_short_ttl_english_accuracy_and_no_main_key(self):
        secret = 'sk-test-main-key-do-not-expose'
        self.settings.update({'api_key': secret})
        provider = {'value': 'ek_test-short-lived', 'expires_at': 2000000000,
                    'session': {'private': secret}, 'extra': secret}
        with patch.object(server, 'api', return_value=provider) as mocked:
            with self.post('/api/realtime-token', b'{}') as response:
                result = json.load(response)
            self.assertEqual(set(result), {'value', 'expires_at', 'model', 'transcription'})
            self.assertEqual(result['value'], 'ek_test-short-lived')
            self.assertEqual(result['expires_at'], 2000000000)
            self.assertEqual(result['model'], 'gpt-live-transcribe')
            self.assertNotIn(secret, json.dumps(result))
            self.assertEqual(mocked.call_args.args[0], 'realtime/client_secrets')
            payload = json.loads(mocked.call_args.args[1])
            self.assertEqual(payload['expires_after']['seconds'], 60)
            self.assertEqual(payload['session']['type'], 'transcription')
            audio = payload['session']['audio']['input']
            self.assertEqual(audio['format'], {'type': 'audio/pcm', 'rate': 24000})
            self.assertEqual(audio['transcription']['delay'], 'medium')
            self.assertEqual(audio['transcription']['languages'], ['en'])
            self.assertIn('English', audio['transcription']['prompt'])
            self.assertIn('Do not translate', audio['transcription']['prompt'])
            self.assertIn('Python', audio['transcription']['keywords'])
            self.assertEqual(result['transcription'], audio['transcription'])
            self.assertIsNone(audio['turn_detection'])

    def test_realtime_token_model_override_and_invalid_provider_output(self):
        with patch.dict(server.os.environ, {'REALTIME_TRANSCRIPTION_MODEL': 'custom-realtime'}), \
                patch.object(server, 'api', return_value={'value': 'ek_override'}) as mocked:
            result = server.realtime_token({})
            self.assertEqual(result['model'], 'custom-realtime')
            payload = json.loads(mocked.call_args.args[1])
            self.assertEqual(payload['session']['audio']['input']['transcription']['model'], 'custom-realtime')
        for provider in ({}, {'value': 'sk-never-expose-this-main-key'}, {'value': None}, []):
            with patch.object(server, 'api', return_value=provider):
                with self.assertRaises(ValueError):
                    server.realtime_token({})

    def test_realtime_token_rejects_parameters_and_cross_origin(self):
        with patch.object(server, 'api') as mocked:
            with self.assertRaises(ValueError):
                server.realtime_token({'key': 'wrong'})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post('/api/realtime-token', b'{}', 'https://example.com')
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()
            mocked.assert_not_called()

    def test_missing_key(self):
        with patch.dict(server.os.environ, {'OPENAI_API_KEY': ''}):
            with self.assertRaises(ValueError):
                server.api('responses', b'{}')

    def test_set_session_key_without_exposing_or_persisting_it(self):
        secret = 'sk-unit-test-session-secret-only'
        with self.post('/api/settings', json.dumps({'api_key': secret, 'remember': False}).encode()) as response:
            result = json.load(response)
            self.assertEqual(result, {'configured': True, 'storage': 'session'})
            self.assertNotIn(secret, json.dumps(result))
        self.assertFalse(self.settings.path.exists())
        self.assertEqual(self.settings.current_key(), secret)
        with urllib.request.urlopen(self.origin + '/api/status') as response:
            self.assertNotIn(secret, response.read().decode())
        fake_response = unittest.mock.MagicMock()
        fake_response.__enter__.return_value.read.return_value = b'{"ok": true}'
        with patch.object(server.urllib.request, 'urlopen', return_value=fake_response) as opened:
            self.assertTrue(server.api('responses', b'{}')['ok'])
            self.assertEqual(opened.call_args.args[0].headers['Authorization'], 'Bearer ' + secret)

    def test_persisted_key_can_reload_and_be_removed(self):
        secret = 'sk-unit-test-persisted-secret-only'
        encrypted = b'protected-ciphertext-for-test'
        with patch.object(server, 'protect_secret', return_value=encrypted):
            self.assertEqual(self.settings.update({'api_key': secret, 'remember': True})['storage'], 'protected')
        self.assertEqual(self.settings.path.read_bytes(), encrypted)
        self.assertNotIn(secret.encode(), self.settings.path.read_bytes())
        restored = server.KeySettings(self.settings.path)
        with patch.object(server, 'protect_secret', return_value=secret.encode()) as protector:
            restored.load()
            protector.assert_called_once_with(encrypted, decrypt=True)
        self.assertEqual(restored.current_key(), secret)
        restored.update({'api_key': 'sk-another-session-only-test-key', 'remember': False})
        self.assertFalse(self.settings.path.exists())
        self.assertEqual(restored.status()['storage'], 'session')

    def test_clear_reverts_to_environment(self):
        self.settings.update({'api_key': 'sk-unit-test-override-key-long'})
        with patch.dict(server.os.environ, {'OPENAI_API_KEY': 'sk-unit-test-environment-key'}):
            with self.post('/api/settings', b'{"clear":true}') as response:
                self.assertEqual(json.load(response), {'configured': True, 'storage': 'environment'})
            self.assertEqual(self.settings.current_key(), 'sk-unit-test-environment-key')
        self.assertEqual(self.settings.status(), {'configured': False, 'storage': 'none'})

    def test_invalid_settings_preserve_existing_key(self):
        secret = 'sk-unit-test-valid-existing-key'
        self.settings.update({'api_key': secret})
        for value in ({'api_key': ''}, {'api_key': 'short'}, {'api_key': []},
                      {'api_key': 'sk-key-with-internal\nnewline'},
                      {'api_key': secret, 'remember': 'yes'}):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.post('/api/settings', json.dumps(value).encode())
            self.assertEqual(caught.exception.code, 400)
            self.assertNotIn(secret, caught.exception.read().decode())
            caught.exception.close()
        self.assertEqual(self.settings.current_key(), secret)

    def test_cross_origin_settings_cannot_change_key(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post('/api/settings', b'{"api_key":"sk-unit-test-forbidden-secret"}', 'https://example.com')
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()
        self.assertFalse(self.settings.status()['configured'])

    @unittest.skipUnless(server.os.name == 'nt', 'Windows DPAPI only')
    def test_dpapi_round_trip(self):
        secret = b'sk-local-dpapi-unit-test-fake-key'
        encrypted = server.protect_secret(secret)
        self.assertNotIn(secret, encrypted)
        self.assertEqual(server.protect_secret(encrypted, decrypt=True), secret)

    def test_failed_persistence_does_not_replace_active_key(self):
        secret = 'sk-unit-test-original-valid-key'
        self.settings.update({'api_key': secret})
        with patch.object(server, 'protect_secret', side_effect=ValueError('DPAPI failed')):
            with self.assertRaises(ValueError):
                self.settings.update({'api_key': 'sk-unit-test-new-valid-key-long', 'remember': True})
        self.assertEqual(self.settings.current_key(), secret)

    def test_launcher_uses_chrome_app_window(self):
        chrome = Path('C:/Chrome/chrome.exe')
        with patch.object(server, 'find_chrome', return_value=chrome), \
                patch.object(server, 'CompactWindowAPI'), \
                patch.object(server.threading, 'Thread'), \
                patch.object(server.subprocess, 'Popen') as launch:
            server.open_compact_window('http://localhost:8765')
        args = launch.call_args.args[0]
        self.assertEqual(args[0], str(chrome))
        self.assertIn('--app=http://localhost:8765', args)
        self.assertIn('--window-size=840,760', args)

    def test_missing_chrome_does_not_launch_another_browser(self):
        with patch.object(server, 'find_chrome', side_effect=FileNotFoundError('Chrome missing')), \
                patch.object(server.subprocess, 'Popen') as launch:
            with self.assertRaises(FileNotFoundError):
                server.open_compact_window('http://localhost:8765')
        launch.assert_not_called()

    def test_find_chrome_never_uses_edge(self):
        with patch.object(server.Path, 'is_file', return_value=False), \
                patch.object(server.shutil, 'which', return_value=None) as which:
            with self.assertRaises(FileNotFoundError):
                server.find_chrome()
        which.assert_called_once_with('chrome.exe')


if __name__ == '__main__':
    unittest.main()
