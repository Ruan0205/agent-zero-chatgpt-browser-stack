import asyncio
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / 'tools' / 'chatgpt_browser_media.py'
spec = importlib.util.spec_from_file_location('chatgpt_browser_media_under_test', MODULE_PATH)
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


class LocalPathTests(unittest.TestCase):
    def test_current_chat_image_allowed_but_other_chat_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            chats = root / 'chats'
            chat_data = root / 'chat-data'
            workdir = root / 'workdir'
            own = chats / 'current' / 'images' / 'capture.png'
            other = chats / 'other' / 'images' / 'capture.png'
            own_capture = chat_data / 'current' / 'images' / 'capture.png'
            other_capture = chat_data / 'other' / 'images' / 'capture.png'
            outside = root / 'private.png'
            for item in (own, other, own_capture, other_capture, outside):
                item.parent.mkdir(parents=True, exist_ok=True)
                item.write_bytes(b'png')
            alias = own.parent / 'alias.png'
            alias.symlink_to(outside)
            with patch.object(media, 'WORKSPACES', chats), patch.object(media, 'CHAT_DATA', chat_data), patch.object(media, 'LOCAL_WORKDIR', workdir):
                roots = media._allowed_local_roots('current')
                self.assertEqual(media._allowed_local_file(str(own), roots), own)
                self.assertEqual(media._allowed_local_file(str(own_capture), roots), own_capture)
                self.assertIsNone(media._allowed_local_file(str(other), roots))
                self.assertIsNone(media._allowed_local_file(str(other_capture), roots))
                self.assertIsNone(media._allowed_local_file(str(outside), roots))
                self.assertIsNone(media._allowed_local_file(str(alias), roots))

    def test_invalid_context_does_not_grant_chat_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(media, 'WORKSPACES', root / 'chats'), patch.object(media, 'CHAT_DATA', root / 'chat-data'), patch.object(media, 'LOCAL_WORKDIR', root / 'workdir'):
                self.assertEqual(media._allowed_local_roots('../other'), [(root / 'workdir').resolve()])

    def test_tool_publishes_current_chat_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            chats = root / 'chats'
            image = root / 'chat-data' / 'current' / 'images' / 'capture.png'
            image.parent.mkdir(parents=True)
            image.write_bytes(b'valid-test-image')
            agent = SimpleNamespace(context=SimpleNamespace(id='current'))
            tool = media.ChatgptBrowserMedia(agent, 'chatgpt_browser_media', None, {}, '', None)
            with (
                patch.object(media, 'WORKSPACES', chats),
                patch.object(media, 'CHAT_DATA', root / 'chat-data'),
                patch.object(media, 'LOCAL_WORKDIR', root / 'workdir'),
                patch.object(media, 'UPLOADS', root / 'uploads'),
            ):
                result = asyncio.run(tool.execute(path=str(image)))
                self.assertFalse(result.break_loop)
                self.assertEqual(len(result.additional['attachments']), 1)
                published = Path(result.additional['media_paths'][0])
                self.assertEqual(published.read_bytes(), image.read_bytes())
                self.assertEqual(Path(result.additional['vscode_paths'][0]).read_bytes(), image.read_bytes())

    def test_missing_file_returns_recoverable_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agent = SimpleNamespace(context=SimpleNamespace(id='current'))
            tool = media.ChatgptBrowserMedia(agent, 'chatgpt_browser_media', None, {}, '', None)
            with (
                patch.object(media, 'WORKSPACES', root / 'chats'),
                patch.object(media, 'CHAT_DATA', root / 'chat-data'),
                patch.object(media, 'LOCAL_WORKDIR', root / 'workdir'),
                patch.object(media, 'UPLOADS', root / 'uploads'),
            ):
                result = asyncio.run(tool.execute(path=str(root / 'chat-data' / 'current' / 'images' / 'missing.png')))
                self.assertFalse(result.break_loop)
                self.assertIn('Falha recuperável', result.message)
                self.assertIn('não repita a mesma chamada', result.message)


if __name__ == '__main__':
    unittest.main()
