"""Synthetic HTTP board/manager only; never contacts a real board or model."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import urllib.error
import urllib.parse

spec = importlib.util.spec_from_file_location('listener', Path(__file__).with_name('listener.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def message(key, sender='other', reason='mention'):
    return {'id': key, 'sender': {'external_id': sender}, 'reason': reason, 'channel_id': 7, 'body': 'synthetic external text'}


class ListenerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.pages = []
        self.polls = []
        self.deliveries = []
        self.registrations = {}
        self.rejected = set()
        self.manager_status = 'pending'
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def answer(self, status, value):
                encoded = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path == '/board/v1/activity':
                    owner.assertEqual(self.headers.get('Authorization'), 'Bearer fixture-token')
                    query = urllib.parse.parse_qs(parsed.query)
                    owner.polls.append(int(query['after'][0]))
                    page = owner.pages.pop(0)
                    self.answer(200, page)
                else:
                    owner.assertEqual(self.headers.get('X-AM-Request'), '1')
                    self.answer(200, {'notifications': [dict(row, status=owner.manager_status) for row in owner.registrations.values()]})

            def do_POST(self):
                owner.assertEqual(self.headers.get('X-AM-Request'), '1')
                owner.assertIn('from=agent', self.path)
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.deliveries.append(body)
                if body['eventId'] in owner.rejected:
                    self.answer(409, {'error': 'synthetic refusal'})
                    return
                row = owner.registrations.setdefault(body['eventId'], {'id': 'notification-' + body['eventId'],
                    'source': body['source'], 'eventId': body['eventId'], 'status': owner.manager_status})
                self.answer(202, {'ok': True, 'notification': row})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        base = 'http://127.0.0.1:' + str(self.server.server_port)
        (self.root / 'token.json').write_text('{"token":"fixture-token"}')
        self.config = {'boardUrl': base + '/board', 'handle': 'self', 'agentId': 'agent', 'managerUrl': base,
                       'stateFile': str(self.root / 'inbox.json'), 'tokenFile': str(self.root / 'token.json'),
                       'initialCursor': 408, 'ignoreIds': [406]}
        self.listener = module.Listener(self.config)

    def page(self, messages, cursor):
        self.pages.append({'messages': messages, 'next_cursor': cursor, 'has_more': False})

    def test_fetched_registered_accepted_and_acknowledged_are_distinct_and_restart_safe(self):
        self.page([message(409)], 409)
        self.listener.collect_once(wait=0)
        self.assertEqual(self.listener.snapshot()['events']['409']['status'], 'pending')
        self.listener.deliver_once()
        event = self.listener.snapshot()['events']['409']
        self.assertEqual(event['status'], 'registered')
        self.assertEqual(event['managerStatus'], 'pending')
        restarted = module.Listener(self.config)
        restarted.deliver_once()
        self.assertEqual(len(self.deliveries), 1)
        self.manager_status = 'accepted'
        restarted.deliver_once()
        self.assertEqual(restarted.snapshot()['events']['409']['managerStatus'], 'accepted')
        self.manager_status = 'acknowledged'
        restarted.deliver_once()
        self.assertEqual(restarted.snapshot()['events']['409']['managerStatus'], 'acknowledged')
        self.assertEqual(self.polls, [408])

    def test_rejected_wake_does_not_stop_new_collection_or_other_delivery(self):
        self.rejected.add('409')
        self.page([message(409)], 409)
        self.listener.collect_once(wait=0)
        self.listener.deliver_once()
        self.assertEqual(self.listener.snapshot()['deliveryError'], 'HTTP 409')
        self.page([message(410)], 410)
        self.listener.collect_once(wait=0)
        self.listener.deliver_once()
        data = self.listener.snapshot()
        self.assertEqual(data['cursor'], 410)
        self.assertEqual(data['events']['409']['status'], 'pending')
        self.assertEqual(data['events']['410']['status'], 'registered')
        self.assertEqual(data['deliveryError'], 'HTTP 409')  # successful GET does not hide the POST failure
        restarted = module.Listener(self.config)
        self.rejected.clear()
        restarted.update(lambda current: current['events']['409'].update(retryAt=0))
        restarted.deliver_once()
        self.assertEqual(restarted.snapshot()['events']['409']['status'], 'registered')
        self.assertEqual([row['eventId'] for row in self.deliveries], ['409', '410', '409'])

    def test_history_self_and_unsubscribed_messages_are_saved_without_waking(self):
        self.page([message(406), message(409, sender='self'), message(410, reason='channel'), message(411)], 411)
        self.listener.collect_once(wait=0)
        self.listener.deliver_once()
        self.assertEqual([row['eventId'] for row in self.deliveries], ['411'])
        self.assertEqual(len(self.listener.snapshot()['events']), 4)
        self.config['wakeChannelIds'] = [7]
        self.page([message(412, reason='channel')], 412)
        self.listener.collect_once(wait=0)
        self.listener.deliver_once()
        self.assertEqual(self.deliveries[-1]['eventId'], '412')

    def test_page_cursor_and_events_commit_atomically_with_failure_then_replay(self):
        self.page([message(409)], 409)
        with patch.object(module, 'atomic_json', side_effect=OSError('fixture disk failure')):
            with self.assertRaises(OSError):
                self.listener.collect_once(wait=0)
        restarted = module.Listener(self.config)
        self.assertEqual(restarted.snapshot()['cursor'], 408)
        self.assertEqual(restarted.snapshot()['events'], {})
        self.page([message(409)], 409)
        restarted.collect_once(wait=0)
        self.page([message(409)], 409)
        restarted.collect_once(wait=0)
        restarted.deliver_once()
        self.assertEqual(len(self.deliveries), 1)
        self.assertEqual(self.polls, [408, 408, 409])

    def test_invalid_page_never_advances_cursor(self):
        self.page([message(410)], 409)
        with self.assertRaises(ValueError):
            self.listener.collect_once(wait=0)
        self.assertEqual(self.listener.snapshot()['cursor'], 408)
        self.assertEqual(self.listener.snapshot()['events'], {})

    def test_collection_continues_while_manager_call_is_blocked(self):
        self.page([message(409)], 409)
        self.listener.collect_once(wait=0)
        entered, release = threading.Event(), threading.Event()
        real_transport = self.listener.transport
        def blocked(url, **kwargs):
            if kwargs.get('body'):
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('synthetic timeout')
            return real_transport(url, **kwargs)
        self.listener.transport = blocked
        worker = threading.Thread(target=self.listener.deliver_once)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            self.page([message(410)], 410)
            self.listener.collect_once(wait=0)
            self.assertEqual(self.listener.snapshot()['cursor'], 410)
        finally:
            release.set()
            worker.join(timeout=3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(self.listener.snapshot()['events']), 2)

    def test_state_identity_cannot_silently_switch_agent_or_board(self):
        changed = dict(self.config, agentId='another')
        with self.assertRaises(ValueError):
            module.Listener(changed)
        with self.assertRaises(ValueError):
            module.Listener(dict(self.config, initialCursor=500))


if __name__ == '__main__':
    unittest.main()
