import importlib.util
from pathlib import Path
import tempfile
import unittest
from PIL import Image

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).parents[1] / 'evidence.py')
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.blank = self.root / 'blank.jpg'
        Image.new('RGB', (1024, 768), (8, 9, 13)).save(self.blank)
        self.valid = self.root / 'valid.png'
        im = Image.new('RGB', (100, 100), (8, 9, 13))
        for x in range(50):
            for y in range(100): im.putpixel((x, y), (80, 100, 120))
        im.save(self.valid)

    def tearDown(self): self.temp.cleanup()
    def test_uniform_capture(self): self.assertTrue(e.inspect_image(self.blank)['uniform'])
    def test_dark_content_not_rejected(self): self.assertFalse(e.inspect_image(self.valid)['uniform'])
    def test_missing_file(self):
        with self.assertRaises(OSError): e.inspect_image(self.root / 'absent.png')
    def test_review_without_evidence(self):
        with self.assertRaisesRegex(ValueError, 'MISSING'): e.prepare_review('Crítico visual')
    def test_blank_cannot_be_delegated(self):
        with self.assertRaisesRegex(ValueError, 'INVALID'): e.prepare_review('Crítico visual', [self.blank])
    def test_manifest_and_exact_attachment(self):
        message, paths = e.prepare_review('Crítico visual', [self.valid])
        self.assertEqual(paths, [str(self.valid.resolve())])
        self.assertIn('sha256=', message)
    def test_last_capture_is_scoped(self):
        _, paths = e.prepare_review('Crítico visual', last_capture={'valid':True, 'path':str(self.valid)})
        self.assertEqual(paths, [str(self.valid)])
    def test_invalid_last_capture_not_used(self):
        with self.assertRaises(ValueError): e.prepare_review('Crítico visual', last_capture={'valid':False, 'path':str(self.blank)})
    def test_expression_alias(self):
        args={'action':'evaluate', 'expression':'document.body.innerText'}
        e.normalize_browser_args(args)
        self.assertEqual(args['script'], args['expression'])
    def test_empty_script_rejected(self):
        with self.assertRaises(ValueError): e.normalize_browser_args({'action':'evaluate'})
    def test_batch_alias(self):
        args={'action':'batch','calls':[{'action':'evaluate','expression':'1'}]}
        e.normalize_browser_args(args)
        self.assertEqual(args['calls'][0]['script'], '1')
    def test_visual_detection(self):
        self.assertTrue(e.is_visual_review('Você é um crítico visual técnico'))
        self.assertFalse(e.is_visual_review('Execute testes unitários e examine o terminal'))


if __name__ == '__main__': unittest.main()
