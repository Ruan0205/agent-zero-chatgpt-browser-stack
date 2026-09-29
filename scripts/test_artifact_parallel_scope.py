import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source=os.environ.get('ARTIFACT_VERIFY_SOURCE') or Path(__file__).parents[1]/'agent-zero/seed/agents/agent0/tools/artifact_verify.py'
spec=importlib.util.spec_from_file_location('artifact_verify',source)
artifact=importlib.util.module_from_spec(spec); spec.loader.exec_module(artifact)

class ParallelScopeTests(unittest.TestCase):
    def setUp(self):
        self.parent=SimpleNamespace(id='parent')
        self.agent=SimpleNamespace(context=SimpleNamespace(id='worker'))
        self.job=SimpleNamespace(parent_agent=SimpleNamespace(context=self.parent),parent_context_id='parent',worker_context_id='worker')
    def test_real_worker_uses_parent_scope(self):
        with patch('helpers.parallel_tools.get_parallel_worker_job',return_value=self.job):
            self.assertIs(artifact._artifact_context(self.agent),self.parent)
    def test_unregistered_chat_cannot_claim_another_parent(self):
        with patch('helpers.parallel_tools.get_parallel_worker_job',return_value=None):
            self.assertIs(artifact._artifact_context(self.agent),self.agent.context)
    def test_different_worker_is_not_authorized(self):
        self.job.worker_context_id='another-chat'
        with patch('helpers.parallel_tools.get_parallel_worker_job',return_value=self.job):
            self.assertIs(artifact._artifact_context(self.agent),self.agent.context)
    def test_mismatched_parent_is_not_authorized(self):
        self.job.parent_context_id='another-parent'
        with patch('helpers.parallel_tools.get_parallel_worker_job',return_value=self.job):
            self.assertIs(artifact._artifact_context(self.agent),self.agent.context)

if __name__=='__main__': unittest.main()
