import importlib
from types import SimpleNamespace
import unittest
from langchain_core.messages import HumanMessage
from usr.plugins.visual_evidence_guard.native_vision import detailed_messages
Hook = importlib.import_module('usr.plugins.visual_evidence_guard.extensions.python.chat_model_call_before._95_native_detail').NativeVisualDetail

class NativeVisionTests(unittest.IsolatedAsyncioTestCase):
    async def test_high_detail_preserves_url_and_original_message(self):
        msg=HumanMessage(content=[{'type':'text','text':'compare'},{'type':'image_url','image_url':{'url':'/tmp/a.png'}}],id='message-1')
        new=detailed_messages([msg])[0]
        self.assertEqual(new.content[1]['image_url'],{'url':'/tmp/a.png','detail':'high'})
        self.assertEqual(new.id,msg.id)
        self.assertNotIn('detail',msg.content[1]['image_url'])
    async def test_explicit_detail_and_text_unchanged(self):
        msg=HumanMessage(content=[{'type':'image_url','image_url':{'url':'data:image/png;base64,AA','detail':'low'}}])
        text=HumanMessage(content='only text')
        self.assertIs(detailed_messages([msg,text])[0],msg)
        self.assertIs(detailed_messages([msg,text])[1],text)
    async def test_non_kimi_not_modified(self):
        messages=[HumanMessage(content=[{'type':'image_url','image_url':{'url':'/tmp/a.png'}}])]
        data={'model':SimpleNamespace(model_name='openai/chatgpt-browser'),'messages':messages}
        await Hook(agent=None).execute(call_data=data)
        self.assertIs(data['messages'],messages)
    async def test_kimi_multiple_images_get_detail(self):
        data={'model':SimpleNamespace(model_name='openai/kimi-k3'),'messages':[HumanMessage(content=[{'type':'image_url','image_url':{'url':p}} for p in ('/tmp/a.png','/tmp/b.png')])]}
        await Hook(agent=None).execute(call_data=data)
        self.assertEqual([p['image_url']['detail'] for p in data['messages'][0].content],['high','high'])
