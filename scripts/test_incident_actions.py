"""Exercise audit-list actions against isolated temporary data."""

import asyncio
import importlib.util
import json
import tempfile
import types
import sys
from pathlib import Path

helpers = types.ModuleType('helpers')
api = types.ModuleType('helpers.api')
api.ApiHandler = type('ApiHandler', (), {})
api.Request = type('Request', (), {})
api.Response = type('Response', (), {})
sys.modules['helpers'] = helpers
sys.modules['helpers.api'] = api

source = Path(__file__).resolve().parents[1] / 'agent-zero/browser-incidents-plugin/api/state.py'
spec = importlib.util.spec_from_file_location('incident_state', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    module.ROOT = Path(directory)
    module.SETTINGS = module.ROOT / 'settings.json'
    module.INCIDENTS = module.ROOT / 'incidents.json'
    module.STATUS = module.ROOT / 'status.json'
    module.SHARED_UID = -1
    module.SHARED_GID = -1
    # The test user may not have chown permission; identity changes do not
    # affect the action semantics being tested.
    module.os.chown = lambda *args: None
    module.INCIDENTS.write_text(json.dumps([{'id': 'one'}, {'id': 'two'}]))
    handler = module.State()
    after_remove = asyncio.run(handler.process({'action': 'remove', 'id': 'one'}, None))
    assert [item['id'] for item in after_remove['incidents']] == ['two']
    after_clear = asyncio.run(handler.process({'action': 'clear_all'}, None))
    assert after_clear['counts']['total'] == 0
    assert json.loads(module.INCIDENTS.read_text()) == []
    print('PASS incident remove and clear-all actions')
