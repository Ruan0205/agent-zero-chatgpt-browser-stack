import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec=importlib.util.spec_from_file_location('safety',Path(__file__).parents[1]/'safety.py')
safety=importlib.util.module_from_spec(spec); spec.loader.exec_module(safety)

class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.docs=[SimpleNamespace(page_content='A0TEST-UNIQUE dourado',metadata={'id':'test'}),SimpleNamespace(page_content='Preferência real do usuário dourado',metadata={'id':'user'})]
    def test_unique_marker_never_deletes_semantically_related_user_data(self):
        self.assertEqual(safety.select_ids(self.docs,'A0TEST-UNIQUE'),(['test'],['test']))
    def test_multiple_matches_only_preview(self):
        self.assertEqual(safety.select_ids(self.docs,'dourado'),([],['test','user']))
    def test_selected_ids_only(self):
        self.assertEqual(safety.select_ids(self.docs,'dourado',confirm_ids=['test']),(['test'],['test','user']))
    def test_unrelated_id_cannot_be_selected(self):
        with self.assertRaises(ValueError): safety.select_ids(self.docs,'A0TEST-UNIQUE',confirm_ids=['user'])
    def test_empty_query_is_rejected(self):
        with self.assertRaises(ValueError): safety.select_ids(self.docs,'')
    def test_filter_is_preserved(self):
        self.assertEqual(safety.select_ids(self.docs,'dourado',predicate=lambda m:m['id']=='test'),(['test'],['test']))

if __name__=='__main__': unittest.main()
